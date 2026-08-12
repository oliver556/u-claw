import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMaintenanceService } from "../../desktop/src/data/maintenance-service.js";
import { createDiagnosticsService } from "../../desktop/src/diagnostics/diagnostics-service.js";
import { LOG_OWNERSHIP_MANIFEST, resolvePortableDesktopPaths } from "../../desktop/src/portable-paths.js";
import { createProductionReleaseService } from "../../desktop/src/release/production-release.js";

const roots: string[] = [];

async function portableFixture() {
  const root = await mkdtemp(join(tmpdir(), "uclaw-system-real-"));
  roots.push(root);
  const dataDir = join(root, "usb", ".uclaw", "data");
  const cacheParent = join(root, "host-cache");
  const cacheDir = join(cacheParent, "owned");
  const paths = resolvePortableDesktopPaths(dataDir, cacheDir);
  await mkdir(join(dataDir, "workspace", "memory"), { recursive: true });
  await mkdir(join(dataDir, ".openclaw", "agents", "main", "sessions"), { recursive: true });
  await mkdir(join(dataDir, "channels"), { recursive: true });
  await mkdir(join(dataDir, "capabilities", "skills"), { recursive: true });
  await mkdir(join(cacheDir, "electron"), { recursive: true });
  await mkdir(join(cacheDir, "temp"), { recursive: true });
  await mkdir(paths.logs, { recursive: true });
  await writeFile(join(cacheParent, ".uclaw-cache.json"), `${JSON.stringify({ schemaVersion: 1, product: "U-Claw", purpose: "rebuildable-cache" })}\n`);
  await writeFile(join(paths.logs, ".uclaw-log-ownership.json"), JSON.stringify(LOG_OWNERSHIP_MANIFEST));
  await writeFile(join(dataDir, "workspace", "MEMORY.md"), "authoritative-memory");
  await writeFile(join(dataDir, "workspace", "notes.txt"), "preserved-user-file");
  await writeFile(join(dataDir, ".openclaw", "agents", "main", "sessions", "s1.jsonl"), "session");
  await writeFile(join(dataDir, "channels", "channels.json"), "owned-channel-state");
  await writeFile(join(dataDir, "capabilities", "skills", "index.json"), "owned-skill-state");
  await writeFile(join(cacheDir, "electron", "entry.bin"), "cache");
  await writeFile(join(cacheDir, "temp", "download.tmp"), "temporary");
  return { root, dataDir, cacheDir, paths };
}

function maintenance(dataDir: string, cacheDir: string) {
  return createMaintenanceService({
    dataDir,
    cacheDir,
    acquireConsistencyLease: async () => ({ release: async () => undefined }),
  });
}

async function waitForTerminal(service: ReturnType<typeof createMaintenanceService>, operationId: string) {
  for (let index = 0; index < 200; index += 1) {
    const operation = service.getOperation(operationId);
    if (["completed", "failed", "cancelled", "needs-recovery"].includes(operation.state)) return operation;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("maintenance operation timeout");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("advanced system production wiring", () => {
  it("re-reads appended OpenClaw, Desktop, Launcher logs and redacted config after service recreation", async () => {
    const fixture = await portableFixture();
    await writeFile(join(fixture.paths.logs, "uclaw-desktop.log"), "desktop credential material\n");
    await writeFile(join(fixture.paths.logs, "uclaw-launcher.log"), "launcher credential material\n");
    const diagnostics = {
      list: async () => [],
      listLogs: async () => ({
        items: [{ id: "private-openclaw-id", timestamp: "2026-08-12T01:00:00.000Z", level: "warning" as const, source: "openclaw" as const, message: "Bearer openclaw-secret" }],
        nextCursor: null,
        hasMore: false,
      }),
      config: async () => ({ gateway: { port: 18789, token: "config-secret" }, providers: [{ apiKey: "provider-secret" }] }),
    };
    const servicePaths = { dataDir: fixture.dataDir, logsDir: fixture.paths.logs, configPath: fixture.paths.openClawConfig };
    let service = createDiagnosticsService({ ...servicePaths, diagnostics, runtime: { productVersion: "0.1.0" } });
    await expect(service.dispatch({ method: "logs.list", requestId: "before", params: { limit: 100 } })).resolves.toMatchObject({
      ok: true,
      result: { items: expect.arrayContaining([expect.objectContaining({ source: "openclaw" }), expect.objectContaining({ source: "desktop" }), expect.objectContaining({ source: "launcher" })]) },
    });
    await writeFile(join(fixture.paths.logs, "uclaw-launcher.log"), "launcher credential material\nsecond credential material\n");

    service = createDiagnosticsService({ ...servicePaths, diagnostics, runtime: { productVersion: "0.1.0" } });
    const logs = await service.dispatch({ method: "logs.list", requestId: "after-restart", params: { limit: 100, sources: ["launcher"] } });
    expect(logs).toMatchObject({ ok: true, result: { items: [expect.any(Object), expect.any(Object)] } });
    const config = await service.dispatch({ method: "config.get", requestId: "config", params: {} });
    const exported = await service.dispatch({ method: "logs.export", requestId: "export", params: { fileName: "system-real.jsonl" } });
    expect(exported.ok).toBe(true);
    const exportText = exported.ok && exported.method === "logs.export" ? await readFile(join(fixture.dataDir, exported.result.relativePath), "utf8") : "";
    expect(`${JSON.stringify(logs)}${JSON.stringify(config)}${exportText}`).not.toMatch(/credential material|openclaw-secret|config-secret|provider-secret|private-openclaw-id/);
  });

  it("persists backup retention and restore, then performs controlled cleanup and factory reset", async () => {
    const fixture = await portableFixture();
    let service = maintenance(fixture.dataDir, fixture.cacheDir);
    for (let index = 0; index < 3; index += 1) {
      const preview = await service.previewBackup(["openclaw-memory"], "automatic", 2);
      const operation = service.createBackup({ collectionIds: ["openclaw-memory"], previewToken: preview.previewToken, trigger: "automatic", retainLatest: 2 });
      expect(await waitForTerminal(service, operation.id)).toMatchObject({ state: "completed" });
    }

    service = maintenance(fixture.dataDir, fixture.cacheDir);
    const backups = await service.listBackups();
    expect(backups).toHaveLength(2);
    await writeFile(join(fixture.dataDir, "workspace", "MEMORY.md"), "changed-after-backup");
    const restorePreview = await service.previewRestore(backups[0]!.id, ["openclaw-memory"]);
    const restore = service.restoreBackup({ backupId: backups[0]!.id, collectionIds: ["openclaw-memory"], previewToken: restorePreview.previewToken });
    expect(await waitForTerminal(service, restore.id)).toMatchObject({ state: "completed" });
    expect(await readFile(join(fixture.dataDir, "workspace", "MEMORY.md"), "utf8")).toBe("authoritative-memory");

    expect(await service.storageStats()).toMatchObject({ state: "available", categories: expect.arrayContaining([expect.objectContaining({ id: "cache", fileCount: 1 })]) });
    const cleanupPreview = await service.previewCleanup(["cache:electron", "cache:temp"]);
    const cleanup = service.executeCleanup(["cache:electron", "cache:temp"], cleanupPreview.previewToken);
    expect(await waitForTerminal(service, cleanup.id)).toMatchObject({ state: "completed", partialFailures: 0 });

    service = maintenance(fixture.dataDir, fixture.cacheDir);
    const resetPreview = await service.previewFactoryReset();
    const reset = service.executeFactoryReset({ previewToken: resetPreview.previewToken });
    expect(await waitForTerminal(service, reset.id)).toMatchObject({ state: "completed" });
    expect(await readFile(join(fixture.dataDir, "workspace", "notes.txt"), "utf8")).toBe("preserved-user-file");
    expect(await service.listBackups()).toHaveLength(2);
    await expect(readFile(join(fixture.dataDir, "workspace", "MEMORY.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed before network when formal release feed and trust root are absent", async () => {
    const fixture = await portableFixture();
    const fetchImpl = vi.fn();
    const release = createProductionReleaseService(fixture.paths, {}, fetchImpl);
    await expect(release.check("stable")).resolves.toMatchObject({ state: "unavailable", retryable: false, message: "发布更新配置缺失。" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
