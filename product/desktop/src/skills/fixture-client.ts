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
}

export interface SkillHubClient {
  readonly mode: "fixture" | "live";
  search(input: { query: string; cursor: string | null; pageSize: number }): Promise<SkillHubSearchResult>;
  detail(slug: string): Promise<SkillDetail>;
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
    manifest: { kind: "skill", id: slug, version, entry: "index.js" },
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
  const entrySource = "export default {};";
  let entries: SkillBundleEntry[] = [
    { path: "SKILL.json", type: "file", size: Buffer.byteLength(manifest), contentBase64: Buffer.from(manifest).toString("base64") },
    { path: "index.js", type: "file", size: Buffer.byteLength(entrySource), contentBase64: Buffer.from(entrySource).toString("base64") },
  ];
  if (invalid === "path-escape") entries.push({ path: "../outside.txt", type: "file", size: 1, contentBase64: "eA==" });
  if (invalid === "symlink") entries.push({ path: "link", type: "symlink", size: 0 });
  if (invalid === "hardlink") entries.push({ path: "hard-link", type: "hardlink", size: 0 } as unknown as SkillBundleEntry);
  if (invalid === "duplicate-path") entries.push({ path: "SKILL.json", type: "file", size: Buffer.byteLength(manifest), contentBase64: Buffer.from(manifest).toString("base64") });
  if (invalid === "archive-bomb") entries = Array.from({ length: 1_001 }, (_, index) => ({ path: `f-${index}`, type: "file" as const, size: 1, contentBase64: "eA==" }));
  return {
    sourceUrl: `https://api.skillhub.cn/api/v1/download?slug=${slug}`,
    compressedBytes: invalid === "archive-bomb" ? 1 : 100,
    checksumSha256: bundleChecksum(entries),
    entries,
  };
}

export function createFixtureSkillHubClient(options: FixtureOptions = {}): SkillHubClient {
  const catalog = [
    detail("workspace-reader", "free", options.versionOverride?.["workspace-reader"]),
    detail("command-runner", "free", options.versionOverride?.["command-runner"]),
    detail("paid-private", "paid", options.versionOverride?.["paid-private"]),
  ];
  return {
    mode: "fixture",
    failAfterBackup: options.failAfterBackup,
    async search({ query, cursor, pageSize }) {
      const offset = cursor === null ? 0 : Number.parseInt(cursor, 10);
      const matches = catalog.filter((item) => item.pricingType === "free" &&
        `${item.name} ${item.description} ${item.slug}`.toLowerCase().includes(query.trim().toLowerCase()));
      const items = matches.slice(offset, offset + pageSize);
      const nextOffset = offset + items.length;
      return { items, nextCursor: nextOffset < matches.length ? String(nextOffset) : null, hasMore: nextOffset < matches.length, mode: "fixture" };
    },
    async detail(slug) {
      const found = catalog.find((item) => item.slug === slug);
      if (!found) throw new Error("Skill not found.");
      const pricingType = options.detailPricingOverride?.[slug] ?? found.pricingType;
      return { ...found, pricingType };
    },
    async download(slug) {
      const version = catalog.find((item) => item.slug === slug)?.version ?? "1.0.0";
      return makeBundle(slug, version, options.invalidBundle);
    },
  };
}
