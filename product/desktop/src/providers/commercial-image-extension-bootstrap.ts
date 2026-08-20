import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const FILES = ["package.json", "openclaw.plugin.json", "dist/index.js"] as const;

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function requireSafeDirectory(path: string, allowMissing: boolean): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Commercial image extension directory is unsafe.");
  } catch (error) {
    if (allowMissing && missing(error)) return;
    throw error;
  }
}

export async function installBundledCommercialImageExtension(options: { sourceDir: string; targetDir: string }): Promise<void> {
  await requireSafeDirectory(options.sourceDir, false);
  const contents = new Map<string, Buffer>();
  for (const relative of FILES) {
    const path = join(options.sourceDir, ...relative.split("/"));
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Commercial image extension source is unsafe.");
    contents.set(relative, await readFile(path));
  }
  const packageJson = JSON.parse(contents.get("package.json")!.toString("utf8")) as Record<string, unknown>;
  const manifest = JSON.parse(contents.get("openclaw.plugin.json")!.toString("utf8")) as Record<string, unknown>;
  if (packageJson.name !== "@uclaw/openclaw-commercial-image" || manifest.id !== "uclaw-commercial-image") {
    throw new Error("Commercial image extension source is invalid.");
  }

  await mkdir(dirname(options.targetDir), { recursive: true, mode: 0o700 });
  await requireSafeDirectory(dirname(options.targetDir), false);
  await requireSafeDirectory(options.targetDir, true);
  const staging = `${options.targetDir}.${randomUUID()}.staging`;
  const backup = `${options.targetDir}.${randomUUID()}.backup`;
  let backedUp = false;
  try {
    await mkdir(join(staging, "dist"), { recursive: true, mode: 0o700 });
    for (const [relative, bytes] of contents) {
      await writeFile(join(staging, ...relative.split("/")), bytes, { mode: 0o600 });
    }
    try {
      await rename(options.targetDir, backup);
      backedUp = true;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await rename(staging, options.targetDir);
    if (backedUp) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (backedUp) {
      await rm(options.targetDir, { recursive: true, force: true }).catch(() => undefined);
      await rename(backup, options.targetDir).catch(() => undefined);
    }
    throw error;
  }
}
