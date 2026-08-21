import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createImageOperationService } from "../src/images/image-operation-service.js";

const MANAGED = "http://127.0.0.1:18789/api/chat/media/outgoing/agent%3Amain%3Achat/01234567-89ab-cdef-0123-456789abcdef/full";
const ASSISTANT = "http://127.0.0.1:18789/__openclaw__/assistant-media?source=%2Fdata%2Fworkspace%2Fimage.png";

function response(body: Uint8Array | null, contentType = "image/png", status = 200): Response {
  return new Response(body === null ? null : Buffer.from(body), { status, headers: { "content-type": contentType } });
}

function setup(overrides: Record<string, unknown> = {}) {
  const clipboard = { writeImage: vi.fn() };
  const nativeImage = { createFromBuffer: vi.fn(() => ({ isEmpty: () => false })) };
  const fetch = vi.fn(async (_input: string, _init: RequestInit) => response(new Uint8Array([1, 2, 3])));
  const showSaveDialog = vi.fn(async () => ({ canceled: true }));
  const service = createImageOperationService({
    gatewayOrigin: () => "http://127.0.0.1:18789",
    gatewayToken: "gateway-secret",
    fetch,
    clipboard,
    nativeImage,
    showSaveDialog,
    dataRoot: "/data",
    realpath: vi.fn(async (path: string) => path),
    operationTimeoutMs: 30_000,
    ...overrides,
  });
  return { service, clipboard, nativeImage, fetch, showSaveDialog };
}

describe("image operation service", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

  it("fetches managed media without redirects and adds bearer plus decoded session header", async () => {
    const { service, fetch, clipboard } = setup();
    await expect(service.copy({ sourceUrl: MANAGED, suggestedName: "image.png" })).resolves.toEqual({ status: "completed" });

    expect(fetch).toHaveBeenCalledWith(MANAGED, expect.objectContaining({
      redirect: "manual",
      headers: {
        Authorization: "Bearer gateway-secret",
        "x-openclaw-requester-session-key": "agent:main:chat",
      },
    }));
    expect(clipboard.writeImage).toHaveBeenCalledOnce();
  });

  it("adds only bearer auth for assistant media", async () => {
    const { service, fetch } = setup();
    await service.copy({ sourceUrl: ASSISTANT, suggestedName: "image.png" });
    expect(fetch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      headers: { Authorization: "Bearer gateway-secret" },
    }));
  });

  it("times out a hung assistant realpath without starting fetch", async () => {
    const realpath = vi.fn(() => new Promise<string>(() => undefined));
    const { service, fetch } = setup({ realpath, operationTimeoutMs: 10 });
    await expect(service.copy({ sourceUrl: ASSISTANT, suggestedName: "image.png" })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["%2Fetc%2Fpasswd", "/etc/passwd"],
    ["%2Fdata%2Fworkspace%2F..%2Fsecret.png", "/data/secret.png"],
    ["C%3A%5CWindows%5Csecret.png", "C:\\Windows\\secret.png"],
    ["%5C%5Cserver%5Cshare%5Csecret.png", "\\\\server\\share\\secret.png"],
    ["%2Fdata%2Fworkspace%2Flink.png", "/etc/secret.png"],
  ])("rejects assistant media outside the real workspace: %s", async (rawSource, resolvedSource) => {
    const sourceUrl = `http://127.0.0.1:18789/__openclaw__/assistant-media?source=${rawSource}`;
    const linkedSource = resolve("/data/workspace/link.png");
    const resolvedTarget = /^[A-Z]:\\|^\\\\/iu.test(resolvedSource) ? resolvedSource : resolve(resolvedSource);
    const realpath = vi.fn(async (path: string) => path === linkedSource ? resolvedTarget : path);
    const { service, fetch } = setup({ realpath });
    await expect(service.copy({ sourceUrl, suggestedName: "image.png" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "https://example.com/image.png",
    "http://127.0.0.1:18888/api/chat/media/outgoing/agent%3Amain/01234567-89ab-cdef-0123-456789abcdef/full",
    "http://user:password@127.0.0.1:18789/__openclaw__/assistant-media?source=%2Ftmp%2Fimage.png",
    "http://127.0.0.1:18789/__openclaw__/assistant-media?source=%2Ftmp%2Fimage.png#private",
  ])("rejects a source outside the current controlled gateway: %s", async (sourceUrl) => {
    const { service, fetch } = setup();
    await expect(service.copy({ sourceUrl, suggestedName: "image.png" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "图片读取失败，请重试。",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [response(new Uint8Array([1]), "image/png", 302), "OPERATION_FAILED"],
    [response(new Uint8Array([1]), "text/plain"), "FILE_TYPE_UNSUPPORTED"],
    [response(new Uint8Array(), "image/png"), "OPERATION_FAILED"],
  ])("rejects redirect, non-image MIME, and empty image responses", async (fetchResponse, code) => {
    const { service } = setup({ fetch: vi.fn(async () => fetchResponse) });
    await expect(service.copy({ sourceUrl: MANAGED, suggestedName: "image.png" })).rejects.toMatchObject({ code });
  });

  it("aborts streaming reads above 32 MiB", async () => {
    const chunk = new Uint8Array(16 * 1024 * 1024 + 1);
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls += 1; controller.enqueue(chunk); } });
    const { service } = setup({ fetch: vi.fn(async () => new Response(stream, { headers: { "content-type": "image/png" } })) });

    await expect(service.copy({ sourceUrl: MANAGED, suggestedName: "image.png" })).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(pulls).toBeLessThanOrEqual(3);
  });

  it("maps streaming failures to a stable path-free read error", async () => {
    const stream = new ReadableStream<Uint8Array>({ pull() { throw new Error("/private/image.png token=gateway-secret"); } });
    const { service } = setup({ fetch: vi.fn(async () => new Response(stream, { headers: { "content-type": "image/png" } })) });

    await expect(service.copy({ sourceUrl: MANAGED, suggestedName: "image.png" })).rejects.toMatchObject({
      code: "OPERATION_FAILED",
      message: "图片读取失败，请重试。",
    });
  });

  it("rejects an empty Electron NativeImage without writing clipboard", async () => {
    const { service, clipboard } = setup({ nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) } });
    await expect(service.copy({ sourceUrl: MANAGED, suggestedName: "image.png" })).rejects.toMatchObject({
      code: "OPERATION_FAILED",
      message: "无法复制此图片。",
    });
    expect(clipboard.writeImage).not.toHaveBeenCalled();
  });

  it("does not write when save dialog is cancelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-image-cancel-")); roots.push(root);
    const { service } = setup({ showSaveDialog: vi.fn(async () => ({ canceled: true })) });
    await expect(service.save({ sourceUrl: MANAGED, suggestedName: "image.png" })).resolves.toEqual({ status: "cancelled" });
    expect(await readdir(root)).toEqual([]);
  });

  it("uses the exact dialog-selected target and does not touch a MIME-extension sibling", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-image-save-")); roots.push(root);
    const selected = join(root, "chosen.txt");
    await writeFile(join(root, "chosen.png"), "existing sibling");
    const rename = vi.fn(async (from: string, to: string) => {
      const fs = await import("node:fs/promises");
      await fs.rename(from, to);
    });
    const { service } = setup({
      showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: selected })),
      rename,
    });

    await expect(service.save({ sourceUrl: MANAGED, suggestedName: "suggested.jpg" })).resolves.toEqual({ status: "completed" });
    expect(await readFile(selected)).toEqual(Buffer.from([1, 2, 3]));
    expect(await readFile(join(root, "chosen.png"), "utf8")).toBe("existing sibling");
    expect(rename).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/u), selected);
    expect(await readdir(root)).toEqual(["chosen.png", "chosen.txt"]);
  });

  it("dispose aborts an in-flight fetch before clipboard side effects", async () => {
    let signal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const { service, clipboard } = setup({ fetch });
    const pending = service.copy({ sourceUrl: MANAGED, suggestedName: "image.png" });
    await vi.waitFor(() => expect(signal).toBeDefined());
    service.dispose();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(signal?.aborted).toBe(true);
    expect(clipboard.writeImage).not.toHaveBeenCalled();
  });

  it("times out before dialog or file writes", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const showSaveDialog = vi.fn(async () => ({ canceled: false, filePath: "/private/never.png" }));
    const { service } = setup({ fetch, showSaveDialog, operationTimeoutMs: 10 });
    const pending = service.save({ sourceUrl: MANAGED, suggestedName: "image.png" });
    const rejected = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(11);
    await rejected;
    expect(showSaveDialog).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("dispose after dialog returns prevents atomic file writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-image-dispose-save-")); roots.push(root);
    const target = join(root, "chosen.png");
    let service!: ReturnType<typeof createImageOperationService>;
    const showSaveDialog = vi.fn(async () => {
      queueMicrotask(() => service.dispose());
      await Promise.resolve();
      return { canceled: false, filePath: target };
    });
    ({ service } = setup({ showSaveDialog }));

    await expect(service.save({ sourceUrl: MANAGED, suggestedName: "image.png" })).rejects.toMatchObject({ code: "CANCELLED" });
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects promptly on dispose and retries temporary cleanup after a delayed write closes", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-image-delayed-write-")); roots.push(root);
    const target = join(root, "chosen.png");
    const fs = await import("node:fs/promises");
    let releaseWrite!: () => void;
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => { writeStarted = resolve; });
    const openFile = vi.fn(async (path: string, flags: string, mode: number) => {
      const handle = await fs.open(path, flags, mode);
      return {
        writeFile: vi.fn(async (contents: Buffer) => {
          writeStarted();
          await new Promise<void>((resolve) => { releaseWrite = resolve; });
          await handle.writeFile(contents);
        }),
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    });
    let unlinkAttempts = 0;
    const unlinkFile = vi.fn(async (path: string) => {
      unlinkAttempts += 1;
      if (unlinkAttempts === 1) throw Object.assign(new Error("file busy"), { code: "EBUSY" });
      await fs.unlink(path);
    });
    const { service } = setup({
      showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: target })),
      openFile,
      unlinkFile,
    });
    const pending = service.save({ sourceUrl: MANAGED, suggestedName: "image.png" });
    const caught = pending.catch((error: unknown) => error);
    await started;
    service.dispose();
    await expect(caught).resolves.toMatchObject({ code: "CANCELLED" });
    expect(await readdir(root)).toEqual([expect.stringMatching(/\.tmp$/u)]);
    releaseWrite();
    await vi.waitFor(async () => expect(await readdir(root)).toEqual([]));
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(unlinkFile).toHaveBeenCalledTimes(2);
  });

  it.each(["timeout", "dispose"])("%s promptly rejects a hung dialog without file writes", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-image-hung-dialog-")); roots.push(root);
    const showSaveDialog = vi.fn(() => new Promise<{ canceled: boolean; filePath?: string }>(() => undefined));
    const { service } = setup({ showSaveDialog, operationTimeoutMs: mode === "timeout" ? 50 : 1_000 });
    const pending = service.save({ sourceUrl: MANAGED, suggestedName: "image.png" });
    const caught = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(showSaveDialog).toHaveBeenCalledOnce());
    if (mode === "dispose") service.dispose();
    await expect(caught).resolves.toMatchObject({ code: mode === "timeout" ? "TIMEOUT" : "CANCELLED" });
    expect(await readdir(root)).toEqual([]);
  });

  it("waits for a delayed rename commit and returns completed when disposed", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-image-rename-commit-")); roots.push(root);
    const target = join(root, "chosen.png");
    let finishRename!: () => void;
    let renameStarted!: () => void;
    const started = new Promise<void>((resolve) => { renameStarted = resolve; });
    const rename = vi.fn((from: string, to: string) => new Promise<void>((resolveRename) => {
      finishRename = async () => {
        const fs = await import("node:fs/promises");
        await fs.rename(from, to);
        resolveRename();
      };
      renameStarted();
    }));
    const { service } = setup({
      showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: target })),
      rename,
    });
    const pending = service.save({ sourceUrl: MANAGED, suggestedName: "image.png" });
    await started;
    service.dispose();
    let settled = false;
    void pending.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishRename();
    await expect(pending).resolves.toEqual({ status: "completed" });
    expect(await readFile(target)).toEqual(Buffer.from([1, 2, 3]));
  });

  it("cleans the temporary file and returns a stable path-free save error", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-image-fail-")); roots.push(root);
    const selected = join(root, "private-name.png");
    const { service } = setup({
      showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: selected })),
      rename: vi.fn(async () => { throw new Error(`cannot rename ${selected} token=gateway-secret`); }),
    });

    await expect(service.save({ sourceUrl: MANAGED, suggestedName: "image.png" })).rejects.toMatchObject({
      code: "DATA_WRITE_FAILED",
      message: "图片保存失败，请重试。",
    });
    expect(await readdir(root)).toEqual([]);
  });
});
