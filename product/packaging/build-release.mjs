import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { validateRuntimeManifest } from "../scripts/runtime-manifest.mjs";

const execFileAsync = promisify(execFile);

export async function buildRelease(options) {
  const manifest = validateRuntimeManifest(options.manifest);
  if (manifest.runtimeArchive !== "runtime.pkg") {
    throw new Error("release package name must be runtime.pkg");
  }
  const launcherPath = path.resolve(options.launcherPath);
  const runtimePackagePath = path.resolve(options.runtimePackagePath);
  const outputDir = path.resolve(options.outputDir);
  await requireRegularFile(launcherPath, "launcher input");
  const packageInfo = await requireRegularFile(runtimePackagePath, "runtime package");
  if (packageInfo.size !== manifest.runtimeBytes || !await digestMatches(runtimePackagePath, manifest.runtimeSha256)) {
    throw new Error("runtime package does not match manifest");
  }
  await requireMissing(outputDir, "release output already exists");

  const outputParent = path.dirname(outputDir);
  await mkdir(outputParent, { recursive: true });
  const temporaryRoot = await mkdtemp(path.join(outputParent, ".uclaw-release-"));
  let committed = false;
  try {
    const packageRoot = path.join(temporaryRoot, ".uclaw");
    await mkdir(path.join(packageRoot, "data"), { recursive: true });
    await copyFile(launcherPath, path.join(temporaryRoot, "U-Claw.exe"), constants.COPYFILE_EXCL);
    await copyFile(runtimePackagePath, path.join(packageRoot, "runtime.pkg"), constants.COPYFILE_EXCL);
    await writeFile(
      path.join(packageRoot, "version.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    if (process.platform === "win32") {
      await execFileAsync("attrib", ["+h", packageRoot], { windowsHide: true });
    }
    try {
      await rename(temporaryRoot, outputDir);
    } catch (error) {
      if (error.code === "EEXIST" || error.code === "ENOTEMPTY") {
        throw new Error("release output already exists");
      }
      throw error;
    }
    committed = true;
  } finally {
    if (!committed) await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function requireRegularFile(target, label) {
  const info = await lstat(target).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return info;
}

async function requireMissing(target, message) {
  try {
    await lstat(target);
    throw new Error(message);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function digestMatches(file, expected) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const actual = Buffer.from(hash.digest("hex"), "ascii");
  return actual.length === expected.length && timingSafeEqual(actual, Buffer.from(expected.toLowerCase(), "ascii"));
}

async function runCLI() {
  const { values } = parseArgs({
    options: {
      launcher: { type: "string" },
      "runtime-package": { type: "string" },
      manifest: { type: "string" },
      output: { type: "string" },
    },
  });
  const manifest = JSON.parse(await readFile(values.manifest, "utf8"));
  await buildRelease({
    launcherPath: values.launcher,
    runtimePackagePath: values["runtime-package"],
    manifest,
    outputDir: values.output,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCLI().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
