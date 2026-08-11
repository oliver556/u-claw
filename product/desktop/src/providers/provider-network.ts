import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

import {
  DEFAULT_PROVIDER_NETWORK_SETTINGS,
  LocalModelDiscoverySchema,
  ProviderVerificationSchema,
  type LocalModelDiscovery,
  type ProviderConfigEntry,
  type ProviderNetworkSettings,
  type ProviderVerification,
} from "@uclaw/shared";
import { Agent, ProxyAgent, fetch as undiciFetch } from "undici";

type DiscoveryTarget = { source: "ollama" | "lm-studio"; baseUrl: string };
type FetchLike = (url: string, init: RequestInit, proxyUrl?: string) => Promise<Response>;
type FetchOperation = { response: Response; close(): Promise<void> };

export interface CreateProviderNetworkServiceOptions {
  discoveryTargets?: readonly DiscoveryTarget[];
  discoveryTimeoutMs?: number;
  verifyTimeoutMs?: number;
  maxConcurrent?: number;
  proxyFetch?: FetchLike;
  lookup?: typeof dnsLookup;
}

export interface ProviderNetworkService {
  discover(requestId: string): Promise<LocalModelDiscovery>;
  verify(requestId: string, provider: ProviderConfigEntry, network?: ProviderNetworkSettings): Promise<ProviderVerification>;
  cancel(requestId: string): boolean;
}

const DEFAULT_DISCOVERY_TARGETS: readonly DiscoveryTarget[] = Object.freeze([
  { source: "ollama", baseUrl: "http://127.0.0.1:11434" },
  { source: "lm-studio", baseUrl: "http://127.0.0.1:1234" },
]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const failed = (category: Exclude<ProviderVerification, { state: "unverified" | "succeeded" }>["category"]): ProviderVerification => {
  const results = {
    dns: { state: "failed", category: "dns", code: "NETWORK_UNREACHABLE", message: "DNS 解析失败。", retryable: true },
    tls: { state: "failed", category: "tls", code: "NETWORK_UNREACHABLE", message: "TLS 连接失败。", retryable: true },
    authentication: { state: "failed", category: "authentication", code: "PROVIDER_AUTH_FAILED", message: "认证失败，请检查 API Key。", retryable: false },
    "rate-limit": { state: "failed", category: "rate-limit", code: "NETWORK_UNREACHABLE", message: "请求受限，请稍后重试。", retryable: true },
    timeout: { state: "failed", category: "timeout", code: "TIMEOUT", message: "连接超时，请重试。", retryable: true },
    proxy: { state: "failed", category: "proxy", code: "NETWORK_UNREACHABLE", message: "代理连接失败。", retryable: true },
    "model-not-found": { state: "failed", category: "model-not-found", code: "MODEL_UNAVAILABLE", message: "模型不存在或不可用。", retryable: false },
    network: { state: "failed", category: "network", code: "NETWORK_UNREACHABLE", message: "网络连接失败。", retryable: true },
    "unsafe-target": { state: "failed", category: "unsafe-target", code: "INVALID_ARGUMENT", message: "目标地址不安全。", retryable: false },
    cancelled: { state: "failed", category: "cancelled", code: "CANCELLED", message: "连接测试已取消。", retryable: true },
    busy: { state: "failed", category: "busy", code: "UNAVAILABLE", message: "网络操作繁忙，请稍后重试。", retryable: true },
    unsupported: { state: "failed", category: "unsupported", code: "UNSUPPORTED", message: "此 Provider 不支持直接连通测试。", retryable: false },
  } as const;
  return ProviderVerificationSchema.parse(results[category]);
};

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase().replace(/^\[|\]$/g, ""));
}

function isPrivateAddress(address: string): boolean {
  if (address === "::1") return true;
  const normalized = address.toLowerCase();
  if (normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

async function resolveSafeAddress(url: URL, lookup: typeof dnsLookup): Promise<string> {
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("UNSAFE_TARGET");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = isLoopbackHost(hostname);
  if (url.protocol === "http:" && !loopback) throw new Error("UNSAFE_TARGET");
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname) && !loopback) throw new Error("UNSAFE_TARGET");
    return hostname;
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw Object.assign(new Error("DNS lookup returned no addresses"), { code: "ENOTFOUND" });
  if (addresses.some(({ address }) => isPrivateAddress(address)) && !loopback) throw new Error("UNSAFE_TARGET");
  return addresses[0].address;
}

async function assertSafeProxy(url: URL, lookup: typeof dnsLookup): Promise<void> {
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("UNSAFE_TARGET");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = isLoopbackHost(hostname);
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw Object.assign(new Error("DNS lookup returned no addresses"), { code: "ENOTFOUND" });
  if (addresses.some(({ address }) => isPrivateAddress(address)) && !loopback) throw new Error("UNSAFE_TARGET");
}

function bypassesProxy(url: URL, network: ProviderNetworkSettings): boolean {
  if (isLoopbackHost(url.hostname)) return true;
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return network.noProxy.some((rule) => {
    const normalized = rule.toLowerCase();
    if (normalized.startsWith(".")) return hostname.endsWith(normalized) || hostname === normalized.slice(1);
    return hostname === normalized;
  });
}

async function readLimitedJson(response: Response, maxBytes = 262_144): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new Error("Provider response is too large");
    }
    chunks.push(next.value);
  }
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
}

export interface ProviderHttpClientOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  proxyFetch?: FetchLike;
  lookup?: typeof dnsLookup;
}

export interface ProviderJsonRequest {
  url: string;
  init: RequestInit;
  network?: ProviderNetworkSettings;
}

export interface ProviderHttpClient {
  requestJson(request: ProviderJsonRequest): Promise<unknown>;
}

export function createProviderHttpClient(options: ProviderHttpClientOptions = {}): ProviderHttpClient {
  const lookup = options.lookup ?? dnsLookup;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxResponseBytes = options.maxResponseBytes ?? 1_048_576;

  return {
    async requestJson({ url, init, network = DEFAULT_PROVIDER_NETWORK_SETTINGS }): Promise<unknown> {
      const endpoint = new URL(url);
      await resolveSafeAddress(endpoint, lookup);
      const proxyUrl = endpoint.protocol === "https:" ? network.httpsProxy : network.httpProxy;
      const useProxy = proxyUrl !== null && !bypassesProxy(endpoint, network);
      if (useProxy) await assertSafeProxy(new URL(proxyUrl), lookup);

      const timeout = AbortSignal.timeout(timeoutMs);
      const signals = [timeout, ...(init.signal ? [init.signal] : [])];
      const requestInit: RequestInit = { ...init, redirect: "error", signal: AbortSignal.any(signals) };
      let operation: FetchOperation | undefined;
      try {
        if (useProxy) {
          if (options.proxyFetch) {
            operation = {
              response: await options.proxyFetch(endpoint.toString(), { ...requestInit, redirect: "error" }, proxyUrl!),
              close: async () => undefined,
            };
          } else {
            const dispatcher = new ProxyAgent(proxyUrl!);
            try {
              operation = {
                response: await undiciFetch(endpoint, { ...requestInit, redirect: "error", dispatcher } as any) as unknown as Response,
                close: () => dispatcher.close(),
              };
            } catch (error) {
              await dispatcher.close();
              throw error;
            }
          }
        } else {
          const address = await resolveSafeAddress(endpoint, lookup);
          const dispatcher = new Agent({ connect: { lookup: (_hostname, lookupOptions, callback) => {
            if (lookupOptions.all) callback(null, [{ address, family: isIP(address) }]);
            else callback(null, address, isIP(address));
          } } });
          try {
            operation = {
              response: await undiciFetch(endpoint, { ...requestInit, redirect: "error", dispatcher } as any) as unknown as Response,
              close: () => dispatcher.close(),
            };
          } catch (error) {
            await dispatcher.close();
            throw error;
          }
        }
        if (!operation.response.ok) throw new Error("Provider request failed.");
        return await readLimitedJson(operation.response, maxResponseBytes);
      } finally {
        await operation?.response.body?.cancel().catch(() => undefined);
        await operation?.close().catch(() => undefined);
      }
    },
  };
}

export function createProviderNetworkService(options: CreateProviderNetworkServiceOptions = {}): ProviderNetworkService {
  const operations = new Map<string, { controller: AbortController; timedOut: boolean; cancelled: boolean }>();
  const maxConcurrent = options.maxConcurrent ?? 2;
  const lookup = options.lookup ?? dnsLookup;
  const fetchThroughProxy = options.proxyFetch === undefined ? async (url: string, init: RequestInit, proxyUrl: string): Promise<FetchOperation> => {
    const dispatcher = new ProxyAgent(proxyUrl!);
    try {
      const response = await undiciFetch(url, { ...init, redirect: "error", dispatcher } as any) as unknown as Response;
      return { response, close: () => dispatcher.close() };
    } catch (error) {
      await dispatcher.close();
      throw error;
    }
  } : async (url: string, init: RequestInit, proxyUrl: string): Promise<FetchOperation> => ({
    response: await options.proxyFetch!(url, { ...init, redirect: "error" }, proxyUrl),
    close: async () => undefined,
  });

  const directFetch = async (url: URL, init: RequestInit): Promise<FetchOperation> => {
    const address = await resolveSafeAddress(url, lookup);
    const dispatcher = new Agent({ connect: { lookup: (_hostname, lookupOptions, callback) => {
      if (lookupOptions.all) callback(null, [{ address, family: isIP(address) }]);
      else callback(null, address, isIP(address));
    } } });
    try {
      const response = await undiciFetch(url, { ...init, redirect: "error", dispatcher } as any) as unknown as Response;
      return { response, close: () => dispatcher.close() };
    } catch (error) {
      await dispatcher.close();
      throw error;
    }
  };

  const begin = (requestId: string, timeoutMs: number) => {
    if (operations.size >= maxConcurrent || operations.has(requestId)) return null;
    const operation = { controller: new AbortController(), timedOut: false, cancelled: false };
    const timer = setTimeout(() => {
      operation.timedOut = true;
      operation.controller.abort(new DOMException("Timed out", "TimeoutError"));
    }, timeoutMs);
    operations.set(requestId, operation);
    return { operation, finish: () => { clearTimeout(timer); operations.delete(requestId); } };
  };

  const discover = async (requestId: string): Promise<LocalModelDiscovery> => {
    const active = begin(requestId, options.discoveryTimeoutMs ?? 1_500);
    if (!active) return LocalModelDiscoverySchema.parse({ state: "empty", models: [] });
    try {
      const results = await Promise.all((options.discoveryTargets ?? DEFAULT_DISCOVERY_TARGETS).map(async (target) => {
        try {
          const origin = new URL(target.baseUrl);
          if (!isLoopbackHost(origin.hostname) || origin.protocol !== "http:") return [];
          const endpoint = new URL(target.source === "ollama" ? "/api/tags" : "/v1/models", origin);
          const operation = await directFetch(endpoint, { method: "GET", signal: active.operation.controller.signal });
          try {
            if (!operation.response.ok) return [];
            const payload = await readLimitedJson(operation.response) as { models?: { name?: unknown }[]; data?: { id?: unknown }[] };
            const ids = target.source === "ollama" ? payload.models?.map(({ name }) => name) : payload.data?.map(({ id }) => id);
            return (ids ?? []).filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 160).map((id) => ({
              id, label: id, source: target.source, baseUrl: new URL("/v1", origin).toString().replace(/\/$/u, ""),
            }));
          } finally {
            await operation.response.body?.cancel().catch(() => undefined);
            await operation.close();
          }
        } catch {
          return [];
        }
      }));
      const models = results.flat();
      return LocalModelDiscoverySchema.parse({ state: models.length === 0 ? "empty" : "ready", models });
    } finally {
      active.finish();
    }
  };

  const verify = async (requestId: string, provider: ProviderConfigEntry, network = DEFAULT_PROVIDER_NETWORK_SETTINGS): Promise<ProviderVerification> => {
    if (provider.baseUrl === null) return failed("unsupported");
    let url: URL;
    try {
      url = new URL(`${provider.baseUrl.replace(/\/$/u, "")}/chat/completions`);
    } catch {
      return failed("unsafe-target");
    }
    const active = begin(requestId, options.verifyTimeoutMs ?? 8_000);
    if (!active) return failed("busy");
    let usesProxy = false;
    let fetchOperation: FetchOperation | undefined;
    try {
      await resolveSafeAddress(url, lookup);
      const proxyUrl = url.protocol === "https:" ? network.httpsProxy : network.httpProxy;
      usesProxy = proxyUrl !== null && !bypassesProxy(url, network);
      if (usesProxy) await assertSafeProxy(new URL(proxyUrl!), lookup);
      const init: RequestInit = {
        method: "POST",
        signal: active.operation.controller.signal,
        headers: { "content-type": "application/json", ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}) },
        body: JSON.stringify({ model: provider.model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
      };
      fetchOperation = usesProxy ? await fetchThroughProxy(url.toString(), init, proxyUrl!) : await directFetch(url, init);
      const response = fetchOperation.response;
      if (response.ok) return ProviderVerificationSchema.parse({ state: "succeeded", category: "ok", code: "OK", message: "连接成功。", retryable: false });
      if (response.status === 401 || response.status === 403) return failed("authentication");
      if (response.status === 407) return failed("proxy");
      if (response.status === 429) return failed("rate-limit");
      if (response.status === 400 || response.status === 404) return failed("model-not-found");
      return failed("network");
    } catch (error) {
      if (active.operation.cancelled) return failed("cancelled");
      if (active.operation.timedOut) return failed("timeout");
      if (error instanceof Error && error.message === "UNSAFE_TARGET") return failed("unsafe-target");
      const candidate = error as { code?: string; cause?: { code?: string } };
      const code = candidate.code ?? candidate.cause?.code ?? "";
      if (["ENOTFOUND", "EAI_AGAIN", "ENODATA"].includes(code)) return failed("dns");
      if (/CERT|TLS|SSL/u.test(code)) return failed("tls");
      return failed(usesProxy ? "proxy" : "network");
    } finally {
      await fetchOperation?.response.body?.cancel().catch(() => undefined);
      await fetchOperation?.close().catch(() => undefined);
      active.finish();
    }
  };

  return {
    discover,
    verify,
    cancel: (requestId) => {
      const operation = operations.get(requestId);
      if (!operation) return false;
      operation.cancelled = true;
      operation.controller.abort(new DOMException("Cancelled", "AbortError"));
      return true;
    },
  };
}
