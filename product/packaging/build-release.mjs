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

import { list as listTar } from "tar";

import { hashRuntimeTree } from "./build-runtime.mjs";
import {
  isSafeWindowsRelativePath,
  verifySignedRuntimeManifest,
} from "../scripts/runtime-manifest.mjs";

const execFileAsync = promisify(execFile);

export async function buildRelease(options) {
  const manifest = verifySignedRuntimeManifest(options.manifest, options.trustedPublicKeys);
  if (manifest.runtimeArchive !== "runtime.pkg") {
    throw new Error("release package name must be runtime.pkg");
  }
  const launcherPath = path.resolve(options.launcherPath);
  const runtimePackagePath = path.resolve(options.runtimePackagePath);
  const outputDir = path.resolve(options.outputDir);
  await requireRegularFile(launcherPath, "launcher input");
  const verifyLauncherPolicyConfig = options.verifyLauncherPolicyConfig ?? verifyOfficialLauncherPolicyConfig;
  const packageInfo = await requireRegularFile(runtimePackagePath, "runtime package");
  if (packageInfo.size !== manifest.runtimeBytes || !await digestMatches(runtimePackagePath, manifest.runtimeSha256)) {
    throw new Error("runtime package does not match manifest");
  }
  await validateRuntimeArchive(runtimePackagePath, manifest);
  await requireMissing(outputDir, "release output already exists");

  const outputParent = path.dirname(outputDir);
  await mkdir(outputParent, { recursive: true });
  const temporaryRoot = await mkdtemp(path.join(outputParent, ".uclaw-release-"));
  let committed = false;
  try {
    const packageRoot = path.join(temporaryRoot, ".uclaw");
    await mkdir(path.join(packageRoot, "data"), { recursive: true });
    const outputLauncher = path.join(temporaryRoot, "U-Claw.exe");
    await copyFile(launcherPath, outputLauncher, constants.COPYFILE_EXCL);
    if (!options.allowFixtureLauncher) await verifyLauncherPolicyConfig(outputLauncher);
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

async function verifyOfficialLauncherPolicyConfig(launcherPath) {
  try {
    await execFileAsync(launcherPath, ["--verify-official-release-policy-config"], {
      windowsHide: true,
      timeout: 30_000,
    });
  } catch {
    throw new Error("launcher release policy configuration is missing or invalid");
  }
}

export async function validateRuntimeArchive(archivePath, manifest) {
  const records = [];
  const pending = [];
  const seen = new Set();
  let fileCount = 0;
  let unpackedBytes = 0;

  try {
    await listTar({
      file: archivePath,
      gzip: true,
      strict: true,
      onReadEntry(entry) {
        if (entry.type !== "Directory" && entry.type !== "File") {
          throw new Error(`unsupported entry type: ${entry.type}`);
        }
        const normalized = entry.path.replaceAll("\\", "/").replace(/^\.\//u, "");
        const relative = entry.type === "Directory" ? normalized.replace(/\/$/u, "") : normalized;
        if (!isSafeWindowsRelativePath(relative)) {
          throw new Error(`unsafe path: ${entry.path}`);
        }
        const canonical = relative.toLowerCase();
        if (canonical === ".uclaw-runtime-cache.json") {
          throw new Error(`reserved path: ${entry.path}`);
        }
        if (seen.has(canonical)) throw new Error(`duplicate path: ${entry.path}`);
        seen.add(canonical);

        if (entry.type === "Directory") return;
        if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
          throw new Error(`invalid entry size: ${entry.path}`);
        }
        fileCount += 1;
        unpackedBytes += entry.size;
        if (!Number.isSafeInteger(unpackedBytes) || unpackedBytes > manifest.unpackedBytes) {
          throw new Error("unpacked size exceeds signed manifest");
        }

        const hash = createHash("sha256");
        pending.push(new Promise((resolve, reject) => {
          entry.on("data", (chunk) => hash.update(chunk));
          entry.once("error", reject);
          entry.once("end", () => {
            records.push({ path: relative, size: entry.size, sha256: hash.digest("hex") });
            resolve();
          });
        }));
      },
    });
    await Promise.all(pending);
  } catch (error) {
    throw new Error(`runtime archive validation failed: ${error.message}`);
  }

  if (fileCount !== manifest.fileCount || unpackedBytes !== manifest.unpackedBytes) {
    throw new Error("runtime archive metadata does not match manifest");
  }
  if (!records.some((record) => record.path.toLowerCase() === manifest.entrypoint.toLowerCase())) {
    throw new Error("runtime archive entrypoint is missing");
  }
  if (hashRuntimeTree(records) !== manifest.runtimeTreeSha256.toLowerCase()) {
    throw new Error("runtime archive tree does not match manifest");
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
      "public-key": { type: "string" },
      output: { type: "string" },
      "test-fixture-launcher": { type: "boolean", default: false },
    },
  });
  const manifest = JSON.parse(await readFile(values.manifest, "utf8"));
  if (!values["public-key"]) throw new Error("trusted runtime public key is required");
  const publicKey = await readFile(values["public-key"], "utf8");
  await buildRelease({
    launcherPath: values.launcher,
    runtimePackagePath: values["runtime-package"],
    manifest,
    outputDir: values.output,
    trustedPublicKeys: { [manifest.signature?.keyId]: publicKey },
    allowFixtureLauncher: values["test-fixture-launcher"],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCLI().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
