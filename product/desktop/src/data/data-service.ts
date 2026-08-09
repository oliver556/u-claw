import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { FsSafeError, root, type Root } from "@openclaw/fs-safe";
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
const CONTROL_FILES = new Set([
  "agents.md", "soul.md", "tools.md", "identity.md", "user.md", "heartbeat.md", "bootstrap.md", "dreams.md",
]);

interface DataServiceOptions {
  dataDir: string;
  cacheDir?: string;
  acquireConsistencyLease?(): Promise<{ release(): Promise<void> }>;
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
  const first = id.split("/")[0]?.toLocaleLowerCase("en-US") ?? "";
  return first === "memory" || first === "memory.md" || CONTROL_FILES.has(first) || first.startsWith(".");
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
  const maintenance = options.cacheDir === undefined ? undefined : createMaintenanceService({
    dataDir: options.dataDir,
    cacheDir: options.cacheDir,
    acquireConsistencyLease: options.acquireConsistencyLease,
  });
  let availableOverride: boolean | undefined;
  let mutationQueue = Promise.resolve();

  const serialized = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = mutationQueue;
    let release!: () => void;
    mutationQueue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    await previous;
    try { return await operation(); } finally { release(); }
  };

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
    if (!isMemoryId(id) || id.startsWith("memory/.")) throw safeError("FORBIDDEN", "该项目不属于 OpenClaw 记忆域。");
  };

  const readFile = async (safeRoot: Root, id: string) => {
    const read = await safeRoot.read(id, { hardlinks: "reject", maxBytes: MAX_TEXT_BYTES, symlinks: "reject" });
    return { ...read, version: contentVersion(read.buffer, read.stat) };
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

  const listMemoryIds = async (safeRoot: Root): Promise<string[]> => {
    const ids: string[] = [];
    try { await readFile(safeRoot, "MEMORY.md"); ids.push("MEMORY.md"); }
    catch (caught) { if (!(caught instanceof FsSafeError && caught.code === "not-found")) throw caught; }
    const walk = async (relativeDir: string): Promise<void> => {
      let entries;
      try { entries = await safeRoot.list(relativeDir, { withFileTypes: true }); }
      catch (caught) {
        if (caught instanceof FsSafeError && caught.code === "not-found") return;
        throw caught;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.isSymbolicLink || (entry.isFile && entry.nlink > 1)) continue;
        const id = `${relativeDir}/${entry.name}`;
        if (entry.isDirectory) await walk(id);
        else if (entry.isFile && id.toLocaleLowerCase("en-US").endsWith(".md")) ids.push(id);
      }
    };
    await walk("memory");
    return ids.sort((left, right) => left.localeCompare(right));
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
          const query = request.params.query?.toLocaleLowerCase() ?? "";
          const candidates: WorkspaceEntry[] = [];
          for (const entry of await safeRoot.list(parentId ?? ".", { withFileTypes: true })) {
            const id = parentId ? `${parentId}/${entry.name}` : entry.name;
            if (isProtectedWorkspaceId(id) || entry.isSymbolicLink || (entry.isFile && entry.nlink > 1) || (query && !entry.name.toLocaleLowerCase().includes(query))) continue;
            if (entry.isFile || entry.isDirectory) candidates.push(toWorkspaceEntry(id, entry));
          }
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
          const opened = await safeRoot.open(request.params.entryId, { hardlinks: "reject", symlinks: "reject" });
          await opened.handle.close();
          throw safeError("UNAVAILABLE", "受控系统打开组件尚未安装。");
        }
        case "workspace.rename":
        case "workspace.move":
        case "workspace.delete":
          result = await serialized(async () => {
            assertWorkspaceDomain(request.params.entryId);
            const safeRoot = await getRoot();
            const sourceInfo = await assertVersion(safeRoot, request.params.entryId, request.params.version);
            if (request.method === "workspace.delete") {
              await safeRoot.remove(request.params.entryId);
              return null;
            }
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
            const version = isFile(sourceInfo) && request.params.version.startsWith("sha256:")
              ? (await readFile(safeRoot, targetId)).version
              : metadataVersion(target);
            return toWorkspaceEntry(targetId, target, version);
          });
          break;
        case "memory.list": {
          const safeRoot = await getRoot();
          const query = request.params.query?.toLocaleLowerCase() ?? "";
          const items: MemoryEntry[] = [];
          for (const id of await listMemoryIds(safeRoot)) {
            if (query && !id.toLocaleLowerCase().includes(query)) continue;
            const read = await readFile(safeRoot, id);
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
          result = await serialized(async () => {
            assertMemoryDomain(request.params.memoryId);
            const safeRoot = await getRoot();
            await assertVersion(safeRoot, request.params.memoryId, request.params.version);
            await safeRoot.write(request.params.memoryId, request.params.content, { mode: 0o600, overwrite: true });
            const written = await readFile(safeRoot, request.params.memoryId);
            if (!written.buffer.equals(Buffer.from(request.params.content, "utf8"))) {
              throw safeError("CONFLICT", "内容已被其他进程修改，请重新加载。", true);
            }
            return { memory: toMemoryEntry(request.params.memoryId, written.stat, written.version) };
          });
          break;
        case "memory.delete":
          result = await serialized(async () => {
            assertMemoryDomain(request.params.memoryId);
            const safeRoot = await getRoot();
            await assertVersion(safeRoot, request.params.memoryId, request.params.version);
            await safeRoot.remove(request.params.memoryId);
            return null;
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
