import { chmod, link, mkdir, mkdtemp, readFile, rename, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createMaintenanceService } from "../src/data/maintenance-service.js";

async function fixture(coordinated = true, hooks: Partial<Parameters<typeof createMaintenanceService>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), "uclaw-maintenance-"));
  const dataDir = join(root, "data");
  const cacheDir = join(root, "cache", "owned");
  await mkdir(join(dataDir, "workspace", "memory"), { recursive: true });
  await mkdir(join(dataDir, ".openclaw", "agents", "main", "sessions"), { recursive: true });
  await mkdir(join(dataDir, "channels"), { recursive: true });
  await mkdir(join(dataDir, "capabilities", "skills"), { recursive: true });
  await mkdir(join(cacheDir, "electron"), { recursive: true });
  await mkdir(join(cacheDir, "temp"), { recursive: true });
  await writeFile(join(root, "cache", ".uclaw-cache.json"), `${JSON.stringify({ schemaVersion: 1, product: "U-Claw", purpose: "rebuildable-cache" })}\n`);
  await writeFile(join(dataDir, "workspace", "MEMORY.md"), "memory-body");
  await writeFile(join(dataDir, "workspace", "notes.txt"), "user-file");
  await writeFile(join(dataDir, ".openclaw", "agents", "main", "sessions", "s1.jsonl"), "session-body");
  await writeFile(join(dataDir, "channels", "channels.json"), "channel-secret");
  await writeFile(join(dataDir, "capabilities", "skills", "index.json"), "skill-state");
  await writeFile(join(cacheDir, "electron", "entry.bin"), "cache-data");
  await writeFile(join(cacheDir, "temp", "download.tmp"), "temporary");
  const service = createMaintenanceService({
    dataDir,
    cacheDir,
    acquireConsistencyLease: coordinated ? async () => ({ release: async () => undefined }) : undefined,
    createId: (() => { let index = 0; return (prefix) => `${prefix}-20260809-${++index}`; })(),
    ...hooks,
  });
  return { root, dataDir, cacheDir, service };
}

async function waitForTerminal(service: ReturnType<typeof createMaintenanceService>, operationId: string) {
  for (let index = 0; index < 100; index += 1) {
    const operation = service.getOperation(operationId);
    if (["completed", "failed", "cancelled", "needs-recovery"].includes(operation.state)) return operation;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("operation timeout");
}

describe("maintenance service", () => {
  it("previews every backup collection without renderer paths or file contents", async () => {
    const { service } = await fixture();
    const preview = await service.previewBackup();
    expect(preview.collections.map((item) => item.id)).toEqual([
      "workspace-user-files", "openclaw-memory", "openclaw-sessions", "uclaw-configuration",
    ]);
    expect(preview.totalFileCount).toBe(5);
    expect(JSON.stringify(preview)).not.toContain("channel-secret");
    expect(JSON.stringify(preview)).not.toMatch(/(?:\/tmp\/|\/Users\/|[A-Za-z]:\\\\)/);
  });

  it("never classifies interrupted data transactions as backup content", async () => {
    const { dataDir, service } = await fixture();
    const transaction = join(dataDir, "workspace", ".uclaw-data-staging", "interrupted");
    await mkdir(transaction, { recursive: true });
    await writeFile(join(transaction, "journal.json"), "sensitive journal");
    await writeFile(join(transaction, "payload"), "staged memory body");
    const preview = await service.previewBackup();
    expect(preview.totalFileCount).toBe(5);
  });

  it("fails closed when runtime cannot provide a global consistency lease", async () => {
    const { service } = await fixture(false);
    expect(() => service.createBackup({ collectionIds: ["openclaw-memory"], trigger: "manual", retainLatest: 3 }))
      .toThrow(expect.objectContaining({ code: "UNAVAILABLE" }));
  });

  it("commits a coordinated backup with manifest hashes and retention metadata", async () => {
    const { dataDir, service } = await fixture();
    const preview = await service.previewBackup(["openclaw-memory", "openclaw-sessions", "uclaw-configuration"]);
    const started = service.createBackup({ collectionIds: ["openclaw-memory", "openclaw-sessions", "uclaw-configuration"], previewToken: preview.previewToken, trigger: "manual", retainLatest: 3 });
    expect(await waitForTerminal(service, started.id)).toMatchObject({ state: "completed", message: "备份已完成。" });
    const backups = await service.listBackups();
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({ state: "ready", trigger: "manual", fileCount: 4 });
    const manifest = JSON.parse(await readFile(join(dataDir, "backups", backups[0]!.id, "manifest.json"), "utf8"));
    expect(manifest.files.every((file: any) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(manifest.files.every((file: any) => !file.id.startsWith("/") && !file.id.includes(".."))).toBe(true);
  });

  it("re-reads staged backup hashes before atomic commit", async () => {
    const { service } = await fixture(true, {
      async beforeBackupCommit(root, stagingId) {
        await root.write(`${stagingId}/files/workspace/MEMORY.md`, "tampered", { overwrite: true });
      },
    });
    const preview = await service.previewBackup(["openclaw-memory"]);
    const started = service.createBackup({ collectionIds: ["openclaw-memory"], previewToken: preview.previewToken, trigger: "manual", retainLatest: 3 });

    expect(await waitForTerminal(service, started.id)).toMatchObject({ state: "failed" });
    expect(await service.listBackups()).toHaveLength(0);
  });

  it("binds the backup preview token to the confirmed retention policy", async () => {
    const { service } = await fixture();
    const preview = await service.previewBackup(["openclaw-memory"]);

    expect(() => service.createBackup({ collectionIds: ["openclaw-memory"], previewToken: preview.previewToken, trigger: "manual", retainLatest: 4 }))
      .toThrow(expect.objectContaining({ code: "CONFLICT" }));
  });

  it("applies automatic retention without deleting manual backups", async () => {
    const { service } = await fixture();
    const create = async (trigger: "manual" | "automatic") => {
      const preview = await service.previewBackup(["openclaw-memory"], trigger, 2);
      const operation = service.createBackup({ collectionIds: ["openclaw-memory"], previewToken: preview.previewToken, trigger, retainLatest: 2 });
      expect(await waitForTerminal(service, operation.id)).toMatchObject({ state: "completed", message: "备份已完成。", partialFailures: 0, failures: [] });
    };
    await create("manual");
    await create("automatic");
    await create("automatic");
    await create("automatic");
    const backups = await service.listBackups();
    expect(backups.filter((backup) => backup.trigger === "manual")).toHaveLength(1);
    expect(backups.filter((backup) => backup.trigger === "automatic")).toHaveLength(2);
    const cleanup = await service.previewCleanup(["backups:expired"]);
    expect(cleanup.totalFileCount).toBe(0);
  });

  it("preflights an expired backup tree before retention deletes any file", async () => {
    const { dataDir, root, service } = await fixture();
    for (let index = 0; index < 3; index += 1) {
      const preview = await service.previewBackup(["openclaw-memory"], "automatic", 3);
      const operation = service.createBackup({ collectionIds: ["openclaw-memory"], previewToken: preview.previewToken, trigger: "automatic", retainLatest: 3 });
      expect(await waitForTerminal(service, operation.id)).toMatchObject({ state: "completed" });
    }
    const oldest = (await service.listBackups()).filter((backup) => backup.trigger === "automatic").at(-1)!;
    await symlink(join(root, "outside"), join(dataDir, "backups", oldest.id, "zzz-link"));
    const preview = await service.previewBackup(["openclaw-memory"], "automatic", 3);
    const operation = service.createBackup({ collectionIds: ["openclaw-memory"], previewToken: preview.previewToken, trigger: "automatic", retainLatest: 3 });
    expect(await waitForTerminal(service, operation.id)).toMatchObject({ state: "completed", partialFailures: 1 });

    expect(await readFile(join(dataDir, "backups", oldest.id, "manifest.json"), "utf8")).toContain(oldest.id);
  });

  it("does not delete a replacement swapped in after retention verification", async () => {
    let expiredId: string | undefined;
    const { dataDir, service } = await fixture(true, {
      async beforeRetentionMove(root, backupId) {
        expiredId = backupId;
        await root.move(`backups/${backupId}`, `backups/${backupId}.original`, { overwrite: true });
        await root.mkdir(`backups/${backupId}`);
        await root.create(`backups/${backupId}/replacement.txt`, "keep replacement");
      },
    });
    for (let index = 0; index < 3; index += 1) {
      const preview = await service.previewBackup(["openclaw-memory"], "automatic", 3);
      const operation = service.createBackup({ collectionIds: ["openclaw-memory"], previewToken: preview.previewToken, trigger: "automatic", retainLatest: 3 });
      expect(await waitForTerminal(service, operation.id)).toMatchObject({ state: "completed" });
    }
    const preview = await service.previewBackup(["openclaw-memory"], "automatic", 3);
    const operation = service.createBackup({ collectionIds: ["openclaw-memory"], previewToken: preview.previewToken, trigger: "automatic", retainLatest: 3 });

    expect(await waitForTerminal(service, operation.id)).toMatchObject({ state: "completed", partialFailures: 1 });
    expect(expiredId).toBeDefined();
    expect(await readFile(join(dataDir, "backups", expiredId!, "replacement.txt"), "utf8")).toBe("keep replacement");
  });

  it("restores only confirmed collections and rolls target state through a journal", async () => {
    const { dataDir, service } = await fixture();
    const backupPreview = await service.previewBackup(["openclaw-memory"]);
    const backup = service.createBackup({ collectionIds: ["openclaw-memory"], previewToken: backupPreview.previewToken, trigger: "manual", retainLatest: 3 });
    expect(await waitForTerminal(service, backup.id)).toMatchObject({ state: "completed", message: "备份已完成。" });
    const backupId = (await service.listBackups())[0]!.id;
    await writeFile(join(dataDir, "workspace", "MEMORY.md"), "changed-memory");

    const restorePreview = await service.previewRestore(backupId, ["openclaw-memory"]);
    expect(restorePreview).toMatchObject({ overwriteFileCount: 1, newFileCount: 0, target: "当前 U 盘数据根" });
    const restore = service.restoreBackup({ backupId, collectionIds: ["openclaw-memory"], previewToken: restorePreview.previewToken });
    expect((await waitForTerminal(service, restore.id)).state).toBe("completed");
    expect(await readFile(join(dataDir, "workspace", "MEMORY.md"), "utf8")).toBe("memory-body");
  });

  it.each([
    { name: "relabeled collection", id: "workspace/MEMORY.md", collection: "workspace-user-files", manifestCollections: ["workspace-user-files"] },
    { name: "backup path", id: "backups/injected.txt", collection: "openclaw-memory", manifestCollections: ["openclaw-memory"] },
    { name: "diagnostics path", id: "diagnostics/injected.txt", collection: "openclaw-memory", manifestCollections: ["openclaw-memory"] },
  ])("rejects a manifest entry outside its declared collection: $name", async ({ id, collection, manifestCollections }) => {
    const { dataDir, service } = await fixture();
    const backupPreview = await service.previewBackup(["openclaw-memory"]);
    const backup = service.createBackup({ collectionIds: ["openclaw-memory"], previewToken: backupPreview.previewToken, trigger: "manual", retainLatest: 3 });
    expect(await waitForTerminal(service, backup.id)).toMatchObject({ state: "completed" });
    const backupId = (await service.listBackups())[0]!.id;
    const manifestPath = join(dataDir, "backups", backupId, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.collections = manifestCollections;
    manifest.files[0].id = id;
    manifest.files[0].collection = collection;
    const backupFile = join(dataDir, "backups", backupId, "files", id);
    await mkdir(dirname(backupFile), { recursive: true });
    await writeFile(backupFile, "memory-body");
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

    await expect(service.previewRestore(backupId, manifestCollections as any)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("preserves files created outside the selected backup snapshot", async () => {
    const { dataDir, service } = await fixture();
    const backupPreview = await service.previewBackup(["openclaw-memory"]);
    const backup = service.createBackup({ collectionIds: ["openclaw-memory"], previewToken: backupPreview.previewToken, trigger: "manual", retainLatest: 3 });
    expect(await waitForTerminal(service, backup.id)).toMatchObject({ state: "completed", message: "备份已完成。" });
    const backupId = (await service.listBackups())[0]!.id;
    const addedAfterBackup = join(dataDir, "workspace", "memory", "after-backup.md");
    await writeFile(addedAfterBackup, "keep-me");

    const restorePreview = await service.previewRestore(backupId, ["openclaw-memory"]);
    const restore = service.restoreBackup({ backupId, collectionIds: ["openclaw-memory"], previewToken: restorePreview.previewToken });
    expect((await waitForTerminal(service, restore.id)).state).toBe("completed");
    expect(await readFile(addedAfterBackup, "utf8")).toBe("keep-me");
  });

  it("rejects a stale restore preview without overwriting current data", async () => {
    const { dataDir, service } = await fixture();
    const backupPreview = await service.previewBackup(["openclaw-memory"]);
    const backup = service.createBackup({ collectionIds: ["openclaw-memory"], previewToken: backupPreview.previewToken, trigger: "manual", retainLatest: 3 });
    await waitForTerminal(service, backup.id);
    const backupId = (await service.listBackups())[0]!.id;
    const restorePreview = await service.previewRestore(backupId, ["openclaw-memory"]);
    await writeFile(join(dataDir, "workspace", "MEMORY.md"), "newer-after-preview");
    const restore = service.restoreBackup({ backupId, collectionIds: ["openclaw-memory"], previewToken: restorePreview.previewToken });
    expect((await waitForTerminal(service, restore.id)).state).toBe("failed");
    expect(await readFile(join(dataDir, "workspace", "MEMORY.md"), "utf8")).toBe("newer-after-preview");
  });

  it("rejects symlinks and hardlinks before backup or cleanup traversal", async () => {
    const linked = await fixture();
    await symlink(join(linked.root, "outside"), join(linked.dataDir, "workspace", "linked"));
    await expect(linked.service.previewBackup()).rejects.toMatchObject({ code: "FORBIDDEN" });

    const hardlinked = await fixture();
    await link(join(hardlinked.cacheDir, "electron", "entry.bin"), join(hardlinked.cacheDir, "electron", "copy.bin"));
    await expect(hardlinked.service.previewCleanup(["cache:electron"])).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a single-file size bomb before backup reads it into memory", async () => {
    const { dataDir, service } = await fixture();
    const oversized = join(dataDir, "workspace", "oversized.bin");
    await writeFile(oversized, "");
    await truncate(oversized, 64 * 1024 * 1024 + 1);

    await expect(service.previewBackup(["workspace-user-files"])).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });

  it("still counts and cleans oversized cache files without reading them into memory", async () => {
    const { cacheDir, service } = await fixture();
    const oversized = join(cacheDir, "electron", "oversized.bin");
    await writeFile(oversized, "");
    await truncate(oversized, 64 * 1024 * 1024 + 1);

    expect(await service.storageStats()).toMatchObject({ state: "available" });
    const preview = await service.previewCleanup(["cache:electron"]);
    expect(preview.totalBytes).toBeGreaterThan(64 * 1024 * 1024);
    const started = service.executeCleanup(["cache:electron"], preview.previewToken);
    expect(await waitForTerminal(service, started.id)).toMatchObject({ state: "completed", partialFailures: 0 });
    await expect(readFile(oversized)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans only rebuildable candidates and preserves durable/user data", async () => {
    const { dataDir, cacheDir, service } = await fixture();
    const preview = await service.previewCleanup(["cache:electron", "cache:temp"]);
    expect(preview.totalFileCount).toBe(2);
    const started = service.executeCleanup(["cache:electron", "cache:temp"], preview.previewToken);
    expect((await waitForTerminal(service, started.id)).state).toBe("completed");
    await expect(readFile(join(cacheDir, "electron", "entry.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(cacheDir, "temp", "download.tmp"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(dataDir, "workspace", "MEMORY.md"), "utf8")).toBe("memory-body");
    expect(await readFile(join(dataDir, "workspace", "notes.txt"), "utf8")).toBe("user-file");
  });

  it("cancels an in-flight backup before committing staged data", async () => {
    const { service } = await fixture();
    const preview = await service.previewBackup(["openclaw-memory"]);
    const started = service.createBackup({ collectionIds: ["openclaw-memory"], previewToken: preview.previewToken, trigger: "manual", retainLatest: 3 });
    service.cancelOperation(started.id);

    expect(await waitForTerminal(service, started.id)).toMatchObject({ state: "cancelled", phase: "cancelled" });
    expect(await service.listBackups()).toHaveLength(0);
  });

  it("reports bounded partial failures when a cleanup file cannot be deleted", async () => {
    const { cacheDir, service } = await fixture();
    const preview = await service.previewCleanup(["cache:electron"]);
    await chmod(join(cacheDir, "electron"), 0o500);
    try {
      const started = service.executeCleanup(["cache:electron"], preview.previewToken);
      expect(await waitForTerminal(service, started.id)).toMatchObject({ state: "completed", partialFailures: 1, failures: [{ candidateId: "cache:electron", code: "DELETE_FAILED" }] });
    } finally {
      await chmod(join(cacheDir, "electron"), 0o700);
    }
  });

  it("quarantines and identity-checks a cleanup target before deleting it", async () => {
    let swapped = false;
    const { cacheDir, service } = await fixture(true, {
      async beforeCleanupMove(root, safeId) {
        if (swapped || !safeId.endsWith("electron/entry.bin")) return;
        swapped = true;
        await root.move(safeId, `${safeId}.original`, { overwrite: false });
        await root.create(safeId, "replacement");
      },
    });
    const preview = await service.previewCleanup(["cache:electron"]);
    const started = service.executeCleanup(["cache:electron"], preview.previewToken);

    expect(await waitForTerminal(service, started.id)).toMatchObject({ state: "failed" });
    expect(await readFile(join(cacheDir, "electron", "entry.bin"), "utf8")).toBe("replacement");
  });

  it("offers only explicitly expired diagnostics and preserves recent logs", async () => {
    const { dataDir, service } = await fixture();
    const logs = join(dataDir, "diagnostics", "desktop-logs");
    await mkdir(logs, { recursive: true });
    const oldLog = join(logs, "old.log");
    const recentLog = join(logs, "recent.log");
    await writeFile(oldLog, "old"); await writeFile(recentLog, "recent");
    await utimes(oldLog, new Date("2025-01-01T00:00:00.000Z"), new Date("2025-01-01T00:00:00.000Z"));
    const preview = await service.previewCleanup(["diagnostics:expired-logs"]);
    expect(preview.totalFileCount).toBe(1);
    const operation = service.executeCleanup(["diagnostics:expired-logs"], preview.previewToken);
    expect((await waitForTerminal(service, operation.id)).state).toBe("completed");
    await expect(readFile(oldLog)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(recentLog, "utf8")).toBe("recent");
  });

  it("reports an interrupted restore journal as a manual recovery state after restart", async () => {
    const { dataDir, cacheDir, service } = await fixture();
    const backupPreview = await service.previewBackup(["openclaw-memory"]);
    const backup = service.createBackup({ collectionIds: ["openclaw-memory"], previewToken: backupPreview.previewToken, trigger: "manual", retainLatest: 3 });
    expect(await waitForTerminal(service, backup.id)).toMatchObject({ state: "completed", message: "备份已完成。" });
    const backupId = (await service.listBackups())[0]!.id;
    await writeFile(join(dataDir, "backups", ".operation-interrupted.restore-journal.json"), `${JSON.stringify({ schemaVersion: 1, operationId: "operation-interrupted", backupId, phase: "prepared" })}\n`);

    const restarted = createMaintenanceService({ dataDir, cacheDir, acquireConsistencyLease: async () => ({ release: async () => undefined }) });
    expect(await restarted.storageStats()).toMatchObject({ state: "damaged" });
    expect((await restarted.listBackups()).find((item) => item.id === backupId)).toMatchObject({ state: "incomplete" });
  });

  it("keeps the restore journal when operation failure and rollback failure combine", async () => {
    let failRestore = false;
    const { dataDir, service } = await fixture(true, {
      async beforeRestoreWrite() {
        if (failRestore) throw new Error("restore write failed");
      },
      async beforeRestoreRollback() { throw new Error("rollback failed"); },
    });
    const backupPreview = await service.previewBackup(["openclaw-memory"]);
    const backup = service.createBackup({ collectionIds: ["openclaw-memory"], previewToken: backupPreview.previewToken, trigger: "manual", retainLatest: 3 });
    expect((await waitForTerminal(service, backup.id)).state).toBe("completed");
    const backupId = (await service.listBackups())[0]!.id;
    await writeFile(join(dataDir, "workspace", "MEMORY.md"), "changed");
    const restorePreview = await service.previewRestore(backupId, ["openclaw-memory"]);
    failRestore = true;
    const restore = service.restoreBackup({ backupId, collectionIds: ["openclaw-memory"], previewToken: restorePreview.previewToken });

    expect(await waitForTerminal(service, restore.id)).toMatchObject({ state: "needs-recovery", phase: "needs-recovery" });
    expect(await service.storageStats()).toMatchObject({ state: "damaged" });
  });

  it("reports orphaned backup staging as a manual recovery state after restart", async () => {
    const { dataDir, cacheDir } = await fixture();
    await mkdir(join(dataDir, "backups", ".backup-interrupted.staging"), { recursive: true });

    const restarted = createMaintenanceService({ dataDir, cacheDir, acquireConsistencyLease: async () => ({ release: async () => undefined }) });
    expect(await restarted.storageStats()).toMatchObject({ state: "damaged" });
    await expect(restarted.assertNoRecoveryState()).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("fails factory reset closed without OpenClaw coordination", async () => {
    const { service } = await fixture(false);
    const preview = await service.previewFactoryReset();
    expect(preview.consistency).toBe("runtime-coordination-required");
    expect(() => service.executeFactoryReset({ previewToken: preview.previewToken }))
      .toThrow(expect.objectContaining({ code: "UNAVAILABLE" }));
  });

  it("releases the consistency lease when the portable data root disappears after acquisition", async () => {
    let dataDir = "";
    const release = vi.fn(async () => undefined);
    const acquired = vi.fn(async () => {
      await rename(dataDir, `${dataDir}-missing`);
      return { release };
    });
    const fixtureState = await fixture(true, { acquireConsistencyLease: acquired });
    dataDir = fixtureState.dataDir;
    const preview = await fixtureState.service.previewFactoryReset();

    const reset = fixtureState.service.executeFactoryReset({ previewToken: preview.previewToken });

    expect(await waitForTerminal(fixtureState.service, reset.id)).toMatchObject({ state: "failed" });
    expect(acquired).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("factory reset deletes only owned state while preserving user files and backups", async () => {
    const { dataDir, cacheDir, service } = await fixture();
    const backupPreview = await service.previewBackup(["openclaw-memory"]);
    const backup = service.createBackup({ collectionIds: ["openclaw-memory"], previewToken: backupPreview.previewToken, trigger: "manual", retainLatest: 3 });
    expect((await waitForTerminal(service, backup.id)).state).toBe("completed");
    const backupId = (await service.listBackups())[0]!.id;

    const preview = await service.previewFactoryReset();
    expect(preview.preserve.map((item) => item.id)).toEqual(["user-files", "backups"]);
    expect(JSON.stringify(preview)).not.toMatch(/(?:\/tmp\/|\/Users\/|[A-Za-z]:\\\\)/);
    const reset = service.executeFactoryReset({ previewToken: preview.previewToken });
    expect((await waitForTerminal(service, reset.id)).state).toBe("completed");

    expect(await readFile(join(dataDir, "workspace", "notes.txt"), "utf8")).toBe("user-file");
    expect(await readFile(join(dataDir, "backups", backupId, "manifest.json"), "utf8")).toContain(backupId);
    await expect(readFile(join(dataDir, "workspace", "MEMORY.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(dataDir, "channels", "channels.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(cacheDir, "electron", "entry.bin"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a stale factory reset preview before deleting anything", async () => {
    const { dataDir, service } = await fixture();
    const preview = await service.previewFactoryReset();
    await writeFile(join(dataDir, "channels", "changed-after-preview.json"), "new-state");
    const reset = service.executeFactoryReset({ previewToken: preview.previewToken });
    expect((await waitForTerminal(service, reset.id)).state).toBe("failed");
    expect(await readFile(join(dataDir, "workspace", "MEMORY.md"), "utf8")).toBe("memory-body");
  });

  it("keeps factory reset recovery state after cancellation", async () => {
    const { dataDir, cacheDir, service } = await fixture();
    const preview = await service.previewFactoryReset();
    const reset = service.executeFactoryReset({ previewToken: preview.previewToken });
    service.cancelOperation(reset.id);

    expect((await waitForTerminal(service, reset.id)).state).toBe("cancelled");
    const restarted = createMaintenanceService({ dataDir, cacheDir, acquireConsistencyLease: async () => ({ release: async () => undefined }) });
    expect(await restarted.storageStats()).toMatchObject({ state: "damaged" });
    await expect(restarted.assertNoRecoveryState()).rejects.toMatchObject({ code: "CONFLICT" });

    const resumePreview = await restarted.previewFactoryReset();
    expect(resumePreview.warnings.join(" ")).toContain("未完成");
    const resumed = restarted.executeFactoryReset({ previewToken: resumePreview.previewToken });
    expect((await waitForTerminal(restarted, resumed.id)).state).toBe("completed");
    expect(await restarted.storageStats()).toMatchObject({ state: "available" });
  });

  it("keeps factory reset recovery state when managed Gateway restart fails", async () => {
    const { dataDir, cacheDir } = await fixture();
    const service = createMaintenanceService({
      dataDir,
      cacheDir,
      acquireConsistencyLease: async () => ({ release: async () => { throw new Error("restart failed"); } }),
    });
    const preview = await service.previewFactoryReset();
    const reset = service.executeFactoryReset({ previewToken: preview.previewToken });

    expect(await waitForTerminal(service, reset.id)).toMatchObject({ state: "needs-recovery", phase: "needs-recovery" });
    expect(await service.storageStats()).toMatchObject({ state: "damaged" });
  });

  it("keeps factory reset recovery state when journal cleanup fails", async () => {
    const { service } = await fixture(true, {
      async beforeFactoryResetJournalCleanup() { throw new Error("journal cleanup failed"); },
    });
    const preview = await service.previewFactoryReset();
    const reset = service.executeFactoryReset({ previewToken: preview.previewToken });

    expect(await waitForTerminal(service, reset.id)).toMatchObject({ state: "needs-recovery", phase: "needs-recovery" });
    expect(await service.storageStats()).toMatchObject({ state: "damaged" });
  });

  it("releases the consistency lease when the portable data root disappears", async () => {
    const { root, dataDir, cacheDir } = await fixture();
    let released = false;
    const service = createMaintenanceService({
      dataDir,
      cacheDir,
      acquireConsistencyLease: async () => {
        await rename(dataDir, join(root, "removed-during-backup"));
        return { release: async () => { released = true; } };
      },
    });
    const preview = await service.previewBackup(["openclaw-memory"]);
    const backup = service.createBackup({ collectionIds: ["openclaw-memory"], previewToken: preview.previewToken, trigger: "manual", retainLatest: 3 });

    expect(await waitForTerminal(service, backup.id)).toMatchObject({ state: "failed" });
    expect(released).toBe(true);
  });

  it("fails factory reset closed when a scanned file changes identity", async () => {
    let swapped = false;
    const { dataDir, service } = await fixture(true, {
      async beforeFactoryResetDelete(root, safeId) {
        if (swapped || !safeId.endsWith("sessions/s1.jsonl")) return;
        swapped = true;
        await root.write(safeId, "replacement", { overwrite: true });
      },
    });
    const preview = await service.previewFactoryReset();
    const reset = service.executeFactoryReset({ previewToken: preview.previewToken });

    expect(await waitForTerminal(service, reset.id)).toMatchObject({ state: "failed", partialFailures: 0 });
    expect(await readFile(join(dataDir, "workspace", "MEMORY.md"), "utf8")).toBe("memory-body");
    expect(await readFile(join(dataDir, "capabilities", "skills", "index.json"), "utf8")).toBe("skill-state");
  });

  it("rejects concurrent maintenance operations", async () => {
    const { service } = await fixture();
    const firstPreview = await service.previewFactoryReset();
    const secondPreview = await service.previewFactoryReset();
    const first = service.executeFactoryReset({ previewToken: firstPreview.previewToken });

    expect(() => service.executeFactoryReset({ previewToken: secondPreview.previewToken }))
      .toThrow(expect.objectContaining({ code: "CONFLICT" }));
    service.cancelOperation(first.id);
    expect((await waitForTerminal(service, first.id)).state).toBe("cancelled");
  });

  it("rejects factory reset recovery after the portable data root is replaced", async () => {
    const { root, dataDir, cacheDir, service } = await fixture();
    const preview = await service.previewFactoryReset();
    const reset = service.executeFactoryReset({ previewToken: preview.previewToken });
    service.cancelOperation(reset.id);
    expect((await waitForTerminal(service, reset.id)).state).toBe("cancelled");

    await rename(dataDir, join(root, "removed-data-root"));
    await mkdir(join(dataDir, "workspace"), { recursive: true });
    await mkdir(join(dataDir, "channels"), { recursive: true });
    await writeFile(join(dataDir, "workspace", "notes.txt"), "different-portable-root");
    await writeFile(join(dataDir, "channels", "channels.json"), "different-channel-state");
    const restarted = createMaintenanceService({ dataDir, cacheDir, acquireConsistencyLease: async () => ({ release: async () => undefined }) });

    await expect(restarted.previewFactoryReset()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(join(dataDir, "channels", "channels.json"), "utf8")).toBe("different-channel-state");
  });
});
