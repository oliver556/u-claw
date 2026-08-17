import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;
export interface AttachmentCleanupOptions {
  dataDir: string; now?: () => number; ttlMs?: number; intervalMs?: number;
  referencedAttachmentIds?: ReadonlySet<string> | (() => ReadonlySet<string> | Promise<ReadonlySet<string>>);
}
async function safeDir(path: string) {
  const before = await lstat(path).catch((caught: NodeJS.ErrnoException) => caught.code === "ENOENT" ? undefined : Promise.reject(caught));
  if (before?.isSymbolicLink()) throw new Error(`Unsafe attachment cleanup symlink: ${path}`);
  await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe attachment cleanup directory: ${path}`);
}
async function roots(dataDir: string) {
  const paths = [dataDir, join(dataDir, "uclaw"), join(dataDir, "uclaw", "attachments"), join(dataDir, "uclaw", "attachments", "objects"), join(dataDir, "uclaw", "attachments", "imports")];
  for (const path of paths) await safeDir(path);
  return { objects: paths[3], imports: paths[4] };
}
export async function cleanupAttachmentCache(options: AttachmentCleanupOptions) {
  const now = options.now?.() ?? Date.now();
  const ttl = options.ttlMs ?? ATTACHMENT_TTL_MS;
  const active = typeof options.referencedAttachmentIds === "function" ? await options.referencedAttachmentIds() : options.referencedAttachmentIds ?? new Set<string>();
  const cache = await roots(options.dataDir);
  let removedAttachments = 0, removedImports = 0;
  for (const entry of await readdir(cache.objects, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const dir = join(cache.objects, entry.name);
    const metadata = JSON.parse(await readFile(join(dir, "metadata.json"), "utf8")) as { lastUsedAt?: number; createdAt?: number };
    if (active.has(entry.name)) {
      await writeFile(join(dir, "metadata.json"), JSON.stringify({ ...metadata, lastUsedAt: now }), { mode: 0o600 });
      continue;
    }
    if (now - (metadata.lastUsedAt ?? metadata.createdAt ?? now) >= ttl) { await rm(dir, { recursive: true, force: true }); removedAttachments += 1; }
  }
  for (const entry of await readdir(cache.imports, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const dir = join(cache.imports, entry.name);
    if (now - (await lstat(dir)).mtimeMs >= ttl) { await rm(dir, { recursive: true, force: true }); removedImports += 1; }
  }
  return { removedAttachments, removedImports };
}
export function startAttachmentCleanup(options: AttachmentCleanupOptions) {
  const run = () => cleanupAttachmentCache(options).then(() => undefined);
  // Cleanup is maintenance work. A malformed or unavailable cache must not
  // prevent the desktop runtime from starting; the interval will retry it.
  const started = run().catch(() => undefined);
  const timer = setInterval(() => void run().catch(() => undefined), options.intervalMs ?? 60 * 60 * 1000);
  timer.unref?.();
  return { started, dispose: () => clearInterval(timer) };
}
