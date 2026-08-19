import { createHash } from "node:crypto";

import type { CapabilityRisk, SkillDetail, SkillPermission } from "@uclaw/shared";

export interface SkillBundleEntry {
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
  contentBase64?: string;
}

export interface SkillBundle {
  sourceUrl: string;
  compressedBytes: number;
  checksumSha256: string;
  entries: SkillBundleEntry[];
}

export interface SkillHubSearchResult {
  items: SkillDetail[];
  nextCursor: string | null;
  hasMore: boolean;
  mode: "fixture" | "live";
  stale?: boolean;
}

export type SkillHubFailureReason = "not-found" | "identity-conflict" | "forbidden" | "upstream-invalid" | "upstream-unavailable";

/** Tags a marketplace failure so cache and service layers can preserve its security meaning. */
export function tagSkillHubFailure(error: unknown, reason: SkillHubFailureReason): Error {
  const tagged = error instanceof Error ? error : new Error("SkillHub request failed.");
  return Object.assign(tagged, { skillHubFailureReason: reason });
}

/** Reads only a recognized marketplace failure reason from an unknown thrown value. */
export function skillHubFailureReason(error: unknown): SkillHubFailureReason | undefined {
  const reason = (error as { skillHubFailureReason?: unknown })?.skillHubFailureReason;
  return reason === "not-found" || reason === "identity-conflict" || reason === "forbidden" ||
    reason === "upstream-invalid" || reason === "upstream-unavailable" ? reason : undefined;
}

/** Private marketplace tuple used to pin detail and download to one exact Skill version. */
export interface SkillHubIdentity {
  slug: string;
  namespace: string;
  version: string;
}

export interface SkillHubClient {
  readonly mode: "fixture" | "live";
  search(input: { query: string; category?: string | null; sort?: "score" | "downloads" | "stars" | "updatedAt"; cursor: string | null; pageSize: number }): Promise<SkillHubSearchResult>;
  /** Returns an already validated private identity tuple without projecting namespace publicly. */
  confirmedIdentity(slug: string): SkillHubIdentity | undefined;
  detail(slug: string, expectedVersion?: string, forceRefresh?: boolean): Promise<SkillDetail>;
  download(slug: string): Promise<SkillBundle>;
  readonly failAfterBackup?: boolean;
}

type FixtureOptions = {
  detailPricingOverride?: Record<string, "free" | "paid">;
  versionOverride?: Record<string, string>;
  invalidBundle?: "path-escape" | "symlink" | "hardlink" | "duplicate-path" | "archive-bomb" | "bad-manifest" | "permission-mismatch";
  failAfterBackup?: boolean;
};

const permissions: Record<string, SkillPermission[]> = {
  "workspace-reader": [{ kind: "filesystem", access: "read", target: "workspace", risk: "medium", reason: "读取工作区文件" }],
  "command-runner": [{ kind: "command", access: "execute", target: "git", risk: "high", reason: "执行 Git 命令" }],
  "paid-private": [{ kind: "network", access: "connect", target: "api.example.com", risk: "medium", reason: "访问服务" }],
};

const riskOrder: CapabilityRisk[] = ["low", "medium", "high", "critical"];
export function highestPermissionRisk(items: readonly SkillPermission[]): CapabilityRisk {
  return items.reduce<CapabilityRisk>((highest, item) =>
    riskOrder.indexOf(item.risk) > riskOrder.indexOf(highest) ? item.risk : highest, "low");
}

export function permissionFingerprint(items: readonly SkillPermission[]): string {
  return createHash("sha256").update(JSON.stringify(items)).digest("hex");
}

/** Creates the opaque token that binds confirmation to one private SkillHub identity tuple. */
export function skillIdentityFingerprint(identity: SkillHubIdentity): string {
  return createHash("sha256").update(JSON.stringify({
    slug: identity.slug,
    namespace: identity.namespace,
    version: identity.version,
  })).digest("hex");
}

/** Builds a deterministic catalog/detail record for offline development and tests. */
function detail(slug: string, pricingType: "free" | "paid" = "free", version = "1.0.0"): SkillDetail {
  const names: Record<string, string> = {
    "workspace-reader": "工作区读取器",
    "command-runner": "命令运行器",
    "paid-private": "付费私有技能",
  };
  const skillPermissions = permissions[slug] ?? [];
  return {
    slug,
    name: names[slug] ?? slug,
    description: slug === "command-runner" ? "运行批准命令" : "读取便携工作区",
    version,
    pricingType,
    installedVersion: null,
    enabled: false,
    updateAvailable: false,
    source: { provider: "skillhub", url: `https://api.skillhub.cn/api/v1/skills/${slug}` },
    permissions: skillPermissions,
    permissionFingerprint: permissionFingerprint(skillPermissions),
    risk: highestPermissionRisk(skillPermissions),
    mode: "fixture",
    categories: slug === "workspace-reader" ? ["productivity"] : ["developer-tools"],
    ownerName: "U-Claw Fixtures",
    downloads: slug === "workspace-reader" ? 879 : slug === "command-runner" ? 421 : 12,
    stars: slug === "workspace-reader" ? 24 : slug === "command-runner" ? 11 : 1,
    requiresKey: slug === "paid-private",
    updatedAt: slug === "workspace-reader" ? "2026-08-19T12:00:00.000Z" : "2026-08-18T12:00:00.000Z",
    readme: `# ${names[slug] ?? slug}\n\n${slug === "command-runner" ? "运行批准命令" : "读取便携工作区"}\n`,
    manifest: { kind: "skill", id: slug, version, entry: "SKILL.md" },
  };
}

function bundleChecksum(entries: readonly SkillBundleEntry[]): string {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function makeBundle(slug: string, version: string, invalid?: FixtureOptions["invalidBundle"]): SkillBundle {
  const manifestPermissions = invalid === "permission-mismatch"
    ? [{ kind: "environment", access: "read-secret", target: "UNDECLARED_TOKEN", risk: "critical", reason: "未声明权限" }]
    : permissions[slug] ?? [];
  const manifest = JSON.stringify({
    kind: invalid === "bad-manifest" ? "plugin" : "skill",
    id: slug,
    version,
    entry: "index.js",
    permissions: manifestPermissions,
  });
  const skillMarkdown = `---\nslug: ${slug}\nname: ${slug}\ndescription: Fixture Skill ${slug}\nversion: ${version}\n---\n`;
  const legacyManifestCase = invalid === "bad-manifest" || invalid === "permission-mismatch";
  let entries: SkillBundleEntry[] = legacyManifestCase
    ? [{ path: "SKILL.json", type: "file", size: Buffer.byteLength(manifest), contentBase64: Buffer.from(manifest).toString("base64") },
      { path: "index.js", type: "file", size: 18, contentBase64: Buffer.from("export default {};").toString("base64") }]
    : [{ path: "SKILL.md", type: "file", size: Buffer.byteLength(skillMarkdown), contentBase64: Buffer.from(skillMarkdown).toString("base64") }];
  if (invalid === "path-escape") entries.push({ path: "../outside.txt", type: "file", size: 1, contentBase64: "eA==" });
  if (invalid === "symlink") entries.push({ path: "link", type: "symlink", size: 0 });
  if (invalid === "hardlink") entries.push({ path: "hard-link", type: "hardlink", size: 0 } as unknown as SkillBundleEntry);
  if (invalid === "duplicate-path") entries.push({ path: "SKILL.md", type: "file", size: Buffer.byteLength(skillMarkdown), contentBase64: Buffer.from(skillMarkdown).toString("base64") });
  if (invalid === "archive-bomb") entries = Array.from({ length: 1_001 }, (_, index) => ({ path: `f-${index}`, type: "file" as const, size: 1, contentBase64: "eA==" }));
  return {
    sourceUrl: `https://api.skillhub.cn/api/v1/download?slug=${slug}`,
    compressedBytes: invalid === "archive-bomb" ? 1 : 100,
    checksumSha256: bundleChecksum(entries),
    entries,
  };
}

/** Creates deterministic fixture data while enforcing requested version identity in tests. */
export function createFixtureSkillHubClient(options: FixtureOptions = {}): SkillHubClient {
  const catalog = [
    detail("workspace-reader", "free", options.versionOverride?.["workspace-reader"]),
    detail("command-runner", "free", options.versionOverride?.["command-runner"]),
    detail("paid-private", "paid", options.versionOverride?.["paid-private"]),
  ];
  return {
    mode: "fixture",
    failAfterBackup: options.failAfterBackup,
    /** Returns fixture identity without adding namespace to public Skill details. */
    confirmedIdentity(slug) {
      const found = catalog.find((item) => item.slug === slug);
      return found ? { slug, namespace: "fixture", version: found.version } : undefined;
    },
    async search({ query, category, sort, cursor, pageSize }) {
      const offset = cursor === null ? 0 : Number(cursor);
      if (!Number.isSafeInteger(offset) || offset < 0 || (cursor !== null && String(offset) !== cursor)) throw new Error("Fixture SkillHub cursor is invalid.");
      const matches = catalog.filter((item) => item.pricingType === "free" &&
        (!category || item.categories.includes(category)) &&
        `${item.name} ${item.description} ${item.slug}`.toLowerCase().includes(query.trim().toLowerCase()));
      if (sort && sort !== "score") matches.sort((left, right) => {
        if (sort === "updatedAt") return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
        return (right[sort] ?? 0) - (left[sort] ?? 0);
      });
      const items = matches.slice(offset, offset + pageSize);
      const nextOffset = offset + items.length;
      return { items, nextCursor: nextOffset < matches.length ? String(nextOffset) : null, hasMore: nextOffset < matches.length, mode: "fixture" };
    },
    /** Returns only the selected fixture version so cache tests mirror marketplace pinning. */
    async detail(slug, expectedVersion) {
      const found = catalog.find((item) => item.slug === slug);
      if (!found) throw tagSkillHubFailure(new Error("Skill not found."), "not-found");
      if (expectedVersion !== undefined && found.version !== expectedVersion) {
        throw tagSkillHubFailure(new Error("Fixture Skill version mismatch."), "identity-conflict");
      }
      const pricingType = options.detailPricingOverride?.[slug] ?? found.pricingType;
      return { ...found, pricingType };
    },
    async download(slug) {
      const version = catalog.find((item) => item.slug === slug)?.version ?? "1.0.0";
      return makeBundle(slug, version, options.invalidBundle);
    },
  };
}
