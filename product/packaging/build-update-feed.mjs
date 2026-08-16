import { createHash, sign, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { verifySignedRuntimeManifest } from "../scripts/runtime-manifest.mjs";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

export function releaseSigningPayload(feed) {
  const { signature: ignored, ...unsigned } = feed;
  return Buffer.from(JSON.stringify(unsigned));
}

export async function buildUpdateFeed(options) {
  if (!options.privateKey) throw new Error("release private key is required");
  if (!options.publicKey) throw new Error("release public key is required for self-verification");
  if (!identifierPattern.test(options.keyId ?? "") || !identifierPattern.test(options.releaseId ?? "")) {
    throw new Error("invalid release signing metadata");
  }
  if (!versionPattern.test(options.version ?? "")) throw new Error("invalid release version");
  if (!Number.isSafeInteger(options.sequence) || options.sequence < 1) throw new Error("release sequence must be positive");
  if (!Array.isArray(options.notes) || !options.notes.every((note) => typeof note === "string")) throw new Error("release notes must be strings");
  const publishedAt = validDate(options.publishedAt, "publishedAt");
  const expiresAt = validDate(options.expiresAt, "expiresAt");
  if (expiresAt <= publishedAt) throw new Error("release expiry must follow publication");

  const runtimeManifest = verifySignedRuntimeManifest(options.runtimeManifest, options.trustedRuntimePublicKeys);
  if (runtimeManifest.productVersion !== options.version || runtimeManifest.signature.sequence !== options.sequence) {
    throw new Error("release version or sequence does not match runtime manifest");
  }
  if (runtimeManifest.targetPlatform !== "win32" || runtimeManifest.targetArch !== "x64" || runtimeManifest.runtimeArchive !== "runtime.pkg") {
    throw new Error("runtime manifest is not compatible with the stable Windows feed");
  }

  const runtimePath = path.resolve(options.runtimePackagePath);
  const runtimeInfo = await requireRegularFile(runtimePath, "runtime package");
  const runtimeHash = await hashFile(runtimePath);
  if (runtimeInfo.size !== runtimeManifest.runtimeBytes || runtimeHash !== runtimeManifest.runtimeSha256.toLowerCase()) {
    throw new Error("runtime package does not match signed runtime manifest");
  }

  const unsigned = {
    schemaVersion: 1,
    id: options.releaseId,
    version: options.version,
    channel: "stable",
    publishedAt: publishedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    sequence: options.sequence,
    notes: [...options.notes],
    compatibility: {
      platform: runtimeManifest.targetPlatform,
      arch: runtimeManifest.targetArch,
      runtimeId: runtimeManifest.runtimeId,
    },
    package: { bytes: runtimeInfo.size, sha256: runtimeHash },
    runtimeManifest,
    mandatory: options.mandatory === true,
  };
  const signature = {
    algorithm: "ed25519",
    keyId: options.keyId,
    value: sign(null, Buffer.from(JSON.stringify(unsigned)), options.privateKey).toString("base64"),
  };
  const feed = { ...unsigned, signature };
  if (!verify(null, releaseSigningPayload(feed), options.publicKey, Buffer.from(signature.value, "base64"))) {
    throw new Error("release signature self-verification failed");
  }

  const outputDir = path.resolve(options.outputDir);
  await requireMissing(outputDir, "release feed output already exists");
  await mkdir(path.dirname(outputDir), { recursive: true });
  const temporaryDir = await mkdtemp(path.join(path.dirname(outputDir), ".uclaw-update-feed-"));
  let committed = false;
  try {
    const packageDir = path.join(temporaryDir, "packages", feed.id);
    await mkdir(packageDir, { recursive: true });
    await writeFile(path.join(temporaryDir, "stable.json"), `${JSON.stringify(feed)}\n`, { encoding: "utf8", flag: "wx", mode: 0o644 });
    await copyFile(runtimePath, path.join(packageDir, "runtime.pkg"));
    await rename(temporaryDir, outputDir);
    committed = true;
  } finally {
    if (!committed) await rm(temporaryDir, { recursive: true, force: true });
  }
  return feed;
}

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function validDate(value, label) {
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error(`invalid ${label}`);
  return result;
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
    runtime: { type: "string" },
    manifest: { type: "string" },
    output: { type: "string" },
    id: { type: "string" },
    version: { type: "string" },
    notes: { type: "string", multiple: true, default: [] },
    mandatory: { type: "boolean", default: false },
    published: { type: "string" },
    expires: { type: "string" },
    sequence: { type: "string" },
    "key-id": { type: "string" },
    "private-key": { type: "string" },
    "public-key": { type: "string" },
    "runtime-public-key": { type: "string" },
  } });
  if (!values["private-key"] || !values["public-key"] || !values["runtime-public-key"]) throw new Error("release and runtime key paths are required");
  const runtimeManifest = JSON.parse(await readFile(values.manifest, "utf8"));
  await buildUpdateFeed({
    runtimePackagePath: values.runtime,
    runtimeManifest,
    outputDir: values.output,
    releaseId: values.id,
    version: values.version,
    notes: values.notes,
    mandatory: values.mandatory,
    publishedAt: values.published,
    expiresAt: values.expires,
    sequence: Number(values.sequence),
    keyId: values["key-id"],
    privateKey: await readFile(values["private-key"], "utf8"),
    publicKey: await readFile(values["public-key"], "utf8"),
    trustedRuntimePublicKeys: { [runtimeManifest.signature?.keyId]: await readFile(values["runtime-public-key"], "utf8") },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCLI().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
