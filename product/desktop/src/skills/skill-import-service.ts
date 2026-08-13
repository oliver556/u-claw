import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { SkillDetail } from "@uclaw/shared";
import JSZip from "jszip";

import { parseSkillMarkdownFrontmatter, validateSkillBundle, type ValidatedBundle } from "./bundle-validator.js";
import { permissionFingerprint, type SkillBundle, type SkillBundleEntry } from "./fixture-client.js";

const MAX_ZIP_BYTES = 20 * 1024 * 1024;
const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1_000;

export type SkillImportSelection = {
  token: string;
  fileName: string;
  sizeBytes: number;
};

export type PreparedSkillImport = {
  detail: SkillDetail;
  validated: ValidatedBundle;
};

export interface SkillImportService {
  select(): Promise<SkillImportSelection | null>;
  prepare(token: string): Promise<PreparedSkillImport>;
  dispose(token: string): Promise<void>;
}

type Options = {
  dataDir: string;
  selectZip(): Promise<string | null>;
  now?: () => number;
  tokenTtlMs?: number;
};

type SelectionRecord = SkillImportSelection & { path: string; expiresAt: number };

function bundleChecksum(entries: readonly SkillBundleEntry[]): string {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

async function readBundle(path: string): Promise<{ bundle: SkillBundle; markdown: string }> {
  const compressed = await readFile(path);
  const zip = await JSZip.loadAsync(compressed, { createFolders: false, checkCRC32: true });
  const entries: SkillBundleEntry[] = [];
  let markdown = "";
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) {
      entries.push({ path: name.replace(/\/$/u, ""), type: "directory", size: 0 });
      continue;
    }
    const content = await entry.async("nodebuffer");
    entries.push({ path: name, type: "file", size: content.byteLength, contentBase64: content.toString("base64") });
    if (name === "SKILL.md") markdown = content.toString("utf8");
  }
  return {
    markdown,
    bundle: {
      sourceUrl: "uclaw-local://import/selected.zip",
      compressedBytes: compressed.byteLength,
      checksumSha256: bundleChecksum(entries),
      entries,
    },
  };
}

export function createSkillImportService({
  dataDir,
  selectZip,
  now = Date.now,
  tokenTtlMs = DEFAULT_TOKEN_TTL_MS,
}: Options): SkillImportService {
  const root = join(dataDir, "capabilities", ".skill-imports");
  const selections = new Map<string, SelectionRecord>();

  const dispose = async (token: string) => {
    const record = selections.get(token);
    selections.delete(token);
    if (record) await rm(record.path, { force: true });
  };

  return {
    async select() {
      const source = await selectZip();
      if (source === null) return null;
      if (extname(source).toLowerCase() !== ".zip") throw new Error("Only Skill ZIP files can be imported.");
      const info = await stat(source);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_ZIP_BYTES) throw new Error("Skill ZIP exceeds the 20 MB limit.");
      await mkdir(root, { recursive: true, mode: 0o700 });
      const token = randomBytes(18).toString("base64url");
      const path = join(root, `${token}.zip`);
      await copyFile(source, path);
      const record = { token, fileName: basename(source), sizeBytes: info.size, path, expiresAt: now() + tokenTtlMs };
      selections.set(token, record);
      return { token: record.token, fileName: record.fileName, sizeBytes: record.sizeBytes };
    },
    async prepare(token) {
      const record = selections.get(token);
      selections.delete(token);
      if (!record || now() > record.expiresAt) {
        if (record) await rm(record.path, { force: true });
        throw new Error("Skill import selection expired or was already used.");
      }
      try {
        const current = await stat(record.path);
        if (!current.isFile() || current.size !== record.sizeBytes || current.size > MAX_ZIP_BYTES) throw new Error("Skill ZIP changed after selection.");
        const { bundle, markdown } = await readBundle(record.path);
        const identity = parseSkillMarkdownFrontmatter(markdown);
        if (!identity.slug || !identity.version) throw new Error("Skill ZIP must declare slug and version.");
        const detail: SkillDetail = {
          slug: identity.slug,
          name: identity.name,
          description: identity.description,
          version: identity.version,
          pricingType: "free",
          installedVersion: null,
          enabled: false,
          updateAvailable: false,
          source: { provider: "skillhub", url: "https://skillhub.cloud.tencent.com/skills" },
          permissions: [],
          permissionFingerprint: permissionFingerprint([]),
          risk: "high",
          mode: "live",
          categories: [],
          manifest: { kind: "skill", id: identity.slug, version: identity.version, entry: "SKILL.md" },
        };
        return { detail, validated: validateSkillBundle(bundle, detail, "local-import") };
      } finally {
        await rm(record.path, { force: true });
      }
    },
    dispose,
  };
}
