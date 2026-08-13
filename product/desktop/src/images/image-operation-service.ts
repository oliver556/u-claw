import { randomUUID } from "node:crypto";
import { open, rename as renameFile, unlink } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, win32 } from "node:path";

import { ControlledImageSourceUrlSchema, UClawErrorSchema, type UClawError } from "@uclaw/shared";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MANAGED_PATH = /^\/api\/chat\/media\/outgoing\/([^/]+)\/[0-9a-f-]+\/(?:full|preview)$/iu;
const MIME_EXTENSIONS = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/bmp", ".bmp"],
  ["image/avif", ".avif"],
]);

export interface ImageOperationParams {
  sourceUrl: string;
  suggestedName: string;
}

export interface NativeImageLike {
  isEmpty(): boolean;
}

export interface ImageOperationServiceDependencies {
  gatewayOrigin(): string;
  gatewayToken: string;
  fetch(input: string, init: RequestInit): Promise<Response>;
  nativeImage: { createFromBuffer(buffer: Buffer): NativeImageLike };
  clipboard: { writeImage(image: NativeImageLike): void };
  showSaveDialog(options: {
    defaultPath: string;
    filters: Array<{ name: string; extensions: string[] }>;
  }): Promise<{ canceled: boolean; filePath?: string }>;
  dataRoot: string;
  realpath(path: string): Promise<string>;
  operationTimeoutMs?: number;
  openFile?(path: string, flags: string, mode: number): Promise<{
    writeFile(contents: Buffer): Promise<unknown>;
    sync(): Promise<unknown>;
    close(): Promise<unknown>;
  }>;
  unlinkFile?(path: string): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
}

export interface ImageOperationService {
  copy(params: ImageOperationParams): Promise<{ status: "completed" }>;
  save(params: ImageOperationParams): Promise<{ status: "completed" | "cancelled" }>;
  dispose(): void;
}

function error(code: UClawError["code"], message: string, retryable = false): UClawError {
  return UClawErrorSchema.parse({ code, message, retryable, recoveryActions: retryable ? ["retry"] : [], causeDetails: {} });
}

function normalizeMime(value: string | null): string {
  return (value ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

function withMimeExtension(path: string, extension: string): string {
  const current = extname(path);
  return current === extension ? path : `${path.slice(0, current === "" ? path.length : -current.length)}${extension}`;
}

async function readBounded(
  response: Response,
  signal: AbortController,
  raceAbort: <T>(promise: Promise<T>) => Promise<T>,
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    signal.abort();
    throw error("FILE_TOO_LARGE", "图片读取失败，请重试。");
  }
  if (response.body === null) throw error("OPERATION_FAILED", "图片读取失败，请重试。", true);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await raceAbort(reader.read());
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_IMAGE_BYTES) {
        signal.abort();
        await reader.cancel().catch(() => undefined);
        throw error("FILE_TOO_LARGE", "图片读取失败，请重试。");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) throw error("OPERATION_FAILED", "图片读取失败，请重试。", true);
  return Buffer.concat(chunks, size);
}

function isWithin(root: string, target: string, windows: boolean): boolean {
  const pathApi = windows ? win32 : { relative };
  const result = pathApi.relative(root, target);
  return result === "" || (!result.startsWith("..") && !(/^[/\\]/u.test(result)));
}

async function resolveSource(
  sourceUrl: string,
  gatewayOrigin: string,
  dataRoot: string,
  realpathPath: (path: string) => Promise<string>,
  raceAbort: <T>(promise: Promise<T>) => Promise<T>,
): Promise<{ url: string; headers: Record<string, string> }> {
  const parsedSource = ControlledImageSourceUrlSchema.safeParse(sourceUrl);
  if (!parsedSource.success) throw error("INVALID_ARGUMENT", "图片读取失败，请重试。");
  let source: URL;
  let origin: URL;
  try {
    source = new URL(parsedSource.data);
    origin = new URL(gatewayOrigin);
  } catch (caught) {
    if (UClawErrorSchema.safeParse(caught).success) throw caught;
    throw error("INVALID_ARGUMENT", "图片读取失败，请重试。");
  }
  if (
    origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.port === "" ||
    origin.username !== "" || origin.password !== "" || origin.search !== "" || origin.hash !== "" ||
    source.origin !== origin.origin || source.username !== "" || source.password !== "" || source.hash !== ""
  ) {
    throw error("INVALID_ARGUMENT", "图片读取失败，请重试。");
  }
  const managed = MANAGED_PATH.exec(source.pathname);
  if (managed !== null) {
    let sessionKey: string;
    try {
      sessionKey = decodeURIComponent(managed[1]!);
    } catch {
      throw error("INVALID_ARGUMENT", "图片读取失败，请重试。");
    }
    return { url: source.href, headers: { "x-openclaw-requester-session-key": sessionKey } };
  }
  if (source.pathname !== "/__openclaw__/assistant-media") throw error("INVALID_ARGUMENT", "图片读取失败，请重试。");
  const sourcePath = source.searchParams.get("source") ?? "";
  const windows = /^[A-Z]:\\/iu.test(dataRoot);
  if ((windows && /^\\\\/u.test(sourcePath)) || (!windows && (/^[A-Z]:\\/iu.test(sourcePath) || /^\\\\/u.test(sourcePath)))) {
    throw error("INVALID_ARGUMENT", "图片读取失败，请重试。");
  }
  const workspace = windows ? win32.resolve(dataRoot, "workspace") : resolve(dataRoot, "workspace");
  const lexicalSource = windows ? win32.resolve(sourcePath) : resolve(sourcePath);
  if (!isWithin(workspace, lexicalSource, windows)) throw error("INVALID_ARGUMENT", "图片读取失败，请重试。");
  try {
    const [realWorkspace, realSource] = await raceAbort(Promise.all([realpathPath(workspace), realpathPath(lexicalSource)]));
    if (!isWithin(realWorkspace, realSource, windows)) throw new Error("outside workspace");
  } catch (caught) {
    const known = UClawErrorSchema.safeParse(caught);
    if (known.success && (known.data.code === "TIMEOUT" || known.data.code === "CANCELLED")) throw known.data;
    throw error("INVALID_ARGUMENT", "图片读取失败，请重试。");
  }
  return { url: source.href, headers: {} };
}

async function atomicWrite(
  target: string,
  contents: Buffer,
  rename: (from: string, to: string) => Promise<void>,
  assertActive: () => void,
  raceAbort: <T>(promise: Promise<T>) => Promise<T>,
  beginCommit: () => void,
  openFile: NonNullable<ImageOperationServiceDependencies["openFile"]>,
  unlinkFile: NonNullable<ImageOperationServiceDependencies["unlinkFile"]>,
): Promise<void> {
  const temporary = join(dirname(target), `.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof openFile>> | undefined;
  let pendingIo: Promise<unknown> | undefined;
  try {
    assertActive();
    const opening = openFile(temporary, "wx", 0o600);
    pendingIo = opening;
    handle = await raceAbort(opening);
    pendingIo = undefined;
    assertActive();
    const openedHandle = handle;
    pendingIo = openedHandle.writeFile(contents);
    await raceAbort(pendingIo);
    pendingIo = undefined;
    assertActive();
    pendingIo = openedHandle.sync();
    await raceAbort(pendingIo);
    pendingIo = undefined;
    pendingIo = openedHandle.close();
    await raceAbort(pendingIo);
    pendingIo = undefined;
    handle = undefined;
    beginCommit();
    await rename(temporary, target);
  } catch (caught) {
    void (async () => {
      await unlinkFile(temporary).catch(() => undefined);
      await pendingIo?.catch(() => undefined);
      await handle?.close().catch(() => undefined);
      await unlinkFile(temporary).catch(() => undefined);
    })();
    if (UClawErrorSchema.safeParse(caught).success) throw caught;
    throw error("DATA_WRITE_FAILED", "图片保存失败，请重试。", true);
  }
}

export function createImageOperationService(dependencies: ImageOperationServiceDependencies): ImageOperationService {
  const active = new Map<AbortController, "cancelled" | "timeout">();
  let disposed = false;
  const abortError = (reason: "cancelled" | "timeout") => reason === "timeout"
    ? error("TIMEOUT", "图片读取失败，请重试。", true)
    : error("CANCELLED", "图片读取失败，请重试。");
  interface OperationContext {
    controller: AbortController;
    assertActive(): void;
    raceAbort<T>(promise: Promise<T>): Promise<T>;
    beginCommit(): void;
  }
  const run = async <T>(operation: (context: OperationContext) => Promise<T>): Promise<T> => {
    if (disposed) throw abortError("cancelled");
    const controller = new AbortController();
    active.set(controller, "cancelled");
    let committing = false;
    const timeout = setTimeout(() => {
      if (committing) return;
      active.set(controller, "timeout");
      controller.abort();
    }, dependencies.operationTimeoutMs ?? 30_000);
    timeout.unref?.();
    const assertActive = () => {
      if (controller.signal.aborted) throw abortError(active.get(controller) ?? "cancelled");
    };
    const raceAbort = <T>(promise: Promise<T>): Promise<T> => {
      assertActive();
      return new Promise<T>((resolvePromise, rejectPromise) => {
        const onAbort = () => {
          try { assertActive(); } catch (caught) { rejectPromise(caught); }
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
          (value) => { controller.signal.removeEventListener("abort", onAbort); resolvePromise(value); },
          (caught) => { controller.signal.removeEventListener("abort", onAbort); rejectPromise(caught); },
        );
      });
    };
    const beginCommit = () => {
      assertActive();
      committing = true;
      clearTimeout(timeout);
      active.delete(controller);
    };
    try {
      return await operation({ controller, assertActive, raceAbort, beginCommit });
    } finally {
      clearTimeout(timeout);
      active.delete(controller);
    }
  };
  const load = async (params: ImageOperationParams, context: OperationContext): Promise<{ bytes: Buffer; mime: string }> => {
    const { controller, assertActive, raceAbort } = context;
    const resolved = await resolveSource(params.sourceUrl, dependencies.gatewayOrigin(), dependencies.dataRoot, dependencies.realpath, raceAbort);
    assertActive();
    let response: Response;
    try {
      response = await raceAbort(dependencies.fetch(resolved.url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${dependencies.gatewayToken}`, ...resolved.headers },
      }));
    } catch {
      assertActive();
      throw error("OPERATION_FAILED", "图片读取失败，请重试。", true);
    }
    if (response.status < 200 || response.status >= 300) {
      controller.abort();
      throw error("OPERATION_FAILED", "图片读取失败，请重试。", true);
    }
    const mime = normalizeMime(response.headers.get("content-type"));
    if (!MIME_EXTENSIONS.has(mime)) {
      controller.abort();
      throw error("FILE_TYPE_UNSUPPORTED", "图片读取失败，请重试。");
    }
    try {
      return { bytes: await readBounded(response, controller, raceAbort), mime };
    } catch (caught) {
      if (UClawErrorSchema.safeParse(caught).success) throw caught;
      assertActive();
      controller.abort();
      throw error("OPERATION_FAILED", "图片读取失败，请重试。", true);
    }
  };

  return {
    async copy(params) {
      return run(async (context) => {
        const { assertActive } = context;
        const { bytes } = await load(params, context);
        try {
          assertActive();
          const image = dependencies.nativeImage.createFromBuffer(bytes);
          if (image.isEmpty()) throw new Error("empty image");
          assertActive();
          dependencies.clipboard.writeImage(image);
        } catch (caught) {
          if (UClawErrorSchema.safeParse(caught).success) throw caught;
          throw error("OPERATION_FAILED", "无法复制此图片。");
        }
        return { status: "completed" };
      });
    },
    async save(params) {
      return run(async (context) => {
        const { assertActive, raceAbort, beginCommit } = context;
        const { bytes, mime } = await load(params, context);
        const extension = MIME_EXTENSIONS.get(mime)!;
        assertActive();
        const selected = await raceAbort(dependencies.showSaveDialog({
          defaultPath: withMimeExtension(params.suggestedName, extension),
          filters: [{ name: "Image", extensions: [extension.slice(1)] }],
        }));
        assertActive();
        if (selected.canceled || selected.filePath === undefined) return { status: "cancelled" };
        await atomicWrite(
          selected.filePath,
          bytes,
          dependencies.rename ?? renameFile,
          assertActive,
          raceAbort,
          beginCommit,
          dependencies.openFile ?? open,
          dependencies.unlinkFile ?? unlink,
        );
        return { status: "completed" };
      });
    },
    dispose() {
      disposed = true;
      for (const controller of active.keys()) controller.abort();
    },
  };
}
