import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const magic = Buffer.from("UCLAWUP1", "ascii");
const trailerBytes = 16;
const maxManifestBytes = 1 << 20;

export async function buildOfflineUpdater(options) {
  const updaterPath = path.resolve(options.updaterPath);
  const feedPath = path.resolve(options.feedPath);
  const runtimePath = path.resolve(options.runtimePackagePath);
  const outputFile = path.resolve(options.outputFile);
  const updaterInfo = await requireRegularFile(updaterPath, "generic updater");
  await requireRegularFile(feedPath, "release feed");
  await requireRegularFile(runtimePath, "runtime package");
  await requireMissing(outputFile, "offline updater output already exists");

  const feedBytes = await readFile(feedPath);
  const runtimeBytes = await readFile(runtimePath);
  if (feedBytes.length === 0 || feedBytes.length > maxManifestBytes || runtimeBytes.length === 0) throw new Error("offline update payload has invalid bounds");
  let feed;
  try {
    feed = JSON.parse(feedBytes);
  } catch {
    throw new Error("release feed is invalid JSON");
  }
  const runtimeHash = createHash("sha256").update(runtimeBytes).digest("hex");
  if (feed.channel !== "stable" || feed.package?.bytes !== runtimeBytes.length || feed.package?.sha256 !== runtimeHash ||
      feed.runtimeManifest?.runtimeBytes !== runtimeBytes.length || feed.runtimeManifest?.runtimeSha256 !== runtimeHash) {
    throw new Error("runtime package does not match release feed");
  }

  const trailer = Buffer.alloc(trailerBytes);
  magic.copy(trailer);
  trailer.writeUInt32BE(feedBytes.length, 8);
  trailer.writeUInt32BE(runtimeBytes.length, 12);
  await mkdir(path.dirname(outputFile), { recursive: true });
  const temporaryDir = await mkdtemp(path.join(path.dirname(outputFile), ".uclaw-offline-updater-"));
  const temporaryFile = path.join(temporaryDir, path.basename(outputFile));
  try {
    const handle = await open(temporaryFile, "wx", updaterInfo.mode & 0o777);
    try {
      await handle.writeFile(await readFile(updaterPath));
      await handle.writeFile(feedBytes);
      await handle.writeFile(runtimeBytes);
      await handle.writeFile(trailer);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const extracted = await extractOfflinePayload(temporaryFile);
    if (!extracted.manifest.equals(feedBytes) || !extracted.runtime.equals(runtimeBytes)) throw new Error("offline payload self-verification failed");
    try {
      await link(temporaryFile, outputFile);
    } catch (error) {
      if (error.code === "EEXIST") throw new Error("offline updater output already exists");
      throw error;
    }
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

export async function extractOfflinePayload(file) {
  const info = await requireRegularFile(path.resolve(file), "offline updater");
  if (info.size <= trailerBytes) throw new Error("offline update payload is too short");
  const handle = await open(file, "r");
  try {
    const trailer = Buffer.alloc(trailerBytes);
    await readExactly(handle, trailer, info.size - trailerBytes);
    if (!trailer.subarray(0, 8).equals(magic)) throw new Error("offline update payload magic is invalid");
    const manifestLength = trailer.readUInt32BE(8);
    const runtimeLength = trailer.readUInt32BE(12);
    const payloadOffset = info.size - trailerBytes - manifestLength - runtimeLength;
    if (manifestLength === 0 || manifestLength > maxManifestBytes || runtimeLength === 0 || payloadOffset <= 0) throw new Error("offline update payload bounds are invalid");
    const manifest = Buffer.alloc(manifestLength);
    const runtime = Buffer.alloc(runtimeLength);
    await readExactly(handle, manifest, payloadOffset);
    await readExactly(handle, runtime, payloadOffset + manifestLength);
    return { manifest, runtime };
  } finally {
    await handle.close();
  }
}

async function readExactly(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read({ buffer, offset, length: buffer.length - offset, position: position + offset });
    if (bytesRead === 0) throw new Error("offline update payload is truncated");
    offset += bytesRead;
  }
}

async function requireRegularFile(target, label) {
  const info = await lstat(target).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return info;
}

async function requireMissing(target, message) {
  const info = await lstat(target).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info) throw new Error(message);
}

async function runCLI() {
  const { values } = parseArgs({ options: {
    updater: { type: "string" },
    feed: { type: "string" },
    runtime: { type: "string" },
    output: { type: "string" },
  } });
  await buildOfflineUpdater({ updaterPath: values.updater, feedPath: values.feed, runtimePackagePath: values.runtime, outputFile: values.output });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCLI().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
