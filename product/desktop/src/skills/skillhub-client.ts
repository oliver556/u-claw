import { createHash } from "node:crypto";
import { posix } from "node:path";

import { SKILLHUB_TRUSTED_LOGO_HOSTS, SkillDetailSchema, type SkillDetail, SkillPermissionSchema } from "@uclaw/shared";
import JSZip from "jszip";
import { z } from "zod";

import { parseSkillMarkdownFrontmatter } from "./bundle-validator.js";
import { skillIdentityFingerprint, type SkillBundle, type SkillBundleEntry, type SkillHubClient, type SkillHubSearchResult } from "./fixture-client.js";

const DEFAULT_ORIGIN = "https://api.skillhub.cn";
const TRUSTED_API_HOST = "api.skillhub.cn";
const TRUSTED_DOWNLOAD_HOST = "skillhub-1388575217.cos.accelerate.myqcloud.com";
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$/iu;
const WINDOWS_INVALID_PATH_CHARACTER = /[<>:"|?*\u0000-\u001f\u007f]/u;
const JSON_LIMIT = 1024 * 1024;
const MARKDOWN_LIMIT = 1024 * 1024;
const ZIP_LIMIT = 20 * 1024 * 1024;
const FILE_LIMIT = 5 * 1024 * 1024;
const TOTAL_FILE_LIMIT = 50 * 1024 * 1024;
const FILE_COUNT_LIMIT = 1_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const OFFICIAL_NOT_PAID_FILTER = "pricing_type:!paid";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const NamespaceSchema = z.object({
  canonicalName: z.string().min(1).max(240),
  displayName: z.string().min(1).max(120),
  handle: z.string().min(1).max(120),
  publicSlug: z.string().min(1).max(80),
}).strict();

const LabelsSchema = z.record(z.string(), z.string()).nullable().optional();
const SearchItemSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),
  name: z.string().min(1).max(120),
  description: z.string().max(1_000),
  description_zh: z.string().max(1_000).nullable().optional(),
  version: z.string().min(1).max(80),
  labels: LabelsSchema,
  category: z.string().max(80).nullable().optional(),
  iconUrl: z.unknown().optional(),
  namespace: NamespaceSchema,
}).loose();
const SearchResponseSchema = z.object({
  code: z.number().int(),
  data: z.object({ skills: z.array(SearchItemSchema).max(50), total: z.number().int().nonnegative() }).strict(),
  message: z.string().max(500),
}).strict();

const DetailResponseSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),
  namespace: NamespaceSchema,
  latestVersion: z.object({ version: z.string().min(1).max(80) }).loose(),
  skill: z.object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),
    displayName: z.string().min(1).max(120),
    summary: z.string().max(1_000),
    summary_zh: z.string().max(1_000).nullable().optional(),
    labels: LabelsSchema,
    category: z.string().max(80).nullable().optional(),
    iconUrl: z.unknown().optional(),
  }).loose(),
}).loose();

const FileEntrySchema = z.object({
  path: z.string().min(1).max(500),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative().max(FILE_LIMIT),
}).strict();
const FilesResponseSchema = z.object({
  count: z.number().int().nonnegative().max(FILE_COUNT_LIMIT),
  files: z.array(FileEntrySchema).max(FILE_COUNT_LIMIT),
  namespace: NamespaceSchema,
  version: z.string().min(1).max(80),
}).strict();

const conservativePermissions = SkillPermissionSchema.array().parse([{
  kind: "command",
  access: "execute",
  target: "skill-package",
  risk: "high",
  reason: "SkillHub does not publish authoritative machine-readable permissions; inspect package before enabling.",
}]);
const conservativeFingerprint = createHash("sha256").update(JSON.stringify(conservativePermissions)).digest("hex");

function assertTrustedApiOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== TRUSTED_API_HOST || url.username || url.password || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("SkillHub client requires the trusted SkillHub HTTPS origin.");
  }
  return url;
}

function pricingDisposition(value: Record<string, unknown> & { labels?: Record<string, string> | null }): "free" | "unknown" | "non-free" {
  const MAX_PRICING_DEPTH = 8;
  const MAX_PRICING_NODES = 128;
  let declarations = 0;
  let nodes = 0;
  const explicitFalse = (entry: unknown) => entry === false || (typeof entry === "string" && entry.trim().toLowerCase() === "false");
  const explicitZero = (entry: unknown) => (typeof entry === "number" && Number.isFinite(entry) && entry === 0) ||
    (typeof entry === "string" && entry.trim() !== "" && Number(entry) === 0);
  const explicitFreeText = (entry: unknown) => typeof entry === "string" && entry.trim().toLowerCase() === "free";
  const pending: Array<{ key: string; entry: unknown; paidContext: boolean; depth: number }> = [];
  for (const [key, entry] of Object.entries(value.labels ?? {})) pending.push({ key, entry, paidContext: false, depth: 0 });
  for (const [key, entry] of Object.entries(value)) {
    if (key !== "labels") pending.push({ key, entry, paidContext: false, depth: 0 });
  }
  while (pending.length > 0) {
    const { key, entry, paidContext, depth } = pending.pop()!;
    const normalizedKey = key.toLowerCase().replace(/[-_]/gu, "");
    const paidContainer = normalizedKey.includes("pricing") || normalizedKey.includes("billing") ||
      normalizedKey.includes("payment") || normalizedKey.includes("plan");
    const relevant = paidContext || paidContainer || normalizedKey.includes("paid") ||
      normalizedKey.includes("trial") || normalizedKey.includes("price");
    if (!relevant) continue;
    nodes += 1;
    if (nodes > MAX_PRICING_NODES || depth > MAX_PRICING_DEPTH) return "non-free";
    if (normalizedKey.includes("paid") || normalizedKey.includes("trial")) {
      if (!explicitFalse(entry)) return "non-free";
      declarations += 1;
      continue;
    }
    if (normalizedKey.includes("price") || (paidContext && (normalizedKey === "amount" || normalizedKey === "cents"))) {
      if (!explicitZero(entry)) return "non-free";
      declarations += 1;
      continue;
    }
    if (paidContainer || (paidContext && normalizedKey === "type")) {
      if (entry && typeof entry === "object") {
        const children = Array.isArray(entry) ? entry.map((child, index) => [String(index), child] as const) : Object.entries(entry);
        for (const [childKey, child] of children) pending.push({ key: childKey, entry: child, paidContext: true, depth: depth + 1 });
      } else if (explicitFreeText(entry) || explicitFalse(entry) || explicitZero(entry)) declarations += 1;
      else return "non-free";
      continue;
    }
    if (paidContext && entry && typeof entry === "object") {
      const children = Array.isArray(entry) ? entry.map((child, index) => [String(index), child] as const) : Object.entries(entry);
      for (const [childKey, child] of children) pending.push({ key: childKey, entry: child, paidContext: true, depth: depth + 1 });
    }
  }
  return declarations > 0 ? "free" : "unknown";
}

function categories(labels: Record<string, string> | null | undefined, direct?: string | null): string[] {
  const result = new Set<string>();
  if (direct !== undefined && direct !== null && /^[a-z0-9][a-z0-9._-]{0,79}$/u.test(direct)) result.add(direct);
  for (const [key, value] of Object.entries(labels ?? {})) {
    const normalizedKey = key.toLowerCase().replace(/[-_]/gu, "");
    if (normalizedKey !== "category" && normalizedKey !== "categories") continue;
    for (const category of value.split(",").map((entry) => entry.trim().toLowerCase())) {
      if (/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(category)) result.add(category);
    }
  }
  return [...result];
}

/** Projects an upstream icon only when it uses an exact trusted SkillHub HTTPS host. */
function marketplaceLogoUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      SKILLHUB_TRUSTED_LOGO_HOSTS.some((host) => host === url.hostname)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

type MarketplaceMetadata = Pick<SkillDetail, "ownerName" | "downloads" | "stars" | "requiresKey" | "updatedAt">;

/** Projects only bounded, correctly typed marketplace fields from loose SkillHub payloads. */
function marketplaceMetadata(namespace: z.infer<typeof NamespaceSchema>, ...sources: ReadonlyArray<Record<string, unknown>>): MarketplaceMetadata {
  const entries = (keys: readonly string[]): unknown[] => sources.flatMap((source) => keys.map((key) => source[key]));
  const text = (keys: readonly string[], max: number): string | undefined => entries(keys)
    .find((value): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max)?.trim();
  const count = (keys: readonly string[]): number | undefined => entries(keys)
    .find((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  const boolean = (keys: readonly string[]): boolean | undefined => {
    for (const value of entries(keys)) {
      if (typeof value === "boolean") return value;
      if (typeof value === "string" && ["true", "false"].includes(value.trim().toLowerCase())) return value.trim().toLowerCase() === "true";
    }
    return undefined;
  };
  const timestamp = text(["updatedAt", "updated_at"], 80);
  const updatedAt = timestamp !== undefined && z.iso.datetime().safeParse(timestamp).success ? timestamp : undefined;
  const labels = sources.flatMap((source) => {
    const candidate = source.labels;
    return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate) ? [candidate as Record<string, unknown>] : [];
  });
  const downloads = count(["downloads", "downloadCount", "download_count"]);
  const stars = count(["stars", "starCount", "star_count"]);
  const requiresKey = boolean(["requiresKey", "requires_key", "requiresApiKey", "requires_api_key"]) ??
    marketplaceMetadataBoolean(labels, ["requiresKey", "requires_key", "requiresApiKey", "requires_api_key"]);
  return {
    ownerName: text(["ownerName", "owner_name", "upstream_owner_login"], 120) ?? namespace.displayName,
    ...(downloads === undefined ? {} : { downloads }),
    ...(stars === undefined ? {} : { stars }),
    ...(requiresKey === undefined ? {} : { requiresKey }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

/** Reads a boolean label without allowing arbitrary strings into the shared contract. */
function marketplaceMetadataBoolean(sources: ReadonlyArray<Record<string, unknown>>, keys: readonly string[]): boolean | undefined {
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "boolean") return value;
      if (typeof value === "string" && ["true", "false"].includes(value.trim().toLowerCase())) return value.trim().toLowerCase() === "true";
    }
  }
  return undefined;
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) throw new Error("SkillHub response exceeds limit.");
  if (!response.body) throw new Error("SkillHub response body is missing.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel(); throw new Error("SkillHub response exceeds limit."); }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

function responseType(response: Response): string {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function assertSuccess(response: Response): void {
  if (!response.ok || response.redirected || response.status >= 300) {
    throw Object.assign(new Error("SkillHub HTTP request failed."), {
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
    });
  }
}

function safeRedirect(response: Response): string {
  if (![301, 302, 303, 307, 308].includes(response.status)) throw new Error("SkillHub download did not return a redirect.");
  const location = response.headers.get("location");
  if (!location) throw new Error("SkillHub download redirect is missing.");
  const target = new URL(location);
  if (target.protocol !== "https:" || target.hostname !== TRUSTED_DOWNLOAD_HOST || target.username || target.password) {
    throw new Error("SkillHub returned an untrusted redirect.");
  }
  return target.toString();
}

function validRelativePath(path: string): boolean {
  if (!path || path.includes("\\") || path.includes("\0") || path.includes(":") || path.startsWith("/") || /^[A-Za-z]:/u.test(path)) return false;
  const normalized = posix.normalize(path);
  if (normalized !== path || normalized === ".." || normalized.startsWith("../")) return false;
  return path.split("/").every((segment) =>
    segment !== "" && !WINDOWS_INVALID_PATH_CHARACTER.test(segment) &&
    !segment.endsWith(".") && !segment.endsWith(" ") &&
    !WINDOWS_RESERVED_NAME.test(segment.split(".", 1)[0]!.replace(/ +$/u, "")));
}

function registerPath(
  paths: Map<string, "file" | "directory">,
  path: string,
  type: "file" | "directory",
  duplicateMessage: string,
  conflictMessage: string,
): void {
  const key = path.toLowerCase();
  const existing = paths.get(key);
  if (existing !== undefined) throw new Error(existing === type ? duplicateMessage : conflictMessage);
  const ancestors = key.split("/");
  ancestors.pop();
  let ancestor = "";
  for (const segment of ancestors) {
    ancestor = ancestor ? `${ancestor}/${segment}` : segment;
    if (paths.get(ancestor) === "file") throw new Error(conflictMessage);
  }
  if (type === "file" && [...paths.keys()].some((candidate) => candidate.startsWith(`${key}/`))) throw new Error(conflictMessage);
  paths.set(key, type);
}

/** Creates a live client that pins detail and download to validated catalog identity/version. */
export function createSkillHubClient({
  baseUrl = DEFAULT_ORIGIN,
  fetch = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
} = {}): SkillHubClient {
  const origin = assertTrustedApiOrigin(baseUrl).origin;
  type FreeProof = {
    slug: string;
    namespace: string;
    version: string;
    evidence: "explicit-free-metadata" | "official-not-paid-filter";
  };
  const confirmedFree = new Map<string, FreeProof>();
  const request = (url: string, redirect: RequestRedirect = "error", accept = "application/json") => fetch(url, {
    method: "GET",
    headers: { accept },
    redirect,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const requestJson = async <T>(url: string, schema: z.ZodType<T>): Promise<T> => {
    const response = await request(url);
    assertSuccess(response);
    if (responseType(response) !== "application/json") throw new Error("SkillHub response is not JSON.");
    const bytes = await readBounded(response, JSON_LIMIT);
    return schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  };
  const redirectedBody = async (url: string, limit: number, accept: string, allowedTypes: readonly string[]): Promise<Uint8Array> => {
    const redirectResponse = await request(url, "manual", accept);
    const target = safeRedirect(redirectResponse);
    const response = await request(target, "error", accept);
    assertSuccess(response);
    if (!allowedTypes.includes(responseType(response))) throw new Error("SkillHub response content type is invalid.");
    return readBounded(response, limit);
  };
  /** Converts a loose upstream search record into the strict shared Skill contract. */
  const project = (item: z.infer<typeof SearchItemSchema>): SkillDetail => SkillDetailSchema.parse({
    slug: item.slug,
    name: item.name,
    description: item.description_zh ?? item.description,
    version: item.version,
    pricingType: "free",
    installedVersion: null,
    enabled: false,
    updateAvailable: false,
    source: { provider: "skillhub", url: `${origin}/api/v1/skills/${encodeURIComponent(item.slug)}` },
    permissions: conservativePermissions,
    permissionFingerprint: conservativeFingerprint,
    risk: "high",
    mode: "live",
    categories: categories(item.labels, item.category),
    logoUrl: marketplaceLogoUrl(item.iconUrl),
    ...marketplaceMetadata(item.namespace, item),
    manifest: { kind: "skill", id: item.slug, version: item.version, entry: "SKILL.md" },
  });

  return {
    mode: "live",
    /** Returns only the identity tuple already proven by a validated catalog/detail response. */
    confirmedIdentity(slug) {
      const proof = confirmedFree.get(slug);
      return proof ? { slug: proof.slug, namespace: proof.namespace, version: proof.version } : undefined;
    },
    async search({ query, category, sort, cursor, pageSize }): Promise<SkillHubSearchResult> {
      const page = cursor === null ? 1 : Number(cursor);
      if (!Number.isSafeInteger(page) || page < 1) throw new Error("SkillHub cursor is invalid.");
      const url = new URL("/api/skills", origin);
      url.searchParams.set("page", String(page));
      url.searchParams.set("pageSize", String(pageSize));
      url.searchParams.set("keyword", query);
      if (sort) url.searchParams.set("sort", sort);
      if (category !== undefined && category !== null && !/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(category)) throw new Error("SkillHub category is invalid.");
      if (category) url.searchParams.set("category", category);
      url.searchParams.set("labels", OFFICIAL_NOT_PAID_FILTER);
      const response = await requestJson(url.toString(), SearchResponseSchema);
      if (response.code !== 0) throw new Error("SkillHub API request failed.");
      if (response.data.skills.some((item) => pricingDisposition(item) === "non-free")) throw new Error("Only explicitly free Skills are available.");
      const pageProofs = new Map<string, FreeProof>();
      for (const item of response.data.skills) {
        const proof: FreeProof = {
          slug: item.slug,
          namespace: item.namespace.handle,
          version: item.version,
          evidence: pricingDisposition(item) === "free" ? "explicit-free-metadata" : "official-not-paid-filter",
        };
        const duplicate = pageProofs.get(item.slug);
        if (duplicate && (duplicate.namespace !== proof.namespace || duplicate.version !== proof.version)) {
          throw new Error("SkillHub catalog identity is ambiguous.");
        }
        pageProofs.set(item.slug, proof);
      }
      for (const [slug, proof] of pageProofs) confirmedFree.set(slug, proof);
      const consumed = page * pageSize;
      return {
        items: response.data.skills.map(project),
        nextCursor: consumed < response.data.total ? String(page + 1) : null,
        hasMore: consumed < response.data.total,
        mode: "live",
      };
    },
    /** Loads README only when live identity still matches the catalog version selected by the user. */
    async detail(slug, expectedVersion) {
      const known = confirmedFree.get(slug);
      if (expectedVersion !== undefined && known && known.version !== expectedVersion) {
        throw new Error("SkillHub detail version drifted from the requested catalog version.");
      }
      const detailUrl = new URL(`/api/v1/skills/${encodeURIComponent(slug)}`, origin);
      detailUrl.searchParams.set("namespace", known?.namespace ?? "");
      const response = await requestJson(detailUrl.toString(), DetailResponseSchema);
      const pricing = pricingDisposition(response.skill);
      const namespace = response.namespace.handle;
      const version = response.latestVersion.version;
      if (expectedVersion !== undefined && version !== expectedVersion) {
        throw new Error("SkillHub detail version drifted from the requested catalog version.");
      }
      const identityMatchesProof = known !== undefined && known.slug === slug && known.namespace === namespace && known.version === version;
      if (known && !identityMatchesProof) throw new Error("SkillHub detail identity drifted from its free catalog proof.");
      if (response.slug !== slug || response.skill.slug !== slug || pricing === "non-free" || (pricing === "unknown" && !identityMatchesProof)) {
        if (pricing === "non-free" || (pricing === "unknown" && !identityMatchesProof)) throw new Error("Only explicitly free Skills are available.");
        throw new Error("SkillHub detail identity mismatch.");
      }
      confirmedFree.set(slug, known ?? { slug, namespace, version, evidence: "explicit-free-metadata" });
      const markdownUrl = new URL(`/api/v1/skills/${encodeURIComponent(slug)}/file`, origin);
      markdownUrl.searchParams.set("path", "SKILL.md");
      markdownUrl.searchParams.set("version", version);
      markdownUrl.searchParams.set("namespace", namespace);
      const markdown = new TextDecoder("utf-8", { fatal: true }).decode(await redirectedBody(
        markdownUrl.toString(), MARKDOWN_LIMIT, "text/markdown, text/plain;q=0.9",
        ["text/markdown", "text/plain", "application/octet-stream"],
      ));
      const frontmatter = parseSkillMarkdownFrontmatter(markdown);
      if (
        (frontmatter.slug !== undefined && frontmatter.slug !== slug) ||
        (frontmatter.version !== undefined && frontmatter.version !== version)
      ) throw new Error("SkillHub SKILL.md identity mismatch.");
      return SkillDetailSchema.parse({
        slug,
        name: frontmatter.name,
        description: frontmatter.description,
        version,
        pricingType: "free",
        installedVersion: null,
        enabled: false,
        updateAvailable: false,
        source: { provider: "skillhub", url: detailUrl.toString() },
        permissions: conservativePermissions,
        permissionFingerprint: conservativeFingerprint,
        risk: "high",
        mode: "live",
        categories: categories(response.skill.labels, response.skill.category),
        identityFingerprint: skillIdentityFingerprint({ slug, namespace, version }),
        logoUrl: marketplaceLogoUrl(response.skill.iconUrl),
        ...marketplaceMetadata(response.namespace, response.skill, response.latestVersion, response),
        readme: markdown,
        manifest: { kind: "skill", id: slug, version, entry: "SKILL.md" },
      });
    },
    async download(slug) {
      const known = confirmedFree.get(slug);
      if (!known) throw new Error("SkillHub download identity is not confirmed.");
      const filesUrl = new URL(`/api/v1/skills/${encodeURIComponent(slug)}/files`, origin);
      filesUrl.searchParams.set("version", known.version);
      filesUrl.searchParams.set("namespace", known.namespace);
      const listing = await requestJson(filesUrl.toString(), FilesResponseSchema);
      if (listing.version !== known.version || listing.namespace.handle !== known.namespace) {
        throw new Error("SkillHub download identity mismatch.");
      }
      if (listing.count !== listing.files.length || listing.files.length === 0 || !listing.files.some((file) => file.path === "SKILL.md")) {
        throw new Error("SkillHub file manifest is invalid.");
      }
      const listedPaths = new Map<string, "file" | "directory">();
      for (const file of listing.files) {
        if (!validRelativePath(file.path)) throw new Error("SkillHub file manifest contains an unsafe path.");
        registerPath(
          listedPaths, file.path, "file",
          "SkillHub file manifest contains duplicate paths.",
          "SkillHub file manifest contains file/directory conflicts.",
        );
      }
      if (listing.files.reduce((total, file) => total + file.size, 0) > TOTAL_FILE_LIMIT) throw new Error("SkillHub file manifest exceeds limit.");
      const downloadUrl = new URL("/api/v1/download", origin);
      downloadUrl.searchParams.set("slug", slug);
      downloadUrl.searchParams.set("version", listing.version);
      downloadUrl.searchParams.set("namespace", listing.namespace.handle);
      const archive = await redirectedBody(
        downloadUrl.toString(), ZIP_LIMIT, "application/zip",
        ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
      );
      const zip = await JSZip.loadAsync(archive);
      if (Object.keys(zip.files).length > FILE_COUNT_LIMIT) throw new Error("SkillHub ZIP entry count exceeds limit.");
      const archivePaths = new Map<string, "file" | "directory">();
      for (const entry of Object.values(zip.files)) {
        if (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name) throw new Error("SkillHub ZIP contains an unsafe path.");
        if (typeof entry.unixPermissions === "number" && (entry.unixPermissions & 0o170000) === 0o120000) {
          throw new Error("SkillHub ZIP contains an unsafe ZIP entry.");
        }
        const path = entry.dir && entry.name.endsWith("/") ? entry.name.slice(0, -1) : entry.name;
        if (!validRelativePath(path)) throw new Error("SkillHub ZIP contains an unsafe path.");
        registerPath(
          archivePaths, path, entry.dir ? "directory" : "file",
          "SkillHub ZIP contains duplicate paths.",
          "SkillHub ZIP contains file/directory conflicts.",
        );
        if (entry.dir) continue;
        if (entry.name !== "_meta.json" && !listing.files.some((file) => file.path === entry.name)) throw new Error("SkillHub ZIP contains an unlisted file.");
      }
      const entries: SkillBundleEntry[] = [];
      for (const expected of listing.files) {
        const entry = zip.file(expected.path);
        if (!entry) throw new Error("SkillHub ZIP is missing a listed file.");
        const declaredSize = (entry as unknown as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize;
        if (declaredSize !== expected.size) throw new Error("SkillHub ZIP file size mismatch.");
        const content = await entry.async("uint8array");
        if (content.byteLength !== expected.size) throw new Error("SkillHub ZIP file size mismatch.");
        if (createHash("sha256").update(content).digest("hex") !== expected.sha256) throw new Error("SkillHub ZIP file hash mismatch.");
        entries.push({ path: expected.path, type: "file", size: content.byteLength, contentBase64: Buffer.from(content).toString("base64") });
      }
      return {
        sourceUrl: downloadUrl.toString(),
        compressedBytes: archive.byteLength,
        checksumSha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
        entries,
      };
    },
  };
}
