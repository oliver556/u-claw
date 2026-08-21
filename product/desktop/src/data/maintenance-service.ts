import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath, statfs } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { FsSafeError, root as createSafeRoot, type Root } from "@openclaw/fs-safe";
import {
  CleanupPreviewSchema,
  DATA_ROOT_CONTRACT,
  FactoryResetPreviewSchema,
  MaintenanceOperationSchema,
  RelativeDomainIdSchema,
  RestorePreviewSchema,
  StorageStatsSchema,
  UClawErrorSchema,
  type BackupCollectionId,
  type BackupPreview,
  type BackupSummary,
  type CleanupCandidateId,
  type CleanupPreview,
  type FactoryResetPreview,
  type MaintenanceOperation,
  type RestorePreview,
  type StorageStats,
  type UClawError,
} from "@uclaw/shared";

const MAX_FILES = 50_000;
const MAX_BYTES = 200 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 10 * 1024 * 1024;
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const BACKUP_COLLECTIONS = DATA_ROOT_CONTRACT.backupSets;
const COLLECTION_LABELS: Record<BackupCollectionId, string> = {
  "workspace-user-files": "用户文件",
  "openclaw-memory": "记忆",
  "openclaw-sessions": "会话",
  "uclaw-configuration": "配置、skills/plugins/MCP 与渠道",
};
const CLEANUP_LABELS: Record<CleanupCandidateId, string> = {
  "cache:electron": "Electron 可重建缓存",
  "cache:node-compile": "Node 编译缓存",
  "cache:temp": "临时与下载文件",
  "diagnostics:expired-logs": "过期桌面日志",
  "diagnostics:expired-crash-dumps": "过期崩溃转储",
  "backups:expired": "保留策略外旧备份",
};

interface InventoryFile { id: string; safeId: string; safeRoot: Root; size: number; dev: number; ino: number; mtimeMs: number; collection?: BackupCollectionId }
interface PreviewRecord { kind: "backup" | "cleanup" | "restore" | "factory-reset"; ids: string[]; fingerprint: string; expiresAt: number; backupId?: string; policy?: string }
interface ConsistencyLease { release(): Promise<void> }
interface MaintenanceOptions {
  dataDir: string;
  cacheDir: string;
  acquireConsistencyLease?(signal?: AbortSignal): Promise<ConsistencyLease>;
  beforeBackupCommit?(root: Root, stagingId: string): Promise<void>;
  beforeCleanupMove?(root: Root, safeId: string): Promise<void>;
  beforeFactoryResetDelete?(root: Root, safeId: string): Promise<void>;
  beforeFactoryResetJournalCleanup?(root: Root, journalId: string): Promise<void>;
  beforeRestoreWrite?(root: Root, safeId: string): Promise<void>;
  beforeRestoreRollback?(root: Root): Promise<void>;
  beforeRetentionMove?(root: Root, backupId: string): Promise<void>;
  createId?(prefix: "backup" | "operation" | "preview"): string;
  now?(): Date;
  runMutation?<T>(operation: () => Promise<T>): Promise<T>;
}
interface BackupManifest {
  schemaVersion: 1; id: string; createdAt: string; trigger: "manual" | "automatic"; retainLatest: number;
  collections: BackupCollectionId[]; files: Array<{ id: string; size: number; sha256: string; collection: BackupCollectionId }>;
}

function safeError(code: UClawError["code"], message: string, retryable = false): UClawError {
  return UClawErrorSchema.parse({ code, message, retryable, recoveryActions: retryable ? ["retry"] : [], causeDetails: {} });
}

function isWithin(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return candidate === "" || (!candidate.startsWith(`..${sep}`) && candidate !== ".." && !isAbsolute(candidate));
}

function fingerprint(files: InventoryFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file.id}\0${file.size}\0${file.dev}\0${file.ino}\0${file.mtimeMs}\n`);
  return hash.digest("hex");
}

function classifyDataId(id: string): BackupCollectionId | undefined {
  const lower = id.toLocaleLowerCase("en-US");
  if (lower === "workspace/memory.md" || (lower.startsWith("workspace/memory/") && lower.endsWith(".md"))) return "openclaw-memory";
  if (lower.startsWith(".openclaw/agents/")) return "openclaw-sessions";
  if (lower.startsWith("workspace/")) {
    const first = lower.slice("workspace/".length).split("/")[0] ?? "";
    if (first === ".uclaw-data-staging") return undefined;
    if (["agents.md", "soul.md", "tools.md", "identity.md", "user.md", "heartbeat.md", "bootstrap.md", "dreams.md", ".openclaw"].includes(first)) return "uclaw-configuration";
    return "workspace-user-files";
  }
  if (lower === "backups" || lower.startsWith("backups/") || lower === "diagnostics" || lower.startsWith("diagnostics/")) return undefined;
  if (lower.startsWith(".openclaw/") || ["desktop", "capabilities", "channels", "mcp", "providers", "uclaw"].some((root) => lower === root || lower.startsWith(`${root}/`))) return "uclaw-configuration";
  return undefined;
}

async function assertRoot(path: string, label: string): Promise<string> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw safeError("USB_MISSING", `${label}离线。`, true);
    throw error;
  });
  if (!info.isDirectory() || info.isSymbolicLink()) throw safeError("FORBIDDEN", `${label}根不安全。`);
  return realpath(path);
}

async function pinnedRoot(rootPath: string, label: string): Promise<Root> {
  const rootReal = await assertRoot(rootPath, label);
  const safeRoot = await createSafeRoot(rootPath, { hardlinks: "reject", maxBytes: MAX_FILE_BYTES, mkdir: true, mode: 0o600, symlinks: "reject" });
  if (safeRoot.rootReal !== rootReal) throw safeError("FORBIDDEN", "数据根在扫描前发生变化。");
  return safeRoot;
}

async function scanPinned(safeRoot: Root, baseId = "", classify?: (id: string) => BackupCollectionId | undefined, excludeBackups = false, maxFileBytes?: number): Promise<InventoryFile[]> {
  const files: InventoryFile[] = [];
  let bytes = 0;
  const walk = async (safeParentId: string): Promise<void> => {
    const entries = await safeRoot.list(safeParentId || ".", { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const safeId = safeParentId ? `${safeParentId}/${entry.name}` : entry.name;
      const id = baseId ? safeId.slice(baseId.length + 1) : safeId;
      if (excludeBackups && (safeId === "backups" || safeId.startsWith("backups/"))) continue;
      if (entry.isSymbolicLink) throw safeError("FORBIDDEN", "拒绝链接数据对象。");
      if (entry.isDirectory) { await walk(safeId); continue; }
      if (entry.nlink > 1) throw safeError("FORBIDDEN", "拒绝链接数据对象。");
      if (!entry.isFile) throw safeError("FORBIDDEN", "拒绝特殊数据对象。");
      if (maxFileBytes !== undefined && entry.size > maxFileBytes) throw safeError("FILE_TOO_LARGE", "单个数据文件超过安全读取上限。");
      const collection = classify?.(id);
      if (classify && collection === undefined) continue;
      files.push({ id, safeId, safeRoot, size: entry.size, dev: entry.dev, ino: entry.ino, mtimeMs: Math.trunc(entry.mtimeMs), collection });
      bytes += entry.size;
      if (files.length > MAX_FILES || bytes > MAX_BYTES) throw safeError("FILE_TOO_LARGE", "数据集合超过安全扫描上限。");
    }
  };
  await walk(baseId);
  return files;
}

async function scan(rootPath: string, label: string, classify?: (id: string) => BackupCollectionId | undefined, excludeBackups = false, maxFileBytes?: number): Promise<InventoryFile[]> {
  return scanPinned(await pinnedRoot(rootPath, label), "", classify, excludeBackups, maxFileBytes);
}

async function safeRead(file: InventoryFile): Promise<Buffer> {
  const current = await file.safeRoot.read(file.safeId, { hardlinks: "reject", maxBytes: MAX_FILE_BYTES, symlinks: "reject" });
  if (current.stat.dev !== file.dev || current.stat.ino !== file.ino || current.stat.size !== file.size || Math.trunc(current.stat.mtimeMs) !== file.mtimeMs) throw safeError("CONFLICT", "数据在预览后发生变化，请重新预览。", true);
  return current.buffer;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync().catch((error: NodeJS.ErrnoException) => {
      if (
        process.platform !== "win32" ||
        !["EINVAL", "ENOTSUP", "EPERM"].includes(error.code ?? "")
      ) throw error;
    });
  } finally { await handle.close(); }
}

async function removeTree(safeRoot: Root, safeId: string): Promise<void> {
  const files: string[] = [];
  const directories: string[] = [];
  const inventory = async (directoryId: string): Promise<void> => {
    const entries = await safeRoot.list(directoryId, { withFileTypes: true });
    for (const entry of entries) {
      const childId = `${directoryId}/${entry.name}`;
      if (entry.isSymbolicLink || (entry.isFile && entry.nlink > 1) || (!entry.isFile && !entry.isDirectory)) throw safeError("FORBIDDEN", "拒绝清理链接或特殊对象。");
      if (entry.isDirectory) await inventory(childId);
      else files.push(childId);
    }
    directories.push(directoryId);
  };
  await inventory(safeId);
  for (const fileId of files) await safeRoot.remove(fileId);
  for (const directoryId of directories) await safeRoot.remove(directoryId);
}

async function pruneEmptyTree(safeRoot: Root, safeId: string): Promise<void> {
  const entries = await safeRoot.list(safeId, { withFileTypes: true });
  for (const entry of entries) if (entry.isDirectory && !entry.isSymbolicLink) await pruneEmptyTree(safeRoot, `${safeId}/${entry.name}`);
  if ((await safeRoot.list(safeId)).length === 0) await safeRoot.remove(safeId);
}

function cloneOperation(operation: MaintenanceOperation): MaintenanceOperation {
  return MaintenanceOperationSchema.parse({ ...operation });
}

export function createMaintenanceService(options: MaintenanceOptions) {
  if (!isAbsolute(options.dataDir) || !isAbsolute(options.cacheDir)) throw new Error("Maintenance roots must be absolute.");
  const dataDir = resolve(options.dataDir);
  const cacheDir = resolve(options.cacheDir);
  if (isWithin(dataDir, cacheDir) || isWithin(cacheDir, dataDir)) throw new Error("Maintenance roots must not overlap.");
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? ((prefix) => `${prefix}-${randomUUID().toLowerCase()}`);
  const previews = new Map<string, PreviewRecord>();
  const operations = new Map<string, MaintenanceOperation>();
  const controllers = new Map<string, AbortController>();
  const activeArtifacts = new Set<string>();

  const rememberPreview = (record: Omit<PreviewRecord, "expiresAt">): string => {
    const id = createId("preview");
    previews.set(id, { ...record, expiresAt: Date.now() + PREVIEW_TTL_MS });
    return id;
  };
  const requirePreview = (token: string, kind: PreviewRecord["kind"], ids: string[], policy?: string): PreviewRecord => {
    const preview = previews.get(token);
    if (!preview || preview.kind !== kind || preview.expiresAt < Date.now() || preview.policy !== policy || JSON.stringify(preview.ids) !== JSON.stringify([...ids].sort())) {
      throw safeError("CONFLICT", "预览已过期或选择已变化，请重新预览。", true);
    }
    previews.delete(token);
    return preview;
  };
  const dataInventory = async (collections: BackupCollectionId[]): Promise<InventoryFile[]> =>
    (await scan(dataDir, "U 盘数据", classifyDataId, true, MAX_FILE_BYTES)).filter((file) => file.collection && collections.includes(file.collection));
  const ownedCacheRoot = async (): Promise<{ root: Root; baseId: string; dev: number; ino: number }> => {
    const cacheParent = await pinnedRoot(dirname(cacheDir), "缓存目录");
    const markerId = ".uclaw-cache.json";
    const info = await cacheParent.stat(markerId).catch(() => undefined);
    if (!info || !info.isFile || info.isSymbolicLink || info.nlink > 1 || info.size > 1024 * 1024) throw safeError("FORBIDDEN", "缓存所有权标记无效。");
    const marker = JSON.parse(await cacheParent.readText(markerId, { hardlinks: "reject", maxBytes: 1024 * 1024, symlinks: "reject" })) as Record<string, unknown>;
    if (marker.schemaVersion !== 1 || marker.product !== "U-Claw" || marker.purpose !== "rebuildable-cache") throw safeError("FORBIDDEN", "缓存所有权标记无效。");
    const cacheEntry = await cacheParent.stat(basename(cacheDir));
    if (!cacheEntry.isDirectory || cacheEntry.isSymbolicLink) throw safeError("FORBIDDEN", "缓存根不安全。");
    return { root: cacheParent, baseId: basename(cacheDir), dev: cacheEntry.dev, ino: cacheEntry.ino };
  };
  const assertOwnedCacheIdentity = async (cache: Awaited<ReturnType<typeof ownedCacheRoot>>): Promise<void> => {
    const current = await cache.root.stat(cache.baseId);
    if (!current.isDirectory || current.isSymbolicLink || current.dev !== cache.dev || current.ino !== cache.ino) throw safeError("CONFLICT", "缓存根在操作期间发生变化。", true);
  };

  const previewBackup = async (requested: BackupCollectionId[] = [...BACKUP_COLLECTIONS], trigger: "manual" | "automatic" = "manual", retainLatest = 3): Promise<BackupPreview> => {
    const collections = [...new Set(requested)] as BackupCollectionId[];
    const files = await dataInventory(collections);
    const summaries = collections.map((id) => {
      const selected = files.filter((file) => file.collection === id);
      const bytes = selected.reduce((sum, file) => sum + file.size, 0);
      return { id, label: COLLECTION_LABELS[id], fileCount: selected.length, bytes, risk: id === "workspace-user-files" ? (bytes > 1024 * 1024 * 1024 ? "large" as const : "normal" as const) : "sensitive" as const };
    });
    return {
      previewToken: rememberPreview({ kind: "backup", ids: [...collections].sort(), fingerprint: fingerprint(files), policy: `${trigger}:${retainLatest}` }),
      target: "当前 U 盘受控备份区", consistency: options.acquireConsistencyLease ? "coordinated" : "runtime-coordination-required",
      trigger, retainLatest,
      collections: summaries, totalFileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      warnings: [options.acquireConsistencyLease ? "创建时将暂停跨域写入并获取一致性快照。" : "当前 runtime 无全局 snapshot/CAS，创建将安全拒绝。"],
    };
  };

  const startOperation = (kind: MaintenanceOperation["kind"], totalFiles: number, totalBytes: number, task: (operation: MaintenanceOperation, signal: AbortSignal) => Promise<void>): MaintenanceOperation => {
    if ([...operations.values()].some((operation) => operation.state === "queued" || operation.state === "running")) {
      throw safeError("CONFLICT", "已有维护操作正在执行，请等待完成。", true);
    }
    const id = createId("operation");
    const operation = MaintenanceOperationSchema.parse({ id, kind, state: "queued", phase: "queued", processedFiles: 0, totalFiles, processedBytes: 0, totalBytes, partialFailures: 0, failures: [], message: "操作已排队。" });
    const controller = new AbortController();
    operations.set(id, operation); controllers.set(id, controller);
    void task(operation, controller.signal).catch((caught) => {
      if (operation.state === "cancelled" || operation.state === "needs-recovery") return;
      operation.state = "failed"; operation.phase = "failed";
      operation.message = UClawErrorSchema.safeParse(caught).success
        ? (caught as UClawError).message
        : caught instanceof FsSafeError ? `受控文件系统拒绝操作（${caught.code}）。` : "操作失败。";
    }).finally(() => controllers.delete(id));
    return cloneOperation(operation);
  };

  const createBackup = (input: { collectionIds: BackupCollectionId[]; previewToken?: string; trigger: "manual" | "automatic"; retainLatest: number }): MaintenanceOperation => {
    if (!options.acquireConsistencyLease) throw safeError("UNAVAILABLE", "OpenClaw runtime 无全局 snapshot/CAS，拒绝不一致热备份。");
    const collections = [...new Set(input.collectionIds)].sort() as BackupCollectionId[];
    const preview = requirePreview(input.previewToken ?? "", "backup", collections, `${input.trigger}:${input.retainLatest}`);
    return startOperation("backup", 0, 0, async (operation, signal) => {
      await assertNoRecoveryState();
      operation.state = "running"; operation.phase = "coordinating"; operation.message = "正在协调 runtime 一致性快照。";
      const lease = await options.acquireConsistencyLease!(signal);
      const backupId = createId("backup");
      const stagingId = `backups/.${backupId}.staging`;
      const targetId = `backups/${backupId}`;
      activeArtifacts.add(basename(stagingId));
      let dataRoot: Root | undefined;
      try {
        dataRoot = await pinnedRoot(dataDir, "U 盘数据");
        await dataRoot.mkdir("backups");
        if (await dataRoot.exists(targetId)) throw safeError("CONFLICT", "备份 ID 已存在，请重试。", true);
        await dataRoot.mkdir(stagingId);
        await dataRoot.mkdir(`${stagingId}/files`);
        const files = await dataInventory(collections);
        if (fingerprint(files) !== preview.fingerprint) throw safeError("CONFLICT", "数据在预览后发生变化，请重新预览。", true);
        operation.totalFiles = files.length; operation.totalBytes = files.reduce((sum, file) => sum + file.size, 0);
        operation.phase = "staging"; operation.message = "正在写入同目录暂存区。";
        const manifestFiles: BackupManifest["files"] = [];
        for (const file of files) {
          if (signal.aborted) throw safeError("CANCELLED", "备份已取消。");
          const buffer = await safeRead(file);
          await dataRoot.create(`${stagingId}/files/${file.id}`, buffer, { mkdir: true, mode: 0o600 });
          manifestFiles.push({ id: file.id, size: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex"), collection: file.collection! });
          operation.processedFiles += 1; operation.processedBytes += buffer.length;
        }
        operation.phase = "verifying"; operation.message = "正在校验 manifest 与文件哈希。";
        const manifest: BackupManifest = { schemaVersion: 1, id: backupId, createdAt: now().toISOString(), trigger: input.trigger, retainLatest: input.retainLatest, collections, files: manifestFiles };
        const serializedManifest = `${JSON.stringify(manifest)}\n`;
        if (Buffer.byteLength(serializedManifest) > MANIFEST_MAX_BYTES) throw safeError("FILE_TOO_LARGE", "备份 manifest 超过安全上限。");
        await dataRoot.create(`${stagingId}/manifest.json`, serializedManifest, { mkdir: true, mode: 0o600 });
        await options.beforeBackupCommit?.(dataRoot, stagingId);
        const stagedManifest = await readManifest(dataRoot, backupId, stagingId).catch(() => { throw safeError("CONFLICT", "暂存备份 manifest 已损坏。"); });
        if (JSON.stringify(stagedManifest) !== JSON.stringify(manifest)) throw safeError("CONFLICT", "暂存备份 manifest 在提交前发生变化。");
        const rootEntries = await dataRoot.list(stagingId, { withFileTypes: true });
        if (rootEntries.length !== 2 || !rootEntries.some((entry) => entry.name === "manifest.json" && entry.isFile && !entry.isSymbolicLink && entry.nlink === 1) || !rootEntries.some((entry) => entry.name === "files" && entry.isDirectory && !entry.isSymbolicLink)) {
          throw safeError("CONFLICT", "暂存备份目录结构已损坏。");
        }
        const expectedFiles = new Map(manifest.files.map((entry) => [entry.id, entry]));
        const expectedDirectories = new Set<string>();
        for (const id of expectedFiles.keys()) {
          const parts = id.split("/");
          for (let index = 1; index < parts.length; index += 1) expectedDirectories.add(parts.slice(0, index).join("/"));
        }
        const verifyDirectoryTree = async (parentId: string, relativeParent = ""): Promise<void> => {
          for (const entry of await dataRoot!.list(parentId, { withFileTypes: true })) {
            const relativeId = relativeParent ? `${relativeParent}/${entry.name}` : entry.name;
            if (entry.isSymbolicLink || (entry.isFile && entry.nlink > 1) || (!entry.isFile && !entry.isDirectory)) throw safeError("CONFLICT", "暂存备份目录结构已损坏。");
            if (entry.isDirectory) {
              if (!expectedDirectories.has(relativeId)) throw safeError("CONFLICT", "暂存备份含未声明目录。");
              await verifyDirectoryTree(`${parentId}/${entry.name}`, relativeId);
            } else if (!expectedFiles.has(relativeId)) throw safeError("CONFLICT", "暂存备份含未声明文件。");
          }
        };
        await verifyDirectoryTree(`${stagingId}/files`);
        const stagedFiles = await scanPinned(dataRoot, `${stagingId}/files`);
        if (stagedFiles.length !== expectedFiles.size) throw safeError("CONFLICT", "暂存备份文件集合已变化。");
        for (const staged of stagedFiles) {
          const entry = expectedFiles.get(staged.id);
          if (!entry || staged.size !== entry.size) throw safeError("CONFLICT", "暂存备份文件集合已变化。");
          const buffer = await safeRead(staged);
          if (createHash("sha256").update(buffer).digest("hex") !== entry.sha256) throw safeError("CONFLICT", "暂存备份哈希校验失败。");
        }
        for (const directory of expectedDirectories) {
          const info = await dataRoot.stat(`${stagingId}/files/${directory}`);
          if (!info.isDirectory || info.isSymbolicLink) throw safeError("CONFLICT", "暂存备份目录结构已损坏。");
        }
        operation.phase = "committing"; operation.message = "正在原子提交备份。";
        await dataRoot.move(stagingId, targetId, { overwrite: true }); await syncDirectory(join(dataRoot.rootReal, "backups"));
        if (input.trigger === "automatic") {
          const automatic = (await listBackups()).filter((backup) => backup.trigger === "automatic" && backup.state === "ready");
          const quarantineName = `.${operation.id}.retention-quarantine`;
          const quarantineRootId = `backups/${quarantineName}`;
          activeArtifacts.add(quarantineName);
          try {
            for (const expired of automatic.slice(input.retainLatest)) {
              const sourceId = `backups/${expired.id}`;
              const quarantineId = `${quarantineRootId}/${expired.id}`;
              let moved = false;
              let deleting = false;
              try {
                const verified = await verifiedBackupFiles(expired.id, expired.collections);
                const beforeMove = await backupTreeIdentity(verified, sourceId);
                await dataRoot.mkdir(quarantineRootId);
                if (await dataRoot.exists(quarantineId)) throw safeError("CONFLICT", "旧备份清理暂存目标已存在。", true);
                await options.beforeRetentionMove?.(dataRoot, expired.id);
                await dataRoot.move(sourceId, quarantineId, { overwrite: true });
                moved = true;
                const movedVerified = await verifiedBackupFiles(expired.id, expired.collections, quarantineId);
                const afterMove = await backupTreeIdentity(movedVerified, quarantineId);
                if (JSON.stringify(afterMove) !== JSON.stringify(beforeMove)) throw safeError("CONFLICT", "旧备份在保留清理前发生变化。", true);
                deleting = true;
                await removeTree(dataRoot, quarantineId);
                moved = false;
              } catch (caught) {
                if (moved && !deleting && await dataRoot.exists(quarantineId).catch(() => false)) {
                  try {
                    if (await dataRoot.exists(sourceId)) throw safeError("CONFLICT", "旧备份原位置已被占用。");
                    await dataRoot.move(quarantineId, sourceId, { overwrite: true }); moved = false;
                  }
                  catch {
                    operation.state = "needs-recovery"; operation.phase = "needs-recovery"; operation.message = "旧备份保留清理回退失败，需人工处理。";
                    return;
                  }
                }
                if (moved && deleting) {
                  operation.state = "needs-recovery"; operation.phase = "needs-recovery"; operation.message = "旧备份清理中断，已保留恢复对象，需人工处理。";
                  return;
                }
                operation.partialFailures += 1;
                const code = caught instanceof FsSafeError ? caught.code.toUpperCase().replaceAll("-", "_").slice(0, 40) : "RETENTION_FAILED";
                if (operation.failures.length < 20) operation.failures.push({ candidateId: "backups:expired", code, message: "旧自动备份保留清理失败。" });
              }
            }
            if (await dataRoot.exists(quarantineRootId).catch(() => false)) await pruneEmptyTree(dataRoot, quarantineRootId);
          } finally {
            activeArtifacts.delete(quarantineName);
          }
          await syncDirectory(join(dataRoot.rootReal, "backups"));
        }
        operation.state = "completed"; operation.phase = "completed"; operation.message = "备份已完成。";
      } catch (caught) {
        if (dataRoot && await dataRoot.exists(stagingId).catch(() => false)) await removeTree(dataRoot, stagingId).catch(() => undefined);
        if ((caught as UClawError).code === "CANCELLED") { operation.state = "cancelled"; operation.phase = "cancelled"; operation.message = "备份已取消。"; return; }
        throw caught;
      } finally { activeArtifacts.delete(basename(stagingId)); await lease.release(); }
    });
  };

  const readManifest = async (dataRoot: Root, backupId: string, backupRootId = `backups/${backupId}`): Promise<BackupManifest> => {
    const manifestRead = await dataRoot.read(`${backupRootId}/manifest.json`, { hardlinks: "reject", maxBytes: MANIFEST_MAX_BYTES, symlinks: "reject" });
    const raw = JSON.parse(manifestRead.buffer.toString("utf8")) as BackupManifest;
    if (raw.schemaVersion !== 1 || raw.id !== backupId || !/^backup-[a-z0-9-]{1,80}$/.test(raw.id) || !Array.isArray(raw.files) || raw.files.length > MAX_FILES || !Array.isArray(raw.collections) || raw.collections.length === 0 || raw.collections.length > 4 || new Set(raw.collections).size !== raw.collections.length || raw.collections.some((id) => !BACKUP_COLLECTIONS.includes(id)) || !["manual", "automatic"].includes(raw.trigger) || !Number.isInteger(raw.retainLatest) || raw.retainLatest < 1 || raw.retainLatest > 20 || Number.isNaN(Date.parse(raw.createdAt))) throw new Error("invalid manifest");
    const ids = new Set<string>(); let bytes = 0;
    for (const file of raw.files) {
      const classifiedCollection = classifyDataId(file.id);
      if (!RelativeDomainIdSchema.safeParse(file.id).success || ids.has(file.id) || classifiedCollection !== file.collection || !raw.collections.includes(file.collection) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("invalid manifest");
      ids.add(file.id); bytes += file.size;
      if (bytes > MAX_BYTES) throw new Error("invalid manifest");
    }
    return raw;
  };
  const verifiedBackupFiles = async (backupId: string, collections: BackupCollectionId[], backupRootId = `backups/${backupId}`): Promise<{ root: Root; rootInfo: Awaited<ReturnType<Root["stat"]>>; manifest: BackupManifest; manifestFile: InventoryFile; files: Array<{ entry: BackupManifest["files"][number]; file: InventoryFile }> }> => {
    const dataRoot = await pinnedRoot(dataDir, "U 盘数据");
    const info = await dataRoot.stat(backupRootId);
    if (!info.isDirectory || info.isSymbolicLink) throw safeError("FORBIDDEN", "备份对象不安全。");
    const manifest = await readManifest(dataRoot, backupId, backupRootId).catch(() => { throw safeError("CONFLICT", "备份 manifest 已损坏。"); });
    const manifestId = `${backupRootId}/manifest.json`;
    const manifestInfo = await dataRoot.stat(manifestId);
    if (!manifestInfo.isFile || manifestInfo.isSymbolicLink || manifestInfo.nlink > 1 || manifestInfo.size > MANIFEST_MAX_BYTES) throw safeError("CONFLICT", "备份 manifest 已损坏。");
    const manifestFile: InventoryFile = { id: "manifest.json", safeId: manifestId, safeRoot: dataRoot, size: manifestInfo.size, dev: manifestInfo.dev, ino: manifestInfo.ino, mtimeMs: Math.trunc(manifestInfo.mtimeMs) };
    const manifestEcho = JSON.parse((await safeRead(manifestFile)).toString("utf8")) as BackupManifest;
    if (JSON.stringify(manifestEcho) !== JSON.stringify(manifest)) throw safeError("CONFLICT", "备份 manifest 在校验期间发生变化。");
    if (manifest.id !== backupId || collections.some((id) => !manifest.collections.includes(id))) throw safeError("CONFLICT", "备份集合与恢复选择不匹配。");
    const selected = manifest.files.filter((file) => collections.includes(file.collection));
    const files = [] as Array<{ entry: BackupManifest["files"][number]; file: InventoryFile }>;
    for (const entry of selected) {
      if (entry.size > MAX_FILE_BYTES) throw safeError("FILE_TOO_LARGE", "备份含超出安全读取上限的文件。");
      const safeId = `${backupRootId}/files/${entry.id}`;
      const fileInfo = await dataRoot.stat(safeId);
      if (!fileInfo.isFile || fileInfo.isSymbolicLink || fileInfo.nlink > 1 || fileInfo.size !== entry.size) throw safeError("CONFLICT", "备份文件已损坏。");
      const file: InventoryFile = { id: entry.id, safeId, safeRoot: dataRoot, size: fileInfo.size, dev: fileInfo.dev, ino: fileInfo.ino, mtimeMs: Math.trunc(fileInfo.mtimeMs) };
      const buffer = await safeRead(file);
      if (createHash("sha256").update(buffer).digest("hex") !== entry.sha256) throw safeError("CONFLICT", "备份哈希校验失败。");
      files.push({ entry, file });
    }
    return { root: dataRoot, rootInfo: info, manifest, manifestFile, files };
  };
  const backupTreeIdentity = async (verified: Awaited<ReturnType<typeof verifiedBackupFiles>>, backupRootId: string): Promise<Array<{ id: string; kind: "file" | "directory"; dev: number; ino: number; size?: number; mtimeMs?: number }>> => {
    const currentRoot = await verified.root.stat(backupRootId);
    if (!currentRoot.isDirectory || currentRoot.isSymbolicLink || currentRoot.dev !== verified.rootInfo.dev || currentRoot.ino !== verified.rootInfo.ino) throw safeError("CONFLICT", "备份目录在校验期间发生变化。");
    const expectedFiles = new Map<string, InventoryFile>([["manifest.json", verified.manifestFile]]);
    for (const item of verified.files) expectedFiles.set(`files/${item.entry.id}`, item.file);
    const expectedDirectories = new Set<string>(["files"]);
    for (const id of verified.manifest.files.map((entry) => `files/${entry.id}`)) {
      const parts = id.split("/");
      for (let index = 1; index < parts.length; index += 1) expectedDirectories.add(parts.slice(0, index).join("/"));
    }
    const identities: Array<{ id: string; kind: "file" | "directory"; dev: number; ino: number; size?: number; mtimeMs?: number }> = [
      { id: ".", kind: "directory", dev: currentRoot.dev, ino: currentRoot.ino },
    ];
    const seenFiles = new Set<string>();
    const walk = async (parentId: string, relativeParent = ""): Promise<void> => {
      for (const entry of await verified.root.list(parentId, { withFileTypes: true })) {
        const relativeId = relativeParent ? `${relativeParent}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink || (entry.isFile && entry.nlink > 1) || (!entry.isFile && !entry.isDirectory)) throw safeError("CONFLICT", "备份树含链接或特殊对象。");
        if (entry.isDirectory) {
          if (!expectedDirectories.has(relativeId)) throw safeError("CONFLICT", "备份树含未声明目录。");
          identities.push({ id: relativeId, kind: "directory", dev: entry.dev, ino: entry.ino });
          await walk(`${parentId}/${entry.name}`, relativeId);
          continue;
        }
        const expected = expectedFiles.get(relativeId);
        if (!expected || entry.dev !== expected.dev || entry.ino !== expected.ino || entry.size !== expected.size || Math.trunc(entry.mtimeMs) !== expected.mtimeMs) throw safeError("CONFLICT", "备份文件 identity 已变化。");
        seenFiles.add(relativeId);
        identities.push({ id: relativeId, kind: "file", dev: entry.dev, ino: entry.ino, size: entry.size, mtimeMs: Math.trunc(entry.mtimeMs) });
      }
    };
    await walk(backupRootId);
    if (seenFiles.size !== expectedFiles.size) throw safeError("CONFLICT", "备份文件集合不完整。");
    return identities.sort((left, right) => left.id.localeCompare(right.id));
  };
  const maintenanceRecoveryState = async (dataRoot: Root): Promise<{ backupIds: Set<string>; damaged: boolean }> => {
    const backupIds = new Set<string>();
    let damaged = false;
    const entries = await dataRoot.list("backups", { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (activeArtifacts.has(entry.name)) continue;
      if (/^\.backup-[a-z0-9-]{1,80}\.staging$/.test(entry.name) || /^\.operation-[a-z0-9-]{1,80}\.rollback$/.test(entry.name) || /^\.operation-[a-z0-9-]{1,80}\.(?:cleanup|retention)-quarantine$/.test(entry.name)) {
        damaged = true;
        continue;
      }
      if (!/^\.operation-[a-z0-9-]{1,80}\.restore-journal\.json$/.test(entry.name)) continue;
      damaged = true;
      if (!entry.isFile || entry.isSymbolicLink || entry.nlink > 1 || entry.size > 1024 * 1024) continue;
      try {
        const journal = JSON.parse(await dataRoot.readText(`backups/${entry.name}`, { hardlinks: "reject", maxBytes: 1024 * 1024, symlinks: "reject" })) as Record<string, unknown>;
        if (journal.schemaVersion === 1 && typeof journal.backupId === "string" && /^backup-[a-z0-9-]{1,80}$/.test(journal.backupId)) backupIds.add(journal.backupId);
      } catch { /* damaged journal still forces manual recovery */ }
    }
    return { backupIds, damaged };
  };
  const cacheRecoveryState = async (cache: Awaited<ReturnType<typeof ownedCacheRoot>>): Promise<{ factoryReset: boolean; other: boolean }> => {
    const maintenanceId = `${cache.baseId}/.maintenance`;
    if (!await cache.root.exists(maintenanceId)) return { factoryReset: false, other: false };
    const entries = await cache.root.list(maintenanceId, { withFileTypes: true });
    return {
      factoryReset: entries.some((entry) => entry.name === ".factory-reset-journal.json"),
      other: entries.some((entry) => !activeArtifacts.has(entry.name) && /^\.operation-[a-z0-9-]{1,80}\.cleanup-quarantine$/.test(entry.name)),
    };
  };
  const validateFactoryResetJournal = async (cache: Awaited<ReturnType<typeof ownedCacheRoot>>): Promise<void> => {
    const journalId = `${cache.baseId}/.maintenance/.factory-reset-journal.json`;
    const journal = JSON.parse(await cache.root.readText(journalId, { hardlinks: "reject", maxBytes: 1024 * 1024, symlinks: "reject" })) as Record<string, unknown>;
    const dataInfo = await lstat(dataDir);
    if (journal.schemaVersion !== 1 || journal.phase !== "cleaning" || typeof journal.operationId !== "string" || !/^operation-[a-z0-9-]{1,80}$/.test(journal.operationId) ||
      journal.dataRootDev !== dataInfo.dev || journal.dataRootIno !== dataInfo.ino) {
      throw safeError("CONFLICT", "恢复出厂 journal 与当前 U 盘不匹配，拒绝继续。", true);
    }
  };
  const assertNoRecoveryState = async (allowFactoryReset = false): Promise<void> => {
    const dataRoot = await pinnedRoot(dataDir, "U 盘数据");
    const dataRecovery = await maintenanceRecoveryState(dataRoot);
    const cache = await ownedCacheRoot();
    const cacheRecovery = await cacheRecoveryState(cache);
    if (dataRecovery.damaged || cacheRecovery.other || (cacheRecovery.factoryReset && !allowFactoryReset)) throw safeError("CONFLICT", "检测到未完成维护状态，请先人工恢复。", true);
  };
  const listBackups = async (): Promise<BackupSummary[]> => {
    const dataRoot = await pinnedRoot(dataDir, "U 盘数据");
    if (!await dataRoot.exists("backups")) return [];
    const entries = await dataRoot.list("backups", { withFileTypes: true });
    const interrupted = await maintenanceRecoveryState(dataRoot);
    const result: BackupSummary[] = [];
    for (const entry of entries) {
      if (!/^backup-[a-z0-9-]{1,80}$/.test(entry.name) || !entry.isDirectory || entry.isSymbolicLink) continue;
      try {
        const manifest = await readManifest(dataRoot, entry.name);
        result.push({ id: manifest.id, createdAt: manifest.createdAt, trigger: manifest.trigger, state: interrupted.backupIds.has(manifest.id) ? "incomplete" : "ready", collections: manifest.collections, fileCount: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.size, 0) });
      } catch { result.push({ id: entry.name, createdAt: new Date(0).toISOString(), trigger: "manual", state: "damaged", collections: ["uclaw-configuration"], fileCount: 0, bytes: 0 }); }
    }
    return result.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 200);
  };

  const previewRestore = async (backupId: string, requested?: BackupCollectionId[]): Promise<RestorePreview> => {
    const summary = (await listBackups()).find((backup) => backup.id === backupId);
    if (!summary || summary.state !== "ready") throw safeError("NOT_FOUND", "可恢复备份不存在。");
    const collections = [...new Set(requested ?? summary.collections)] as BackupCollectionId[];
    const verified = await verifiedBackupFiles(backupId, collections);
    const current = await dataInventory(collections);
    const currentIds = new Set(current.map((file) => file.id));
    const summaries = collections.map((id) => {
      const selected = verified.files.filter((file) => file.entry.collection === id);
      const bytes = selected.reduce((sum, file) => sum + file.entry.size, 0);
      return { id, label: COLLECTION_LABELS[id], fileCount: selected.length, bytes, risk: id === "workspace-user-files" ? "normal" as const : "sensitive" as const };
    });
    const manifestFingerprint = createHash("sha256").update(JSON.stringify(verified.manifest)).digest("hex");
    return RestorePreviewSchema.parse({
      previewToken: rememberPreview({ kind: "restore", ids: [...collections].sort(), fingerprint: `${fingerprint(current)}:${manifestFingerprint}`, backupId }),
      backupId, source: "当前 U 盘受控备份区", target: "当前 U 盘数据根", collections: summaries,
      totalFileCount: verified.files.length, totalBytes: verified.files.reduce((sum, file) => sum + file.entry.size, 0),
      overwriteFileCount: verified.files.filter((file) => currentIds.has(file.entry.id)).length,
      newFileCount: verified.files.filter((file) => !currentIds.has(file.entry.id)).length,
      warnings: [options.acquireConsistencyLease ? "恢复将暂停跨域写入；失败时自动回滚。" : "当前 runtime 无全局 snapshot/CAS，恢复将安全拒绝。"],
    });
  };

  const restoreBackup = (input: { backupId: string; collectionIds: BackupCollectionId[]; previewToken: string }): MaintenanceOperation => {
    if (!options.acquireConsistencyLease) throw safeError("UNAVAILABLE", "OpenClaw runtime 无全局 snapshot/CAS，拒绝不一致恢复。");
    const collections = [...new Set(input.collectionIds)].sort() as BackupCollectionId[];
    const preview = requirePreview(input.previewToken, "restore", collections);
    if (preview.backupId !== input.backupId) throw safeError("CONFLICT", "恢复预览与备份不匹配。", true);
    return startOperation("restore", 0, 0, async (operation, signal) => {
      await assertNoRecoveryState();
      operation.state = "running"; operation.phase = "coordinating"; operation.message = "正在协调 runtime 并校验恢复目标。";
      const lease = await options.acquireConsistencyLease!(signal);
      const rollbackId = `backups/.${operation.id}.rollback`;
      const journalId = `backups/.${operation.id}.restore-journal.json`;
      activeArtifacts.add(basename(rollbackId)); activeArtifacts.add(basename(journalId));
      let current: InventoryFile[] = [];
      let verified: Awaited<ReturnType<typeof verifiedBackupFiles>> | undefined;
      let dataRoot: Root | undefined;
      let prepared = false;
      try {
        verified = await verifiedBackupFiles(input.backupId, collections);
        dataRoot = verified.root;
        current = await dataInventory(collections);
        const manifestFingerprint = createHash("sha256").update(JSON.stringify(verified.manifest)).digest("hex");
        if (`${fingerprint(current)}:${manifestFingerprint}` !== preview.fingerprint) throw safeError("CONFLICT", "恢复目标在预览后发生变化，请重新预览。", true);
        operation.totalFiles = verified.files.length; operation.totalBytes = verified.files.reduce((sum, file) => sum + file.entry.size, 0);
        operation.phase = "staging"; operation.message = "正在创建同目录回滚副本。";
        await dataRoot.mkdir(rollbackId);
        const restoreIds = new Set(verified.files.map((file) => file.entry.id));
        const overwritten = current.filter((file) => restoreIds.has(file.id));
        for (const file of overwritten) await dataRoot.create(`${rollbackId}/files/${file.id}`, await safeRead(file), { mkdir: true, mode: 0o600 });
        await dataRoot.create(journalId, `${JSON.stringify({ schemaVersion: 1, operationId: operation.id, backupId: input.backupId, phase: "prepared", collections, currentIds: overwritten.map((file) => file.id), restoreIds: [...restoreIds] })}\n`, { mode: 0o600 });
        await syncDirectory(join(dataRoot.rootReal, "backups"));
        prepared = true;
        operation.phase = "committing"; operation.message = "正在恢复已确认数据。";
        for (const file of verified.files) {
          if (signal.aborted) throw safeError("CANCELLED", "恢复已取消。");
          const buffer = await safeRead(file.file);
          if (createHash("sha256").update(buffer).digest("hex") !== file.entry.sha256) throw safeError("CONFLICT", "备份文件在恢复前发生变化。", true);
          await options.beforeRestoreWrite?.(dataRoot, file.entry.id);
          await dataRoot.write(file.entry.id, buffer, { mkdir: true, mode: 0o600, overwrite: true });
          operation.processedFiles += 1; operation.processedBytes += buffer.length;
        }
        await removeTree(dataRoot, rollbackId); await dataRoot.remove(journalId); await syncDirectory(join(dataRoot.rootReal, "backups"));
        operation.state = "completed"; operation.phase = "completed"; operation.message = "恢复已完成。";
      } catch (caught) {
        if (!prepared) throw caught;
        operation.phase = "rolling-back"; operation.message = "恢复失败，正在自动回滚。";
        try {
          if (!dataRoot) throw new Error("missing restore root");
          await options.beforeRestoreRollback?.(dataRoot);
          const affected = new Set(verified?.files.map((file) => file.entry.id) ?? []);
          for (const id of affected) if (await dataRoot.exists(id)) await dataRoot.remove(id);
          const restoreIds = new Set(verified?.files.map((file) => file.entry.id) ?? []);
          for (const file of current.filter((item) => restoreIds.has(item.id))) {
            const buffer = await dataRoot.readBytes(`${rollbackId}/files/${file.id}`, { hardlinks: "reject", maxBytes: MAX_FILE_BYTES, symlinks: "reject" });
            await dataRoot.write(file.id, buffer, { mkdir: true, mode: 0o600, overwrite: true });
          }
          if (await dataRoot.exists(rollbackId)) await removeTree(dataRoot, rollbackId);
          if (await dataRoot.exists(journalId)) await dataRoot.remove(journalId);
          await syncDirectory(join(dataRoot.rootReal, "backups"));
          if ((caught as UClawError).code === "CANCELLED") { operation.state = "cancelled"; operation.phase = "cancelled"; operation.message = "恢复已取消，原数据已回滚。"; return; }
          throw caught;
        } catch (rollbackError) {
          if (rollbackError === caught) throw caught;
          operation.state = "needs-recovery"; operation.phase = "needs-recovery"; operation.message = "自动回滚失败，已保留恢复日志，需人工处理。";
          return;
        }
      } finally { activeArtifacts.delete(basename(rollbackId)); activeArtifacts.delete(basename(journalId)); await lease.release(); }
    });
  };

  const cleanupRoots = (ids: CleanupCandidateId[]): Array<{ id: CleanupCandidateId; root: "cache" | "data"; baseId: string }> => ids.map((id) => {
    if (id === "cache:electron") return { id, root: "cache", baseId: "electron" };
    if (id === "cache:node-compile") return { id, root: "cache", baseId: "node-compile" };
    if (id === "cache:temp") return { id, root: "cache", baseId: "temp" };
    if (id === "diagnostics:expired-logs") return { id, root: "data", baseId: "diagnostics/desktop-logs" };
    if (id === "diagnostics:expired-crash-dumps") return { id, root: "data", baseId: "diagnostics/crash-dumps" };
    return { id, root: "data", baseId: "backups" };
  });
  const scanCleanup = async (ids: CleanupCandidateId[]): Promise<InventoryFile[]> => {
    const ownedCache = ids.some((id) => id.startsWith("cache:")) ? await ownedCacheRoot() : undefined;
    const dataRoot = ids.some((id) => !id.startsWith("cache:")) ? await pinnedRoot(dataDir, "U 盘数据") : undefined;
    const files: InventoryFile[] = [];
    for (const candidate of cleanupRoots(ids)) {
      if (candidate.id === "backups:expired") {
        if (!dataRoot || !await dataRoot.exists("backups")) continue;
        const entries = await dataRoot.list("backups", { withFileTypes: true });
        const automatic: BackupManifest[] = [];
        for (const entry of entries) {
          if (!entry.isDirectory || entry.isSymbolicLink || !entry.name.startsWith("backup-")) continue;
          try {
            const manifest = await readManifest(dataRoot, entry.name);
            if (manifest.trigger === "automatic") automatic.push(manifest);
          } catch { /* damaged backups require explicit recovery, never cleanup */ }
        }
        automatic.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        const retainLatest = automatic[0]?.retainLatest ?? 0;
        for (const expired of automatic.slice(retainLatest)) {
          await verifiedBackupFiles(expired.id, expired.collections);
          const baseId = `backups/${expired.id}`;
          const scanned = await scanPinned(dataRoot, baseId);
          const expected = new Set(["manifest.json", ...expired.files.map((file) => `files/${file.id}`)]);
          if (scanned.length !== expected.size || scanned.some((file) => !expected.has(file.id))) continue;
          files.push(...scanned.map((file) => ({ ...file, id: `${candidate.id}/${expired.id}/${file.id}` })));
        }
        continue;
      }
      const root = candidate.root === "cache" ? ownedCache?.root : dataRoot;
      const baseId = candidate.root === "cache" && ownedCache ? `${ownedCache.baseId}/${candidate.baseId}` : candidate.baseId;
      if (!root || !await root.exists(baseId)) continue;
      let scanned = await scanPinned(root, baseId);
      if (candidate.id === "diagnostics:expired-logs" || candidate.id === "diagnostics:expired-crash-dumps") {
        const cutoff = now().getTime() - 30 * 24 * 60 * 60 * 1000;
        scanned = scanned.filter((file) => file.mtimeMs < cutoff);
      }
      files.push(...scanned.map((file) => ({ ...file, id: `${candidate.id}/${file.id}` })));
    }
    if (ownedCache) await assertOwnedCacheIdentity(ownedCache);
    return files.sort((left, right) => left.id.localeCompare(right.id));
  };
  const previewCleanup = async (requested: CleanupCandidateId[] = ["cache:electron", "cache:node-compile", "cache:temp", "diagnostics:expired-logs", "diagnostics:expired-crash-dumps", "backups:expired"]): Promise<CleanupPreview> => {
    const ids = [...new Set(requested)].sort() as CleanupCandidateId[];
    const files = await scanCleanup(ids);
    const candidates = ids.map((id) => {
      const selected = files.filter((file) => file.id.startsWith(`${id}/`));
      return { id, label: CLEANUP_LABELS[id], bytes: selected.reduce((sum, file) => sum + file.size, 0), fileCount: selected.length, reason: id.startsWith("cache:") ? "可重建缓存" : id === "backups:expired" ? "保留策略外旧备份" : "明确过期诊断文件" };
    });
    return CleanupPreviewSchema.parse({ previewToken: rememberPreview({ kind: "cleanup", ids, fingerprint: fingerprint(files) }), candidates, totalBytes: files.reduce((sum, file) => sum + file.size, 0), totalFileCount: files.length, protectedCategories: ["configuration", "sessions", "memory", "capabilities", "user-files"] });
  };
  const executeCleanup = (requested: CleanupCandidateId[], previewToken: string): MaintenanceOperation => {
    const ids = [...new Set(requested)].sort() as CleanupCandidateId[];
    const preview = requirePreview(previewToken, "cleanup", ids);
    return startOperation("cleanup", 0, 0, (operation, signal) => (options.runMutation ?? ((run) => run()))(async () => {
      await assertNoRecoveryState();
      operation.state = "running"; operation.phase = "scanning"; operation.message = "正在重新校验清理对象。";
      const files = await scanCleanup(ids);
      if (fingerprint(files) !== preview.fingerprint) throw safeError("CONFLICT", "清理对象在预览后发生变化，请重新预览。", true);
      operation.totalFiles = files.length; operation.totalBytes = files.reduce((sum, file) => sum + file.size, 0);
      operation.phase = "cleaning"; operation.message = "正在清理可重建或明确过期数据。";
      const quarantineName = `.${operation.id}.cleanup-quarantine`;
      activeArtifacts.add(quarantineName);
      const quarantineRoots = new Map<string, { root: Root; id: string }>();
      const cleanupQuarantines = async (): Promise<void> => {
        for (const quarantine of quarantineRoots.values()) {
          if (await quarantine.root.exists(quarantine.id).catch(() => false)) await pruneEmptyTree(quarantine.root, quarantine.id);
        }
      };
      try {
        for (const file of files) {
        if (signal.aborted) { await cleanupQuarantines(); operation.state = "cancelled"; operation.phase = "cancelled"; operation.message = "清理已取消。"; return; }
        const candidateId = file.id.split("/")[0] as CleanupCandidateId;
        const isCache = candidateId.startsWith("cache:");
        const quarantineRootId = isCache ? `${basename(cacheDir)}/.maintenance/${quarantineName}` : `backups/${quarantineName}`;
        const relativeFileId = isCache ? file.safeId.slice(basename(cacheDir).length + 1) : file.safeId;
        const quarantineId = `${quarantineRootId}/items/${relativeFileId}`;
        quarantineRoots.set(`${file.safeRoot.rootReal}:${quarantineRootId}`, { root: file.safeRoot, id: quarantineRootId });
        try {
          await file.safeRoot.mkdir(dirname(quarantineId));
          await options.beforeCleanupMove?.(file.safeRoot, file.safeId);
          await file.safeRoot.move(file.safeId, quarantineId);
          const moved = await file.safeRoot.stat(quarantineId);
          if (!moved.isFile || moved.isSymbolicLink || moved.nlink > 1 || moved.dev !== file.dev || moved.ino !== file.ino || moved.size !== file.size || Math.trunc(moved.mtimeMs) !== file.mtimeMs) {
            await file.safeRoot.move(quarantineId, file.safeId);
            throw safeError("CONFLICT", "清理对象在执行前发生变化。", true);
          }
          await file.safeRoot.remove(quarantineId); operation.processedFiles += 1; operation.processedBytes += file.size;
        } catch (caught) {
          if ((caught as UClawError).code === "CONFLICT") { await cleanupQuarantines().catch(() => undefined); activeArtifacts.delete(quarantineName); throw caught; }
          if (await file.safeRoot.exists(quarantineId).catch(() => false)) {
            try { await file.safeRoot.move(quarantineId, file.safeId); }
            catch {
              operation.state = "needs-recovery"; operation.phase = "needs-recovery"; operation.message = "清理回退失败，已保留恢复对象，需人工处理。";
              return;
            }
          }
          operation.partialFailures += 1;
          if (operation.failures.length < 20) operation.failures.push({ candidateId, code: "DELETE_FAILED", message: "对象删除失败。" });
        }
      }
      if (ids.includes("backups:expired")) {
        const backupRoots = new Set(files.filter((file) => file.id.startsWith("backups:expired/")).map((file) => file.id.split("/")[1]).filter(Boolean));
        const dataRoot = await pinnedRoot(dataDir, "U 盘数据");
        for (const backupId of backupRoots) {
          try { await pruneEmptyTree(dataRoot, `backups/${backupId}`); }
          catch {
            operation.partialFailures += 1;
            if (operation.failures.length < 20) operation.failures.push({ candidateId: "backups:expired", code: "PRUNE_FAILED", message: "旧备份目录清理失败。" });
          }
        }
      }
      await cleanupQuarantines();
      activeArtifacts.delete(quarantineName);
      operation.state = "completed"; operation.phase = "completed";
      operation.message = operation.partialFailures ? "清理完成，部分对象失败。" : "清理已完成。";
      } finally {
        activeArtifacts.delete(quarantineName);
      }
    }));
  };

  const FACTORY_RESET_IDS = ["openclaw-state", "uclaw-owned-state", "capabilities", "diagnostics", "rebuildable-cache"] as const;
  const factoryResetInventory = async (): Promise<InventoryFile[]> => {
    const data = (await scan(dataDir, "U 盘数据", undefined, true, MAX_FILE_BYTES)).filter((file) => {
      const collection = classifyDataId(file.id);
      return collection !== undefined && collection !== "workspace-user-files" || file.id.startsWith("diagnostics/");
    }).map((file) => ({ ...file, id: `data:${file.id}` }));
    const cache = await ownedCacheRoot();
    const cacheFiles = (await scanPinned(cache.root, cache.baseId, undefined, false, MAX_FILE_BYTES))
      .filter((file) => !file.id.startsWith(".maintenance/"))
      .map((file) => ({ ...file, id: `cache:${file.id}` }));
    await assertOwnedCacheIdentity(cache);
    return [...data, ...cacheFiles];
  };

  const previewFactoryReset = async (): Promise<FactoryResetPreview> => {
    const files = await factoryResetInventory();
    const recoveryCache = await ownedCacheRoot();
    const recoveryPending = (await cacheRecoveryState(recoveryCache)).factoryReset;
    if (recoveryPending) await validateFactoryResetJournal(recoveryCache);
    const category = (file: InventoryFile) => file.id.startsWith("cache:") ? "rebuildable-cache"
      : file.id.startsWith("data:capabilities/") ? "capabilities"
      : file.id.startsWith("data:diagnostics/") ? "diagnostics"
      : file.id.startsWith("data:.openclaw/") || file.id.startsWith("data:workspace/") ? "openclaw-state"
      : "uclaw-owned-state";
    const labels = { "openclaw-state": "OpenClaw 配置、会话与记忆", "uclaw-owned-state": "U-Claw 配置与运行状态", capabilities: "Skills、Plugins、MCP 与渠道能力", diagnostics: "诊断数据", "rebuildable-cache": "可重建缓存" } as const;
    const previewToken = rememberPreview({ kind: "factory-reset", ids: [...FACTORY_RESET_IDS].sort(), fingerprint: fingerprint(files) });
    return FactoryResetPreviewSchema.parse({
      previewToken,
      consistency: options.acquireConsistencyLease ? "coordinated" : "runtime-coordination-required",
      recovery: recoveryPending ? "resume-required" : "none",
      delete: FACTORY_RESET_IDS.map((id) => { const selected = files.filter((file) => category(file) === id); return { id, label: labels[id], fileCount: selected.length, bytes: selected.reduce((sum, file) => sum + file.size, 0) }; }),
      preserve: [{ id: "user-files", label: "用户工作文件" }, { id: "backups", label: "备份" }],
      warnings: [recoveryPending ? "检测到未完成恢复出厂；确认后将从剩余受控数据继续。" : options.acquireConsistencyLease ? "执行时将暂停 OpenClaw 写入；失败对象保留并显示恢复状态。" : "当前 runtime 无恢复出厂协调能力，执行将安全拒绝。"],
    });
  };

  const executeFactoryReset = (input: { previewToken: string }): MaintenanceOperation => {
    if (!options.acquireConsistencyLease) throw safeError("UNAVAILABLE", "OpenClaw runtime 无恢复出厂协调能力，拒绝执行。");
    const preview = requirePreview(input.previewToken, "factory-reset", [...FACTORY_RESET_IDS]);
    return startOperation("factory-reset", 0, 0, async (operation, signal) => {
      await assertNoRecoveryState(true);
      operation.state = "running"; operation.phase = "coordinating"; operation.message = "正在协调 OpenClaw 停止写入。";
      const lease = await options.acquireConsistencyLease!(signal);
      let cache: Awaited<ReturnType<typeof ownedCacheRoot>> | undefined;
      let journalId: string | undefined;
      let clearJournal = false;
      let finalState: "completed" | "cancelled" | "needs-recovery" | undefined;
      let finalMessage = "";
      try {
        const dataRoot = await pinnedRoot(dataDir, "U 盘数据");
        cache = await ownedCacheRoot();
        const journalDir = `${cache.baseId}/.maintenance`;
        journalId = `${journalDir}/.factory-reset-journal.json`;
        const files = await factoryResetInventory();
        if (fingerprint(files) !== preview.fingerprint) throw safeError("CONFLICT", "数据在预览后发生变化，请重新预览。", true);
        operation.totalFiles = files.length; operation.totalBytes = files.reduce((sum, file) => sum + file.size, 0);
        await cache.root.mkdir(journalDir);
        if (await cache.root.exists(journalId)) {
          await validateFactoryResetJournal(cache);
        } else {
          const dataInfo = await lstat(dataDir);
          await cache.root.create(journalId, `${JSON.stringify({ schemaVersion: 1, operationId: operation.id, phase: "cleaning", dataRootDev: dataInfo.dev, dataRootIno: dataInfo.ino })}\n`, { mode: 0o600 });
        }
        operation.phase = "cleaning"; operation.message = "正在删除 U-Claw 自有受控数据。";
        for (const file of files) {
          if (signal.aborted) { finalState = "cancelled"; finalMessage = "恢复出厂已取消；未处理对象保持不变。"; break; }
          try {
            await options.beforeFactoryResetDelete?.(file.safeRoot, file.safeId);
            await safeRead(file);
            await file.safeRoot.remove(file.safeId);
            operation.processedFiles += 1; operation.processedBytes += file.size;
          } catch (caught) {
            if (caught instanceof FsSafeError || UClawErrorSchema.safeParse(caught).success) throw caught;
            operation.partialFailures += 1;
            if (operation.failures.length < 20) operation.failures.push({ candidateId: file.id.startsWith("cache:") ? "factory-reset:cache" : "factory-reset:owned-data", code: "DELETE_FAILED", message: "受控对象删除失败。" });
          }
        }
        for (const id of [".openclaw", "desktop", "capabilities", "channels", "mcp", "providers", "uclaw", "diagnostics", "workspace/memory"]) {
          if (await dataRoot.exists(id).catch(() => false)) await pruneEmptyTree(dataRoot, id).catch(() => undefined);
        }
        for (const id of ["electron", "node-compile", "temp"]) {
          const safeId = `${cache.baseId}/${id}`;
          if (await cache.root.exists(safeId).catch(() => false)) await pruneEmptyTree(cache.root, safeId).catch(() => undefined);
        }
        operation.phase = "restarting"; operation.message = "受控数据已处理，正在恢复 Managed Gateway。";
        if (!finalState) {
          finalState = operation.partialFailures ? "needs-recovery" : "completed";
          finalMessage = operation.partialFailures ? "恢复出厂部分失败，需重启后恢复处理。" : "恢复出厂已完成，请重启应用。";
        }
        clearJournal = finalState === "completed";
      } finally {
        try {
          await lease.release();
        } catch {
          operation.state = "needs-recovery"; operation.phase = "needs-recovery";
          operation.message = "受控数据已处理，但 Managed Gateway 重启失败；恢复日志已保留。";
          return;
        }
      }
      if (clearJournal && cache && journalId) {
        try {
          await options.beforeFactoryResetJournalCleanup?.(cache.root, journalId);
          await cache.root.remove(journalId);
        } catch {
          operation.state = "needs-recovery"; operation.phase = "needs-recovery";
          operation.message = "受控数据已处理，但恢复日志清理失败；需人工恢复。";
          return;
        }
      }
      if (finalState) {
        operation.state = finalState;
        operation.phase = finalState;
        operation.message = finalMessage;
      }
    });
  };

  const storageStats = async (): Promise<StorageStats> => {
    const ownedCache = await ownedCacheRoot();
    const dataRoot = await pinnedRoot(dataDir, "U 盘数据");
    const data = await scanPinned(dataRoot); const cache = await scanPinned(ownedCache.root, ownedCache.baseId);
    await assertOwnedCacheIdentity(ownedCache);
    const categoryFiles: Record<string, InventoryFile[]> = { configuration: [], sessions: [], memory: [], capabilities: [], logs: [], cache, "temporary-downloads": [], "user-files": [], backups: [] };
    for (const file of data) {
      const collection = classifyDataId(file.id);
      if (collection === "openclaw-memory") categoryFiles.memory.push(file);
      else if (collection === "openclaw-sessions") categoryFiles.sessions.push(file);
      else if (collection === "workspace-user-files") categoryFiles["user-files"].push(file);
      else if (file.id.startsWith("capabilities/") || file.id.startsWith("mcp/")) categoryFiles.capabilities.push(file);
      else if (file.id.startsWith("diagnostics/")) categoryFiles.logs.push(file);
      else if (file.id.startsWith("backups/")) categoryFiles.backups.push(file);
      else categoryFiles.configuration.push(file);
    }
    categoryFiles["temporary-downloads"] = cache.filter((file) => file.id.startsWith("temp/"));
    categoryFiles.cache = cache.filter((file) => !file.id.startsWith("temp/"));
    const labels: Record<string, string> = { configuration: "配置", sessions: "会话", memory: "记忆", capabilities: "能力包", logs: "日志", cache: "缓存", "temporary-downloads": "临时/下载", "user-files": "用户文件", backups: "备份" };
    const categories = Object.entries(categoryFiles).map(([id, files]) => ({ id, label: labels[id], bytes: files.reduce((sum, file) => sum + file.size, 0), fileCount: files.length, protected: ["configuration", "sessions", "memory", "capabilities", "user-files"].includes(id) }));
    await statfs(dataRoot.rootReal);
    const interrupted = await maintenanceRecoveryState(dataRoot);
    const cacheRecovery = await cacheRecoveryState(ownedCache);
    return StorageStatsSchema.parse({ state: interrupted.damaged || cacheRecovery.factoryReset || cacheRecovery.other ? "damaged" : "available", categories, totalBytes: categories.reduce((sum, item) => sum + item.bytes, 0) });
  };

  const getOperation = (id: string): MaintenanceOperation => {
    const operation = operations.get(id); if (!operation) throw safeError("NOT_FOUND", "维护操作不存在。"); return cloneOperation(operation);
  };
  const cancelOperation = (id: string): MaintenanceOperation => {
    const operation = operations.get(id); if (!operation) throw safeError("NOT_FOUND", "维护操作不存在。");
    if (["completed", "failed", "cancelled", "needs-recovery"].includes(operation.state)) throw safeError("ALREADY_COMPLETED", "维护操作已结束。");
    controllers.get(id)?.abort(); return cloneOperation(operation);
  };

  return { previewBackup, createBackup, listBackups, previewRestore, restoreBackup, previewCleanup, executeCleanup, previewFactoryReset, executeFactoryReset, storageStats, getOperation, cancelOperation, assertNoRecoveryState };
}
