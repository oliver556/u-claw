import { createHash } from "node:crypto";
import { posix } from "node:path";

import { z } from "zod";
import { SkillPermissionSchema, type SkillDetail } from "@uclaw/shared";

import type { SkillBundle } from "./fixture-client.js";

const MAX_FILES = 1_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_EXPANSION_RATIO = 100;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$/iu;
const WINDOWS_INVALID_PATH_CHARACTER = /[<>:"|?*\u0000-\u001f\u007f]/u;

const ManifestSchema = z.object({
  kind: z.literal("skill"),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),
  version: z.string().min(1).max(80),
  entry: z.string().min(1).max(240),
  permissions: z.array(SkillPermissionSchema).max(64),
}).strict();

export interface ValidatedBundle {
  manifest: { kind: "skill"; id: string; version: string; entry: string };
  files: Array<{ path: string; content: Buffer }>;
}

export interface SkillMarkdownFrontmatter {
  slug?: string;
  name: string;
  displayName?: string;
  description: string;
  version?: string;
}

function scalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== "string") throw new Error("SKILL.md frontmatter scalar is invalid.");
    return parsed;
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/gu, "'");
  if (trimmed === "" || /^[\[{&*!|>@`]/u.test(trimmed)) throw new Error("SKILL.md frontmatter scalar is invalid.");
  return trimmed;
}

/** 读取受限 YAML block scalar，并保留 identity parser 所需的确定性语义。 */
function blockScalar(lines: readonly string[], start: number, end: number, header: string): { value: string; next: number } {
  const matched = /^([|>])([+-]?)$/u.exec(header);
  if (!matched) throw new Error("SKILL.md frontmatter scalar is invalid.");
  const content: string[] = [];
  let indent: number | undefined;
  let next = start;
  for (; next < end; next += 1) {
    const line = lines[next]!;
    if (line.trim() === "") {
      content.push("");
      continue;
    }
    const leading = /^( +)/u.exec(line)?.[1].length;
    if (leading === undefined) break;
    indent ??= leading;
    if (leading < indent) throw new Error("SKILL.md frontmatter scalar is invalid.");
    content.push(line.slice(indent));
  }
  if (indent === undefined || content.every((line) => line.trim() === "")) {
    throw new Error("SKILL.md frontmatter scalar is invalid.");
  }
  const style = matched[1]!;
  const chomp = matched[2]!;
  let value: string;
  if (style === "|") value = `${content.join("\n")}\n`;
  else {
    value = "";
    let blankLines = 0;
    let previous = "";
    for (const line of content) {
      if (line === "") {
        blankLines += 1;
        continue;
      }
      if (value === "") value = `${"\n".repeat(blankLines)}${line}`;
      else if (blankLines > 0) value += `${"\n".repeat(blankLines)}${line}`;
      else value += `${/^\s/u.test(previous) || /^\s/u.test(line) ? "\n" : " "}${line}`;
      previous = line;
      blankLines = 0;
    }
    value += "\n".repeat(blankLines + 1);
  }
  if (chomp === "-") value = value.replace(/\n+$/u, "");
  else if (chomp !== "+") value = value.replace(/\n+$/u, "\n");
  return { value, next };
}

/** 解析 Skill identity 所需的受限 YAML frontmatter。 */
export function parseSkillMarkdownFrontmatter(markdown: string): SkillMarkdownFrontmatter {
  const normalized = markdown.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") throw new Error("SKILL.md frontmatter is missing.");
  const end = lines.indexOf("---", 1);
  if (end < 2) throw new Error("SKILL.md frontmatter is incomplete.");
  const values = new Map<string, string>();
  for (let index = 1; index < end; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (/^\s/u.test(line)) continue;
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error("SKILL.md frontmatter is invalid.");
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(key)) throw new Error("SKILL.md frontmatter is invalid.");
    if (!["slug", "name", "displayName", "description", "summary", "version"].includes(key)) continue;
    if (values.has(key)) throw new Error("SKILL.md frontmatter is invalid.");
    const rawValue = line.slice(separator + 1).trim();
    if (/^[|>]/u.test(rawValue)) {
      const parsed = blockScalar(lines, index + 1, end, rawValue);
      values.set(key, parsed.value);
      index = parsed.next - 1;
    } else values.set(key, scalar(rawValue));
  }
  const slug = values.get("slug");
  const displayName = values.get("displayName");
  const name = values.get("name") ?? displayName;
  const description = values.get("description") ?? values.get("summary");
  const version = values.get("version");
  if (!name || !description) throw new Error("SKILL.md frontmatter lacks required identity.");
  if (
    (slug !== undefined && !/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(slug)) ||
    name.length > 120 || description.length > 1_000 ||
    (version !== undefined && (version.length === 0 || version.length > 80))
  ) {
    throw new Error("SKILL.md frontmatter identity is invalid.");
  }
  return { slug, name, displayName, description, version };
}

function validRelativePath(value: string): boolean {
  if (!value || value.includes("\\") || value.includes("\0") || value.includes(":") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const normalized = posix.normalize(value);
  if (normalized !== value || normalized === ".." || normalized.startsWith("../")) return false;
  return value.split("/").every((segment) =>
    segment !== "" && !WINDOWS_INVALID_PATH_CHARACTER.test(segment) &&
    !segment.endsWith(".") && !segment.endsWith(" ") &&
    !WINDOWS_RESERVED_NAME.test(segment.split(".", 1)[0]!.replace(/ +$/u, "")));
}

export function validateSkillBundle(
  bundle: SkillBundle,
  expected: Pick<SkillDetail, "slug" | "version" | "permissionFingerprint">,
  sourcePolicy: "skillhub" | "local-import" = "skillhub",
): ValidatedBundle {
  const source = new URL(bundle.sourceUrl);
  const trustedSkillHub = sourcePolicy === "skillhub" && source.protocol === "https:" && source.hostname === "api.skillhub.cn";
  const trustedLocalImport = sourcePolicy === "local-import" && source.protocol === "uclaw-local:" && source.hostname === "import";
  if ((!trustedSkillHub && !trustedLocalImport) || source.username || source.password) {
    throw new Error("Untrusted Skill package source.");
  }
  if (bundle.entries.length === 0 || bundle.entries.length > MAX_FILES) throw new Error("Skill package file count exceeds limit.");
  const checksum = createHash("sha256").update(JSON.stringify(bundle.entries)).digest("hex");
  if (checksum !== bundle.checksumSha256) throw new Error("Skill package checksum mismatch.");
  let total = 0;
  const files: Array<{ path: string; content: Buffer }> = [];
  const paths = new Map<string, SkillBundle["entries"][number]["type"]>();
  for (const entry of bundle.entries) {
    if (!validRelativePath(entry.path)) throw new Error("Skill package path escapes target.");
    if (entry.type !== "file" && entry.type !== "directory") throw new Error("Skill package links are forbidden.");
    const windowsPathKey = entry.path.toLowerCase();
    const existing = paths.get(windowsPathKey);
    if (existing !== undefined) {
      throw new Error(existing === entry.type ? "Skill package contains duplicate paths." : "Skill package contains file/directory conflicts.");
    }
    const ancestors = windowsPathKey.split("/");
    ancestors.pop();
    let ancestor = "";
    for (const segment of ancestors) {
      ancestor = ancestor ? `${ancestor}/${segment}` : segment;
      if (paths.get(ancestor) === "file") throw new Error("Skill package contains file/directory conflicts.");
    }
    if (entry.type === "file" && [...paths.keys()].some((path) => path.startsWith(`${windowsPathKey}/`))) {
      throw new Error("Skill package contains file/directory conflicts.");
    }
    paths.set(windowsPathKey, entry.type);
    if (entry.type !== "file") continue;
    if (entry.size < 0 || entry.size > MAX_FILE_BYTES || !entry.contentBase64) throw new Error("Skill package file exceeds limit.");
    const content = Buffer.from(entry.contentBase64, "base64");
    if (content.byteLength !== entry.size) throw new Error("Skill package file size mismatch.");
    total += content.byteLength;
    files.push({ path: entry.path, content });
  }
  if (total > MAX_TOTAL_BYTES || bundle.compressedBytes <= 0 || total / bundle.compressedBytes > MAX_EXPANSION_RATIO) {
    throw new Error("Skill package expansion exceeds limit.");
  }
  const markdownFile = files.find((entry) => entry.path === "SKILL.md");
  const legacyManifestFile = files.find((entry) => entry.path === "SKILL.json");
  let manifest: ValidatedBundle["manifest"];
  if (markdownFile) {
    const frontmatter = parseSkillMarkdownFrontmatter(markdownFile.content.toString("utf8"));
    manifest = {
      kind: "skill",
      id: frontmatter.slug ?? expected.slug,
      version: frontmatter.version ?? expected.version,
      entry: "SKILL.md",
    };
    if (manifest.id !== expected.slug || manifest.version !== expected.version) throw new Error("Skill package manifest does not match request.");
  } else if (legacyManifestFile) {
    const legacy = ManifestSchema.parse(JSON.parse(legacyManifestFile.content.toString("utf8")));
    const permissionHash = createHash("sha256").update(JSON.stringify(legacy.permissions)).digest("hex");
    if (
      legacy.id !== expected.slug || legacy.version !== expected.version ||
      permissionHash !== expected.permissionFingerprint ||
      !validRelativePath(legacy.entry) || !files.some((entry) => entry.path === legacy.entry)
    ) {
      throw new Error("Skill package manifest does not match request.");
    }
    manifest = { kind: "skill", id: legacy.id, version: legacy.version, entry: legacy.entry };
  } else throw new Error("Skill package manifest is missing.");
  return { manifest, files };
}
