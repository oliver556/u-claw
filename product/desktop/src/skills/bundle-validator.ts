import { createHash } from "node:crypto";
import { posix } from "node:path";

import { z } from "zod";
import { SkillPermissionSchema, type SkillDetail } from "@uclaw/shared";

import type { SkillBundle } from "./fixture-client.js";

const MAX_FILES = 1_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_EXPANSION_RATIO = 100;

const ManifestSchema = z.object({
  kind: z.literal("skill"),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),
  version: z.string().min(1).max(80),
  entry: z.string().min(1).max(240),
  permissions: z.array(SkillPermissionSchema).max(64),
}).strict();

export interface ValidatedBundle {
  manifest: z.infer<typeof ManifestSchema>;
  files: Array<{ path: string; content: Buffer }>;
}

function validRelativePath(value: string): boolean {
  if (!value || value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const normalized = posix.normalize(value);
  return normalized === value && normalized !== ".." && !normalized.startsWith("../");
}

export function validateSkillBundle(bundle: SkillBundle, expected: Pick<SkillDetail, "slug" | "version" | "permissionFingerprint">): ValidatedBundle {
  const source = new URL(bundle.sourceUrl);
  if (source.protocol !== "https:" || source.hostname !== "api.skillhub.cn" || source.username || source.password) {
    throw new Error("Untrusted Skill package source.");
  }
  if (bundle.entries.length === 0 || bundle.entries.length > MAX_FILES) throw new Error("Skill package file count exceeds limit.");
  const checksum = createHash("sha256").update(JSON.stringify(bundle.entries)).digest("hex");
  if (checksum !== bundle.checksumSha256) throw new Error("Skill package checksum mismatch.");
  let total = 0;
  const files: Array<{ path: string; content: Buffer }> = [];
  const paths = new Set<string>();
  for (const entry of bundle.entries) {
    if (!validRelativePath(entry.path)) throw new Error("Skill package path escapes target.");
    if (paths.has(entry.path)) throw new Error("Skill package contains duplicate paths.");
    paths.add(entry.path);
    if (entry.type !== "file" && entry.type !== "directory") throw new Error("Skill package links are forbidden.");
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
  const manifestFile = files.find((entry) => entry.path === "SKILL.json");
  if (!manifestFile) throw new Error("Skill package manifest is missing.");
  const manifest = ManifestSchema.parse(JSON.parse(manifestFile.content.toString("utf8")));
  const permissionHash = createHash("sha256").update(JSON.stringify(manifest.permissions)).digest("hex");
  if (
    manifest.id !== expected.slug || manifest.version !== expected.version ||
    permissionHash !== expected.permissionFingerprint ||
    !validRelativePath(manifest.entry) || !files.some((entry) => entry.path === manifest.entry)
  ) {
    throw new Error("Skill package manifest does not match request.");
  }
  return { manifest, files };
}
