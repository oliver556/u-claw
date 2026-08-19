import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SkillDetail } from "@uclaw/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { skillIdentityFingerprint, tagSkillHubFailure, type SkillHubClient } from "../src/skills/fixture-client.js";
import {
  createCachedSkillHubClient,
  classifySkillHubRateLimit,
  SKILLHUB_MAX_RETRY_AFTER_MS,
} from "../src/skills/skillhub-cache.js";

const roots: string[] = [];

/** Creates an isolated cache path for one behavioral test. */
async function makeCachePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "uclaw-skillhub-cache-"));
  roots.push(root);
  return join(root, "skillhub.json");
}

/** Produces a schema-valid public SkillHub detail without credentials. */
function detail(slug = "workspace-reader", version = "1.0.0"): SkillDetail {
  return {
    slug,
    name: "Workspace Reader",
    description: "Reads workspace files",
    version,
    pricingType: "free",
    installedVersion: null,
    enabled: false,
    updateAvailable: false,
    source: { provider: "skillhub", url: `https://api.skillhub.cn/api/v1/skills/${slug}` },
    permissions: [],
    permissionFingerprint: "empty",
    risk: "low",
    mode: "live",
    categories: ["productivity"],
    logoUrl: null,
    readme: `# Workspace Reader ${version}\n`,
    manifest: { kind: "skill", id: slug, version, entry: "SKILL.md" },
  };
}

/** Builds a minimal upstream client whose methods can be replaced per test. */
function upstream(overrides: Partial<SkillHubClient> = {}): SkillHubClient {
  const search: SkillHubClient["search"] = vi.fn(async (input) => ({
    items: [detail(input.query || "workspace-reader")], nextCursor: null, hasMore: false, mode: "live" as const,
  }));
  return {
    mode: "live",
    search,
    confirmedIdentity: (slug) => ({ slug, namespace: "fixture", version: "1.0.0" }),
    refreshIdentity: vi.fn(async (identity) => identity),
    detail: vi.fn(async (slug) => detail(slug)),
    download: vi.fn(async () => ({ sourceUrl: "https://api.skillhub.cn/download", compressedBytes: 0, checksumSha256: "empty", entries: [] })),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("persistent SkillHub cache", () => {
  it("invalidates schema version 1 caches so newly projected logos are fetched", async () => {
    const cachePath = await makeCachePath();
    const input = { query: "", cursor: null, pageSize: 40 };
    await createCachedSkillHubClient({ client: upstream(), cachePath }).search(input);
    const legacy = JSON.parse(await readFile(cachePath, "utf8")) as { schemaVersion: number };
    legacy.schemaVersion = 1;
    await writeFile(cachePath, JSON.stringify(legacy));
    const logoUrl = "https://cloudcache.tencent-cloud.com/qcloud/ui/static/workspace-reader.png";
    const search = vi.fn(async () => ({ items: [{ ...detail(), logoUrl }], nextCursor: null, hasMore: false, mode: "live" as const }));

    await expect(createCachedSkillHubClient({ client: upstream({ search }), cachePath }).search(input)).resolves.toMatchObject({ items: [{ logoUrl }] });
    expect(search).toHaveBeenCalledOnce();
  });

  it("deduplicates concurrent catalog requests and persists schema-projected public data", async () => {
    const cachePath = await makeCachePath();
    let resolveSearch!: (value: Awaited<ReturnType<SkillHubClient["search"]>>) => void;
    const search = vi.fn(() => new Promise<Awaited<ReturnType<SkillHubClient["search"]>>>((resolve) => { resolveSearch = resolve; }));
    const client = createCachedSkillHubClient({ client: upstream({ search }), cachePath });
    const input = { query: "private-search-text", category: "productivity", cursor: null, pageSize: 40 };

    const first = client.search(input);
    const second = client.search(input);
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    resolveSearch({ items: [{ ...detail(), apiKey: "must-not-persist" } as SkillDetail], nextCursor: null, hasMore: false, mode: "live" });

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    const persisted = await readFile(cachePath, "utf8");
    expect(persisted).not.toContain("must-not-persist");
    expect(persisted).not.toContain("private-search-text");
    expect(await readdir(join(cachePath, ".."))).toEqual(["skillhub.json"]);
  });

  it("reuses catalog entries for 30 minutes and detail/readme entries for 24 hours across recreation", async () => {
    const cachePath = await makeCachePath();
    let now = 1_000;
    const source = upstream();
    const first = createCachedSkillHubClient({ client: source, cachePath, now: () => now });
    const input = { query: "", cursor: null, pageSize: 40 };
    await first.search(input);
    await first.detail("workspace-reader");

    now += 29 * 60 * 1_000;
    const cachedSource = upstream({
      search: vi.fn(async () => { throw new Error("offline"); }),
      detail: vi.fn(async () => { throw new Error("offline"); }),
    });
    const second = createCachedSkillHubClient({ client: cachedSource, cachePath, now: () => now });
    await expect(second.search(input)).resolves.toMatchObject({ items: [{ slug: "workspace-reader" }] });
    await expect(second.detail("workspace-reader")).resolves.toMatchObject({
      slug: "workspace-reader", readme: "# Workspace Reader 1.0.0\n",
    });
    expect(cachedSource.search).not.toHaveBeenCalled();
    expect(cachedSource.detail).not.toHaveBeenCalled();

    now += 2 * 60 * 1_000;
    await expect(second.search(input)).resolves.toMatchObject({ items: [{ slug: "workspace-reader" }] });
    expect(cachedSource.search).toHaveBeenCalledTimes(1);
    expect(cachedSource.detail).not.toHaveBeenCalled();
  });

  it("refreshes paginated first pages so cached and live identity sessions cannot mix", async () => {
    const cachePath = await makeCachePath();
    const input = { query: "", cursor: null, pageSize: 40 };
    const paginatedSearch = vi.fn(async () => ({
      items: [detail()], nextCursor: "2", hasMore: true, mode: "live" as const,
    }));
    await createCachedSkillHubClient({ client: upstream({ search: paginatedSearch }), cachePath }).search(input);
    const refreshedSearch = vi.fn(async () => ({
      items: [detail()], nextCursor: "2", hasMore: true, mode: "live" as const,
    }));

    await expect(createCachedSkillHubClient({ client: upstream({ search: refreshedSearch }), cachePath }).search(input)).resolves.toMatchObject({
      items: [{ slug: "workspace-reader" }], hasMore: true,
    });
    expect(refreshedSearch).toHaveBeenCalledOnce();
  });

  it("does not cache an older replacement response after a newer catalog wins", async () => {
    const cachePath = await makeCachePath();
    const inputA = { query: "", category: "office-efficiency", cursor: null, pageSize: 40 };
    const inputB = { query: "", category: "education", cursor: null, pageSize: 40 };
    const identityA = { slug: "workspace-reader", namespace: "owner-a", version: "1.0.0" };
    const identityB = { slug: "workspace-reader", namespace: "owner-b", version: "1.0.0" };
    let currentIdentity = identityA;
    let resolveA!: (value: Awaited<ReturnType<SkillHubClient["search"]>>) => void;
    let resolveB!: (value: Awaited<ReturnType<SkillHubClient["search"]>>) => void;
    const search = vi.fn((input: Parameters<SkillHubClient["search"]>[0]) =>
      new Promise<Awaited<ReturnType<SkillHubClient["search"]>>>((resolve) => {
        if (input.category === "office-efficiency") resolveA = resolve;
        else resolveB = resolve;
      }));
    const source = Object.assign(upstream({ search }), { confirmedIdentity: vi.fn(() => currentIdentity) });
    const client = createCachedSkillHubClient({ client: source, cachePath });

    const older = client.search(inputA);
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    const newer = client.search(inputB);
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    currentIdentity = identityB;
    resolveB({ items: [detail()], nextCursor: null, hasMore: false, mode: "live" });
    await expect(newer).resolves.toMatchObject({ items: [{ slug: "workspace-reader" }] });
    resolveA({ items: [detail()], nextCursor: null, hasMore: false, mode: "live" });
    await expect(older).rejects.toThrow(/catalog changed/i);

    currentIdentity = identityA;
    const refreshedSearch = vi.fn(async () => ({ items: [detail()], nextCursor: null, hasMore: false, mode: "live" as const }));
    const restarted = createCachedSkillHubClient({
      client: Object.assign(upstream({ search: refreshedSearch }), { confirmedIdentity: vi.fn(() => identityA) }),
      cachePath,
    });
    await restarted.search(inputA);
    expect(refreshedSearch).toHaveBeenCalledOnce();
  });

  it("restores live identity proof before uncached detail after a disk-cached search", async () => {
    const cachePath = await makeCachePath();
    const input = { query: "", cursor: null, pageSize: 40 };
    await createCachedSkillHubClient({ client: upstream(), cachePath }).search(input);

    const confirmed = new Set<string>();
    const search = vi.fn(async ({ query }: Parameters<SkillHubClient["search"]>[0]) => {
      const items = query === "workspace-reader" ? [detail()] : [];
      for (const item of items) confirmed.add(item.slug);
      return { items, nextCursor: null, hasMore: false, mode: "live" as const };
    });
    const liveDetail = vi.fn(async (slug: string) => {
      if (!confirmed.has(slug)) throw new Error("missing namespace proof");
      return detail(slug);
    });
    const restarted = createCachedSkillHubClient({
      client: upstream({ search, detail: liveDetail }),
      cachePath,
      detailTtlMs: 0,
    });

    await expect(restarted.search(input)).resolves.toMatchObject({ items: [{ slug: "workspace-reader" }] });
    expect(search).not.toHaveBeenCalled();
    await expect(restarted.detail("workspace-reader")).resolves.toMatchObject({ slug: "workspace-reader" });
    await expect(restarted.detail("workspace-reader")).resolves.toMatchObject({ slug: "workspace-reader" });
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith({ query: "workspace-reader", cursor: null, pageSize: 50 });
    expect(liveDetail).toHaveBeenCalledTimes(2);
  });

  it("rejects uncached detail when live identity proof has no exact slug", async () => {
    const cachePath = await makeCachePath();
    const input = { query: "", cursor: null, pageSize: 40 };
    await createCachedSkillHubClient({ client: upstream(), cachePath }).search(input);
    const search = vi.fn(async () => ({ items: [detail("different-skill")], nextCursor: null, hasMore: false, mode: "live" as const }));
    const liveDetail = vi.fn(async (slug: string) => detail(slug));
    const restarted = createCachedSkillHubClient({ client: upstream({ search, detail: liveDetail }), cachePath });

    await expect(restarted.search(input)).resolves.toMatchObject({ items: [{ slug: "workspace-reader" }] });
    await expect(restarted.detail("workspace-reader")).rejects.toThrow(/identity/i);
    expect(search).toHaveBeenCalledOnce();
    expect(liveDetail).not.toHaveBeenCalled();
  });

  it("requests and caches detail independently by slug and expected version", async () => {
    const cachePath = await makeCachePath();
    let liveVersion = "1.0.0";
    const search = vi.fn(async () => ({ items: [detail("workspace-reader", liveVersion)], nextCursor: null, hasMore: false, mode: "live" as const }));
    const detailRequest = vi.fn(async (slug: string, expectedVersion?: string) => detail(slug, expectedVersion ?? liveVersion));
    const source = Object.assign(upstream({ search, detail: detailRequest }), {
      confirmedIdentity: () => ({ slug: "workspace-reader", namespace: "owner", version: liveVersion }),
    });
    const client = createCachedSkillHubClient({ client: source, cachePath });

    await expect(client.detail("workspace-reader", "1.0.0")).resolves.toMatchObject({ version: "1.0.0", readme: expect.stringContaining("1.0.0") });
    liveVersion = "2.0.0";
    await expect(client.detail("workspace-reader", "2.0.0")).resolves.toMatchObject({ version: "2.0.0", readme: expect.stringContaining("2.0.0") });
    liveVersion = "1.0.0";
    await expect(client.detail("workspace-reader", "1.0.0")).resolves.toMatchObject({ version: "1.0.0", readme: expect.stringContaining("1.0.0") });

    expect(detailRequest.mock.calls.map(([, expectedVersion]) => expectedVersion)).toEqual(["1.0.0", "2.0.0"]);
  });

  it("rejects a detail whose upstream namespace fingerprint conflicts with the live proof", async () => {
    const cachePath = await makeCachePath();
    const identity = { slug: "workspace-reader", namespace: "owner-a", version: "1.0.0" };
    const conflicting = { ...identity, namespace: "owner-b" };
    const source = Object.assign(upstream({
      detail: vi.fn(async () => ({ ...detail(), identityFingerprint: skillIdentityFingerprint(conflicting) })),
    }), { confirmedIdentity: vi.fn(() => identity) });
    const client = createCachedSkillHubClient({ client: source, cachePath });

    await expect(client.detail("workspace-reader", "1.0.0")).rejects.toThrow(/identity.*drift/i);
  });

  it("force-refreshes a disk-cached exact identity without relying on an ambiguous slug search", async () => {
    const cachePath = await makeCachePath();
    const identity = { slug: "workspace-reader", namespace: "owner-a", version: "1.0.0" };
    const initialSource = Object.assign(upstream(), { confirmedIdentity: vi.fn(() => identity) });
    await createCachedSkillHubClient({ client: initialSource, cachePath }).detail("workspace-reader", "1.0.0");
    const refreshIdentity = vi.fn(async (candidate) => candidate);
    const search = vi.fn(async () => { throw new Error("ambiguous slug search must not be used"); });
    const restarted = createCachedSkillHubClient({
      client: upstream({ search, refreshIdentity }),
      cachePath,
    });

    await expect(restarted.detail("workspace-reader", "1.0.0", true)).resolves.toMatchObject({
      slug: "workspace-reader",
      version: "1.0.0",
      identityFingerprint: skillIdentityFingerprint(identity),
    });
    expect(refreshIdentity).toHaveBeenCalledWith(identity);
    expect(search).not.toHaveBeenCalled();
  });

  it.each([
    ["namespace", { slug: "workspace-reader", namespace: "owner-b", version: "1.0.0" }],
    ["version", { slug: "workspace-reader", namespace: "owner-a", version: "2.0.0" }],
  ])("rejects download when live %s drifts from the cached detail identity", async (_field, liveIdentity) => {
    const cachePath = await makeCachePath();
    const confirmedIdentity = vi.fn(() => ({ slug: "workspace-reader", namespace: "owner-a", version: "1.0.0" }));
    const initialSource = Object.assign(upstream(), { confirmedIdentity });
    await createCachedSkillHubClient({ client: initialSource, cachePath }).detail("workspace-reader");

    const liveItem = { ...detail(), version: liveIdentity.version, manifest: { ...detail().manifest, version: liveIdentity.version } };
    const search = vi.fn(async () => ({ items: [liveItem], nextCursor: null, hasMore: false, mode: "live" as const }));
    const download = vi.fn(async () => ({ sourceUrl: "https://api.skillhub.cn/download", compressedBytes: 0, checksumSha256: "empty", entries: [] }));
    const refreshIdentity = vi.fn(async () => liveIdentity);
    const restartedSource = Object.assign(upstream({ search, download, refreshIdentity }), { confirmedIdentity: vi.fn(() => liveIdentity) });
    const restarted = createCachedSkillHubClient({ client: restartedSource, cachePath });

    await expect(restarted.detail("workspace-reader")).resolves.toMatchObject({ slug: "workspace-reader", version: "1.0.0" });
    await expect(restarted.download("workspace-reader")).rejects.toThrow(/identity.*drift/i);
    expect(refreshIdentity).toHaveBeenCalledOnce();
    expect(search).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it("returns stale successful values when refresh fails", async () => {
    const cachePath = await makeCachePath();
    let now = 0;
    const input = { query: "", cursor: null, pageSize: 40 };
    const initial = createCachedSkillHubClient({ client: upstream(), cachePath, now: () => now });
    await initial.search(input);
    await initial.detail("workspace-reader");

    now = 25 * 60 * 60 * 1_000;
    const failure = tagSkillHubFailure(new Error("upstream unavailable"), "upstream-unavailable");
    const failing = upstream({
      search: vi.fn(async () => { throw failure; }),
      detail: vi.fn(async () => { throw failure; }),
    });
    const fallback = createCachedSkillHubClient({ client: failing, cachePath, now: () => now });

    await expect(fallback.search(input)).resolves.toMatchObject({ stale: true, items: [{ slug: "workspace-reader" }] });
    await expect(fallback.detail("workspace-reader")).resolves.toMatchObject({ slug: "workspace-reader", stale: true });
  });

  it.each(["not-found", "identity-conflict", "forbidden", "upstream-invalid"] as const)(
    "does not use stale detail for a structured %s failure",
    async (reason) => {
      const cachePath = await makeCachePath();
      let now = 0;
      await createCachedSkillHubClient({ client: upstream(), cachePath, now: () => now }).detail("workspace-reader");
      now = 25 * 60 * 60 * 1_000;
      const failure = tagSkillHubFailure(new Error("rejected"), reason);
      const fallback = createCachedSkillHubClient({
        client: upstream({ detail: vi.fn(async () => { throw failure; }) }),
        cachePath,
        now: () => now,
      });

      await expect(fallback.detail("workspace-reader")).rejects.toBe(failure);
    },
  );

  it("bounds search and detail entries while preserving stale fallback for retained values", async () => {
    const cachePath = await makeCachePath();
    let now = 0;
    const client = createCachedSkillHubClient({
      client: upstream(),
      cachePath,
      now: () => now,
      maxSearchEntries: 2,
      maxDetailEntries: 2,
    });

    for (const slug of ["oldest", "middle", "newest"]) {
      now += 1;
      await client.search({ query: slug, cursor: null, pageSize: 40 });
      now += 1;
      await client.detail(slug);
    }

    const persisted = JSON.parse(await readFile(cachePath, "utf8")) as { searches: object; details: object };
    expect(Object.keys(persisted.searches)).toHaveLength(2);
    expect(Object.keys(persisted.details)).toHaveLength(2);

    now += 25 * 60 * 60 * 1_000;
    const failure = tagSkillHubFailure(new Error("upstream unavailable"), "upstream-unavailable");
    const fallback = createCachedSkillHubClient({
      client: upstream({
        search: vi.fn(async () => { throw failure; }),
        detail: vi.fn(async () => { throw failure; }),
      }),
      cachePath,
      now: () => now,
      maxSearchEntries: 2,
      maxDetailEntries: 2,
    });

    await expect(fallback.search({ query: "newest", cursor: null, pageSize: 40 })).resolves.toMatchObject({ stale: true });
    await expect(fallback.detail("newest")).resolves.toMatchObject({ slug: "newest", stale: true });
    await expect(fallback.search({ query: "oldest", cursor: null, pageSize: 40 })).rejects.toThrow("upstream unavailable");
    await expect(fallback.detail("oldest")).rejects.toThrow("upstream unavailable");
  });

  it("honors Retry-After before exponential backoff and never retries unrelated failures", async () => {
    const cachePath = await makeCachePath();
    const rateLimited = Object.assign(new Error("rate limited"), { status: 429, retryAfter: "2" });
    const search = vi.fn()
      .mockRejectedValueOnce(rateLimited)
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { statusCode: 429 }))
      .mockResolvedValueOnce({ items: [detail()], nextCursor: null, hasMore: false, mode: "live" });
    const sleep = vi.fn(async () => undefined);
    const client = createCachedSkillHubClient({ client: upstream({ search }), cachePath, sleep, retryBaseMs: 250, maxRetries: 2 });

    await expect(client.search({ query: "", cursor: null, pageSize: 40 })).resolves.toMatchObject({ items: [{ slug: "workspace-reader" }] });
    expect(sleep).toHaveBeenNthCalledWith(1, 2_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 500);

    const detailFailure = vi.fn(async () => { throw new Error("invalid response"); });
    const noRetry = createCachedSkillHubClient({ client: upstream({ detail: detailFailure }), cachePath: await makeCachePath(), sleep });
    await expect(noRetry.detail("other-skill")).rejects.toThrow("invalid response");
    expect(detailFailure).toHaveBeenCalledTimes(1);
  });

  it("caps Retry-After seconds, HTTP dates, and explicit milliseconds", () => {
    const now = Date.parse("2026-08-20T00:00:00.000Z");
    const farFuture = new Date(now + 24 * 60 * 60 * 1_000).toUTCString();

    expect(classifySkillHubRateLimit({ status: 429, retryAfter: "999999" }, now)).toEqual({
      retryAfterMs: SKILLHUB_MAX_RETRY_AFTER_MS,
    });
    expect(classifySkillHubRateLimit({ status: 429, headers: { "Retry-After": farFuture } }, now)).toEqual({
      retryAfterMs: SKILLHUB_MAX_RETRY_AFTER_MS,
    });
    expect(classifySkillHubRateLimit({ status: 429, retryAfterMs: Number.MAX_SAFE_INTEGER }, now)).toEqual({
      retryAfterMs: SKILLHUB_MAX_RETRY_AFTER_MS,
    });
  });

  it("passes downloads through and refreshes live identity before each archive", async () => {
    const cachePath = await makeCachePath();
    const source = upstream();
    const client = createCachedSkillHubClient({ client: source, cachePath });

    await client.download("workspace-reader");
    await client.download("workspace-reader");

    expect(source.download).toHaveBeenCalledTimes(2);
    expect(source.search).toHaveBeenCalledTimes(2);
  });
});
