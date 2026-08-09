import { link, mkdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDiagnosticsService } from "../src/diagnostics/diagnostics-service.js";
import { LOG_OWNERSHIP_MANIFEST } from "../src/portable-paths.js";

const logEntry = (id: string, timestamp = "2026-08-09T01:00:00.000Z", level: "debug" | "info" | "warning" | "error" = "info") => ({
  id, timestamp, level, source: "desktop" as const,
  message: "Authorization: Bearer upstream-secret private conversation",
});

function diagnostics(pages: Array<{ items: ReturnType<typeof logEntry>[]; nextCursor: string | null; hasMore: boolean }> = [{ items: [logEntry("upstream-1")], nextCursor: null, hasMore: false }]) {
  let index = 0;
  return { list: async () => [], listLogs: async () => pages[Math.min(index++, pages.length - 1)]! };
}

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "uclaw-diagnostics-"));
  roots.push(root);
  const dataDir = join(root, "data");
  const logsDir = join(dataDir, "diagnostics", "desktop-logs");
  const configPath = join(dataDir, ".openclaw", "openclaw.json");
  await mkdir(logsDir, { recursive: true });
  await mkdir(join(dataDir, ".openclaw"), { recursive: true });
  await writeFile(join(logsDir, ".uclaw-log-ownership.json"), JSON.stringify(LOG_OWNERSHIP_MANIFEST));
  return { root, dataDir, logsDir, configPath };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("diagnostics service", () => {
  it("lists only the existing diagnostics adapter page and projects messages before renderer", async () => {
    const paths = await fixture();
    const upstream = diagnostics([{ items: [logEntry("private-id")], nextCursor: "cursor-2", hasMore: true }]);
    const service = createDiagnosticsService({
      ...paths,
      diagnostics: upstream,
      runtime: { productVersion: "0.1.0", openClawVersion: "2026.7.1-2", gatewayPort: 18789 },
    });
    const response = await service.dispatch({ method: "logs.list", requestId: "list-1", params: { limit: 50 } });
    expect(response.ok).toBe(true);
    if (!response.ok || response.method !== "logs.list") return;
    expect(response.result.items).toHaveLength(1);
    expect(response.result.items[0]).toMatchObject({ timestamp: "2026-08-09T01:00:00.000Z", level: "info", source: "desktop", message: "Desktop info event." });
    expect(response.result.nextCursor).toBe("cursor-2");
    const serialized = JSON.stringify(response);
    expect(serialized).not.toMatch(/upstream-secret|private conversation|private-id/);
  });

  it("deep-redacts nested config and hides unknown fields before renderer and export", async () => {
    const paths = await fixture();
    await writeFile(paths.configPath, JSON.stringify({
      gateway: { port: 18789, status: "ready", auth: { token: "top-secret" } },
      providers: [{ id: "openai", apiKey: "sk-secret-value", headers: { Authorization: "Bearer nested" } }],
      prompt: "private conversation",
      mystery: { harmlessLooking: "must hide by default" },
      cause: { message: "cookie=session-secret", stack: "/Users/alice/private/config.ts:1" },
    }));
    const service = createDiagnosticsService({ ...paths, diagnostics: diagnostics(), runtime: { productVersion: "0.1.0" } });
    const response = await service.dispatch({ method: "config.get", requestId: "config-1", params: { query: "gateway" } });
    expect(response.ok).toBe(true);
    const serialized = JSON.stringify(response);
    expect(serialized).toContain("gateway.port");
    expect(serialized).not.toMatch(/top-secret|sk-secret|Bearer nested|private conversation|must hide|alice|config\.ts/);
    expect(serialized).toContain("[REDACTED]");
    await writeFile(paths.configPath, JSON.stringify({ status: "/Applications/U-Claw/alice/secret", state: "opaque-secret", model: "sk-secret", "sk-proj-key-name-secret": true }));
    const attack = await service.dispatch({ method: "config.get", requestId: "config-attack", params: {} });
    expect(JSON.stringify(attack)).not.toMatch(/Applications|alice|opaque-secret|sk-secret|sk-proj-key-name-secret/);
  });

  it("scans bounded upstream pages for filtered matches and rejects cyclic cursors", async () => {
    const paths = await fixture();
    const upstream = diagnostics([
      { items: [logEntry("one")], nextCursor: "page-2", hasMore: true },
      { items: [logEntry("two", "2026-08-09T01:00:00.000Z", "error")], nextCursor: null, hasMore: false },
    ]);
    const service = createDiagnosticsService({ ...paths, diagnostics: upstream, runtime: { productVersion: "0.1.0" } });
    const filtered = await service.dispatch({ method: "logs.list", requestId: "filtered", params: { limit: 100, levels: ["error"] } });
    expect(filtered).toMatchObject({ ok: true, result: { items: [{ level: "error" }], hasMore: false } });

    const cyclic = createDiagnosticsService({
      ...paths, runtime: { productVersion: "0.1.0" },
      diagnostics: { list: async () => [], listLogs: async () => ({ items: [logEntry("loop")], nextCursor: "same", hasMore: true }) },
    });
    const failed = await cyclic.dispatch({ method: "logs.list", requestId: "cyclic", params: { cursor: "same", limit: 100 } });
    expect(failed).toMatchObject({ ok: false, error: { code: "CONTRACT_INCOMPATIBLE" } });

    const paged = createDiagnosticsService({
      ...paths, runtime: { productVersion: "0.1.0" },
      diagnostics: { list: async () => [], listLogs: async (page) => ({ items: [logEntry("same-upstream-id")], nextCursor: page?.cursor ? null : "page-2", hasMore: !page?.cursor }) },
    });
    const first = await paged.dispatch({ method: "logs.list", requestId: "page-one", params: { limit: 100 } });
    const second = await paged.dispatch({ method: "logs.list", requestId: "page-two", params: { cursor: "page-2", limit: 100 } });
    expect(first.ok && first.method === "logs.list" && second.ok && second.method === "logs.list" && first.result.items[0]?.id).not.toBe(second.ok && second.method === "logs.list" ? second.result.items[0]?.id : undefined);
  });

  it("passes cancellation to the diagnostics adapter and releases the operation", async () => {
    const paths = await fixture();
    let adapterSignal: AbortSignal | undefined;
    const service = createDiagnosticsService({
      ...paths, runtime: { productVersion: "0.1.0" },
      diagnostics: {
        list: async () => [],
        listLogs: async (_page, signal) => {
          adapterSignal = signal;
          return new Promise(() => undefined);
        },
      },
    });
    const pending = service.dispatch({ method: "logs.list", requestId: "cancel-target", params: { limit: 100 } });
    await vi.waitFor(() => expect(adapterSignal).toBeDefined());
    await service.dispatch({ method: "operations.cancel", requestId: "cancel", params: { operationRequestId: "cancel-target" } });
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(adapterSignal?.aborted).toBe(true);
  });

  it("exports without overwrite and leaves source logs unchanged", async () => {
    const paths = await fixture();
    const upstream = diagnostics([
      { items: [logEntry("one")], nextCursor: "page-2", hasMore: true },
      { items: [logEntry("two")], nextCursor: null, hasMore: false },
    ]);
    const service = createDiagnosticsService({ ...paths, diagnostics: upstream, runtime: { productVersion: "0.1.0" } });
    const request = { method: "logs.export" as const, requestId: "export-1", params: { fileName: "diagnostics.jsonl" } };
    const first = await service.dispatch(request);
    const second = await service.dispatch({ ...request, requestId: "export-2" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!first.ok || first.method !== "logs.export") return;
    const exported = await readFile(join(paths.dataDir, first.result.relativePath), "utf8");
    expect(exported).not.toMatch(/secret|conversation|"id":"one"|"id":"two"/);
    expect(exported.trim().split("\n")).toHaveLength(2);
  });

  it("previews then clears only aged owned regular files and rejects link attacks", async () => {
    const paths = await fixture();
    const old = join(paths.logsDir, "uclaw-desktop.log");
    const recent = join(paths.logsDir, "uclaw-gateway.log");
    const outside = join(paths.root, "outside.log");
    await writeFile(old, "old\n");
    await writeFile(recent, "recent\n");
    await writeFile(outside, "outside\n");
    await utimes(old, new Date("2026-07-01T00:00:00Z"), new Date("2026-07-01T00:00:00Z"));
    await symlink(outside, join(paths.logsDir, "uclaw-channel.log"));
    await link(outside, join(paths.logsDir, "uclaw-adapter.log"));
    const service = createDiagnosticsService({ ...paths, diagnostics: diagnostics(), now: () => Date.parse("2026-08-09T00:00:00Z"), runtime: { productVersion: "0.1.0" } });
    const preview = await service.dispatch({ method: "logs.cleanup-preview", requestId: "preview-1", params: { retentionDays: 7 } });
    expect(preview.ok).toBe(true);
    if (!preview.ok || preview.method !== "logs.cleanup-preview") return;
    expect(preview.result.files.map((file) => file.name)).toEqual(["uclaw-desktop.log"]);
    const cleared = await service.dispatch({ method: "logs.cleanup", requestId: "clean-1", params: { previewId: preview.result.previewId, confirm: true } });
    expect(cleared).toMatchObject({ ok: true });
    await expect(readFile(old)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(recent, "utf8")).toBe("recent\n");
    expect(await readFile(outside, "utf8")).toBe("outside\n");
  });

  it("returns copied system values without user paths, unique IDs, or proxy credentials", async () => {
    const paths = await fixture();
    const service = createDiagnosticsService({
      ...paths,
      diagnostics: diagnostics(),
      environment: { HTTPS_PROXY: "http://alice:password@proxy.example:8080" },
      runtime: { productVersion: "0.1.0 /Applications/alice", openClawVersion: "token-secret", gatewayPort: 18789, gatewayStatus: "ready" },
    });
    const response = await service.dispatch({ method: "system.get", requestId: "system-1", params: {} });
    expect(response.ok).toBe(true);
    const serialized = JSON.stringify(response);
    expect(serialized).toContain("已配置（值已隐藏）");
    expect(serialized).not.toMatch(/alice|password|Users|Volumes|deviceId|machineId/);
    expect(serialized).not.toContain("token-secret");
    expect(serialized).toContain("unknown");
  });
});
