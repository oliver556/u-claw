import { createHash, randomUUID } from "node:crypto";
import { access, lstat, realpath, statfs } from "node:fs/promises";
import { constants } from "node:fs";
import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { FsSafeError, root, type Root } from "@openclaw/fs-safe";
import {
  DiagnosticsIpcRequestSchema,
  DiagnosticsIpcResponseSchema,
  DiagnosticLogEntrySchema,
  DOCTOR_REPAIR_ACTION_IDS,
  UClawErrorSchema,
  normalizeKey,
  type DiagnosticLogEntry,
  type DiagnosticsIpcRequest,
  type DiagnosticsIpcResponse,
  type DoctorRepairActionId,
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
  networkProbe?(target: NetworkProbeTarget, signal: AbortSignal): Promise<NetworkProbeOutcome>;
  doctorRepairActions?: Partial<Record<DoctorRepairActionId, (signal: AbortSignal) => Promise<void>>>;
  auditDoctorRepair?(event: DoctorRepairAuditEvent): void;
}

export interface DoctorRepairAuditEvent {
  event: "previewed" | "confirmed" | "started" | "succeeded" | "failed" | "cancelled" | "timed-out";
  actionId: DoctorRepairActionId;
  requestId: string;
  previewToken: string;
  timestamp: string;
}

export type NetworkProbeTarget = "portable-data" | "runtime" | "gateway" | "local-port" | "dns" | "provider" | "channels" | "capabilities";
export type NetworkProbeOutcome = "reachable" | "unreachable" | "unavailable" | "skipped";

interface CleanupCandidate { name: string; size: number; modifiedAt: string; version: string }
interface CleanupPreview { expiresAt: number; retentionDays: number; files: CleanupCandidate[] }
interface DoctorPreview { actionId: DoctorRepairActionId; expiresAt: number }

function safeError(code: UClawError["code"], message: string, retryable = false): UClawError {
  return UClawErrorSchema.parse({ code, message, retryable, recoveryActions: retryable ? ["retry"] : [], causeDetails: {} });
}

function failure(request: DiagnosticsIpcRequest, caught: unknown): DiagnosticsIpcResponse {
  const parsed = UClawErrorSchema.safeParse(caught);
  const nested = UClawErrorSchema.safeParse((caught as { uclawError?: unknown } | null)?.uclawError);
  let error = parsed.success ? parsed.data : nested.success ? nested.data : safeError("OPERATION_FAILED", "诊断操作失败。", true);
  if (caught instanceof DOMException && caught.name === "TimeoutError") error = safeError("TIMEOUT", "诊断操作超时。", true);
  if (error.code === "UNSUPPORTED") error = safeError("UNAVAILABLE", "当前 OpenClaw runtime 未提供结构化诊断 adapter。");
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

function isWithin(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return candidate === "" || (!candidate.startsWith(`..${sep}`) && candidate !== ".." && !isAbsolute(candidate));
}

const DOCTOR_LABELS: Record<string, string> = {
  gateway: "Gateway", runtime: "OpenClaw runtime", configuration: "配置", provider: "Provider", channels: "渠道", capabilities: "能力依赖",
};

export function createDiagnosticsService(options: DiagnosticsServiceOptions) {
  if (![options.dataDir, options.logsDir, options.configPath].every(isAbsolute)) throw new Error("Diagnostics paths must be absolute.");
  const dataDir = resolve(options.dataDir);
  const logsDir = resolve(options.logsDir);
  const configPath = resolve(options.configPath);
  if (!isWithin(dataDir, logsDir) || !isWithin(dataDir, configPath)) throw new Error("Diagnostics paths must remain inside portable data.");
  const now = options.now ?? Date.now;
  const environment = options.environment ?? process.env;
  const previews = new Map<string, CleanupPreview>();
  const doctorPreviews = new Map<string, DoctorPreview>();
  const controllers = new Map<string, AbortController>();
  let doctorGeneration = 0;
  let repairActive = false;
  const doctorRepairActionIds = new Set<DoctorRepairActionId>(DOCTOR_REPAIR_ACTION_IDS);
  const auditDoctorRepair = (event: Omit<DoctorRepairAuditEvent, "timestamp">): void => {
    try { options.auditDoctorRepair?.({ ...event, timestamp: new Date(now()).toISOString() }); } catch { /* audit sinks cannot alter repair control flow */ }
  };

  const defaultNetworkProbe = async (target: NetworkProbeTarget, signal: AbortSignal): Promise<NetworkProbeOutcome> => {
    try {
      signal.throwIfAborted();
      if (target === "portable-data") { await access(dataDir, constants.R_OK); return "reachable"; }
      if (target === "runtime") return safeVersion(options.runtime.openClawVersion) === "unknown" ? "unreachable" : "reachable";
      if (target === "gateway") return options.runtime.gatewayStatus === "ready" || options.runtime.gatewayStatus === "degraded" ? "reachable" : "unreachable";
      if (target === "local-port") {
        if (!options.runtime.gatewayPort) return "unreachable";
        await new Promise<void>((resolvePromise, rejectPromise) => {
          const socket = connect({ host: "127.0.0.1", port: options.runtime.gatewayPort! });
          const abort = () => { socket.destroy(); rejectPromise(signal.reason); };
          signal.addEventListener("abort", abort, { once: true });
          socket.once("connect", () => { signal.removeEventListener("abort", abort); socket.destroy(); resolvePromise(); });
          socket.once("error", (error) => { signal.removeEventListener("abort", abort); rejectPromise(error); });
        });
        return "reachable";
      }
      if (target === "dns") { await lookup("openclaw.ai"); return "reachable"; }
      if (target === "provider") { await fetch("https://api.openai.com", { method: "HEAD", redirect: "manual", signal }); return "reachable"; }
      return target === "channels" ? "unavailable" : "skipped";
    } catch (caught) {
      if (signal.aborted) throw caught;
      return "unreachable";
    }
  };
  const networkProbe = options.networkProbe ?? defaultNetworkProbe;

  const withTimeout = async <T>(task: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, timeoutMs: number): Promise<T> => {
    const controller = new AbortController();
    const abort = () => controller.abort(parent.reason);
    parent.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException("Probe timeout", "TimeoutError")), timeoutMs);
    try { return await abortable(task(controller.signal), controller.signal); }
    finally { clearTimeout(timer); parent.removeEventListener("abort", abort); }
  };

  const runNetworkDiagnostics = async (signal: AbortSignal, timeoutMs: number) => {
    const targets: Array<{ id: NetworkProbeTarget; label: string }> = [
      { id: "portable-data", label: "U 盘与数据根" }, { id: "runtime", label: "OpenClaw runtime" },
      { id: "gateway", label: "Gateway" }, { id: "local-port", label: "本机端口" },
      { id: "dns", label: "DNS" }, { id: "provider", label: "Provider 连通" },
      { id: "channels", label: "渠道依赖" }, { id: "capabilities", label: "能力依赖" },
    ];
    const outcomes = new Map<NetworkProbeTarget, { outcome: NetworkProbeOutcome; durationMs: number }>();
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const target = targets[cursor++]!;
        const startedAt = now();
        const outcome = await withTimeout((probeSignal) => networkProbe(target.id, probeSignal), signal, timeoutMs).catch((caught) => {
          if (signal.aborted) throw caught;
          return "unreachable" as const;
        });
        outcomes.set(target.id, { outcome, durationMs: Math.min(60_000, Math.max(0, now() - startedAt)) });
      }
    };
    await Promise.all(Array.from({ length: 3 }, () => worker()));
    const providerReachable = outcomes.get("provider")?.outcome === "reachable";
    const localReachable = ["portable-data", "runtime", "gateway", "local-port"].some((id) => outcomes.get(id as NetworkProbeTarget)?.outcome === "reachable");
    const mode = providerReachable ? "online" as const : localReachable ? "intranet-only" as const : "offline" as const;
    return {
      mode,
      checks: targets.map((target) => {
        const item = outcomes.get(target.id)!;
        const reachable = item.outcome === "reachable";
        const unavailable = item.outcome === "unavailable" || item.outcome === "skipped";
        return {
          id: target.id, label: target.label, status: reachable ? "passed" as const : item.outcome,
          level: reachable || unavailable ? "info" as const : target.id === "provider" && mode === "intranet-only" ? "warning" as const : "error" as const,
          summary: reachable ? "检查通过。" : item.outcome === "unavailable" ? "当前 adapter 未提供只读检查接口。" : item.outcome === "skipped" ? "缺少权威只读契约，已跳过。" : target.id === "provider" && mode === "intranet-only" ? "外网不可用，内网功能仍可使用。" : "检查未通过。",
          durationMs: item.durationMs,
        };
      }),
      proxy: {
        configured: Boolean(environment.HTTPS_PROXY ?? environment.https_proxy ?? environment.HTTP_PROXY ?? environment.http_proxy),
        noProxyConfigured: Boolean(environment.NO_PROXY ?? environment.no_proxy),
      },
    };
  };

  const runDoctor = async (signal: AbortSignal, timeoutMs: number, requestId: string) => {
    if (!options.diagnostics.doctor) throw safeError("UNAVAILABLE", "当前 OpenClaw runtime 未提供结构化诊断 adapter。");
    const generation = ++doctorGeneration;
    doctorPreviews.clear();
    const upstream = await withTimeout((adapterSignal) => options.diagnostics.doctor!(adapterSignal), signal, timeoutMs);
    if (generation !== doctorGeneration) throw safeError("CONFLICT", "已有更新的 Doctor 结果，请使用最新检查。", true);
    return {
      state: upstream.status === "ok" ? "healthy" as const : "issues" as const,
      adapter: "openclaw" as const,
      checks: upstream.checks.map((check) => {
        const actionId = check.repair?.actionId;
        const repair = actionId && doctorRepairActionIds.has(actionId as DoctorRepairActionId) && options.doctorRepairActions?.[actionId as DoctorRepairActionId] ? (() => {
          const previewToken = `doctor-preview-${randomUUID().toLowerCase()}`;
          const controlledActionId = actionId as DoctorRepairActionId;
          doctorPreviews.set(previewToken, { actionId: controlledActionId, expiresAt: now() + PREVIEW_TTL_MS });
          auditDoctorRepair({ event: "previewed", actionId: controlledActionId, requestId, previewToken });
          return { actionId: controlledActionId, label: "执行受控修复", previewToken };
        })() : undefined;
        const summary = check.status === "pass" ? "检查通过。" : check.status === "warn" ? "检查需要注意。" : "检查未通过。";
        return { id: check.id, label: DOCTOR_LABELS[check.id] ?? "OpenClaw 检查项", level: check.severity, summary, ...(check.suggestion ? { suggestion: repair ? "可使用 OpenClaw 提供的受控修复。" : "请在 OpenClaw 中查看脱敏诊断。" } : {}), ...(repair ? { repair } : {}) };
      }),
    };
  };

  const openRoot = async (path: string, maxBytes = MAX_CONFIG_BYTES): Promise<Root> => {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw safeError("FORBIDDEN", "诊断目录不安全。");
    const safeRoot = await root(path, { hardlinks: "reject", symlinks: "reject", maxBytes, mkdir: false });
    const portableReal = await realpath(dataDir);
    if (!isWithin(portableReal, safeRoot.rootReal)) throw safeError("FORBIDDEN", "诊断目录越界。");
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
    return { items, nextCursor, hasMore: page.hasMore };
  };

  const loadOwnedLogEntries = async (): Promise<DiagnosticLogEntry[]> => {
    const logs = await openRoot(logsDir, MAX_EXPORT_BYTES);
    const entries: DiagnosticLogEntry[] = [];
    for (const name of await ownedLogNames(logs)) {
      const info = await logs.stat(name);
      if (info.size === 0) continue;
      const content = await logs.readText(name, { hardlinks: "reject", maxBytes: MAX_EXPORT_BYTES, symlinks: "reject" });
      const lineCount = content.split(/\r?\n/u).filter((line) => line.length > 0).length;
      const source = name.includes("launcher") ? "launcher" : name.includes("adapter") ? "adapter" : name.includes("gateway") ? "gateway" : name.includes("openclaw") ? "openclaw" : name.includes("channel") ? "channel" : "desktop";
      for (let index = 0; index < lineCount; index += 1) entries.push(DiagnosticLogEntrySchema.parse({
        id: createHash("sha256").update(`${name}:${info.dev}:${info.ino}:${index}:${info.mtimeMs}`).digest("hex").slice(0, 20),
        timestamp: new Date(info.mtimeMs).toISOString(), level: "info", source,
        message: `${LOG_SOURCE_LABELS[source]} owned log event.`,
      }));
    }
    return entries;
  };

  const loadFilteredLogPage = async (params: Extract<DiagnosticsIpcRequest, { method: "logs.list" }>["params"], signal: AbortSignal) => {
    let cursor = params.cursor;
    const seen = new Set<string>();
    for (let pageNumber = 0; pageNumber < MAX_FILTER_SCAN_PAGES; pageNumber += 1) {
      if (cursor !== undefined && seen.has(cursor)) throw safeError("CONTRACT_INCOMPATIBLE", "日志分页游标重复。");
      if (cursor !== undefined) seen.add(cursor);
      const page = await loadRawLogPage({ ...(cursor ? { cursor } : {}), limit: params.limit }, signal, pageNumber * params.limit);
      const owned = cursor === undefined ? await loadOwnedLogEntries() : [];
      const items = [...page.items, ...owned].filter((entry) => matchesLog(entry, params)).sort((left, right) => right.timestamp.localeCompare(left.timestamp)).slice(0, params.limit);
      if (items.length > 0 || !page.hasMore || page.nextCursor === null) return { ...page, items };
      cursor = page.nextCursor;
    }
    throw safeError("FILE_TOO_LARGE", "日志筛选超过单次扫描上限，请缩小范围。");
  };

  const redactedConfig = async () => {
    let parsed: unknown;
    if (options.diagnostics.config) parsed = await options.diagnostics.config();
    else {
      const parent = resolve(configPath, "..");
      const configRoot = await openRoot(parent);
      const raw = await configRoot.readText(relative(parent, configPath), { hardlinks: "reject", maxBytes: MAX_CONFIG_BYTES, symlinks: "reject" });
      try { parsed = JSON.parse(raw); } catch { throw safeError("CONTRACT_INCOMPATIBLE", "OpenClaw 配置不是有效 JSON。"); }
    }
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
          const append = (entry: DiagnosticLogEntry): void => {
            const line = `${JSON.stringify(entry)}\n`;
            bytes += Buffer.byteLength(line);
            count += 1;
            if (count > MAX_EXPORT_ENTRIES || bytes > MAX_EXPORT_BYTES) throw safeError("FILE_TOO_LARGE", "诊断导出超过大小上限。");
            lines.push(line);
          };
          for (const entry of (await loadOwnedLogEntries()).filter((item) => matchesLog(item, request.params))) append(entry);
          do {
            controller.signal.throwIfAborted();
            if (pageCount >= MAX_EXPORT_PAGES) throw safeError("FILE_TOO_LARGE", "诊断导出超过分页上限。");
            if (cursor !== undefined && seen.has(cursor)) throw safeError("CONTRACT_INCOMPATIBLE", "日志分页游标重复。");
            if (cursor !== undefined) seen.add(cursor);
            const page = await loadRawLogPage({ ...(cursor ? { cursor } : {}), limit: 500 }, controller.signal, pageCount * 500);
            pageCount += 1;
            for (const entry of page.items.filter((item) => matchesLog(item, request.params))) append(entry);
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
        case "runtime.get": {
          if (!options.diagnostics.system) throw safeError("UNAVAILABLE", "当前 OpenClaw runtime 未提供系统状态接口。");
          result = await abortable(options.diagnostics.system(controller.signal), controller.signal);
          break;
        }
        case "stability.get": {
          if (!options.diagnostics.stability) throw safeError("UNAVAILABLE", "当前 OpenClaw runtime 未提供稳定性诊断。");
          result = await abortable(options.diagnostics.stability(controller.signal), controller.signal);
          break;
        }
        case "audit.get": {
          if (!options.diagnostics.audit) throw safeError("UNAVAILABLE", "当前 OpenClaw runtime 未提供安全审计。");
          result = await abortable(options.diagnostics.audit(controller.signal), controller.signal);
          break;
        }
        case "config.get": {
          const config = await redactedConfig();
          const query = request.params.query?.toLocaleLowerCase();
          result = { ...config, entries: query ? config.entries.filter((entry) => entry.path.toLocaleLowerCase().includes(query)) : config.entries };
          break;
        }
        case "config.export": result = await createExport(request.params.fileName, `${(await redactedConfig()).content}\n`); break;
        case "doctor.run": result = await runDoctor(controller.signal, request.params.timeoutMs ?? 10_000, request.requestId); break;
        case "doctor.repair": {
          const executor = options.doctorRepairActions?.[request.params.actionId];
          if (!executor) throw safeError("UNAVAILABLE", "当前生产 runtime 未注册该 Doctor 修复动作。");
          const preview = doctorPreviews.get(request.params.previewToken);
          doctorPreviews.delete(request.params.previewToken);
          if (!preview || preview.expiresAt < now() || preview.actionId !== request.params.actionId) throw safeError("CONFLICT", "修复预览已过期，请重新运行 Doctor。", true);
          if (repairActive) throw safeError("CONFLICT", "已有 Doctor 修复正在执行。", true);
          doctorPreviews.clear();
          auditDoctorRepair({ event: "confirmed", actionId: request.params.actionId, requestId: request.requestId, previewToken: request.params.previewToken });
          repairActive = true;
          const timeoutMs = request.params.timeoutMs ?? 10_000;
          try {
            auditDoctorRepair({ event: "started", actionId: request.params.actionId, requestId: request.requestId, previewToken: request.params.previewToken });
            await withTimeout((signal) => {
              const execution = Promise.resolve().then(() => executor(signal));
              void execution.finally(() => { repairActive = false; }).catch(() => undefined);
              return execution;
            }, controller.signal, timeoutMs);
            auditDoctorRepair({ event: "succeeded", actionId: request.params.actionId, requestId: request.requestId, previewToken: request.params.previewToken });
            result = await runDoctor(controller.signal, timeoutMs, request.requestId);
          } catch (caught) {
            const event = controller.signal.aborted ? "cancelled" : caught instanceof DOMException && caught.name === "TimeoutError" ? "timed-out" : "failed";
            auditDoctorRepair({ event, actionId: request.params.actionId, requestId: request.requestId, previewToken: request.params.previewToken });
            throw caught;
          } finally { /* executor settlement releases the global repair slot */ }
          break;
        }
        case "network.run": result = await runNetworkDiagnostics(controller.signal, request.params.timeoutMs); break;
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
