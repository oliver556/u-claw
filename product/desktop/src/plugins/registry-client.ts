import { PluginDetailSchema, UClawErrorSchema, type PluginDetail } from "@uclaw/shared";
import { z } from "zod";

import type { PluginBundle, PluginRegistryClient } from "./fixture-client.js";

export interface LivePluginRegistryClientOptions {
  baseUrl: string | URL;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/);
const SearchInputSchema = z.object({
  query: z.string().max(120),
  cursor: z.string().max(512).nullable(),
  pageSize: z.number().int().min(1).max(50),
}).strict();
const SearchResponseSchema = z.object({
  items: z.array(PluginDetailSchema).max(50),
  nextCursor: z.string().max(512).nullable(),
  hasMore: z.boolean(),
}).strict();
const BundleEntrySchema = z.object({
  path: z.string().min(1).max(500),
  type: z.enum(["file", "directory", "symlink", "hardlink"]),
  size: z.number().int().min(0).max(5 * 1024 * 1024),
  contentBase64: z.string().max(7 * 1024 * 1024).optional(),
}).strict();
const BundleSchema = z.object({
  sourceUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  }, "Plugin bundle source must use HTTPS without credentials."),
  compressedBytes: z.number().int().min(1).max(50 * 1024 * 1024),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  entries: z.array(BundleEntrySchema).min(1).max(1_000),
}).strict();

function registryBaseUrl(value: string | URL): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Plugin registry base URL must use HTTPS without credentials, query, or fragment.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function liveDetail(value: unknown): PluginDetail {
  const detail = PluginDetailSchema.parse(value);
  if (detail.mode !== "live" || detail.source.provider === "fixture") {
    throw new Error("Plugin registry returned a non-live Plugin detail.");
  }
  return detail;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.ok) throw new Error(`Plugin registry request failed with HTTP ${response.status}.`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    throw new Error("Plugin registry response is not JSON.");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes) throw new Error("Plugin registry response is too large.");
  }
  if (!response.body) throw new Error("Plugin registry response body is missing.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("Plugin registry response is too large.");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function createUnavailablePluginRegistryClient(reason: string): PluginRegistryClient {
  const message = z.string().min(1).max(500).parse(reason);
  const unavailable = (): never => {
    throw UClawErrorSchema.parse({
      code: "UNAVAILABLE",
      message,
      retryable: false,
      recoveryActions: [],
      causeDetails: {},
    });
  };
  return {
    mode: "live",
    repositoryVerified: false,
    search: async () => unavailable(),
    detail: async () => unavailable(),
    download: async () => unavailable(),
  };
}

export function createLivePluginRegistryClient(options: LivePluginRegistryClientOptions): PluginRegistryClient {
  const baseUrl = registryBaseUrl(options.baseUrl);
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxResponseBytes = options.maxResponseBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("Plugin registry timeout is invalid.");
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 64 * 1024 * 1024) throw new Error("Plugin registry response limit is invalid.");

  const request = async (url: URL): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Plugin registry request timed out.")), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        credentials: "omit",
        signal: controller.signal,
      });
      return await readBoundedJson(response, maxResponseBytes);
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Plugin registry request timed out.", { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  // Assumed v1 JSON contract; no authoritative registry contract is bundled in this repository.
  const endpoint = (slug?: string, bundle = false): URL => new URL(
    slug === undefined ? "plugins" : `plugins/${encodeURIComponent(slug)}${bundle ? "/bundle" : ""}`,
    baseUrl,
  );

  return {
    mode: "live",
    repositoryVerified: false,
    async search(input) {
      const parsed = SearchInputSchema.parse(input);
      const url = endpoint();
      url.searchParams.set("query", parsed.query);
      if (parsed.cursor !== null) url.searchParams.set("cursor", parsed.cursor);
      url.searchParams.set("pageSize", String(parsed.pageSize));
      const page = SearchResponseSchema.parse(await request(url));
      return {
        ...page,
        items: page.items.map(liveDetail),
        mode: "live",
        repositoryVerified: false,
      };
    },
    async detail(slug) {
      return liveDetail(await request(endpoint(SlugSchema.parse(slug))));
    },
    async download(slug): Promise<PluginBundle> {
      return BundleSchema.parse(await request(endpoint(SlugSchema.parse(slug), true)));
    },
  };
}
