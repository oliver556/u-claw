import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { posix } from "node:path";

import { LOCKED_OPENCLAW_VERSION, type PluginDetail } from "@uclaw/shared";
import { z } from "zod";

import type { PluginBundle, PluginBundleEntry } from "./fixture-client.js";

const semver = createRequire(import.meta.url)("semver") as {
  validRange(value: string): string | null;
  satisfies(version: string, range: string, options: { includePrerelease: boolean }): boolean;
};

const MAX_FILES = 1_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_EXPANSION_RATIO = 100;
const ManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),
  configSchema: z.record(z.string(), z.unknown()),
}).passthrough();
const PackageSchema = z.object({
  name: z.string().min(1).max(214),
  version: z.string().min(1).max(80),
  openclaw: z.object({
    extensions: z.array(z.string().min(1).max(240)).min(1).max(16),
    compat: z.object({ pluginApi: z.string().min(1).max(80) }).passthrough(),
    install: z.object({ minHostVersion: z.string().min(1).max(80) }).passthrough(),
  }).passthrough(),
}).passthrough();

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function validRelativePath(value: string): boolean {
  if (!value || value.includes("\\") || value.includes("\0") || value.includes(":") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const normalized = posix.normalize(value);
  if (normalized !== value || normalized === ".." || normalized.startsWith("../")) return false;
  return value.split("/").every((segment) =>
    segment !== "" && !segment.endsWith(".") && !segment.endsWith(" ") && !WINDOWS_RESERVED_NAME.test(segment));
}

function compatible(range: string): boolean {
  return semver.validRange(range) !== null && semver.satisfies(LOCKED_OPENCLAW_VERSION, range, { includePrerelease: true });
}

export function validatePluginBundle(bundle: PluginBundle, expected: Pick<PluginDetail, "slug" | "version" | "manifest" | "integritySha256">) {
  if (!expected.manifest) throw new Error("Plugin package manifest metadata is unavailable.");
  const source = new URL(bundle.sourceUrl);
  if (source.protocol !== "https:" || source.hostname !== "plugins.openclaw.ai" || source.username || source.password) throw new Error("Untrusted Plugin package source.");
  if (bundle.entries.length === 0 || bundle.entries.length > MAX_FILES) throw new Error("Plugin package file count exceeds limit.");
  const checksum = createHash("sha256").update(JSON.stringify(bundle.entries)).digest("hex");
  if (checksum !== bundle.checksumSha256 || checksum !== expected.integritySha256) throw new Error("Plugin package checksum mismatch.");
  const paths = new Map<string, PluginBundleEntry["type"]>();
  const files: Array<{ path: string; content: Buffer }> = [];
  let total = 0;
  for (const entry of bundle.entries) {
    if (!validRelativePath(entry.path)) throw new Error("Plugin package path escapes target.");
    const windowsPathKey = entry.path.toLowerCase();
    if (paths.has(windowsPathKey)) throw new Error("Plugin package contains duplicate paths.");
    const ancestors = windowsPathKey.split("/");
    ancestors.pop();
    let ancestor = "";
    for (const segment of ancestors) {
      ancestor = ancestor ? `${ancestor}/${segment}` : segment;
      if (paths.get(ancestor) === "file") throw new Error("Plugin package contains file/directory conflicts.");
    }
    if (entry.type === "file" && [...paths.keys()].some((path) => path.startsWith(`${windowsPathKey}/`))) {
      throw new Error("Plugin package contains file/directory conflicts.");
    }
    paths.set(windowsPathKey, entry.type);
    if (entry.type !== "file" && entry.type !== "directory") throw new Error("Plugin package links are forbidden.");
    if (entry.type !== "file") continue;
    if (entry.size < 0 || entry.size > MAX_FILE_BYTES || !entry.contentBase64) throw new Error("Plugin package file exceeds limit.");
    const content = Buffer.from(entry.contentBase64, "base64");
    if (content.byteLength !== entry.size) throw new Error("Plugin package file size mismatch.");
    total += content.byteLength;
    files.push({ path: entry.path, content });
  }
  if (total > MAX_TOTAL_BYTES || bundle.compressedBytes <= 0 || total / bundle.compressedBytes > MAX_EXPANSION_RATIO) throw new Error("Plugin package expansion exceeds limit.");
  const manifestFile = files.find((file) => file.path === "openclaw.plugin.json");
  if (!manifestFile) throw new Error("Plugin package manifest is missing.");
  const packageFile = files.find((file) => file.path === "package.json");
  if (!packageFile) throw new Error("Plugin package metadata is missing.");
  const manifest = ManifestSchema.parse(JSON.parse(manifestFile.content.toString("utf8")));
  const packageJson = PackageSchema.parse(JSON.parse(packageFile.content.toString("utf8")));
  const entries = packageJson.openclaw.extensions.map((entry) => entry.startsWith("./") ? entry.slice(2) : entry);
  if (
    manifest.id !== expected.slug || packageJson.name !== expected.manifest.packageName ||
    packageJson.version !== expected.version ||
    packageJson.openclaw.install.minHostVersion !== expected.manifest.minHostVersion ||
    packageJson.openclaw.compat.pluginApi !== expected.manifest.pluginApi ||
    !compatible(packageJson.openclaw.install.minHostVersion) || !compatible(packageJson.openclaw.compat.pluginApi) ||
    !entries.includes(expected.manifest.entry.replace(/^\.\//, "")) ||
    entries.some((entry) => !validRelativePath(entry) || !files.some((file) => file.path === entry))
  ) throw new Error("Plugin package manifest does not match request or locked OpenClaw runtime.");
  return { manifest, packageJson, files };
}
