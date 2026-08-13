import type { Dirent } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { parseSkillMarkdownFrontmatter } from "./bundle-validator.js";

export type LocalSkillOrigin = "portable-bundled" | "managed-installed" | "workspace-installed";
export interface LocalSkillItem {
  id: string;
  name: string;
  runtimeName: string;
  description: string;
  directoryKey: string;
  markdown: string;
  origin: LocalSkillOrigin;
}
export interface LocalSkillScan { items: LocalSkillItem[]; conflicts: Map<string, LocalSkillOrigin[]>; errors: Array<{ id: string; origin: LocalSkillOrigin }> }
export const MAX_LOCAL_SKILL_ENTRIES = 1_000;
export const MAX_LOCAL_SKILL_MARKDOWN_BYTES = 1024 * 1024;

function within(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function readBoundedFile(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_LOCAL_SKILL_MARKDOWN_BYTES) throw new Error("unsafe");
    const content = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < content.byteLength) {
      const { bytesRead } = await handle.read(content, offset, content.byteLength - offset, offset);
      if (bytesRead === 0) throw new Error("unsafe");
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) throw new Error("unsafe");
    return content.toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function scanLocalSkills({ bundledRoots, managedRoot, workspaceRoot }: {
  bundledRoots: readonly string[]; managedRoot: string; workspaceRoot: string;
}): Promise<LocalSkillScan> {
  const items: LocalSkillItem[] = [];
  const errors: LocalSkillScan["errors"] = [];
  const roots: Array<{ path: string; origin: LocalSkillOrigin }> = [
    ...bundledRoots.map((path) => ({ path, origin: "portable-bundled" as const })),
    { path: managedRoot, origin: "managed-installed" },
    { path: workspaceRoot, origin: "workspace-installed" },
  ];
  for (const root of roots) {
    const rootPath = resolve(root.path);
    let rootReal: string;
    try { rootReal = await realpath(rootPath); } catch { continue; }
    const entries: Dirent[] = [];
    try {
      for await (const entry of await opendir(rootReal)) {
        if (entry.name.startsWith(".")) continue;
        entries.push(entry);
        if (entries.length > MAX_LOCAL_SKILL_ENTRIES) break;
      }
    } catch {
      continue;
    }
    if (entries.length > MAX_LOCAL_SKILL_ENTRIES) {
      errors.push(...entries.map((entry) => ({ id: entry.name, origin: root.origin })));
      continue;
    }
    const candidates: Array<{ entry: Dirent; candidate: string }> = [];
    for (const entry of entries) {
      const candidate = join(rootReal, entry.name);
      if (root.origin !== "workspace-installed" || !/^@[a-z0-9][a-z0-9_-]{0,63}$/u.test(entry.name)) {
        candidates.push({ entry, candidate });
        continue;
      }
      try {
        const namespaceInfo = await lstat(candidate);
        if (!namespaceInfo.isDirectory() || namespaceInfo.isSymbolicLink()) throw new Error("unsafe");
        const namespaceReal = await realpath(candidate);
        if (!within(rootReal, namespaceReal)) throw new Error("unsafe");
        const namespacedEntries: Dirent[] = [];
        for await (const child of await opendir(namespaceReal)) {
          if (child.name.startsWith(".")) continue;
          namespacedEntries.push(child);
          if (namespacedEntries.length > MAX_LOCAL_SKILL_ENTRIES) break;
        }
        if (namespacedEntries.length > MAX_LOCAL_SKILL_ENTRIES) throw new Error("unsafe");
        candidates.push(...namespacedEntries.map((child) => ({ entry: child, candidate: join(namespaceReal, child.name) })));
      } catch {
        errors.push({ id: entry.name, origin: root.origin });
      }
    }
    for (const { entry, candidate } of candidates) {
      try {
        const info = await lstat(candidate);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe");
        const candidateReal = await realpath(candidate);
        if (!within(rootReal, candidateReal)) throw new Error("unsafe");
        const markdownPath = join(candidateReal, "SKILL.md");
        const markdownInfo = await lstat(markdownPath);
        if (!markdownInfo.isFile() || markdownInfo.isSymbolicLink()) throw new Error("unsafe");
        const markdown = await readBoundedFile(markdownPath);
        const frontmatter = parseSkillMarkdownFrontmatter(markdown);
        items.push({
          id: frontmatter.slug ?? entry.name,
          name: frontmatter.displayName ?? frontmatter.name,
          runtimeName: frontmatter.name,
          description: frontmatter.description,
          directoryKey: entry.name,
          markdown,
          origin: root.origin,
        });
      } catch { errors.push({ id: entry.name, origin: root.origin }); }
    }
  }
  const origins = new Map<string, LocalSkillOrigin[]>();
  for (const item of items) origins.set(item.id, [...(origins.get(item.id) ?? []), item.origin]);
  const conflicts = new Map([...origins].filter(([, sources]) => sources.length > 1));
  return { items, conflicts, errors };
}
