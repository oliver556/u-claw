import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { join, relative, resolve } from "node:path";
import readline from "node:readline";
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

import { UClawErrorCodeSchema, UClawErrorSchema, type McpConfigurationService, type McpServerConfigEntry, type UClawError } from "@uclaw/shared";

import { assessMcpStdioPolicy } from "./stdio-policy.js";

export interface McpProbeSuccess {
  status: "connected";
  capabilitySummary: { tools: number; resources: number; prompts: number };
  toolNames: string[];
  resourceSchemes: string[];
}

export interface McpProbeFailure {
  status: "error";
  error: UClawError;
}

export type McpProbeResult = McpProbeSuccess | McpProbeFailure;

export interface McpProtocolProbe {
  test(server: McpServerConfigEntry, signal: AbortSignal): Promise<McpProbeResult>;
}

type Lookup = (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>;
type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
type Request = (url: URL, init: RequestInit, pinnedAddress: string, proxyUrl?: URL) => Promise<Response>;

export interface McpNetworkPolicy {
  httpProxy: string | null;
  httpsProxy: string | null;
  noProxy: string[];
}

export interface CreateMcpProtocolProbeOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  lookup?: Lookup;
  fetch?: Fetch;
  request?: Request;
  network?: McpNetworkPolicy;
  runtimeRoot?: string;
  executables?: Partial<Record<"node" | "npx" | "python" | "uvx", string>>;
}

class ProbeError extends Error {
  constructor(readonly error: UClawError) {
    super(error.message);
  }
}

function safeError(code: UClawError["code"], message: string, retryable: boolean): UClawError {
  return UClawErrorSchema.parse({ code, message, retryable, recoveryActions: retryable ? ["retry"] : [], causeDetails: {} });
}

const privateAddresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) privateAddresses.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32],
] as const) privateAddresses.addSubnet(address, prefix, "ipv6");

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && privateAddresses.check(address, family === 6 ? "ipv6" : "ipv4");
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

async function validateRemoteUrl(rawUrl: string, lookup: Lookup): Promise<{ url: URL; address: string }> {
  let url: URL;
  try { url = new URL(rawUrl); }
  catch { throw new ProbeError(safeError("INVALID_ARGUMENT", "MCP URL 无效。", false)); }
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new ProbeError(safeError("INVALID_ARGUMENT", "MCP URL 不符合安全策略。", false));
  }
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol === "http:" && !loopback) throw new ProbeError(safeError("FORBIDDEN", "远程 MCP 必须使用 TLS。", false));
  const literal = isIP(url.hostname.replace(/^\[|\]$/gu, ""));
  const addresses = literal
    ? [{ address: url.hostname.replace(/^\[|\]$/gu, ""), family: literal }]
    : await lookup(url.hostname, { all: true, verbatim: true }).catch((lookupError) => {
      if (lookupError instanceof ProbeError) throw lookupError;
      throw new ProbeError(safeError("NETWORK_UNREACHABLE", "MCP DNS 解析失败。", true));
    });
  if (addresses.length === 0) throw new ProbeError(safeError("NETWORK_UNREACHABLE", "MCP DNS 解析失败。", true));
  if (!loopback && addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new ProbeError(safeError("FORBIDDEN", "MCP 目标被 SSRF 策略拦截。", false));
  }
  return { url, address: addresses[0]!.address };
}

async function validateProxyUrl(rawUrl: string, lookup: Lookup): Promise<{ url: URL; address: string }> {
  let url: URL;
  try { url = new URL(rawUrl); }
  catch { throw new ProbeError(safeError("INVALID_ARGUMENT", "MCP proxy URL 无效。", false)); }
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.hash || url.search || (url.pathname !== "" && url.pathname !== "/")) {
    throw new ProbeError(safeError("FORBIDDEN", "MCP proxy URL 不符合安全策略。", false));
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const literal = isIP(hostname);
  const addresses = literal ? [{ address: hostname, family: literal }] : await lookup(hostname, { all: true, verbatim: true }).catch((lookupError) => {
    if (lookupError instanceof ProbeError) throw lookupError;
    throw new ProbeError(safeError("NETWORK_UNREACHABLE", "MCP proxy DNS 解析失败。", true));
  });
  if (addresses.length === 0) throw new ProbeError(safeError("NETWORK_UNREACHABLE", "MCP proxy DNS 解析失败。", true));
  if (!isLoopbackHost(url.hostname) && addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new ProbeError(safeError("FORBIDDEN", "MCP proxy 被 SSRF 策略拦截。", false));
  }
  return { url, address: addresses[0]!.address };
}

function bypassesProxy(url: URL, policy: McpNetworkPolicy): boolean {
  if (isLoopbackHost(url.hostname)) return true;
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return policy.noProxy.some((entry) => {
    const rule = entry.trim().toLowerCase();
    if (rule === "*") return true;
    if (rule.startsWith(".")) return hostname === rule.slice(1) || hostname.endsWith(rule);
    return hostname === rule;
  });
}

function environmentNetworkPolicy(): McpNetworkPolicy {
  const env = process.env;
  const list = (env.NO_PROXY ?? env.no_proxy ?? "").split(",").map((value) => value.trim()).filter(Boolean).slice(0, 64);
  return {
    httpProxy: env.HTTP_PROXY ?? env.http_proxy ?? null,
    httpsProxy: env.HTTPS_PROXY ?? env.https_proxy ?? null,
    noProxy: list,
  };
}

interface RequestOperation { response: Response; close(): Promise<void> }

async function secureRequest(url: URL, init: RequestInit, address: string, proxy?: { url: URL; address: string }): Promise<RequestOperation> {
  let dispatcher: Dispatcher;
  let requestUrl = url;
  let requestInit = init;
  if (proxy) {
    const proxyLookup = (_hostname: string, options: { all?: boolean }, callback: (...args: any[]) => void) => {
      const family = isIP(proxy.address);
      if (options.all) callback(null, [{ address: proxy.address, family }]); else callback(null, proxy.address, family);
    };
    dispatcher = new ProxyAgent({
      uri: proxy.url.toString(),
      proxyTls: { lookup: proxyLookup },
      requestTls: { servername: url.hostname },
    });
    requestUrl = new URL(url);
    requestUrl.hostname = address;
    requestInit = { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), host: url.host } };
  } else {
    const pinnedLookup = (_hostname: string, options: { all?: boolean }, callback: (...args: any[]) => void) => {
      const family = isIP(address);
      if (options.all) callback(null, [{ address, family }]); else callback(null, address, family);
    };
    dispatcher = new Agent({ connect: { lookup: pinnedLookup } });
  }
  try {
    const response = await undiciFetch(requestUrl, { ...requestInit, dispatcher } as any) as unknown as Response;
    return { response, close: () => dispatcher.close() };
  } catch (error) {
    await dispatcher.close().catch(() => undefined);
    throw error;
  }
}

async function readLimitedBody(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) throw new ProbeError(safeError("OPERATION_FAILED", "MCP 响应超过大小限制。", false));
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new ProbeError(safeError("OPERATION_FAILED", "MCP 响应超过大小限制。", false));
    }
    chunks.push(next.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(body);
}

function parseRpcBody(body: string, contentType: string, expectedId: number): unknown {
  const payloads = contentType.includes("text/event-stream")
    ? body.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim())
    : [body];
  for (const payload of payloads) {
    if (!payload) continue;
    try {
      const frame = JSON.parse(payload) as { id?: unknown };
      if (frame && typeof frame === "object" && frame.id === expectedId) return frame;
    } catch { /* inspect remaining SSE frames before failing */ }
  }
  throw new ProbeError(safeError("PROTOCOL_MAPPING_FAILED", payloads.length === 0 ? "MCP 响应为空。" : "MCP 响应格式无效。", false));
}

function extractResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProbeError(safeError("PROTOCOL_MAPPING_FAILED", "MCP 响应格式无效。", false));
  const frame = value as Record<string, unknown>;
  if (frame.error !== undefined) throw new ProbeError(safeError("OPERATION_FAILED", "MCP server returned an RPC error.", false));
  if (!frame.result || typeof frame.result !== "object" || Array.isArray(frame.result)) throw new ProbeError(safeError("PROTOCOL_MAPPING_FAILED", "MCP 响应缺少 result。", false));
  return frame.result as Record<string, unknown>;
}

function summarize(tools: unknown[], resources: unknown[], prompts: unknown[]): McpProbeSuccess {
  const toolNames = tools.flatMap((tool) => tool && typeof tool === "object" && typeof (tool as { name?: unknown }).name === "string" ? [(tool as { name: string }).name] : []).slice(0, 100);
  const resourceSchemes = [...new Set(resources.flatMap((resource) => {
    if (!resource || typeof resource !== "object" || typeof (resource as { uri?: unknown }).uri !== "string") return [];
    try { return [new URL((resource as { uri: string }).uri).protocol.replace(/:$/u, "")]; } catch { return []; }
  }))].slice(0, 100);
  return {
    status: "connected",
    capabilitySummary: { tools: tools.length, resources: resources.length, prompts: prompts.length },
    toolNames,
    resourceSchemes,
  };
}

async function listPages(
  rpc: (method: string, params: Record<string, unknown> | undefined) => Promise<Record<string, unknown>>,
  method: "tools/list" | "resources/list" | "prompts/list",
  key: "tools" | "resources" | "prompts",
): Promise<unknown[]> {
  const values: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const result = await rpc(method, cursor ? { cursor } : {});
    const items = result[key];
    if (!Array.isArray(items)) throw new ProbeError(safeError("PROTOCOL_MAPPING_FAILED", `MCP ${key} response is invalid.`, false));
    values.push(...items);
    if (values.length > 10_000) throw new ProbeError(safeError("PROTOCOL_MAPPING_FAILED", `MCP ${key} response exceeds item limit.`, false));
    const next = result.nextCursor;
    if (next === undefined || next === null || next === "") return values;
    if (typeof next !== "string" || next.length > 1_024 || cursors.has(next)) throw new ProbeError(safeError("PROTOCOL_MAPPING_FAILED", `MCP ${key} cursor is invalid.`, false));
    cursors.add(next);
    cursor = next;
  }
  throw new ProbeError(safeError("PROTOCOL_MAPPING_FAILED", `MCP ${key} pagination limit exceeded.`, false));
}

function createDeadline(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; cleanup(): void; timedOut(): boolean } {
  const controller = new AbortController();
  let timeout = false;
  const onAbort = () => controller.abort(parent.reason ?? new DOMException("Aborted", "AbortError"));
  if (parent.aborted) onAbort(); else parent.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => { timeout = true; controller.abort(new DOMException("Timed out", "TimeoutError")); }, timeoutMs);
  return { signal: controller.signal, timedOut: () => timeout, cleanup: () => { clearTimeout(timer); parent.removeEventListener("abort", onAbort); } };
}

function boundedLookup(lookup: Lookup, signal: AbortSignal, parentSignal: AbortSignal): Lookup {
  return (hostname, options) => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new ProbeError(safeError(
      parentSignal.aborted ? "CANCELLED" : "TIMEOUT",
      parentSignal.aborted ? "MCP operation cancelled." : "MCP operation timed out.",
      true,
    ))));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    lookup(hostname, options).then(
      (addresses) => finish(() => resolve(addresses)),
      (lookupError) => finish(() => reject(lookupError)),
    );
  });
}

async function testHttp(server: Extract<McpServerConfigEntry, { transport: "http" | "streamable-http" }>, options: Required<Pick<CreateMcpProtocolProbeOptions, "timeoutMs" | "maxResponseBytes">> & { lookup: Lookup; request?: Request; network: McpNetworkPolicy }, parentSignal: AbortSignal): Promise<McpProbeSuccess> {
  const deadline = createDeadline(parentSignal, options.timeoutMs);
  try {
    const lookup = boundedLookup(options.lookup, deadline.signal, parentSignal);
    const target = await validateRemoteUrl(server.url, lookup);
    const url = target.url;
    const proxyValue = url.protocol === "https:" ? options.network.httpsProxy : options.network.httpProxy;
    const proxy = proxyValue && !bypassesProxy(url, options.network) ? await validateProxyUrl(proxyValue, lookup) : undefined;
    let id = 0;
    let sessionId: string | undefined;
    let protocolVersion: string | undefined;
    const rpc = async (method: string, params: Record<string, unknown> | undefined, expectResponse = true): Promise<Record<string, unknown>> => {
    const requestId = ++id;
    const authentication = server.authentication;
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (authentication.type === "bearer" && authentication.secret) headers.authorization = `Bearer ${authentication.secret}`;
    if (authentication.type === "header" && authentication.secret) headers[authentication.headerName] = authentication.secret;
    if (sessionId) headers["mcp-session-id"] = sessionId;
    if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;
    const init: RequestInit = {
      method: "POST", headers, signal: deadline.signal, redirect: "manual",
      body: JSON.stringify({ jsonrpc: "2.0", ...(expectResponse ? { id: requestId } : {}), method, ...(params ? { params } : {}) }),
    };
    const operation = options.request
      ? { response: await options.request(url, init, target.address, proxy?.url), close: async () => undefined }
      : await secureRequest(url, init, target.address, proxy);
    try {
      const response = operation.response;
      if (response.status >= 300 && response.status < 400) throw new ProbeError(safeError("FORBIDDEN", "MCP redirects are blocked by policy.", false));
      if (!response.ok) {
        const code = response.status === 401 || response.status === 403 ? "UNAUTHORIZED" : response.status === 407 ? "NETWORK_UNREACHABLE" : "OPERATION_FAILED";
        throw new ProbeError(safeError(code, "MCP server request failed.", response.status >= 500 || response.status === 407));
      }
      const responseSessionId = response.headers.get("mcp-session-id");
      if (responseSessionId) {
        if (responseSessionId.length > 1_024 || /[\r\n]/u.test(responseSessionId)) throw new ProbeError(safeError("PROTOCOL_MAPPING_FAILED", "MCP session ID is invalid.", false));
        sessionId = responseSessionId;
      }
      const body = await readLimitedBody(response, options.maxResponseBytes);
      return expectResponse ? extractResult(parseRpcBody(body, response.headers.get("content-type") ?? "", requestId)) : {};
    } finally { await operation.close().catch(() => undefined); }
    };
    const initialized = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "U-Claw", version: "0.1.0" } });
    protocolVersion = typeof initialized.protocolVersion === "string" ? initialized.protocolVersion : "2025-06-18";
    await rpc("notifications/initialized", undefined, false);
    const capabilities = initialized.capabilities && typeof initialized.capabilities === "object" ? initialized.capabilities as Record<string, unknown> : {};
    const tools = "tools" in capabilities ? await listPages(rpc, "tools/list", "tools") : [];
    const resources = "resources" in capabilities ? await listPages(rpc, "resources/list", "resources") : [];
    const prompts = "prompts" in capabilities ? await listPages(rpc, "prompts/list", "prompts") : [];
    return summarize(tools, resources, prompts);
  } catch (error) {
    if (deadline.signal.aborted && !(error instanceof ProbeError)) {
      throw new ProbeError(safeError(parentSignal.aborted ? "CANCELLED" : "TIMEOUT", parentSignal.aborted ? "MCP operation cancelled." : "MCP operation timed out.", true));
    }
    throw error;
  } finally { deadline.cleanup(); }
}

async function testStdio(server: Extract<McpServerConfigEntry, { transport: "stdio" }>, options: CreateMcpProtocolProbeOptions & { timeoutMs: number }, parentSignal: AbortSignal): Promise<McpProbeSuccess> {
  const policy = assessMcpStdioPolicy(server);
  if (!policy.allowed) throw new ProbeError(safeError("FORBIDDEN", "stdio configuration is blocked by policy.", false));
  if (policy.confirmationRequired && server.confirmedRiskFingerprint !== policy.fingerprint) throw new ProbeError(safeError("CONFIRMATION_REQUIRED", "stdio risk confirmation is required.", false));
  const executable = options.executables?.[server.executableId];
  if (!executable || !options.runtimeRoot) throw new ProbeError(safeError("UNAVAILABLE", "stdio executable is unavailable.", false));
  const root = resolve(options.runtimeRoot);
  const args = [...server.args];
  if ((server.executableId === "node" || server.executableId === "python") && args[0] && !args[0].startsWith("-")) {
    const script = resolve(join(root, args[0]));
    const child = relative(root, script);
    if (child.startsWith("..") || child === "") throw new ProbeError(safeError("FORBIDDEN", "stdio script is outside controlled runtime root.", false));
    args[0] = script;
  }
  const environment = {
    ...server.env,
    ...(server.executableId === "node" ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
  };
  const process = spawn(executable, args, { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  return runStdioHandshake(process, options.timeoutMs, parentSignal);
}

async function runStdioHandshake(child: ChildProcessWithoutNullStreams, timeoutMs: number, parentSignal: AbortSignal): Promise<McpProbeSuccess> {
  const deadline = createDeadline(parentSignal, timeoutMs);
  const lines = readline.createInterface({ input: child.stdout });
  const waiters = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: unknown): void }>();
  let id = 0;
  lines.on("line", (line) => {
    try {
      const frame = JSON.parse(line) as { id?: number };
      if (typeof frame.id === "number") { waiters.get(frame.id)?.resolve(extractResult(frame)); waiters.delete(frame.id); }
    } catch { for (const waiter of waiters.values()) waiter.reject(new ProbeError(safeError("PROTOCOL_MAPPING_FAILED", "MCP stdio response is invalid.", false))); }
  });
  const fail = () => { for (const waiter of waiters.values()) waiter.reject(new Error("stdio closed")); waiters.clear(); };
  child.once("error", fail); child.once("exit", fail);
  const rpc = (method: string, params?: Record<string, unknown>, expectResponse = true): Promise<Record<string, unknown>> => {
    const requestId = ++id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...(expectResponse ? { id: requestId } : {}), method, ...(params ? { params } : {}) })}\n`);
    if (!expectResponse) return Promise.resolve({});
    return new Promise((resolve, reject) => waiters.set(requestId, { resolve, reject }));
  };
  const onAbort = () => child.kill();
  deadline.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const initialized = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "U-Claw", version: "0.1.0" } });
    await rpc("notifications/initialized", undefined, false);
    const capabilities = initialized.capabilities && typeof initialized.capabilities === "object" ? initialized.capabilities as Record<string, unknown> : {};
    const tools = "tools" in capabilities ? await listPages(rpc, "tools/list", "tools") : [];
    const resources = "resources" in capabilities ? await listPages(rpc, "resources/list", "resources") : [];
    const prompts = "prompts" in capabilities ? await listPages(rpc, "prompts/list", "prompts") : [];
    return summarize(tools, resources, prompts);
  } catch (error) {
    if (deadline.signal.aborted) throw new ProbeError(safeError(parentSignal.aborted ? "CANCELLED" : "TIMEOUT", parentSignal.aborted ? "MCP operation cancelled." : "MCP operation timed out.", true));
    if (error instanceof ProbeError) throw error;
    throw new ProbeError(safeError("OPERATION_FAILED", "MCP stdio process failed.", true));
  } finally {
    deadline.signal.removeEventListener("abort", onAbort);
    deadline.cleanup();
    lines.close();
    child.kill();
  }
}

export function createMcpProtocolProbe(options: CreateMcpProtocolProbeOptions = {}): McpProtocolProbe {
  const request = options.request ?? (options.fetch ? async (url: URL, init: RequestInit) => options.fetch!(url, init) : undefined);
  const resolved = {
    ...options,
    timeoutMs: options.timeoutMs ?? 10_000,
    maxResponseBytes: options.maxResponseBytes ?? 1_048_576,
    lookup: options.lookup ?? (dnsLookup as Lookup),
    request,
    network: options.network ?? (request ? { httpProxy: null, httpsProxy: null, noProxy: [] } : environmentNetworkPolicy()),
  };
  return {
    test: async (server, signal) => {
      try {
        return server.transport === "stdio"
          ? await testStdio(server, resolved, signal)
          : await testHttp(server, resolved, signal);
      } catch (error) {
        return { status: "error", error: error instanceof ProbeError ? error.error : safeError("OPERATION_FAILED", "MCP connection test failed.", true) };
      }
    },
  };
}

export function createOpenClawMcpRuntime(configuration: McpConfigurationService | undefined, probe: McpProtocolProbe): {
  capability(): boolean;
  reason(): "locked-runtime-no-mcp-rpc";
  test(server: McpServerConfigEntry, signal: AbortSignal): Promise<McpProbeResult>;
  configure(server: McpServerConfigEntry, signal: AbortSignal): Promise<void>;
  remove(server: McpServerConfigEntry, signal: AbortSignal): Promise<void>;
  start(server: McpServerConfigEntry, signal: AbortSignal): Promise<void>;
  stop(server: McpServerConfigEntry, signal: AbortSignal): Promise<void>;
} {
  const available = configuration !== undefined;
  const invoke = async (method: keyof McpConfigurationService, server: McpServerConfigEntry, signal: AbortSignal): Promise<void> => {
    if (!configuration) throw new ProbeError(safeError("UNAVAILABLE", "Runtime MCP configuration unavailable.", false));
    await configuration[method](server, signal);
  };
  const parseConnected = (value: unknown): McpProbeSuccess | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const candidate = value as Record<string, unknown>;
    const summary = candidate.capabilitySummary;
    if (!summary || typeof summary !== "object") return undefined;
    const counts = summary as Record<string, unknown>;
    if (![counts.tools, counts.resources, counts.prompts].every((count) => Number.isSafeInteger(count) && (count as number) >= 0)) return undefined;
    if (!Array.isArray(candidate.toolNames) || candidate.toolNames.length > 100 || candidate.toolNames.some((name) => typeof name !== "string" || name.length < 1 || name.length > 120)) return undefined;
    if (!Array.isArray(candidate.resourceSchemes) || candidate.resourceSchemes.length > 100 || candidate.resourceSchemes.some((scheme) => typeof scheme !== "string" || !/^[a-z][a-z0-9+.-]{0,31}$/u.test(scheme))) return undefined;
    return {
      status: "connected",
      capabilitySummary: { tools: counts.tools as number, resources: counts.resources as number, prompts: counts.prompts as number },
      toolNames: [...candidate.toolNames] as string[],
      resourceSchemes: [...candidate.resourceSchemes] as string[],
    };
  };
  return {
    capability: () => available,
    reason: () => "locked-runtime-no-mcp-rpc",
    test: async (server, signal) => {
      try {
        if (!available) throw new ProbeError(safeError("UNAVAILABLE", "Runtime MCP configuration unavailable.", false));
        const result = await probe.test(server, signal) as { status?: unknown; error?: unknown };
        if (result.status === "connected") {
          const connected = parseConnected(result);
          if (connected) return connected;
        }
        if (result.status === "error") {
          const rawError = result.error && typeof result.error === "object" ? result.error as Record<string, unknown> : {};
          const code = UClawErrorCodeSchema.safeParse(rawError.code);
          if (code.success && typeof rawError.retryable === "boolean") {
            return { status: "error", error: safeError(code.data, "OpenClaw MCP operation failed.", rawError.retryable) };
          }
        }
        return { status: "error", error: safeError("PROTOCOL_MAPPING_FAILED", "OpenClaw MCP result is invalid.", false) };
      } catch (error) {
        return { status: "error", error: error instanceof ProbeError ? error.error : safeError("OPERATION_FAILED", "OpenClaw MCP operation failed.", true) };
      }
    },
    configure: (server, signal) => invoke("configure", server, signal),
    remove: async (server, signal) => { await invoke("remove", server, signal); },
    start: async (server, signal) => { await invoke("start", server, signal); },
    stop: async (server, signal) => { await invoke("stop", server, signal); },
  };
}
