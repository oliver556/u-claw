import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export interface RuntimeReadiness {
  productVersion: string;
  runtimeVersion: string;
  gatewayReady: true;
}

export interface RuntimeStartupFailure {
  stage: "load-options" | "start-desktop";
  code: string;
  name: string;
}

const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;

async function pathInfo(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function requireDirectory(path: string, label: string): Promise<void> {
  const info = await pathInfo(path);
  if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} must be an existing non-symlink directory.`);
  }
}

function validateReadiness(value: RuntimeReadiness): void {
  if (!VERSION_PATTERN.test(value.productVersion) || !VERSION_PATTERN.test(value.runtimeVersion)) {
    throw new Error("Runtime readiness versions are invalid.");
  }
  if (value.gatewayReady !== true) throw new Error("Gateway must be ready.");
}

async function diagnosticsDirectory(dataDir: string, create: boolean): Promise<string | undefined> {
  await requireDirectory(dataDir, "Data directory");
  const directory = join(dataDir, "diagnostics");
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await pathInfo(directory);
  if (info === undefined && !create) return undefined;
  if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("Diagnostics path must be a non-symlink directory.");
  }
  return directory;
}

export async function clearRuntimeReadiness(dataDir: string): Promise<void> {
  const directory = await diagnosticsDirectory(dataDir, false);
  if (directory === undefined) return;
  const target = join(directory, "runtime-ready.json");
  const info = await pathInfo(target);
  if (info === undefined) return;
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("Runtime readiness path must be a non-symlink file.");
  }
  await unlink(target);
}

export async function writeRuntimeReadiness(
  dataDir: string,
  value: RuntimeReadiness,
): Promise<void> {
  validateReadiness(value);
  const directory = (await diagnosticsDirectory(dataDir, true))!;
  const target = join(directory, "runtime-ready.json");
  const targetInfo = await pathInfo(target);
  if (targetInfo !== undefined && (targetInfo.isSymbolicLink() || !targetInfo.isFile())) {
    throw new Error("Runtime readiness path must be a non-symlink file.");
  }
  const temporary = join(directory, `.runtime-ready-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let replaced = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({
      schemaVersion: 1,
      productVersion: value.productVersion,
      runtimeVersion: value.runtimeVersion,
      gatewayReady: true,
    })}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    replaced = true;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!replaced) await unlink(temporary).catch(() => undefined);
  }
}

export async function clearRuntimeStartupFailure(dataDir: string): Promise<void> {
  const directory = await diagnosticsDirectory(dataDir, false);
  if (directory === undefined) return;
  const target = join(directory, "runtime-startup-failure.json");
  const info = await pathInfo(target);
  if (info === undefined) return;
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("Runtime startup failure path must be a non-symlink file.");
  }
  await unlink(target);
}

export async function writeRuntimeStartupFailure(
  dataDir: string,
  value: RuntimeStartupFailure,
): Promise<void> {
  if (
    !["load-options", "start-desktop"].includes(value.stage) ||
    !/^[A-Z][A-Z0-9_]{1,63}$/u.test(value.code) ||
    !/^[A-Za-z][A-Za-z0-9]{1,63}$/u.test(value.name)
  ) {
    throw new Error("Runtime startup failure diagnostic is invalid.");
  }
  const directory = (await diagnosticsDirectory(dataDir, true))!;
  const target = join(directory, "runtime-startup-failure.json");
  const targetInfo = await pathInfo(target);
  if (targetInfo !== undefined && (targetInfo.isSymbolicLink() || !targetInfo.isFile())) {
    throw new Error("Runtime startup failure path must be a non-symlink file.");
  }
  const temporary = join(directory, `.runtime-startup-failure-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let replaced = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, stage: value.stage, code: value.code, name: value.name })}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    replaced = true;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!replaced) await unlink(temporary).catch(() => undefined);
  }
}
