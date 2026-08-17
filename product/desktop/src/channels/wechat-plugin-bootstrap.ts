import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";

import { LOCKED_OPENCLAW_VERSION } from "@uclaw/shared";
import { z } from "zod";

const PLUGIN_ID = "openclaw-weixin";
const PLUGIN_PACKAGE = "@tencent-weixin/openclaw-weixin";
const PLUGIN_VERSION = "2.4.6";
const semver = createRequire(import.meta.url)("semver") as {
  validRange(value: string): string | null;
  satisfies(version: string, range: string, options: { includePrerelease: boolean }): boolean;
};

const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  plugins: z.array(z.object({
    id: z.literal(PLUGIN_ID),
    package: z.literal(PLUGIN_PACKAGE),
    version: z.literal(PLUGIN_VERSION),
    npmIntegrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+=*$/u),
    openclawVersionRange: z.string().refine((value) => semver.validRange(value) !== null),
    files: z.array(z.object({
      path: z.string().min(1).refine((value) => !value.startsWith("/") && !value.includes("..") && !value.includes("\\")),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    })).min(3),
  })).length(1),
});

export type WechatPluginInitialStatus = "healthy" | "missing" | "tampered" | "incompatible";
export type WechatPluginBootstrapResult =
  | { available: true; initialStatus: WechatPluginInitialStatus; status: "healthy" | "repaired" }
  | { available: false; initialStatus: WechatPluginInitialStatus; status: "repair-failed"; code: "SOURCE_INVALID" | "TARGET_UNSAFE" | "REPAIR_FAILED"; reason: string };

type VerifiedManifest = z.infer<typeof ManifestSchema>["plugins"][number];

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function inventory(root: string, relative = ""): Promise<string[]> {
  const entries = await readdir(relative ? join(root, ...relative.split("/")) : root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const files: string[] = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (child === ".uclaw-plugin-manifest.json") continue;
    const info = await lstat(join(root, ...child.split("/")));
    if (info.isSymbolicLink()) throw new Error("symbolic links are forbidden");
    if (info.isDirectory()) files.push(...await inventory(root, child));
    else if (info.isFile()) files.push(child);
    else throw new Error("unsupported plugin entry");
  }
  return files;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function verify(root: string): Promise<{ valid: true; manifest: VerifiedManifest } | { valid: false; status: WechatPluginInitialStatus }> {
  try {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return { valid: false, status: "tampered" };
  } catch (error) {
    if (missing(error)) return { valid: false, status: "missing" };
    throw error;
  }
  try {
    const manifest = ManifestSchema.parse(JSON.parse(await readFile(join(root, ".uclaw-plugin-manifest.json"), "utf8"))).plugins[0]!;
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    if (packageJson.name !== PLUGIN_PACKAGE || packageJson.version !== PLUGIN_VERSION ||
      !semver.satisfies(LOCKED_OPENCLAW_VERSION, manifest.openclawVersionRange, { includePrerelease: true })) {
      return { valid: false, status: "incompatible" };
    }
    const actual = await inventory(root);
    const expected = manifest.files.map((file) => file.path).sort((left, right) => left.localeCompare(right, "en"));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return { valid: false, status: "tampered" };
    for (const file of manifest.files) {
      const path = join(root, ...file.path.split("/"));
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile() || info.size !== file.bytes || await hashFile(path) !== file.sha256) {
        return { valid: false, status: "tampered" };
      }
    }
    return { valid: true, manifest };
  } catch {
    return { valid: false, status: "tampered" };
  }
}

async function copyVerified(source: string, target: string, manifest: VerifiedManifest): Promise<void> {
  await mkdir(target, { mode: 0o700 });
  for (const file of manifest.files) {
    const sourcePath = join(source, ...file.path.split("/"));
    const targetPath = join(target, ...file.path.split("/"));
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
    await writeFile(targetPath, await readFile(sourcePath), { mode: 0o600 });
  }
  await writeFile(join(target, ".uclaw-plugin-manifest.json"), await readFile(join(source, ".uclaw-plugin-manifest.json")), { mode: 0o600 });
}

export async function bootstrapWechatPlugin(options: { sourceDir: string; targetDir: string }): Promise<WechatPluginBootstrapResult> {
  const target = await verify(options.targetDir);
  if (target.valid) return { available: true, initialStatus: "healthy", status: "healthy" };
  const initialStatus = target.status;

  const source = await verify(options.sourceDir);
  if (!source.valid) {
    return { available: false, initialStatus, status: "repair-failed", code: "SOURCE_INVALID", reason: "随包个人微信组件校验失败，请重新安装 U-Claw。" };
  }

  const parent = dirname(options.targetDir);
  const staging = join(parent, `.${basename(options.targetDir)}.${randomUUID()}.staging`);
  const backup = join(parent, `.${basename(options.targetDir)}.${randomUUID()}.backup`);
  let movedOld = false;
  let preserveBackup = false;
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const parentInfo = await lstat(parent);
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
      return { available: false, initialStatus, status: "repair-failed", code: "TARGET_UNSAFE", reason: "个人微信组件目录不安全，已停止修复。" };
    }
    try {
      const info = await lstat(options.targetDir);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        return { available: false, initialStatus, status: "repair-failed", code: "TARGET_UNSAFE", reason: "个人微信组件目录不安全，已停止修复。" };
      }
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await copyVerified(options.sourceDir, staging, source.manifest);
    const staged = await verify(staging);
    if (!staged.valid) throw new Error("staged plugin verification failed");
    try {
      await rename(options.targetDir, backup);
      movedOld = true;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await rename(staging, options.targetDir);
    const installed = await verify(options.targetDir);
    if (!installed.valid) throw new Error("installed plugin verification failed");
    if (movedOld) await rm(backup, { recursive: true, force: true });
    return { available: true, initialStatus, status: "repaired" };
  } catch {
    if (movedOld) {
      await rm(options.targetDir, { recursive: true, force: true }).catch(() => undefined);
      try {
        await rename(backup, options.targetDir);
        movedOld = false;
      } catch {
        preserveBackup = true;
      }
    }
    return { available: false, initialStatus, status: "repair-failed", code: "REPAIR_FAILED", reason: "个人微信组件自动修复失败，请重启 U-Claw；问题持续时请重新安装。" };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (!preserveBackup) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
  }
}
