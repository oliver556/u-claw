import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { buildRuntime, hashFile, inventoryRuntime } from "./build-runtime.mjs";
import { validateRuntimeArchive } from "./build-release.mjs";
import { signRuntimeManifest } from "../scripts/runtime-manifest.mjs";

const execFileAsync = promisify(execFile);
const requiredArtifacts = [
  "runtime.pkg",
  "runtime-manifest.json",
  "inventory.json",
  "sbom.spdx.json",
  "runtime-tree.sha256",
];

export function assertCommercialBuildInputs(repoRoot, inputPaths) {
  const root = path.resolve(repoRoot);
  const productRoot = path.join(root, "product");
  for (const value of inputPaths) {
    const candidate = path.resolve(value);
    const relative = path.relative(productRoot, candidate);
    const segments = relative.split(path.sep).map((segment) => segment.toLowerCase());
    const insideProduct = relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
    const isFixture = segments.includes("fixtures") || segments.includes("fixture");
    if (!insideProduct || isFixture) {
      throw new Error(`commercial build input must be a non-fixture path under product/: ${candidate}`);
    }
  }
}

export async function buildReleaseArtifacts(options) {
  assertCommercialBuildInputs(options.repoRoot, [options.runtimeDir]);
  const outputDir = path.resolve(options.outputDir);
  await requireMissing(outputDir, "release artifact output already exists");
  const parent = path.dirname(outputDir);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(path.join(parent, ".release-artifacts-"));
  let committed = false;
  try {
    const runtimePackage = path.join(temporary, "runtime.pkg");
    const unsigned = await buildRuntime({
      inputDir: options.runtimeDir,
      outputFile: runtimePackage,
      productVersion: options.productVersion,
      releaseId: options.releaseId,
      releaseSequence: options.releaseSequence,
      runtimeId: options.runtimeId,
      entrypoint: options.entrypoint,
      entryArgs: options.entryArgs,
    });
    const manifest = signRuntimeManifest(unsigned, {
      keyId: options.keyId,
      privateKey: options.privateKey,
      signedAt: options.signedAt,
      expiresAt: options.expiresAt,
      sequence: options.releaseSequence,
    });
    await validateRuntimeArchive(runtimePackage, manifest);
    const runtimeInventory = await inventoryRuntime(path.resolve(options.runtimeDir));
    if (runtimeInventory.treeSha256 !== manifest.runtimeTreeSha256 || runtimeInventory.fileCount !== manifest.fileCount || runtimeInventory.unpackedBytes !== manifest.unpackedBytes) {
      throw new Error("runtime changed while release artifacts were being built");
    }
    const files = runtimeInventory.fileRecords
      .map((record) => ({ ...record }))
      .sort((left, right) => left.path.localeCompare(right.path, "en"));
    const inventory = {
      schemaVersion: 1,
      releaseId: options.releaseId,
      releaseSequence: options.releaseSequence,
      runtimeId: options.runtimeId,
      treeSha256: runtimeInventory.treeSha256,
      fileCount: runtimeInventory.fileCount,
      unpackedBytes: runtimeInventory.unpackedBytes,
      files,
    };
    const sbom = createSpdxSbom({
      releaseId: options.releaseId,
      productVersion: options.productVersion,
      runtimeId: options.runtimeId,
      createdAt: options.signedAt,
      files,
    });
    await writeJson(path.join(temporary, "runtime-manifest.json"), manifest);
    await writeJson(path.join(temporary, "inventory.json"), inventory);
    await writeJson(path.join(temporary, "sbom.spdx.json"), sbom);
    await writeFile(path.join(temporary, "runtime-tree.sha256"), `${runtimeInventory.treeSha256}\n`, { encoding: "utf8", flag: "wx" });
    const artifacts = await artifactDigests(temporary, requiredArtifacts);
    await rename(temporary, outputDir);
    committed = true;
    return { manifest, inventory, sbom, artifacts };
  } finally {
    if (!committed) await rm(temporary, { recursive: true, force: true });
  }
}

function createSpdxSbom({ releaseId, productVersion, runtimeId, createdAt, files }) {
  const namespaceDigest = createHash("sha256").update(`${releaseId}\0${runtimeId}`).digest("hex");
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `U-Claw-${releaseId}`,
    documentNamespace: `https://u-claw.org/spdx/${namespaceDigest}`,
    creationInfo: {
      created: new Date(createdAt).toISOString(),
      creators: ["Tool: uclaw-release-gate"],
    },
    packages: [{
      SPDXID: "SPDXRef-Package-UClaw-Runtime",
      name: "U-Claw Runtime",
      versionInfo: productVersion,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: true,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: "NOASSERTION",
      copyrightText: "NOASSERTION",
    }],
    files: files.map((file, index) => ({
      SPDXID: `SPDXRef-File-${index + 1}`,
      fileName: `./${file.path}`,
      checksums: [{ algorithm: "SHA256", checksumValue: file.sha256 }],
      licenseConcluded: "NOASSERTION",
      copyrightText: "NOASSERTION",
    })),
    relationships: [{
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: "SPDXRef-Package-UClaw-Runtime",
    }],
  };
}

export async function promoteReleaseArtifacts(sourceDir, destinationDir) {
  const source = path.resolve(sourceDir);
  const destination = path.resolve(destinationDir);
  await requireMissing(destination, "promotion destination already exists");
  const files = await listRegularFiles(source);
  const temporary = await mkdtemp(path.join(path.dirname(destination), ".release-promotion-"));
  let committed = false;
  try {
    for (const relative of files) {
      const target = path.join(temporary, ...relative.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(source, ...relative.split("/")), target);
    }
    await rename(temporary, destination);
    committed = true;
  } finally {
    if (!committed) await rm(temporary, { recursive: true, force: true });
  }
}

export async function verifyPromotionDigests({ candidate, acceptance, production }) {
  const candidateFiles = await listRegularFiles(candidate);
  const acceptanceFiles = await listRegularFiles(acceptance);
  const productionFiles = await listRegularFiles(production);
  const expectedList = JSON.stringify(candidateFiles);
  if (JSON.stringify(acceptanceFiles) !== expectedList || JSON.stringify(productionFiles) !== expectedList) {
    throw new Error("promotion artifact list mismatch");
  }
  const candidateDigests = await artifactDigests(candidate, candidateFiles);
  for (const [stage, directory] of [["acceptance", acceptance], ["production", production]]) {
    const stageDigests = await artifactDigests(directory, candidateFiles);
    for (const relative of candidateFiles) {
      if (JSON.stringify(stageDigests[relative]) !== JSON.stringify(candidateDigests[relative])) {
        throw new Error(`promotion digest mismatch for ${relative} at ${stage}`);
      }
    }
  }
  return candidateDigests;
}

export async function verifyCdnReadback(baseUrl, expectedArtifacts, options = {}) {
  const base = new URL(baseUrl);
  assertReleaseUrl(base, options.releaseId);
  const isLoopback = base.hostname === "127.0.0.1" || base.hostname === "localhost" || base.hostname === "::1";
  if (base.protocol !== "https:" && !isLoopback) throw new Error("CDN readback requires HTTPS");
  const fetchImpl = options.fetchImpl ?? fetch;
  const verified = {};
  for (const name of Object.keys(expectedArtifacts).sort()) {
    const expected = expectedArtifacts[name];
    validateDigestRecord(name, expected);
    const encoded = name.split("/").map(encodeURIComponent).join("/");
    const url = new URL(encoded, ensureTrailingSlash(base));
    let response;
    try {
      response = await fetchImpl(url, { redirect: "error", signal: options.signal });
    } catch (error) {
      throw new Error(`CDN readback failed for ${name}: ${error.message}`);
    }
    if (!response.ok) throw new Error(`CDN readback failed for ${name}: HTTP ${response.status}`);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of response.body) { hash.update(chunk); bytes += chunk.byteLength; }
    if (bytes !== expected.bytes) {
      throw new Error(`CDN readback failed for ${name}: byte length ${bytes} does not match ${expected.bytes}`);
    }
    const digest = hash.digest("hex");
    if (digest !== expected.sha256.toLowerCase()) {
      throw new Error(`CDN readback failed for ${name}: SHA-256 mismatch`);
    }
    verified[name] = { bytes, sha256: digest, url: url.href };
  }
  return verified;
}

export async function uploadReleaseArtifacts(baseUrl, sourceDir, expectedArtifacts, options = {}) {
  const base = new URL(baseUrl);
  assertReleaseUrl(base, options.releaseId);
  const isLoopback = base.hostname === "127.0.0.1" || base.hostname === "localhost" || base.hostname === "::1";
  if (base.protocol !== "https:" && !isLoopback) throw new Error("release upload requires HTTPS");
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = options.token;
  if (!token) throw new Error("release upload credential is required");
  validateArtifactSet(expectedArtifacts);
  const actual = await artifactDigests(sourceDir, Object.keys(expectedArtifacts).sort());
  if (!sameArtifactDigests(expectedArtifacts, actual)) throw new Error("release upload blocked: local artifact digests do not match build evidence");
  for (const name of Object.keys(expectedArtifacts).sort()) {
    const encoded = name.split("/").map(encodeURIComponent).join("/");
    const url = new URL(encoded, ensureTrailingSlash(base));
    const body = createReadStream(path.join(path.resolve(sourceDir), ...name.split("/")));
    let response;
    try {
      response = await fetchImpl(url, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-length": String(expectedArtifacts[name].bytes) },
        body,
        duplex: "half",
        redirect: "error",
        signal: options.signal,
      });
    } catch (error) {
      throw new Error(`release upload failed for ${name}: ${error.message}`);
    }
    if (!response.ok) throw new Error(`release upload failed for ${name}: HTTP ${response.status}`);
  }
  return actual;
}

export async function runFinalRuntimeSmoke({ repoRoot, runtimeDir, manifest, runner = defaultRunner }) {
  assertCommercialBuildInputs(repoRoot, [runtimeDir]);
  if (!Array.isArray(manifest.criticalFiles) || manifest.criticalFiles.length === 0) {
    throw new Error("final runtime smoke requires signed criticalFiles evidence");
  }
  for (const record of manifest.criticalFiles) {
    const criticalPath = path.resolve(runtimeDir, ...record.path.replaceAll("\\", "/").split("/"));
    const relativeCritical = path.relative(path.resolve(runtimeDir), criticalPath);
    if (relativeCritical.startsWith("..") || path.isAbsolute(relativeCritical)) throw new Error("final runtime smoke critical file escapes runtime");
    const criticalInfo = await lstat(criticalPath).catch(() => null);
    if (!criticalInfo?.isFile() || criticalInfo.isSymbolicLink() || criticalInfo.size !== record.size || await hashFile(criticalPath) !== record.sha256.toLowerCase()) {
      throw new Error(`final runtime smoke critical file mismatch: ${record.path}`);
    }
  }
  const executable = path.resolve(runtimeDir, ...manifest.entrypoint.replaceAll("\\", "/").split("/"));
  const relative = path.relative(path.resolve(runtimeDir), executable);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("final runtime smoke entrypoint escapes runtime");
  const info = await lstat(executable).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error("final runtime smoke entrypoint is not a regular file");
  const result = await runner(executable, ["--version"]);
  if (result.code !== 0) throw new Error(`final runtime smoke failed with code ${result.code}: ${singleLine(result.stderr)}`);
  if (!String(result.stdout).includes(manifest.electronVersion)) {
    throw new Error(`final runtime smoke failed: expected Electron ${manifest.electronVersion}`);
  }
  return {
    runtimeKind: "final",
    executable,
    command: [executable, "--version"],
    electronVersion: manifest.electronVersion,
  };
}

async function defaultRunner(file, args) {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { encoding: "utf8", windowsHide: true });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: Number.isInteger(error.code) ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
  }
}

export async function writePointerSwitchAuthorization(outputPath, evidence) {
  for (const stage of ["build", "smoke", "promotions", "upload", "cdnReadback"]) {
    if (!evidence?.[stage]) throw new Error(`pointer switch blocked: missing ${stage} evidence`);
  }
  if (evidence.smoke.runtimeKind !== "final") throw new Error("pointer switch blocked: smoke evidence is not final runtime");
  if (!Number.isSafeInteger(evidence.releaseSequence) || evidence.releaseSequence < 1) throw new Error("pointer switch blocked: invalid releaseSequence");
  if (!/^[a-f0-9]{40}$/u.test(evidence.commitSha ?? "")) throw new Error("pointer switch blocked: invalid commitSha");
  if (evidence.build.releaseId !== evidence.releaseId || evidence.build.releaseSequence !== evidence.releaseSequence) {
    throw new Error("pointer switch blocked: build release identity mismatch");
  }
  const stages = [evidence.build, evidence.smoke, evidence.promotions, evidence.upload, evidence.cdnReadback];
  const times = stages.map((stage) => Date.parse(stage.completedAt));
  if (times.some((time) => !Number.isFinite(time)) || times.some((time, index) => index > 0 && time < times[index - 1])) {
    throw new Error("pointer switch blocked: release evidence order is invalid");
  }
  const artifacts = evidence.build.artifacts;
  validateArtifactSet(artifacts);
  if (JSON.stringify(Object.keys(artifacts).sort()) !== JSON.stringify([...requiredArtifacts].sort())) {
    throw new Error("pointer switch blocked: required release artifact set is incomplete");
  }
  for (const stage of ["promotions", "upload", "cdnReadback"]) {
    if (!sameArtifactDigests(artifacts, evidence[stage].artifacts)) {
      throw new Error(`pointer switch blocked: ${stage} artifact digests do not match build`);
    }
  }
  const proof = {
    schemaVersion: 1,
    allowed: true,
    gate: "cdn-readback-complete",
    releaseId: evidence.releaseId,
    requiredReleaseSequence: evidence.releaseSequence,
    commitSha: evidence.commitSha.toLowerCase(),
    artifacts,
    evidence: {
      buildCompletedAt: evidence.build.completedAt,
      finalRuntimeSmokeCompletedAt: evidence.smoke.completedAt,
      promotionsCompletedAt: evidence.promotions.completedAt,
      uploadCompletedAt: evidence.upload.completedAt,
      cdnReadbackCompletedAt: evidence.cdnReadback.completedAt,
    },
  };
  await writeJsonExclusive(outputPath, proof);
  return proof;
}

function validateArtifactSet(artifacts) {
  if (!artifacts || Object.keys(artifacts).length === 0) throw new Error("pointer switch blocked: build artifacts are missing");
  for (const [name, record] of Object.entries(artifacts)) validateDigestRecord(name, record);
}

function validateDigestRecord(name, record) {
  const segments = name.split("/");
  const safeName = name.length > 0 && !name.includes("\\") && !path.isAbsolute(name) && segments.every((segment) => segment && segment !== "." && segment !== "..");
  if (!safeName || !Number.isSafeInteger(record?.bytes) || record.bytes < 0 || !/^[a-f0-9]{64}$/iu.test(record?.sha256 ?? "")) {
    throw new Error(`invalid artifact digest record: ${name}`);
  }
}

function sameArtifactDigests(left, right) {
  if (!left || !right) return false;
  const names = Object.keys(left).sort();
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(right).sort())) return false;
  return names.every((name) => left[name].bytes === right[name].bytes && left[name].sha256.toLowerCase() === right[name].sha256.toLowerCase());
}

async function listRegularFiles(root) {
  const base = path.resolve(root);
  const files = [];
  async function visit(relativeDirectory) {
    const directory = relativeDirectory ? path.join(base, ...relativeDirectory.split("/")) : base;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`release artifact symlink is forbidden: ${relative}`);
      if (info.isDirectory()) await visit(relative);
      else if (info.isFile()) files.push(relative);
      else throw new Error(`unsupported release artifact: ${relative}`);
    }
  }
  await visit("");
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

async function artifactDigests(directory, files) {
  const result = {};
  for (const relative of files) {
    const absolute = path.join(path.resolve(directory), ...relative.split("/"));
    const info = await lstat(absolute);
    result[relative] = { bytes: info.size, sha256: await hashFile(absolute) };
  }
  return result;
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function writeJsonExclusive(file, value) {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeJson(path.resolve(file), value);
}

async function requireMissing(target, message) {
  try {
    await lstat(target);
    throw new Error(message);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function ensureTrailingSlash(url) {
  return new URL(url.href.endsWith("/") ? url.href : `${url.href}/`);
}

function assertReleaseUrl(url, releaseId) {
  if (!releaseId) return;
  const finalSegment = decodeURIComponent(url.pathname.replace(/\/+$/u, "").split("/").at(-1) ?? "");
  if (finalSegment !== releaseId) throw new Error(`release URL does not end with release ID ${releaseId}`);
}

function singleLine(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, 300);
}
