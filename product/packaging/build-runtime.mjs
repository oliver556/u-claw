import { createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
} from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { create as createTar } from "tar";

import {
  isSafeWindowsRelativePath,
  validateRuntimeManifest,
} from "../scripts/runtime-manifest.mjs";

const runtimeVersions = JSON.parse(
  await readFile(new URL("../runtime-versions.json", import.meta.url), "utf8"),
);

export async function buildRuntime(options) {
  const expectedRuntimeId = runtimeVersions.runtimeId;
  if (options.runtimeId !== expectedRuntimeId) {
    throw new Error(`runtimeId must be ${expectedRuntimeId}`);
  }
  const inputDir = path.resolve(options.inputDir);
  const outputFile = path.resolve(options.outputFile);
  await requireMissing(outputFile, "runtime output already exists");
  const inputInfo = await lstat(inputDir).catch(() => null);
  if (!inputInfo?.isDirectory() || inputInfo.isSymbolicLink()) {
    throw new Error("runtime input must be a real directory");
  }

  const inventory = await inventoryRuntime(inputDir);
  const normalizedEntrypoint = normalizeRuntimePath(options.entrypoint);
  if (!inventory.files.has(normalizedEntrypoint.toLowerCase())) {
    throw new Error("runtime entrypoint does not exist");
  }

  const provisionalManifest = {
    schemaVersion: 1,
    productVersion: options.productVersion,
    nodeVersion: runtimeVersions.node,
    electronVersion: runtimeVersions.electron,
    runtimeVersion: runtimeVersions.openclaw,
    runtimeId: options.runtimeId,
    targetPlatform: runtimeVersions.targetPlatform,
    targetArch: runtimeVersions.targetArch,
    runtimeArchive: "runtime.pkg",
    runtimeSha256: "0".repeat(64),
    runtimeTreeSha256: inventory.treeSha256,
    runtimeBytes: 1,
    unpackedBytes: inventory.unpackedBytes,
    fileCount: inventory.fileCount,
    entrypoint: normalizedEntrypoint,
    entryArgs: [...(options.entryArgs ?? [])],
  };
  validateRuntimeManifest(provisionalManifest);

  await mkdir(path.dirname(outputFile), { recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(path.dirname(outputFile), ".runtime-pkg-"));
  const temporaryArchive = path.join(
    temporaryDirectory,
    `runtime-${randomBytes(8).toString("hex")}.pkg`,
  );
  try {
    await createTar({
      cwd: inputDir,
      file: temporaryArchive,
      gzip: true,
      noDirRecurse: true,
      noMtime: true,
      portable: true,
      strict: true,
    }, inventory.entries);
    const archiveHandle = await open(temporaryArchive, "r+");
    await archiveHandle.sync();
    await archiveHandle.close();
    const archiveInfo = await lstat(temporaryArchive);
    const manifest = validateRuntimeManifest({
      ...provisionalManifest,
      runtimeSha256: await hashFile(temporaryArchive),
      runtimeBytes: archiveInfo.size,
    });
    try {
      await link(temporaryArchive, outputFile);
    } catch (error) {
      if (error.code === "EEXIST") throw new Error("runtime output already exists");
      throw error;
    }
    return manifest;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function inventoryRuntime(inputDir) {
  const entries = [];
  const files = new Set();
  const fileRecords = [];
  const seen = new Set();
  let fileCount = 0;
  let unpackedBytes = 0;

  async function visit(relativeDirectory) {
    const absoluteDirectory = relativeDirectory
      ? path.join(inputDir, ...relativeDirectory.split("/"))
      : inputDir;
    const children = await readdir(absoluteDirectory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      if (!isSafeWindowsRelativePath(relative)) {
        throw new Error(`unsafe runtime path: ${relative}`);
      }
      const canonical = relative.toLowerCase();
      if (seen.has(canonical)) throw new Error(`duplicate runtime path: ${relative}`);
      seen.add(canonical);

      const absolute = path.join(inputDir, ...relative.split("/"));
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`runtime symlink is forbidden: ${relative}`);
      if (info.isDirectory()) {
        entries.push(relative);
        await visit(relative);
      } else if (info.isFile()) {
        entries.push(relative);
        files.add(canonical);
        fileRecords.push({ path: relative, size: info.size, sha256: await hashFile(absolute) });
        fileCount += 1;
        unpackedBytes += info.size;
        if (!Number.isSafeInteger(unpackedBytes)) throw new Error("runtime is too large");
      } else {
        throw new Error(`unsupported runtime entry: ${relative}`);
      }
    }
  }

  await visit("");
  entries.sort((left, right) => left.localeCompare(right, "en"));
  return { entries, files, fileCount, unpackedBytes, treeSha256: hashRuntimeTree(fileRecords) };
}

export function hashRuntimeTree(records) {
  const hash = createHash("sha256");
  const sorted = [...records].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  for (const record of sorted) {
    const pathBytes = Buffer.from(record.path);
    const pathLength = Buffer.alloc(4); pathLength.writeUInt32BE(pathBytes.length);
    const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(record.size));
    hash.update(pathLength); hash.update(pathBytes); hash.update(size); hash.update(Buffer.from(record.sha256, "hex"));
  }
  return hash.digest("hex");
}

function normalizeRuntimePath(value) {
  if (!isSafeWindowsRelativePath(value)) throw new Error("runtime entrypoint is unsafe");
  return value.replaceAll("\\", "/");
}

async function requireMissing(target, message) {
  try {
    await lstat(target);
    throw new Error(message);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function runCLI() {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      output: { type: "string" },
      "product-version": { type: "string" },
      "runtime-id": { type: "string" },
      entrypoint: { type: "string" },
      "entry-arg": { type: "string", multiple: true, default: [] },
    },
  });
  const manifest = await buildRuntime({
    inputDir: values.input,
    outputFile: values.output,
    productVersion: values["product-version"],
    runtimeId: values["runtime-id"],
    entrypoint: values.entrypoint,
    entryArgs: values["entry-arg"],
  });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCLI().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
