import { createHash } from "node:crypto";

import {
  LOCKED_OPENCLAW_VERSION,
  type CapabilityRisk,
  type CapabilityPermission,
  type PluginDetail,
} from "@uclaw/shared";

export interface PluginBundleEntry {
  path: string;
  type: "file" | "directory" | "symlink" | "hardlink";
  size: number;
  contentBase64?: string;
}

export interface PluginBundle {
  sourceUrl: string;
  compressedBytes: number;
  checksumSha256: string;
  entries: PluginBundleEntry[];
}

export interface PluginRegistryClient {
  readonly mode: "fixture" | "live";
  readonly repositoryVerified: boolean;
  readonly failAfterBackup?: boolean;
  readonly failAfterRuntimeInstall?: boolean;
  readonly failAtPhase?: "replaced";
  search(input: { query: string; cursor: string | null; pageSize: number }): Promise<{ items: PluginDetail[]; nextCursor: string | null; hasMore: boolean; mode: "fixture" | "live"; repositoryVerified: boolean }>;
  detail(slug: string): Promise<PluginDetail>;
  download(slug: string): Promise<PluginBundle>;
}

type InvalidBundle = "path-escape" | "symlink" | "hardlink" | "duplicate-path" | "case-duplicate" | "archive-bomb" | "bad-manifest" | "bad-checksum" | "missing-entry" | "incompatible" | "windows-ads" | "windows-device" | "windows-trailing" | "ancestor-conflict";
type FixtureOptions = {
  versionOverride?: Record<string, string>;
  invalidBundle?: InvalidBundle;
  failAfterBackup?: boolean;
  failAfterRuntimeInstall?: boolean;
  failAtPhase?: "replaced";
  contentMarker?: string;
};

const permissions: Record<string, CapabilityPermission[]> = {
  "openclaw-calendar": [{ kind: "network", access: "connect", target: "calendar.example", risk: "medium", reason: "同步日历事件" }],
  "openclaw-shell-tools": [
    { kind: "command", access: "execute", target: "approved commands", risk: "high", reason: "执行用户批准的本地命令" },
    { kind: "filesystem", access: "write", target: "workspace", risk: "high", reason: "写入工作区文件" },
  ],
  "community-wechat-preview": [{ kind: "network", access: "connect", target: "wechat service", risk: "high", reason: "连接外部微信服务" }],
  "legacy-openclaw-plugin": [],
};
const riskOrder: CapabilityRisk[] = ["low", "medium", "high", "critical"];
const fingerprint = (items: readonly CapabilityPermission[]) => createHash("sha256").update(JSON.stringify(items)).digest("hex");
const highestRisk = (items: readonly CapabilityPermission[]) => items.reduce<CapabilityRisk>((highest, item) =>
  riskOrder.indexOf(item.risk) > riskOrder.indexOf(highest) ? item.risk : highest, "low");

function detail(slug: string, version = "1.0.0", invalidBundle?: InvalidBundle, contentMarker = "default"): PluginDetail {
  const pluginPermissions = permissions[slug] ?? [];
  const unpackaged = slug === "community-wechat-preview";
  const incompatible = slug === "legacy-openclaw-plugin";
  const shell = slug === "openclaw-shell-tools";
  const names: Record<string, string> = {
    "openclaw-calendar": "日历同步",
    "openclaw-shell-tools": "命令工具包",
    "community-wechat-preview": "微信社区预览",
    "legacy-openclaw-plugin": "旧版 OpenClaw 插件",
  };
  const base = {
    packageKind: "plugin",
    slug,
    name: names[slug] ?? slug,
    description: unpackaged ? "外置渠道插件，当前 runtime 未打包" : incompatible ? "仅兼容旧版 OpenClaw" : shell ? "提供原生命令扩展" : "同步日历事件",
    version,
    installedVersion: null,
    enabled: false,
    updateAvailable: false,
    source: {
      provider: unpackaged ? "external" : "fixture",
      url: `https://plugins.openclaw.ai/${slug}`,
      packaged: !unpackaged,
    },
    integritySha256: "0".repeat(64),
    integrityVerified: true,
    managedByUClaw: false,
    availability: unpackaged ? "unpackaged" : incompatible ? "incompatible" : "installable",
    compatibility: {
      state: incompatible ? "incompatible" : "compatible",
      openClawVersion: LOCKED_OPENCLAW_VERSION,
      ...(incompatible ? { reason: `Requires OpenClaw <=2025.12; current ${LOCKED_OPENCLAW_VERSION}.` } : {}),
    },
    permissions: pluginPermissions,
    permissionFingerprint: fingerprint(pluginPermissions),
    risk: highestRisk(pluginPermissions),
    nativeCode: shell,
    commandExecution: shell,
    mode: "fixture",
    manifest: {
      id: slug,
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      packageName: `@uclaw/${slug}`,
      entry: "./dist/index.js",
      minHostVersion: incompatible ? "<=2025.12" : `>=${LOCKED_OPENCLAW_VERSION}`,
      pluginApi: ">=2026.7.1-2",
    },
  } satisfies PluginDetail;
  return { ...base, integritySha256: bundle(base, invalidBundle, contentMarker).checksumSha256 };
}

function checksum(entries: readonly PluginBundleEntry[]): string {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function bundle(plugin: PluginDetail, invalid?: InvalidBundle, contentMarker = "default"): PluginBundle {
  if (!plugin.manifest) throw new Error("Fixture Plugin manifest is missing.");
  const manifest = JSON.stringify({
    id: invalid === "bad-manifest" ? "wrong-plugin" : plugin.slug,
    configSchema: plugin.manifest.configSchema,
  });
  const packageJson = JSON.stringify({
    name: plugin.manifest.packageName,
    version: plugin.version,
    type: "module",
    openclaw: {
      extensions: [invalid === "missing-entry" ? "./dist/missing.js" : plugin.manifest.entry],
      compat: { pluginApi: plugin.manifest.pluginApi },
      install: { minHostVersion: invalid === "incompatible" ? ">=2027.1.0" : plugin.manifest.minHostVersion },
    },
  });
  const source = `export default { activate() {}, marker: ${JSON.stringify(contentMarker)} };`;
  let entries: PluginBundleEntry[] = [
    { path: "openclaw.plugin.json", type: "file", size: Buffer.byteLength(manifest), contentBase64: Buffer.from(manifest).toString("base64") },
    { path: "package.json", type: "file", size: Buffer.byteLength(packageJson), contentBase64: Buffer.from(packageJson).toString("base64") },
    { path: "dist/index.js", type: "file", size: Buffer.byteLength(source), contentBase64: Buffer.from(source).toString("base64") },
  ];
  if (invalid === "path-escape") entries.push({ path: "../outside.js", type: "file", size: 1, contentBase64: "eA==" });
  if (invalid === "symlink") entries.push({ path: "link", type: "symlink", size: 0 });
  if (invalid === "hardlink") entries.push({ path: "hard", type: "hardlink", size: 0 });
  if (invalid === "duplicate-path") entries.push(entries[0]);
  if (invalid === "case-duplicate") entries.push({ ...entries[0], path: "OPENCLAW.PLUGIN.JSON" });
  if (invalid === "windows-ads") entries.push({ path: "dist/index.js:payload", type: "file", size: 1, contentBase64: "eA==" });
  if (invalid === "windows-device") entries.push({ path: "dist/CON.txt", type: "file", size: 1, contentBase64: "eA==" });
  if (invalid === "windows-trailing") entries.push({ path: "dist/trailing. ", type: "file", size: 1, contentBase64: "eA==" });
  if (invalid === "ancestor-conflict") entries.push({ path: "dist", type: "file", size: 1, contentBase64: "eA==" });
  if (invalid === "archive-bomb") entries = Array.from({ length: 1_001 }, (_, index) => ({ path: `f-${index}`, type: "file" as const, size: 1, contentBase64: "eA==" }));
  const digest = checksum(entries);
  return {
    sourceUrl: `https://plugins.openclaw.ai/packages/${plugin.slug}-${plugin.version}.tgz`,
    compressedBytes: invalid === "archive-bomb" ? 1 : 100,
    checksumSha256: invalid === "bad-checksum" ? "0".repeat(64) : digest,
    entries,
  };
}

export function createFixturePluginRegistryClient(options: FixtureOptions = {}): PluginRegistryClient {
  const catalog = [
    detail("openclaw-calendar", options.versionOverride?.["openclaw-calendar"] ?? "1.2.0", options.invalidBundle, options.contentMarker),
    detail("openclaw-shell-tools", options.versionOverride?.["openclaw-shell-tools"] ?? "2.0.0", options.invalidBundle, options.contentMarker),
    detail("community-wechat-preview", "0.9.0", options.invalidBundle, options.contentMarker),
    detail("legacy-openclaw-plugin", "1.0.0", options.invalidBundle, options.contentMarker),
  ];
  return {
    mode: "fixture",
    repositoryVerified: false,
    failAfterBackup: options.failAfterBackup,
    failAfterRuntimeInstall: options.failAfterRuntimeInstall,
    failAtPhase: options.failAtPhase,
    async search({ query, cursor, pageSize }) {
      const offset = cursor === null ? 0 : Number.parseInt(cursor, 10);
      const normalized = query.trim().toLowerCase();
      const matches = catalog.filter((item) => `${item.name} ${item.description} ${item.slug}`.toLowerCase().includes(normalized));
      const items = matches.slice(offset, offset + pageSize);
      const next = offset + items.length;
      return { items, nextCursor: next < matches.length ? String(next) : null, hasMore: next < matches.length, mode: "fixture", repositoryVerified: false };
    },
    async detail(slug) {
      const found = catalog.find((item) => item.slug === slug);
      if (!found) throw new Error("Plugin not found.");
      return found;
    },
    async download(slug) {
      const found = catalog.find((item) => item.slug === slug);
      if (!found) throw new Error("Plugin not found.");
      return bundle(found, options.invalidBundle, options.contentMarker);
    },
  };
}
