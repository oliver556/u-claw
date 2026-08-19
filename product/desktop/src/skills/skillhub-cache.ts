import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { SkillDetailSchema, type SkillDetail } from "@uclaw/shared";
import { z } from "zod";

import { skillHubFailureReason, skillIdentityFingerprint, tagSkillHubFailure, type SkillHubClient, type SkillHubIdentity, type SkillHubSearchResult } from "./fixture-client.js";

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
const SkillHubIdentitySchema = z.object({
  slug: z.string().min(1),
  namespace: z.string().min(1),
  version: z.string().min(1),
}).strict();
const DetailEntrySchema = z.object({
  storedAt: z.number().finite().nonnegative(),
  value: SkillDetailSchema,
  identity: SkillHubIdentitySchema.optional(),
}).strict();
const CacheStateSchema = z.object({
  schemaVersion: z.literal(3),
  searches: z.record(z.string(), SearchEntrySchema),
  details: z.record(z.string(), DetailEntrySchema),
  detailVersions: z.record(z.string(), z.string().min(1)).default({}),
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
  return { schemaVersion: 3, searches: {}, details: {}, detailVersions: {} };
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
    identityFingerprint: value.identityFingerprint,
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

/** Keys README/detail cache entries by both marketplace slug and selected version. */
function detailKey(slug: string, version: string): string {
  return createHash("sha256").update(JSON.stringify({ slug, version })).digest("hex");
}

/** Compares the private catalog tuple that binds a viewed detail to its download. */
function sameIdentity(left: SkillHubIdentity, right: SkillHubIdentity): boolean {
  return left.slug === right.slug && left.namespace === right.namespace && left.version === right.version;
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
  const upstreamProofs = new Map<string, SkillHubIdentity>();
  const confirmedDetails = new Map<string, SkillHubIdentity>();
  let catalogEpoch = 0;

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

  /** Fetches and validates an exact live tuple without exposing namespace through public Skill data. */
  const refreshLiveIdentity = (slug: string, expectedVersion?: string, expectedIdentity?: SkillHubIdentity): Promise<SkillHubIdentity> => deduplicate(`proof-refresh:${slug}:${expectedVersion ?? "latest"}:${expectedIdentity?.namespace ?? "search"}`, async () => {
    if (expectedIdentity) {
      if (expectedIdentity.slug !== slug || (expectedVersion !== undefined && expectedIdentity.version !== expectedVersion)) {
        throw tagSkillHubFailure(new Error("SkillHub cached identity does not match the requested version."), "identity-conflict");
      }
      const refreshed = await withRateLimitRetry(() => options.client.refreshIdentity(expectedIdentity));
      if (!sameIdentity(expectedIdentity, refreshed)) {
        throw tagSkillHubFailure(new Error("SkillHub refreshed identity drifted from the requested tuple."), "identity-conflict");
      }
      return refreshed;
    }
    const proof = await withRateLimitRetry(() => options.client.search({ query: slug, cursor: null, pageSize: 50 }));
    const exact = proof.items.find((item) => item.slug === slug);
    const identity = options.client.confirmedIdentity(slug);
    if (!exact || !identity || identity.slug !== slug || identity.version !== exact.version ||
      (expectedVersion !== undefined && identity.version !== expectedVersion)) {
      throw tagSkillHubFailure(new Error("SkillHub identity is not confirmed by the live catalog."), "identity-conflict");
    }
    return identity;
  });

  /** Reuses a current live proof, rebuilding it after disk-only cache hits. */
  const confirmLiveIdentity = async (slug: string, expectedVersion?: string): Promise<SkillHubIdentity> => {
    const existing = upstreamProofs.get(slug);
    return existing && (expectedVersion === undefined || existing.version === expectedVersion)
      ? existing
      : refreshLiveIdentity(slug, expectedVersion);
  };

  return {
    mode: options.client.mode,
    failAfterBackup: options.client.failAfterBackup,
    /** Returns proof known by this wrapper without adding namespace to public Skill details. */
    confirmedIdentity(slug) {
      return upstreamProofs.get(slug) ?? confirmedDetails.get(slug);
    },
    /** Revalidates and records one exact tuple through the wrapped live client. */
    async refreshIdentity(identity) {
      const refreshed = await withRateLimitRetry(() => options.client.refreshIdentity(identity));
      if (!sameIdentity(identity, refreshed)) {
        throw tagSkillHubFailure(new Error("SkillHub refreshed identity drifted from the requested tuple."), "identity-conflict");
      }
      upstreamProofs.set(identity.slug, refreshed);
      confirmedDetails.set(identity.slug, refreshed);
      return refreshed;
    },
    /** Uses cache only for complete catalogs so cached and live pages cannot mix identity sessions. */
    async search(input) {
      await load();
      const key = searchKey(input);
      const operationKey = `search:${key}`;
      const joinsPendingReplacement = input.cursor === null && inFlight.has(operationKey);
      const requestEpoch = input.cursor === null && !joinsPendingReplacement ? ++catalogEpoch : catalogEpoch;
      const priorProofs = input.cursor === null ? new Map<string, SkillHubIdentity>() : new Map(upstreamProofs);
      if (input.cursor === null && !joinsPendingReplacement) upstreamProofs.clear();
      const cached = state.searches[key];
      if (cached && !cached.value.hasMore && now() - cached.storedAt < searchTtlMs) return { ...cached.value, stale: false };
      return deduplicate(operationKey, async () => {
        try {
          const projected = publicSearchResult(await withRateLimitRetry(() => options.client.search(input)));
          if (requestEpoch !== catalogEpoch) throw new Error("SkillHub catalog changed while loading search results.");
          const accepted: SkillDetail[] = [];
          const pageProofs = new Map<string, SkillHubIdentity>();
          for (const item of projected.items) {
            const identity = options.client.confirmedIdentity(item.slug);
            if (!identity || identity.version !== item.version) continue;
            const prior = priorProofs.get(item.slug) ?? pageProofs.get(item.slug);
            if (prior && !sameIdentity(prior, identity)) continue;
            pageProofs.set(item.slug, identity);
            accepted.push(item);
          }
          const value = publicSearchResult({ ...projected, items: accepted });
          if (requestEpoch === catalogEpoch) {
            if (input.cursor === null) upstreamProofs.clear();
            for (const [slug, identity] of pageProofs) upstreamProofs.set(slug, identity);
          }
          state.searches[key] = { storedAt: now(), value };
          pruneOldestEntries(state.searches, maxSearchEntries);
          // Disk cache failure must not turn a successful marketplace request into an outage.
          await persist().catch(() => undefined);
          return { ...value, stale: false };
        } catch (error) {
          if (requestEpoch !== catalogEpoch) throw error;
          if (cached) return { ...cached.value, nextCursor: null, hasMore: false, stale: true };
          throw error;
        }
      });
    },
    /** Returns a cached detail only when it still matches the active catalog identity. */
    async detail(slug, expectedVersion, forceRefresh = false) {
      await load();
      const requestEpoch = catalogEpoch;
      const cachedVersion = expectedVersion ?? state.detailVersions[slug];
      const key = cachedVersion ? detailKey(slug, cachedVersion) : undefined;
      const cached = key ? state.details[key] : undefined;
      const cachedFingerprint = cached?.identity ? skillIdentityFingerprint(cached.identity) : undefined;
      const activeProof = upstreamProofs.get(slug);
      const cachedIdentityValid = cached?.identity !== undefined &&
        cached.value.identityFingerprint === cachedFingerprint &&
        (activeProof === undefined || (expectedVersion === undefined
          ? sameIdentity(cached.identity, activeProof)
          : cached.identity.namespace === activeProof.namespace)) &&
        (expectedVersion === undefined || cached.value.version === expectedVersion);
      if (!forceRefresh && cached?.identity && cachedIdentityValid && now() - cached.storedAt < detailTtlMs) {
        confirmedDetails.set(slug, cached.identity);
        return { ...cached.value, stale: false };
      }
      return deduplicate(`detail:${slug}:${expectedVersion ?? "latest"}:${forceRefresh ? "refresh" : "cached"}`, async () => {
        try {
          const identity = forceRefresh
            ? await refreshLiveIdentity(slug, expectedVersion, cached?.identity ?? confirmedDetails.get(slug) ?? upstreamProofs.get(slug))
            : await confirmLiveIdentity(slug, expectedVersion);
          if (requestEpoch !== catalogEpoch) throw tagSkillHubFailure(new Error("SkillHub catalog changed while loading detail."), "identity-conflict");
          // Upstream detail includes SKILL.md retrieval and validation, hence the longer README TTL.
          const upstreamDetail = await withRateLimitRetry(() => options.client.detail(slug, expectedVersion));
          let projected: SkillDetail;
          try {
            projected = publicDetail(upstreamDetail);
          } catch (error) {
            throw tagSkillHubFailure(error, "upstream-invalid");
          }
          if (requestEpoch !== catalogEpoch) throw tagSkillHubFailure(new Error("SkillHub catalog changed while loading detail."), "identity-conflict");
          const identityFingerprint = skillIdentityFingerprint(identity);
          if (projected.identityFingerprint !== undefined && projected.identityFingerprint !== identityFingerprint) {
            throw tagSkillHubFailure(new Error("SkillHub detail identity drifted from its live catalog proof."), "identity-conflict");
          }
          let value: SkillDetail;
          try {
            value = SkillDetailSchema.parse({ ...projected, identityFingerprint });
          } catch (error) {
            throw tagSkillHubFailure(error, "upstream-invalid");
          }
          if (value.slug !== identity.slug || value.version !== identity.version) {
            throw tagSkillHubFailure(new Error("SkillHub detail identity drifted from its live catalog proof."), "identity-conflict");
          }
          upstreamProofs.set(slug, identity);
          confirmedDetails.set(slug, identity);
          state.details[detailKey(slug, value.version)] = { storedAt: now(), value, identity };
          state.detailVersions[slug] = value.version;
          pruneOldestEntries(state.details, maxDetailEntries);
          for (const [indexedSlug, version] of Object.entries(state.detailVersions)) {
            if (!state.details[detailKey(indexedSlug, version)]) delete state.detailVersions[indexedSlug];
          }
          await persist().catch(() => undefined);
          return { ...value, stale: false };
        } catch (error) {
          if (requestEpoch !== catalogEpoch) throw error;
          const reason = skillHubFailureReason(error);
          if (reason !== "upstream-unavailable") throw error;
          if (cached?.identity && cachedIdentityValid) {
            confirmedDetails.set(slug, cached.identity);
            return { ...cached.value, stale: true };
          }
          throw error;
        }
      });
    },
    /** Refreshes the live tuple before returning any uncached install archive. */
    async download(slug) {
      const requestEpoch = catalogEpoch;
      // Archives are never cached, but transient rate limits still use the common retry policy.
      // A disk-cached response cannot restore the live client's in-memory free-catalog proof.
      const expected = confirmedDetails.get(slug);
      const live = await refreshLiveIdentity(slug, expected?.version, expected);
      if (requestEpoch !== catalogEpoch) throw new Error("SkillHub catalog changed while downloading.");
      if (expected && !sameIdentity(expected, live)) {
        throw new Error("SkillHub download identity drifted from the user-confirmed detail.");
      }
      upstreamProofs.set(slug, live);
      const bundle = await withRateLimitRetry(() => options.client.download(slug));
      if (requestEpoch !== catalogEpoch) throw new Error("SkillHub catalog changed while downloading.");
      return bundle;
    },
  };
}
