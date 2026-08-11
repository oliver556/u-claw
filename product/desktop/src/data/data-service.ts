import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { FsSafeError, root, type Root } from "@openclaw/fs-safe";
import { withFileLock } from "@openclaw/fs-safe/file-lock";
import {
  DATA_ROOT_CONTRACT,
  DataIpcRequestSchema,
  DataIpcResponseSchema,
  UClawErrorSchema,
  type DataIpcRequest,
  type DataIpcResponse,
  type MemoryEntry,
  type UClawError,
  type WorkspaceEntry,
} from "@uclaw/shared";
import { createMaintenanceService } from "./maintenance-service.js";

const MAX_TEXT_BYTES = 2_000_000;
const DEFAULT_SEARCH_LIMITS = { maxDepth: 32, maxEntries: 10_000, maxBytes: 64_000_000 };
const DATA_STAGING_DIR = ".uclaw-data-staging";
const CONTROL_FILES = new Set([
  "agents.md", "soul.md", "tools.md", "identity.md", "user.md", "heartbeat.md", "bootstrap.md", "dreams.md",
]);

export type WorkspaceShellAction = "open" | "reveal";

export interface WorkspaceShellTarget {
  readonly path: string;
  verify(): Promise<void>;
}

export interface WorkspaceShell {
  invoke(action: WorkspaceShellAction, target: WorkspaceShellTarget): Promise<void>;
}

export type VersionedDataMutationMethod =
  | "workspace.rename"
  | "workspace.move"
  | "workspace.delete"
  | "memory.write"
  | "memory.delete";

export interface DataMutationContext {
  method: VersionedDataMutationMethod;
  id: string;
  expectedVersion: string;
}

export interface DataMutationCoordinator {
  runVersioned<T>(context: DataMutationContext, operation: () => Promise<T>): Promise<T>;
  runTrackedWrite?<T>(operation: () => Promise<T>): Promise<T>;
}

export interface DataServiceOptions {
  dataDir: string;
  cacheDir?: string;
  acquireConsistencyLease?(signal?: AbortSignal): Promise<{ release(): Promise<void> }>;
  workspaceShell?: WorkspaceShell;
  mutationCoordinator?: DataMutationCoordinator;
  searchLimits?: { maxDepth: number; maxEntries: number; maxBytes: number };
}

interface FileInfo {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  nlink: number;
  isFile: boolean | (() => boolean);
  isDirectory: boolean | (() => boolean);
  isSymbolicLink: boolean | (() => boolean);
}

function isFile(info: FileInfo): boolean {
  return typeof info.isFile === "function" ? info.isFile() : info.isFile;
}

function isDirectory(info: FileInfo): boolean {
  return typeof info.isDirectory === "function" ? info.isDirectory() : info.isDirectory;
}

function isSymbolicLink(info: FileInfo): boolean {
  return typeof info.isSymbolicLink === "function" ? info.isSymbolicLink() : info.isSymbolicLink;
}

function sameFileIdentity(left: FileInfo, right: FileInfo): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left: FileInfo, right: FileInfo): boolean {
  return sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.nlink === right.nlink &&
    isFile(left) === isFile(right) &&
    isDirectory(left) === isDirectory(right) &&
    isSymbolicLink(left) === isSymbolicLink(right);
}

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const child = relative(rootPath, candidatePath);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function safeError(code: UClawError["code"], message: string, retryable = false): UClawError {
  return UClawErrorSchema.parse({
    code,
    message,
    retryable,
    recoveryActions: retryable ? ["retry"] : [],
    causeDetails: {},
  });
}

function metadataVersion(info: FileInfo): string {
  return `stat:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
}

function contentVersion(buffer: Buffer, info: FileInfo): string {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}:${metadataVersion(info)}`;
}

function parseCursor(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw safeError("INVALID_ARGUMENT", "分页游标无效。");
  return parsed;
}

function isMemoryId(id: string): boolean {
  return id === "MEMORY.md" || (id.startsWith("memory/") && id.toLocaleLowerCase("en-US").endsWith(".md"));
}

function isProtectedWorkspaceId(id: string): boolean {
  const segments = id.split("/");
  const first = segments[0]?.toLocaleLowerCase("en-US") ?? "";
  return first === "memory" || first === "memory.md" || CONTROL_FILES.has(first) || segments.some((segment) => segment.startsWith("."));
}

function memoryTitle(id: string): string {
  return id === "MEMORY.md" ? "长期记忆" : basename(id, ".md");
}

function toWorkspaceEntry(id: string, info: FileInfo, version = metadataVersion(info)): WorkspaceEntry {
  return {
    id,
    name: basename(id),
    kind: isDirectory(info) ? "directory" : "file",
    size: isFile(info) ? Number(info.size) : 0,
    modifiedAt: new Date(info.mtimeMs).toISOString(),
    version,
    readable: true,
  };
}

function toMemoryEntry(id: string, info: FileInfo, version: string): MemoryEntry {
  return {
    id,
    title: memoryTitle(id),
    size: Number(info.size),
    modifiedAt: new Date(info.mtimeMs).toISOString(),
    version,
  };
}

export function createDataService(options: DataServiceOptions) {
  if (!isAbsolute(options.dataDir)) throw new Error("Data root must be absolute.");
  const workspaceRoot = resolve(options.dataDir, DATA_ROOT_CONTRACT.roots.workspace);
  const searchLimits = options.searchLimits ?? DEFAULT_SEARCH_LIMITS;
  if (searchLimits.maxDepth < 0 || searchLimits.maxEntries < 1 || searchLimits.maxBytes < 1) {
    throw new Error("Search limits must be positive.");
  }
  const mutationCoordinator: DataMutationCoordinator = options.mutationCoordinator ?? {
    runVersioned: async (context, operation) => {
      try {
        return await withFileLock(workspaceRoot, {
          managerKey: "uclaw-data-mutation",
          lockPath: join(options.dataDir, ".uclaw-data-mutation.lock"),
          staleMs: 30_000,
          timeoutMs: 5_000,
          retry: { retries: 20, minTimeout: 10, maxTimeout: 100, factor: 1.4, randomize: true },
          staleRecovery: "fail-closed",
          payload: () => ({
            pid: process.pid,
            boundary: "filesystem-optimistic-cas",
            method: context.method,
            id: context.id,
          }),
        }, operation);
      } catch (caught) {
        const code = (caught as NodeJS.ErrnoException).code;
        if (code === "file_lock_timeout" || code === "file_lock_stale") {
          throw safeError("CONFLICT", "数据正在被其他进程修改，请稍后重试。", true);
        }
        throw caught;
      }
    },
  };
  const maintenance = options.cacheDir === undefined ? undefined : createMaintenanceService({
    dataDir: options.dataDir,
    cacheDir: options.cacheDir,
    acquireConsistencyLease: options.acquireConsistencyLease,
    ...(mutationCoordinator.runTrackedWrite === undefined ? {} : {
      runMutation: (operation) => mutationCoordinator.runTrackedWrite!(operation),
    }),
  });
  let availableOverride: boolean | undefined;
  const activeStagingTransactions = new Set<string>();
  let stagingRecovery: Promise<void> | undefined;

  const getRoot = async (): Promise<Root> => {
    if (availableOverride === false) throw safeError("USB_MISSING", "U 盘工作区离线。", true);
    try {
      const info = await lstat(workspaceRoot);
      if (!info.isDirectory() || info.isSymbolicLink()) throw safeError("FORBIDDEN", "工作区根不安全。");
      const dataRootReal = await realpath(options.dataDir);
      const safeRoot = await root(workspaceRoot, {
        hardlinks: "reject",
        maxBytes: MAX_TEXT_BYTES,
        mkdir: false,
        symlinks: "reject",
      });
      if (relative(dataRootReal, safeRoot.rootReal).toLocaleLowerCase("en-US") !== DATA_ROOT_CONTRACT.roots.workspace) {
        throw safeError("FORBIDDEN", "工作区根不安全。");
      }
      stagingRecovery ??= recoverStagedTargets(safeRoot).finally(() => { stagingRecovery = undefined; });
      await stagingRecovery;
      return safeRoot;
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "ENOENT" || (caught instanceof FsSafeError && caught.code === "not-found")) {
        throw safeError("USB_MISSING", "U 盘工作区离线。", true);
      }
      throw caught;
    }
  };

  const assertWorkspaceDomain = (id: string): void => {
    if (isProtectedWorkspaceId(id)) throw safeError("FORBIDDEN", "该项目属于受保护的 OpenClaw 数据域。");
  };

  const assertMemoryDomain = (id: string): void => {
    const hiddenMemorySegment = id.startsWith("memory/") && id.split("/").slice(1).some((segment) => segment.startsWith("."));
    if (!isMemoryId(id) || hiddenMemorySegment) throw safeError("FORBIDDEN", "该项目不属于 OpenClaw 记忆域。");
  };

  const readFile = async (safeRoot: Root, id: string) => {
    const read = await safeRoot.read(id, { hardlinks: "reject", maxBytes: MAX_TEXT_BYTES, symlinks: "reject" });
    return { ...read, version: contentVersion(read.buffer, read.stat) };
  };

  const removeStagingTransaction = async (safeRoot: Root, transactionId: string, payloadId?: string): Promise<void> => {
    if (payloadId) await safeRoot.remove(payloadId);
    await safeRoot.remove(`${transactionId}/journal.json`).catch((caught) => {
      if (!(caught instanceof FsSafeError && caught.code === "not-found")) throw caught;
    });
    await safeRoot.remove(transactionId);
  };

  async function recoverStagedTargets(safeRoot: Root): Promise<void> {
    let entries;
    try { entries = await safeRoot.list(DATA_STAGING_DIR, { withFileTypes: true }); }
    catch (caught) {
      if (caught instanceof FsSafeError && caught.code === "not-found") return;
      throw caught;
    }
    for (const entry of entries) {
      const transactionId = `${DATA_STAGING_DIR}/${entry.name}`;
      if (activeStagingTransactions.has(transactionId)) continue;
      if (!entry.isDirectory || entry.isSymbolicLink) throw safeError("CONFLICT", "检测到无效的数据恢复事务。", true);
      const transactionEntries = await safeRoot.list(transactionId, { withFileTypes: true });
      if (!transactionEntries.some((candidate) => candidate.name === "journal.json")) {
        if (transactionEntries.length === 0) {
          await safeRoot.remove(transactionId);
          continue;
        }
        throw safeError("CONFLICT", "数据恢复事务损坏，请先运行诊断。", true);
      }
      let id: string;
      try {
        const journal = JSON.parse((await safeRoot.read(`${transactionId}/journal.json`, { maxBytes: 8_192 })).buffer.toString("utf8")) as unknown;
        if (!journal || typeof journal !== "object" || (journal as any).schemaVersion !== 1 || typeof (journal as any).id !== "string") throw new Error("invalid journal");
        id = (journal as any).id;
        const hiddenMemorySegment = id.startsWith("memory/") && id.split("/").slice(1).some((segment) => segment.startsWith("."));
        if ((isProtectedWorkspaceId(id) && !isMemoryId(id)) || hiddenMemorySegment) throw new Error("invalid authority id");
      } catch {
        throw safeError("CONFLICT", "数据恢复事务损坏，请先运行诊断。", true);
      }
      const payloadId = `${transactionId}/payload`;
      let payloadExists = true;
      try { await safeRoot.stat(payloadId); }
      catch (caught) {
        if (caught instanceof FsSafeError && caught.code === "not-found") payloadExists = false;
        else throw caught;
      }
      let authorityExists = true;
      try { await safeRoot.stat(id); }
      catch (caught) {
        if (caught instanceof FsSafeError && caught.code === "not-found") authorityExists = false;
        else throw caught;
      }
      if (payloadExists && !authorityExists) await safeRoot.move(payloadId, id, { overwrite: false });
      else if (payloadExists) await safeRoot.remove(payloadId);
      await removeStagingTransaction(safeRoot, transactionId);
    }
  }

  const verifyWorkspaceShellTarget = async (
    safeRoot: Root,
    targetPath: string,
    expectedRealPath: string,
    expected: FileInfo,
    pinnedHandle?: { stat(): Promise<FileInfo> },
  ): Promise<void> => {
    const before = await lstat(targetPath);
    if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory()) || (before.isFile() && before.nlink > 1)) {
      throw safeError("FORBIDDEN", "拒绝不安全的数据路径。");
    }
    const targetReal = await realpath(targetPath);
    const after = await lstat(targetPath);
    if (
      !sameCanonicalPath(targetReal, expectedRealPath) ||
      !isPathWithin(safeRoot.rootReal, targetReal) ||
      !sameFileSnapshot(before, after) ||
      !sameFileSnapshot(after, expected) ||
      isSymbolicLink(after) ||
      (isFile(after) && after.nlink > 1)
    ) {
      throw safeError("FORBIDDEN", "受控目标在系统操作前发生变化。");
    }
    if (pinnedHandle && !sameFileSnapshot(await pinnedHandle.stat(), expected)) {
      throw safeError("FORBIDDEN", "受控目标在系统操作前发生变化。");
    }
  };

  const invokeWorkspaceShell = async (safeRoot: Root, id: string, action: WorkspaceShellAction): Promise<void> => {
    if (!options.workspaceShell) throw safeError("UNAVAILABLE", "受控系统打开组件尚未安装。");
    const targetPath = resolve(workspaceRoot, id);
    const info = await safeRoot.stat(id);
    if (!isFile(info) && !isDirectory(info)) throw safeError("FORBIDDEN", "拒绝不安全的数据路径。");

    if (isFile(info)) {
      const opened = await safeRoot.open(id, { hardlinks: "reject", symlinks: "reject" });
      try {
        const target: WorkspaceShellTarget = {
          path: targetPath,
          verify: () => verifyWorkspaceShellTarget(safeRoot, targetPath, opened.realPath, opened.stat, opened.handle),
        };
        await target.verify();
        await options.workspaceShell.invoke(action, target);
        await target.verify();
      } finally {
        await opened.handle.close().catch(() => undefined);
      }
      return;
    }

    const targetReal = await realpath(targetPath);
    const target: WorkspaceShellTarget = {
      path: targetPath,
      verify: () => verifyWorkspaceShellTarget(safeRoot, targetPath, targetReal, info),
    };
    await target.verify();
    await options.workspaceShell.invoke(action, target);
    await target.verify();
  };

  const createSearchBudget = () => {
    let entries = 0;
    let bytes = 0;
    return {
      visit(depth: number, info?: FileInfo, countBytes = false): void {
        entries += 1;
        if (countBytes && info && isFile(info)) bytes += Number(info.size);
        if (depth > searchLimits.maxDepth || entries > searchLimits.maxEntries || bytes > searchLimits.maxBytes) {
          throw safeError("FILE_TOO_LARGE", "搜索范围超过安全限制，请缩小搜索目录。");
        }
      },
    };
  };

  const assertVersion = async (safeRoot: Root, id: string, expected: string): Promise<FileInfo> => {
    if (expected.startsWith("sha256:")) {
      const current = await readFile(safeRoot, id);
      if (current.version !== expected) throw safeError("CONFLICT", "内容已被其他进程修改，请重新加载。", true);
      return current.stat;
    }
    const current = await safeRoot.stat(id);
    if (metadataVersion(current) !== expected) throw safeError("CONFLICT", "内容已被其他进程修改，请重新加载。", true);
    return current;
  };

  const stageVersionedTarget = async (safeRoot: Root, id: string, expected: string) => {
    await safeRoot.mkdir(DATA_STAGING_DIR);
    const transactionId = `${DATA_STAGING_DIR}/${randomUUID()}`;
    const stagingId = `${transactionId}/payload`;
    activeStagingTransactions.add(transactionId);
    try {
      await safeRoot.mkdir(transactionId);
      await safeRoot.create(`${transactionId}/journal.json`, `${JSON.stringify({ schemaVersion: 1, id })}\n`, { mode: 0o600 });
      await safeRoot.move(id, stagingId, { overwrite: false });
      const info = await assertVersion(safeRoot, stagingId, expected);
      return { stagingId, transactionId, info, release: () => activeStagingTransactions.delete(transactionId) };
    } catch (caught) {
      await safeRoot.move(stagingId, id, { overwrite: false }).catch(() => undefined);
      await removeStagingTransaction(safeRoot, transactionId).catch(() => undefined);
      activeStagingTransactions.delete(transactionId);
      throw caught;
    }
  };

  const restoreStagedTarget = async (safeRoot: Root, transactionId: string, stagingId: string, id: string): Promise<void> => {
    let authorityExists = true;
    try {
      await safeRoot.stat(id);
    } catch (caught) {
      if (caught instanceof FsSafeError && caught.code === "not-found") {
        authorityExists = false;
      } else throw caught;
    }
    if (authorityExists) await safeRoot.remove(stagingId);
    else await safeRoot.move(stagingId, id, { overwrite: false });
    await removeStagingTransaction(safeRoot, transactionId);
  };

  const listMemoryIds = async (safeRoot: Root): Promise<string[]> => {
    const ids: string[] = [];
    const budget = createSearchBudget();
    try {
      const memory = await readFile(safeRoot, "MEMORY.md");
      budget.visit(0, memory.stat, true);
      ids.push("MEMORY.md");
    }
    catch (caught) { if (!(caught instanceof FsSafeError && caught.code === "not-found")) throw caught; }
    const walk = async (relativeDir: string, depth: number): Promise<void> => {
      budget.visit(depth);
      let entries;
      try { entries = await safeRoot.list(relativeDir, { withFileTypes: true }); }
      catch (caught) {
        if (caught instanceof FsSafeError && caught.code === "not-found") return;
        throw caught;
      }
      for (const entry of entries) {
        const id = `${relativeDir}/${entry.name}`;
        const unsafe = entry.name.startsWith(".") || entry.isSymbolicLink || (entry.isFile && entry.nlink > 1);
        budget.visit(depth + 1, entry, !unsafe && entry.isFile && id.toLocaleLowerCase("en-US").endsWith(".md"));
        if (unsafe) continue;
        if (entry.isDirectory) await walk(id, depth + 1);
        else if (entry.isFile && id.toLocaleLowerCase("en-US").endsWith(".md")) ids.push(id);
      }
    };
    await walk("memory", 0);
    return ids.sort((left, right) => left.localeCompare(right));
  };

  const listWorkspaceEntries = async (safeRoot: Root, parentId: string | undefined, query: string): Promise<WorkspaceEntry[]> => {
    const candidates: WorkspaceEntry[] = [];
    const budget = createSearchBudget();
    const walk = async (relativeDir: string | undefined, depth: number): Promise<void> => {
      budget.visit(depth);
      for (const entry of await safeRoot.list(relativeDir ?? ".", { withFileTypes: true })) {
        budget.visit(depth + 1, entry);
        const id = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        if (isProtectedWorkspaceId(id) || entry.isSymbolicLink || (entry.isFile && entry.nlink > 1)) continue;
        if (entry.isFile || entry.isDirectory) {
          if (!query || id.toLocaleLowerCase("en-US").includes(query)) candidates.push(toWorkspaceEntry(id, entry));
          if (query && entry.isDirectory) await walk(id, depth + 1);
        }
      }
    };
    await walk(parentId, 0);
    return candidates;
  };

  const assertRemoved = async (safeRoot: Root, id: string): Promise<void> => {
    try {
      await safeRoot.stat(id);
    } catch (caught) {
      if (caught instanceof FsSafeError && caught.code === "not-found") return;
      throw caught;
    }
    throw safeError("CONFLICT", "项目删除后仍可见，请重新加载。", true);
  };

  const failure = (request: DataIpcRequest, caught: unknown): DataIpcResponse => {
    const known = UClawErrorSchema.safeParse(caught);
    let mapped: UClawError;
    if (known.success) mapped = known.data;
    else if (caught instanceof FsSafeError) {
      if (caught.code === "not-found") mapped = safeError("NOT_FOUND", "项目不存在。");
      else if (caught.code === "too-large") mapped = safeError("FILE_TOO_LARGE", "文件过大，无法在应用内打开。");
      else if (caught.code === "already-exists" || caught.code === "not-empty") mapped = safeError("CONFLICT", "目标名称已存在或目录不为空。");
      else mapped = safeError("FORBIDDEN", "拒绝不安全的数据路径。");
    } else {
      const code = (caught as NodeJS.ErrnoException)?.code;
      mapped = code === "EACCES" || code === "EPERM"
        ? safeError("FORBIDDEN", "项目不可读。")
        : safeError("OPERATION_FAILED", "数据操作失败。");
    }
    return DataIpcResponseSchema.parse({ method: request.method, requestId: request.requestId, ok: false, error: mapped });
  };

  const dispatch = async (rawRequest: DataIpcRequest): Promise<DataIpcResponse> => {
    const request = DataIpcRequestSchema.parse(rawRequest);
    try {
      let result: unknown;
      switch (request.method) {
        case "data.contract":
          result = DATA_ROOT_CONTRACT;
          break;
        case "data.status": {
          await getRoot();
          let writable = true;
          try { await access(workspaceRoot, constants.W_OK); } catch { writable = false; }
          result = { state: writable ? "available" : "read-only", writable };
          break;
        }
        case "backup.preview":
          if (!maintenance) throw safeError("UNAVAILABLE", "备份服务未配置。");
          result = await maintenance.previewBackup(request.params.collectionIds, request.params.trigger, request.params.retainLatest);
          break;
        case "backup.list":
          if (!maintenance) throw safeError("UNAVAILABLE", "备份服务未配置。");
          result = { items: await maintenance.listBackups() };
          break;
        case "backup.create":
          if (!maintenance) throw safeError("UNAVAILABLE", "备份服务未配置。");
          await maintenance.assertNoRecoveryState();
          result = maintenance.createBackup(request.params);
          break;
        case "backup.restore-preview":
          if (!maintenance) throw safeError("UNAVAILABLE", "恢复服务未配置。");
          result = await maintenance.previewRestore(request.params.backupId, request.params.collectionIds);
          break;
        case "backup.restore":
          if (!maintenance) throw safeError("UNAVAILABLE", "恢复服务未配置。");
          await maintenance.assertNoRecoveryState();
          result = maintenance.restoreBackup(request.params);
          break;
        case "storage.stats":
          if (!maintenance) throw safeError("UNAVAILABLE", "空间服务未配置。");
          result = await maintenance.storageStats();
          break;
        case "cleanup.preview":
          if (!maintenance) throw safeError("UNAVAILABLE", "清理服务未配置。");
          result = await maintenance.previewCleanup(request.params.candidateIds);
          break;
        case "cleanup.execute":
          if (!maintenance) throw safeError("UNAVAILABLE", "清理服务未配置。");
          await maintenance.assertNoRecoveryState();
          result = maintenance.executeCleanup(request.params.candidateIds, request.params.previewToken);
          break;
        case "factory-reset.preview":
          if (!maintenance) throw safeError("UNAVAILABLE", "恢复出厂服务未配置。");
          result = await maintenance.previewFactoryReset();
          break;
        case "factory-reset.execute":
          if (!maintenance) throw safeError("UNAVAILABLE", "恢复出厂服务未配置。");
          result = maintenance.executeFactoryReset({ previewToken: request.params.previewToken });
          break;
        case "maintenance.operation-get":
          if (!maintenance) throw safeError("UNAVAILABLE", "维护服务未配置。");
          result = maintenance.getOperation(request.params.operationId);
          break;
        case "maintenance.operation-cancel":
          if (!maintenance) throw safeError("UNAVAILABLE", "维护服务未配置。");
          result = maintenance.cancelOperation(request.params.operationId);
          break;
        case "workspace.list": {
          const { parentId } = request.params;
          if (parentId) assertWorkspaceDomain(parentId);
          const safeRoot = await getRoot();
          const query = request.params.query?.toLocaleLowerCase("en-US") ?? "";
          const candidates = await listWorkspaceEntries(safeRoot, parentId, query);
          candidates.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1);
          const offset = parseCursor(request.params.cursor);
          const limit = request.params.limit ?? 50;
          result = { items: candidates.slice(offset, offset + limit), nextCursor: offset + limit < candidates.length ? String(offset + limit) : null, hasMore: offset + limit < candidates.length };
          break;
        }
        case "workspace.read": {
          assertWorkspaceDomain(request.params.entryId);
          const safeRoot = await getRoot();
          const read = await readFile(safeRoot, request.params.entryId);
          result = { entry: toWorkspaceEntry(request.params.entryId, read.stat, read.version), content: read.buffer.toString("utf8"), encoding: "utf-8" };
          break;
        }
        case "workspace.open":
        case "workspace.reveal": {
          assertWorkspaceDomain(request.params.entryId);
          const safeRoot = await getRoot();
          await invokeWorkspaceShell(
            safeRoot,
            request.params.entryId,
            request.method === "workspace.open" ? "open" : "reveal",
          );
          result = null;
          break;
        }
        case "workspace.rename":
        case "workspace.move":
        case "workspace.delete":
          result = await mutationCoordinator.runVersioned({
            method: request.method,
            id: request.params.entryId,
            expectedVersion: request.params.version,
          }, async () => {
            assertWorkspaceDomain(request.params.entryId);
            const safeRoot = await getRoot();
            if (request.method === "workspace.delete") {
              const staged = await stageVersionedTarget(safeRoot, request.params.entryId, request.params.version);
              try {
                await removeStagingTransaction(safeRoot, staged.transactionId, staged.stagingId);
                await assertRemoved(safeRoot, request.params.entryId);
                return null;
              } catch (caught) {
                await restoreStagedTarget(safeRoot, staged.transactionId, staged.stagingId, request.params.entryId).catch(() => undefined);
                throw caught;
              } finally { staged.release(); }
            }
            const sourceInfo = await assertVersion(safeRoot, request.params.entryId, request.params.version);
            const parentId = request.method === "workspace.move"
              ? request.params.destinationId
              : dirname(request.params.entryId) === "." ? undefined : dirname(request.params.entryId);
            if (parentId) {
              assertWorkspaceDomain(parentId);
              const parent = await safeRoot.stat(parentId);
              if (!parent.isDirectory) throw safeError("INVALID_ARGUMENT", "目标不是目录。");
            }
            const targetName = request.method === "workspace.rename" ? request.params.name : basename(request.params.entryId);
            const targetId = parentId ? `${parentId}/${targetName}` : targetName;
            assertWorkspaceDomain(targetId);
            await safeRoot.move(request.params.entryId, targetId, { overwrite: false });
            const target = await safeRoot.stat(targetId);
            const movedRead = isFile(sourceInfo) && request.params.version.startsWith("sha256:")
              ? await readFile(safeRoot, targetId)
              : undefined;
            if (!sameFileIdentity(sourceInfo, target) || (movedRead !== undefined && movedRead.version !== request.params.version)) {
              await safeRoot.move(targetId, request.params.entryId, { overwrite: false }).catch(() => undefined);
              throw safeError("CONFLICT", "源项目在移动期间发生变化，请重新加载。", true);
            }
            const version = movedRead !== undefined
              ? movedRead.version
              : metadataVersion(target);
            return toWorkspaceEntry(targetId, target, version);
          });
          break;
        case "memory.list": {
          const safeRoot = await getRoot();
          const query = request.params.query?.toLocaleLowerCase("en-US") ?? "";
          const items: MemoryEntry[] = [];
          for (const id of await listMemoryIds(safeRoot)) {
            const read = await readFile(safeRoot, id);
            if (query && !`${id}\n${memoryTitle(id)}\n${read.buffer.toString("utf8")}`.toLocaleLowerCase("en-US").includes(query)) continue;
            items.push(toMemoryEntry(id, read.stat, read.version));
          }
          const offset = parseCursor(request.params.cursor);
          const limit = request.params.limit ?? 50;
          result = { items: items.slice(offset, offset + limit), nextCursor: offset + limit < items.length ? String(offset + limit) : null, hasMore: offset + limit < items.length };
          break;
        }
        case "memory.read": {
          assertMemoryDomain(request.params.memoryId);
          const safeRoot = await getRoot();
          const read = await readFile(safeRoot, request.params.memoryId);
          result = { memory: toMemoryEntry(request.params.memoryId, read.stat, read.version), content: read.buffer.toString("utf8") };
          break;
        }
        case "memory.write":
          result = await mutationCoordinator.runVersioned({
            method: request.method,
            id: request.params.memoryId,
            expectedVersion: request.params.version,
          }, async () => {
            assertMemoryDomain(request.params.memoryId);
            const safeRoot = await getRoot();
            const staged = await stageVersionedTarget(safeRoot, request.params.memoryId, request.params.version);
            try {
              await safeRoot.create(request.params.memoryId, request.params.content, { mode: 0o600 });
              let written;
              try {
                written = await readFile(safeRoot, request.params.memoryId);
              } catch {
                throw safeError("CONFLICT", "内容已被其他进程修改，请重新加载。", true);
              }
              if (!written.buffer.equals(Buffer.from(request.params.content, "utf8"))) {
                throw safeError("CONFLICT", "内容已被其他进程修改，请重新加载。", true);
              }
              await removeStagingTransaction(safeRoot, staged.transactionId, staged.stagingId);
              return { memory: toMemoryEntry(request.params.memoryId, written.stat, written.version) };
            } catch (caught) {
              await restoreStagedTarget(safeRoot, staged.transactionId, staged.stagingId, request.params.memoryId);
              if (caught instanceof FsSafeError) {
                throw safeError("CONFLICT", "内容已被其他进程修改，请重新加载。", true);
              }
              throw caught;
            } finally { staged.release(); }
          });
          break;
        case "memory.delete":
          result = await mutationCoordinator.runVersioned({
            method: request.method,
            id: request.params.memoryId,
            expectedVersion: request.params.version,
          }, async () => {
            assertMemoryDomain(request.params.memoryId);
            const safeRoot = await getRoot();
            const staged = await stageVersionedTarget(safeRoot, request.params.memoryId, request.params.version);
            try {
              await removeStagingTransaction(safeRoot, staged.transactionId, staged.stagingId);
              await assertRemoved(safeRoot, request.params.memoryId);
              return null;
            } catch (caught) {
              await restoreStagedTarget(safeRoot, staged.transactionId, staged.stagingId, request.params.memoryId).catch(() => undefined);
              throw caught;
            } finally { staged.release(); }
          });
          break;
      }
      return DataIpcResponseSchema.parse({ method: request.method, requestId: request.requestId, ok: true, result });
    } catch (caught) {
      return failure(request, caught);
    }
  };

  return {
    dispatch,
    async setAvailableForTest(available: boolean) { availableOverride = available; },
  };
}
