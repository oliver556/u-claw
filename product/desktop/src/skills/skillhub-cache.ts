import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { SkillDetailSchema, type SkillDetail } from "@uclaw/shared";
import { z } from "zod";

import type { SkillHubClient, SkillHubSearchResult } from "./fixture-client.js";

export const SKILLHUB_SEARCH_TTL_MS = 30 * 60 * 1_000;
export const SKILLHUB_DETAIL_TTL_MS = 24 * 60 * 60 * 1_000;
export const SKILLHUB_MAX_RETRY_AFTER_MS = 30_000;
export const SKILLHUB_MAX_SEARCH_ENTRIES = 200;
export const SKILLHUB_MAX_DETAIL_ENTRIES = 500;

const SearchResultSchema = z.object({
  items: z.array(SkillDetailSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  mode: z.enum(["fixture", "live"]),
}).strict();
const SearchEntrySchema = z.object({ storedAt: z.number().finite().nonnegative(), value: SearchResultSchema }).strict();
const DetailEntrySchema = z.object({ storedAt: z.number().finite().nonnegative(), value: SkillDetailSchema }).strict();
const CacheStateSchema = z.object({
  schemaVersion: z.literal(1),
  searches: z.record(z.string(), SearchEntrySchema),
  details: z.record(z.string(), DetailEntrySchema),
}).strict();

type CacheState = z.infer<typeof CacheStateSchema>;
type RateLimitDirective = { retryAfterMs?: number };

export interface CachedSkillHubClientOptions {
  client: SkillHubClient;
  cachePath: string;
  searchTtlMs?: number;
  detailTtlMs?: number;
  maxSearchEntries?: number;
  maxDetailEntries?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  classifyRateLimit?: (error: unknown) => RateLimitDirective | null;
}

/** Creates an empty, versioned cache state. */
function emptyState(): CacheState {
  return { schemaVersion: 1, searches: {}, details: {} };
}

/** Reads only schema-valid public cache data; missing or corrupt caches are cold starts. */
async function readState(path: string): Promise<CacheState> {
  try {
    return CacheStateSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return emptyState();
  }
}

/** Replaces the cache through a same-directory temporary file, preventing partial JSON reads. */
async function writeStateAtomic(path: string, state: CacheState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Projects upstream values onto the shared public schema so incidental secrets cannot persist. */
function publicDetail(value: SkillDetail): SkillDetail {
  return SkillDetailSchema.parse({
    slug: value.slug,
    name: value.name,
    description: value.description,
    version: value.version,
    pricingType: value.pricingType,
    installedVersion: value.installedVersion,
    enabled: value.enabled,
    updateAvailable: value.updateAvailable,
    source: value.source,
    permissions: value.permissions,
    permissionFingerprint: value.permissionFingerprint,
    risk: value.risk,
    mode: value.mode,
    categories: value.categories,
    logoUrl: value.logoUrl,
    ownerName: value.ownerName,
    downloads: value.downloads,
    stars: value.stars,
    requiresKey: value.requiresKey,
    updatedAt: value.updatedAt,
    readme: value.readme,
    manifest: value.manifest,
  });
}

/** Projects a catalog page and every item before writing it to disk. */
function publicSearchResult(value: SkillHubSearchResult): SkillHubSearchResult {
  return SearchResultSchema.parse({ ...value, items: value.items.map(publicDetail) });
}

/** Hashes search parameters so user-entered query text never appears in persisted cache keys. */
function searchKey(input: Parameters<SkillHubClient["search"]>[0]): string {
  const canonical = JSON.stringify({
    query: input.query,
    category: input.category ?? null,
    sort: input.sort ?? null,
    cursor: input.cursor,
    pageSize: input.pageSize,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Removes least-recently stored entries so each durable cache remains bounded. */
function pruneOldestEntries<T extends { storedAt: number }>(entries: Record<string, T>, maxEntries: number): void {
  const excess = Object.keys(entries).length - maxEntries;
  if (excess <= 0) return;
  const oldestKeys = Object.entries(entries)
    .sort(([, left], [, right]) => left.storedAt - right.storedAt)
    .slice(0, excess)
    .map(([key]) => key);
  for (const key of oldestKeys) delete entries[key];
}

/** Bounds any valid retry delay so one upstream directive cannot stall requests indefinitely. */
function boundedRetryDelay(milliseconds: unknown): number | undefined {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  return Math.min(milliseconds, SKILLHUB_MAX_RETRY_AFTER_MS);
}

/** Reads a Retry-After value expressed as seconds or an HTTP date. */
function retryAfterMilliseconds(value: unknown, now: number): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return boundedRetryDelay(value * 1_000);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) return boundedRetryDelay(Number(trimmed) * 1_000);
  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) ? boundedRetryDelay(Math.max(0, timestamp - now)) : undefined;
}

/** Extracts status and Retry-After from common HTTP client error shapes. */
export function classifySkillHubRateLimit(error: unknown, now = Date.now()): RateLimitDirective | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    retryAfter?: unknown;
    retryAfterMs?: unknown;
    headers?: unknown;
    response?: { status?: unknown; headers?: unknown };
  };
  const status = candidate.status ?? candidate.statusCode ?? candidate.response?.status;
  if (status !== 429) return null;
  const headers = candidate.headers ?? candidate.response?.headers;
  let headerValue: unknown;
  if (headers instanceof Headers) headerValue = headers.get("retry-after");
  else if (headers && typeof headers === "object") {
    const record = headers as Record<string, unknown>;
    headerValue = record["retry-after"] ?? record["Retry-After"];
  }
  const explicitMs = boundedRetryDelay(candidate.retryAfterMs);
  return { retryAfterMs: explicitMs ?? retryAfterMilliseconds(candidate.retryAfter ?? headerValue, now) };
}

/** Sleeps without blocking Electron's main-process event loop. */
async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/** Adds durable TTL, request coalescing, stale fallback, and 429 retry around a SkillHub client. */
export function createCachedSkillHubClient(options: CachedSkillHubClientOptions): SkillHubClient {
  const searchTtlMs = options.searchTtlMs ?? SKILLHUB_SEARCH_TTL_MS;
  const detailTtlMs = options.detailTtlMs ?? SKILLHUB_DETAIL_TTL_MS;
  const maxSearchEntries = options.maxSearchEntries ?? SKILLHUB_MAX_SEARCH_ENTRIES;
  const maxDetailEntries = options.maxDetailEntries ?? SKILLHUB_MAX_DETAIL_ENTRIES;
  const maxRetries = options.maxRetries ?? 2;
  const retryBaseMs = options.retryBaseMs ?? 500;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const classifyRateLimit = options.classifyRateLimit ?? ((error: unknown) => classifySkillHubRateLimit(error, now()));
  if (!Number.isFinite(searchTtlMs) || searchTtlMs < 0 || !Number.isFinite(detailTtlMs) || detailTtlMs < 0 ||
    !Number.isInteger(maxSearchEntries) || maxSearchEntries <= 0 ||
    !Number.isInteger(maxDetailEntries) || maxDetailEntries <= 0 ||
    maxRetries < 0 || !Number.isInteger(maxRetries) || !Number.isFinite(retryBaseMs) || retryBaseMs < 0) {
    throw new Error("SkillHub cache timing options are invalid.");
  }

  let state = emptyState();
  let loadPromise: Promise<void> | undefined;
  let persistPromise = Promise.resolve();
  const inFlight = new Map<string, Promise<unknown>>();
  const upstreamProofs = new Set<string>();

  /** Loads persistent state once before the first cache lookup. */
  const load = async (): Promise<void> => {
    loadPromise ??= readState(options.cachePath).then((loaded) => { state = loaded; });
    await loadPromise;
  };

  /** Serializes atomic writes so overlapping successful requests cannot lose entries. */
  const persist = async (): Promise<void> => {
    persistPromise = persistPromise.catch(() => undefined).then(() => writeStateAtomic(options.cachePath, state));
    await persistPromise;
  };

  /** Retries only recognized 429 failures, honoring Retry-After when supplied. */
  const withRateLimitRetry = async <T>(operation: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const directive = classifyRateLimit(error);
        if (directive === null || attempt >= maxRetries) throw error;
        await sleep(boundedRetryDelay(directive.retryAfterMs ?? retryBaseMs * (2 ** attempt)) ?? SKILLHUB_MAX_RETRY_AFTER_MS);
      }
    }
  };

  /** Coalesces concurrent requests sharing one stable operation key. */
  const deduplicate = <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const existing = inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const pending = operation().finally(() => { inFlight.delete(key); });
    inFlight.set(key, pending);
    return pending;
  };

  return {
    mode: options.client.mode,
    failAfterBackup: options.client.failAfterBackup,
    async search(input) {
      await load();
      const key = searchKey(input);
      const cached = state.searches[key];
      if (cached && now() - cached.storedAt < searchTtlMs) return { ...cached.value, stale: false };
      return deduplicate(`search:${key}`, async () => {
        try {
          const value = publicSearchResult(await withRateLimitRetry(() => options.client.search(input)));
          for (const item of value.items) upstreamProofs.add(item.slug);
          state.searches[key] = { storedAt: now(), value };
          pruneOldestEntries(state.searches, maxSearchEntries);
          // Disk cache failure must not turn a successful marketplace request into an outage.
          await persist().catch(() => undefined);
          return { ...value, stale: false };
        } catch (error) {
          if (cached) return { ...cached.value, stale: true };
          throw error;
        }
      });
    },
    async detail(slug) {
      await load();
      const cached = state.details[slug];
      if (cached && now() - cached.storedAt < detailTtlMs) return { ...cached.value, stale: false };
      return deduplicate(`detail:${slug}`, async () => {
        try {
          // Upstream detail includes SKILL.md retrieval and validation, hence the longer README TTL.
          const value = publicDetail(await withRateLimitRetry(() => options.client.detail(slug)));
          upstreamProofs.add(slug);
          state.details[slug] = { storedAt: now(), value };
          pruneOldestEntries(state.details, maxDetailEntries);
          await persist().catch(() => undefined);
          return { ...value, stale: false };
        } catch (error) {
          if (cached) return { ...cached.value, stale: true };
          throw error;
        }
      });
    },
    async download(slug) {
      // Archives are never cached, but transient rate limits still use the common retry policy.
      // A disk-cached response cannot restore the live client's in-memory free-catalog proof.
      if (!upstreamProofs.has(slug)) {
        const proof = await withRateLimitRetry(() => options.client.search({ query: slug, cursor: null, pageSize: 50 }));
        if (!proof.items.some((item) => item.slug === slug)) throw new Error("SkillHub download identity is not confirmed by the live catalog.");
        upstreamProofs.add(slug);
      }
      return withRateLimitRetry(() => options.client.download(slug));
    },
  };
}
