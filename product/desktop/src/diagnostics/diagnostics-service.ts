import { createHash, randomUUID } from "node:crypto";
import { access, lstat, realpath, statfs } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { FsSafeError, root, type Root } from "@openclaw/fs-safe";
import {
  DiagnosticsIpcRequestSchema,
  DiagnosticsIpcResponseSchema,
  DiagnosticLogEntrySchema,
  UClawErrorSchema,
  normalizeKey,
  type DiagnosticLogEntry,
  type DiagnosticsIpcRequest,
  type DiagnosticsIpcResponse,
  type RendererRedactedValue,
  type UClawClient,
  type UClawError,
} from "@uclaw/shared";

import { LOG_OWNERSHIP_MANIFEST } from "../portable-paths.js";

const MAX_CONFIG_BYTES = 1_000_000;
const MAX_EXPORT_BYTES = 10 * 1024 * 1024;
const MAX_EXPORT_ENTRIES = 20_000;
const MAX_MANIFEST_BYTES = 64 * 1024;
const PREVIEW_TTL_MS = 5 * 60_000;
const MAX_FILTER_SCAN_PAGES = 20;
const MAX_EXPORT_PAGES = 100;
const MAX_ACTIVE_OPERATIONS = 8;
const OWNERSHIP_MANIFEST = ".uclaw-log-ownership.json";
const OWNED_LOG_NAME = /^uclaw-[A-Za-z0-9._-]+\.(?:log|jsonl)$/;
const SAFE_CURSOR = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]{1,40})?$/;
const SAFE_CONFIG_STATES = new Set(["active", "disabled", "enabled", "error", "offline", "ready", "starting", "unknown"]);
const SAFE_CONFIG_MODES = new Set(["auto", "local", "manual", "portable", "read-only"]);
const SAFE_CONFIG_PROTOCOLS = new Set(["http", "https", "stdio", "websocket"]);
const SAFE_CONFIG_KEYS = new Set(["gateway", "port", "status", "state", "type", "mode", "protocol", "enabled", "configured", "portable", "timeout_ms", "max_retries", "retry_delay_ms"]);
const LOG_SOURCE_LABELS: Record<DiagnosticLogEntry["source"], string> = {
  launcher: "Launcher", desktop: "Desktop", adapter: "Adapter", gateway: "Gateway",
  openclaw: "OpenClaw", channel: "Channel",
};

export interface DiagnosticsRuntimeInfo {
  productVersion: string;
  openClawVersion?: string;
  gatewayPort?: number;
  gatewayStatus?: "starting" | "ready" | "degraded" | "offline" | "unknown";
}

export interface DiagnosticsServiceOptions {
  dataDir: string;
  logsDir: string;
  configPath: string;
  diagnostics: UClawClient["diagnostics"];
  runtime: DiagnosticsRuntimeInfo;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
}

interface CleanupCandidate { name: string; size: number; modifiedAt: string; version: string }
interface CleanupPreview { expiresAt: number; retentionDays: number; files: CleanupCandidate[] }

function safeError(code: UClawError["code"], message: string, retryable = false): UClawError {
  return UClawErrorSchema.parse({ code, message, retryable, recoveryActions: retryable ? ["retry"] : [], causeDetails: {} });
}

function failure(request: DiagnosticsIpcRequest, caught: unknown): DiagnosticsIpcResponse {
  const parsed = UClawErrorSchema.safeParse(caught);
  let error = parsed.success ? parsed.data : safeError("OPERATION_FAILED", "诊断操作失败。", true);
  if (caught instanceof FsSafeError) {
    if (caught.code === "already-exists") error = safeError("CONFLICT", "导出文件已存在。请更换文件名。");
    else if (caught.code === "not-found") error = safeError("NOT_FOUND", "诊断数据不存在。");
    else if (caught.code === "too-large") error = safeError("FILE_TOO_LARGE", "诊断数据超过读取上限。");
    else error = safeError("FORBIDDEN", "拒绝不安全的诊断文件操作。");
  }
  return DiagnosticsIpcResponseSchema.parse({ method: request.method, requestId: request.requestId, ok: false, error });
}

function fileVersion(entry: { dev: number; ino: number; size: number; mtimeMs: number; nlink: number }): string {
  return `${entry.dev}:${entry.ino}:${entry.size}:${entry.mtimeMs}:${entry.nlink}`;
}

function safeVersion(value: string | undefined): string {
  return value !== undefined && value.length <= 80 && SAFE_VERSION.test(value) ? value : "unknown";
}

function safeProxy(environment: NodeJS.ProcessEnv): string | null {
  return environment.HTTPS_PROXY ?? environment.https_proxy ?? environment.HTTP_PROXY ?? environment.http_proxy
    ? "已配置（值已隐藏）"
    : null;
}

function safeCursor(value: string | null): string | null {
  return value !== null && SAFE_CURSOR.test(value) ? value : null;
}

function projectLog(entry: Awaited<ReturnType<UClawClient["diagnostics"]["listLogs"]>>["items"][number], index: number, cursor?: string): DiagnosticLogEntry {
  const safeId = createHash("sha256").update(`${cursor ?? "first"}:${index}:${entry.timestamp}:${entry.source}:${entry.level}`).digest("hex").slice(0, 20);
  return DiagnosticLogEntrySchema.parse({
    id: `log-${safeId}`,
    timestamp: entry.timestamp,
    level: entry.level,
    source: entry.source,
    message: `${LOG_SOURCE_LABELS[entry.source]} ${entry.level} event.`,
  });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const abort = () => rejectPromise(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolvePromise, rejectPromise).finally(() => signal.removeEventListener("abort", abort));
  });
}

function matchesLog(entry: DiagnosticLogEntry, params: Extract<DiagnosticsIpcRequest, { method: "logs.list" | "logs.export" }>["params"]): boolean {
  if (params.levels && !params.levels.includes(entry.level)) return false;
  if (params.sources && !params.sources.includes(entry.source)) return false;
  if (params.from && entry.timestamp < params.from) return false;
  if (params.to && entry.timestamp > params.to) return false;
  const query = params.query?.toLocaleLowerCase();
  return !query || `${entry.source} ${entry.level} ${entry.message}`.toLocaleLowerCase().includes(query);
}

function flattenConfig(value: RendererRedactedValue, prefix = "", output: Array<{ path: string; value: string }> = []): Array<{ path: string; value: string }> {
  if (output.length >= 500) return output;
  if (Array.isArray(value)) value.slice(0, 100).forEach((item, index) => flattenConfig(item, `${prefix}[${index}]`, output));
  else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value).slice(0, 100)) flattenConfig(child, prefix ? `${prefix}.${key}` : key, output);
  } else if (prefix) output.push({ path: prefix, value: String(value) });
  return output;
}

const SAFE_CONFIG_NUMBER_KEYS = new Set(["port", "timeout_ms", "max_retries", "retry_delay_ms"]);
const SAFE_CONFIG_BOOLEAN_KEYS = new Set(["enabled", "configured", "portable"]);
const SENSITIVE_CONFIG_KEY = /(?:^|_)(?:authorization|body|cause|content|cookie|credentials?|headers?|key|message|model|password|path|private|prompt|provider|secret|stack|text|token)(?:_|$)/;

function redactConfigTree(value: unknown, contextKey?: string, depth = 0): RendererRedactedValue {
  if (depth > 12) return "[REDACTED]";
  const key = contextKey === undefined ? "" : normalizeKey(contextKey);
  if (key && SENSITIVE_CONFIG_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactConfigTree(item, undefined, depth + 1));
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const result: Record<string, RendererRedactedValue> = {};
    for (const [index, [rawKey, child]] of Object.entries(value as Record<string, unknown>).slice(0, 100).entries()) {
      const safeKey = rawKey.length <= 64 && SAFE_CONFIG_KEYS.has(normalizeKey(rawKey));
      result[safeKey ? rawKey : `field_${index + 1}`] = redactConfigTree(child, rawKey, depth + 1);
    }
    return result;
  }
  if (typeof value === "string") {
    if ((key === "status" || key === "state") && SAFE_CONFIG_STATES.has(value)) return value;
    if (key === "mode" && SAFE_CONFIG_MODES.has(value)) return value;
    if (key === "protocol" && SAFE_CONFIG_PROTOCOLS.has(value)) return value;
  }
  if (typeof value === "number" && Number.isFinite(value) && SAFE_CONFIG_NUMBER_KEYS.has(key)) return value;
  if (typeof value === "boolean" && SAFE_CONFIG_BOOLEAN_KEYS.has(key)) return value;
  if (value === null) return null;
  return "[REDACTED]";
}

export function createDiagnosticsService(options: DiagnosticsServiceOptions) {
  if (![options.dataDir, options.logsDir, options.configPath].every(isAbsolute)) throw new Error("Diagnostics paths must be absolute.");
  const dataDir = resolve(options.dataDir);
  const logsDir = resolve(options.logsDir);
  const configPath = resolve(options.configPath);
  if (relative(dataDir, logsDir).startsWith("..") || relative(dataDir, configPath).startsWith("..")) throw new Error("Diagnostics paths must remain inside portable data.");
  const now = options.now ?? Date.now;
  const environment = options.environment ?? process.env;
  const previews = new Map<string, CleanupPreview>();
  const controllers = new Map<string, AbortController>();

  const openRoot = async (path: string, maxBytes = MAX_CONFIG_BYTES): Promise<Root> => {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw safeError("FORBIDDEN", "诊断目录不安全。");
    const safeRoot = await root(path, { hardlinks: "reject", symlinks: "reject", maxBytes, mkdir: false });
    const portableReal = await realpath(dataDir);
    if (relative(portableReal, safeRoot.rootReal).startsWith("..")) throw safeError("FORBIDDEN", "诊断目录越界。");
    return safeRoot;
  };

  const ownedLogNames = async (logs: Root): Promise<string[]> => {
    const manifest = JSON.parse(await logs.readText(OWNERSHIP_MANIFEST, { maxBytes: MAX_MANIFEST_BYTES })) as unknown;
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) throw safeError("CONTRACT_INCOMPATIBLE", "日志所有权清单无效。");
    const record = manifest as Record<string, unknown>;
    if (JSON.stringify(record) !== JSON.stringify(LOG_OWNERSHIP_MANIFEST)) throw safeError("CONTRACT_INCOMPATIBLE", "日志所有权清单无效。");
    const allowed = new Set<string>(LOG_OWNERSHIP_MANIFEST.files.filter((name) => OWNED_LOG_NAME.test(name)));
    const entries = await logs.list(".", { withFileTypes: true });
    return entries.filter((entry) => allowed.has(entry.name) && entry.isFile && !entry.isSymbolicLink && entry.nlink === 1).map((entry) => entry.name).sort();
  };

  const recoverQuarantine = async (logs: Root): Promise<void> => {
    if (!await logs.exists(".cleanup-quarantine")) return;
    const allowed = new Set<string>(LOG_OWNERSHIP_MANIFEST.files);
    for (const directory of await logs.list(".cleanup-quarantine", { withFileTypes: true })) {
      if (!directory.isDirectory || !/^[0-9a-f-]{36}$/.test(directory.name)) continue;
      const quarantine = `.cleanup-quarantine/${directory.name}`;
      for (const entry of await logs.list(quarantine, { withFileTypes: true })) {
        if (allowed.has(entry.name) && entry.isFile && !entry.isSymbolicLink && entry.nlink === 1) await logs.remove(`${quarantine}/${entry.name}`).catch(() => undefined);
      }
      if ((await logs.list(quarantine)).length === 0) await logs.remove(quarantine).catch(() => undefined);
    }
  };

  const loadRawLogPage = async (
    pageRequest: { cursor?: string; limit: number },
    signal: AbortSignal,
    indexOffset = 0,
  ) => {
    signal.throwIfAborted();
    const page = await abortable(options.diagnostics.listLogs(pageRequest, signal), signal);
    signal.throwIfAborted();
    const items = page.items.map((entry, index) => projectLog(entry, indexOffset + index, pageRequest.cursor));
    const nextCursor = safeCursor(page.nextCursor);
    if (pageRequest.cursor !== undefined && page.hasMore && nextCursor === pageRequest.cursor) throw safeError("CONTRACT_INCOMPATIBLE", "日志分页游标重复。");
    return { items, nextCursor, hasMore: nextCursor !== null && page.hasMore };
  };

  const loadFilteredLogPage = async (params: Extract<DiagnosticsIpcRequest, { method: "logs.list" }>["params"], signal: AbortSignal) => {
    let cursor = params.cursor;
    const seen = new Set<string>();
    for (let pageNumber = 0; pageNumber < MAX_FILTER_SCAN_PAGES; pageNumber += 1) {
      if (cursor !== undefined && seen.has(cursor)) throw safeError("CONTRACT_INCOMPATIBLE", "日志分页游标重复。");
      if (cursor !== undefined) seen.add(cursor);
      const page = await loadRawLogPage({ ...(cursor ? { cursor } : {}), limit: params.limit }, signal, pageNumber * params.limit);
      const items = page.items.filter((entry) => matchesLog(entry, params));
      if (items.length > 0 || !page.hasMore || page.nextCursor === null) return { ...page, items };
      cursor = page.nextCursor;
    }
    throw safeError("FILE_TOO_LARGE", "日志筛选超过单次扫描上限，请缩小范围。");
  };

  const redactedConfig = async () => {
    const parent = resolve(configPath, "..");
    const configRoot = await openRoot(parent);
    const raw = await configRoot.readText(relative(parent, configPath), { hardlinks: "reject", maxBytes: MAX_CONFIG_BYTES, symlinks: "reject" });
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw safeError("CONTRACT_INCOMPATIBLE", "OpenClaw 配置不是有效 JSON。"); }
    const redacted = redactConfigTree(parsed);
    const content = JSON.stringify(redacted, null, 2);
    if (Buffer.byteLength(content) > MAX_CONFIG_BYTES) throw safeError("FILE_TOO_LARGE", "脱敏配置超过显示上限。");
    return { content, entries: flattenConfig(redacted), truncated: false };
  };

  const createExport = async (fileName: string, content: string) => {
    if (Buffer.byteLength(content) > MAX_EXPORT_BYTES) throw safeError("FILE_TOO_LARGE", "诊断导出超过大小上限。");
    const dataRoot = await openRoot(dataDir, MAX_EXPORT_BYTES);
    if (!await dataRoot.exists("exports")) await dataRoot.mkdir("exports");
    if (!await dataRoot.exists("exports/diagnostics")) await dataRoot.mkdir("exports/diagnostics");
    await dataRoot.create(`exports/diagnostics/${fileName}`, content, { mode: 0o600 });
    return { name: fileName, relativePath: `exports/diagnostics/${fileName}`, bytes: Buffer.byteLength(content), createdAt: new Date(now()).toISOString() };
  };

  const dispatch = async (rawRequest: DiagnosticsIpcRequest): Promise<DiagnosticsIpcResponse> => {
    const request = DiagnosticsIpcRequestSchema.parse(rawRequest);
    if (request.method === "operations.cancel") {
      controllers.get(request.params.operationRequestId)?.abort(new DOMException("Cancelled", "AbortError"));
      return DiagnosticsIpcResponseSchema.parse({ method: request.method, requestId: request.requestId, ok: true, result: null });
    }
    if (controllers.has(request.requestId)) return failure(request, safeError("CONFLICT", "诊断请求标识正在使用。"));
    if (controllers.size >= MAX_ACTIVE_OPERATIONS) return failure(request, safeError("UNAVAILABLE", "诊断操作过多，请稍后重试。", true));
    const controller = new AbortController();
    controllers.set(request.requestId, controller);
    try {
      let result: unknown;
      switch (request.method) {
        case "logs.list": result = await loadFilteredLogPage(request.params, controller.signal); break;
        case "logs.export": {
          const lines: string[] = [];
          let cursor: string | undefined;
          let count = 0;
          let bytes = 0;
          let pageCount = 0;
          const seen = new Set<string>();
          do {
            controller.signal.throwIfAborted();
            if (pageCount >= MAX_EXPORT_PAGES) throw safeError("FILE_TOO_LARGE", "诊断导出超过分页上限。");
            if (cursor !== undefined && seen.has(cursor)) throw safeError("CONTRACT_INCOMPATIBLE", "日志分页游标重复。");
            if (cursor !== undefined) seen.add(cursor);
            const page = await loadRawLogPage({ ...(cursor ? { cursor } : {}), limit: 500 }, controller.signal, pageCount * 500);
            pageCount += 1;
            for (const entry of page.items.filter((item) => matchesLog(item, request.params))) {
              const line = `${JSON.stringify(entry)}\n`;
              bytes += Buffer.byteLength(line);
              count += 1;
              if (count > MAX_EXPORT_ENTRIES || bytes > MAX_EXPORT_BYTES) throw safeError("FILE_TOO_LARGE", "诊断导出超过大小上限。");
              lines.push(line);
            }
            cursor = page.hasMore && page.nextCursor !== null ? page.nextCursor : undefined;
          } while (cursor !== undefined);
          result = await createExport(request.params.fileName, lines.join(""));
          break;
        }
        case "logs.cleanup-preview": {
          const logs = await openRoot(logsDir);
          await recoverQuarantine(logs);
          const cutoff = now() - request.params.retentionDays * 86_400_000;
          const files: CleanupCandidate[] = [];
          for (const name of await ownedLogNames(logs)) {
            const info = await logs.stat(name);
            if (info.mtimeMs < cutoff) files.push({ name, size: info.size, modifiedAt: new Date(info.mtimeMs).toISOString(), version: fileVersion(info) });
          }
          const previewId = randomUUID();
          previews.set(previewId, { expiresAt: now() + PREVIEW_TTL_MS, retentionDays: request.params.retentionDays, files });
          result = { previewId, retentionDays: request.params.retentionDays, totalBytes: files.reduce((sum, file) => sum + file.size, 0), files: files.map(({ version: _version, ...file }) => file) };
          break;
        }
        case "logs.cleanup": {
          const preview = previews.get(request.params.previewId);
          previews.delete(request.params.previewId);
          if (!preview || preview.expiresAt < now()) throw safeError("CONFLICT", "清理预览已过期，请重新预览。");
          const logs = await openRoot(logsDir);
          const owned = new Set(await ownedLogNames(logs));
          const pinned: Array<Awaited<ReturnType<Root["open"]>>> = [];
          const quarantine = `.cleanup-quarantine/${request.params.previewId}`;
          const moved: CleanupCandidate[] = [];
          try {
            for (const candidate of preview.files) {
              controller.signal.throwIfAborted();
              if (!owned.has(candidate.name)) throw safeError("CONFLICT", "日志在预览后发生变化，清理未执行。");
              const opened = await logs.open(candidate.name, { hardlinks: "reject", symlinks: "reject" });
              pinned.push(opened);
              if (fileVersion(opened.stat) !== candidate.version) throw safeError("CONFLICT", "日志在预览后发生变化，清理未执行。");
            }
            if (!await logs.exists(".cleanup-quarantine")) await logs.mkdir(".cleanup-quarantine");
            await logs.mkdir(quarantine);
            for (const candidate of preview.files) {
              controller.signal.throwIfAborted();
              await logs.move(candidate.name, `${quarantine}/${candidate.name}`, { overwrite: false });
              moved.push(candidate);
              if (fileVersion(await logs.stat(`${quarantine}/${candidate.name}`)) !== candidate.version) throw safeError("CONFLICT", "日志对象在清理期间发生变化。");
            }
          } catch (caught) {
            for (const candidate of moved.reverse()) {
              if (!await logs.exists(candidate.name)) await logs.move(`${quarantine}/${candidate.name}`, candidate.name, { overwrite: false }).catch(() => undefined);
            }
            throw caught;
          } finally {
            await Promise.all(pinned.map((opened) => opened.handle.close().catch(() => undefined)));
          }
          let pendingPhysicalFiles = 0;
          for (const candidate of moved) {
            try { await logs.remove(`${quarantine}/${candidate.name}`); } catch { pendingPhysicalFiles += 1; }
          }
          if (pendingPhysicalFiles === 0) await logs.remove(quarantine);
          result = { removedFiles: moved.length, removedBytes: moved.reduce((sum, file) => sum + file.size, 0), pendingPhysicalFiles };
          break;
        }
        case "system.get": {
          let writable = true;
          try { await access(dataDir, constants.W_OK); } catch { writable = false; }
          const storage = await statfs(dataDir);
          const totalBytes = Number(storage.blocks) * Number(storage.bsize);
          const freeBytes = Number(storage.bavail) * Number(storage.bsize);
          result = {
            product: { name: "U-Claw", version: safeVersion(options.runtime.productVersion) },
            runtime: { node: safeVersion(process.versions.node), electron: process.versions.electron ? safeVersion(process.versions.electron) : "not-running", openclaw: safeVersion(options.runtime.openClawVersion) },
            platform: ["win32", "darwin", "linux"].includes(process.platform) ? process.platform : "other",
            architecture: process.arch,
            gateway: { status: options.runtime.gatewayStatus ?? "unknown", port: options.runtime.gatewayPort ?? null },
            proxy: safeProxy(environment), portableData: { state: writable ? "available" : "read-only", writable },
            storage: { totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes) },
          };
          break;
        }
        case "config.get": {
          const config = await redactedConfig();
          const query = request.params.query?.toLocaleLowerCase();
          result = { ...config, entries: query ? config.entries.filter((entry) => entry.path.toLocaleLowerCase().includes(query)) : config.entries };
          break;
        }
        case "config.export": result = await createExport(request.params.fileName, `${(await redactedConfig()).content}\n`); break;
      }
      return DiagnosticsIpcResponseSchema.parse({ method: request.method, requestId: request.requestId, ok: true, result });
    } catch (caught) {
      if (controller.signal.aborted) return failure(request, safeError("CANCELLED", "诊断操作已取消。"));
      return failure(request, caught);
    } finally {
      if (controllers.get(request.requestId) === controller) controllers.delete(request.requestId);
    }
  };

  return { dispatch };
}
