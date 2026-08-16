import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildOfflineUpdater, extractOfflinePayload } from "../../packaging/build-offline-updater.mjs";
import { buildUpdateFeed, releaseSigningPayload } from "../../packaging/build-update-feed.mjs";
import { signRuntimeManifest } from "../../scripts/runtime-manifest.mjs";

const runtimeKeys = generateKeyPairSync("ed25519");
const releaseKeys = generateKeyPairSync("ed25519");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function signedRuntimeManifest(runtimeBytes, overrides = {}) {
  const manifest = {
    schemaVersion: 1,
    productVersion: "1.2.3",
    nodeVersion: "24.15.0",
    electronVersion: "40.10.6",
    runtimeVersion: "2026.7.1-2",
    runtimeId: "openclaw-2026.7.1-2-win-x64",
    targetPlatform: "win32",
    targetArch: "x64",
    runtimeArchive: "runtime.pkg",
    runtimeSha256: sha256(runtimeBytes),
    runtimeTreeSha256: "a".repeat(64),
    runtimeBytes: runtimeBytes.length,
    unpackedBytes: 100,
    fileCount: 2,
    entrypoint: "electron/electron.exe",
    entryArgs: ["resources/app.asar"],
    ...overrides,
  };
  return signRuntimeManifest(manifest, {
    keyId: "runtime-key-1",
    privateKey: runtimeKeys.privateKey,
    signedAt: "2026-08-14T00:00:00.000Z",
    expiresAt: "2027-08-14T00:00:00.000Z",
    sequence: overrides.sequence ?? 42,
  });
}

async function fixture(overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-update-feed-"));
  const runtime = Buffer.from("exact-runtime-package-bytes");
  const runtimePath = path.join(root, "runtime.pkg");
  const updaterPath = path.join(root, "generic-updater.exe");
  await writeFile(runtimePath, runtime);
  await writeFile(updaterPath, "MZ-generic-updater", { mode: 0o700 });
  return {
    root,
    runtime,
    runtimePath,
    updaterPath,
    feedDir: path.join(root, "releases"),
    manifest: signedRuntimeManifest(runtime),
    ...overrides,
  };
}

function feedOptions(value, overrides = {}) {
  return {
    runtimePackagePath: value.runtimePath,
    runtimeManifest: value.manifest,
    outputDir: value.feedDir,
    releaseId: "uclaw-1.2.3-42",
	version: "1.2.3",
    notes: ["Security update", "Restart required"],
    mandatory: false,
    publishedAt: "2026-08-14T00:00:00.000Z",
    expiresAt: "2027-08-14T00:00:00.000Z",
    sequence: 42,
    keyId: "release-key-1",
    privateKey: releaseKeys.privateKey,
    publicKey: releaseKeys.publicKey,
    trustedRuntimePublicKeys: { "runtime-key-1": runtimeKeys.publicKey },
    ...overrides,
  };
}

test("builds one signed stable feed and byte-identical offline payload", async () => {
  const value = await fixture();
  const feed = await buildUpdateFeed(feedOptions(value));
  const feedPath = path.join(value.feedDir, "stable.json");
  const publishedRuntime = path.join(value.feedDir, "packages", feed.id, "runtime.pkg");
  const feedBytes = await readFile(feedPath);
  const runtimeBytes = await readFile(publishedRuntime);

  assert.equal(feed.channel, "stable");
  assert.equal(feed.package.sha256, sha256(value.runtime));
  assert.equal(feed.package.bytes, value.runtime.length);
  assert.equal(verify(null, releaseSigningPayload(feed), releaseKeys.publicKey, Buffer.from(feed.signature.value, "base64")), true);
  assert.deepEqual(runtimeBytes, value.runtime);

  const offlinePath = path.join(value.root, "U-Claw-Update-1.2.3.exe");
  await buildOfflineUpdater({
    updaterPath: value.updaterPath,
    feedPath,
    runtimePackagePath: publishedRuntime,
    outputFile: offlinePath,
  });
  const extracted = await extractOfflinePayload(offlinePath);
  assert.deepEqual(extracted.manifest, feedBytes);
  assert.deepEqual(extracted.runtime, runtimeBytes);
  assert.equal((await stat(offlinePath)).mode & 0o100, 0o100);
});

test("rejects existing output, missing key, invalid self-verification, and non-positive sequence", async () => {
  const existing = await fixture();
  await mkdir(existing.feedDir);
  await assert.rejects(buildUpdateFeed(feedOptions(existing)), /already exists/i);

  const missingKey = await fixture();
  await assert.rejects(buildUpdateFeed(feedOptions(missingKey, { privateKey: undefined })), /private key/i);

  const wrongPublic = generateKeyPairSync("ed25519").publicKey;
  const badVerification = await fixture();
  await assert.rejects(buildUpdateFeed(feedOptions(badVerification, { publicKey: wrongPublic })), /self-verification/i);

  const badSequence = await fixture();
  await assert.rejects(buildUpdateFeed(feedOptions(badSequence, { sequence: 0 })), /sequence/i);
});

test("rejects runtime and signed manifest mismatches", async () => {
  const tamperedPackage = await fixture();
  await writeFile(tamperedPackage.runtimePath, "tampered");
  await assert.rejects(buildUpdateFeed(feedOptions(tamperedPackage)), /runtime package/i);

  const inconsistentManifest = await fixture();
  inconsistentManifest.manifest = signedRuntimeManifest(inconsistentManifest.runtime, { productVersion: "9.9.9" });
  await assert.rejects(buildUpdateFeed(feedOptions(inconsistentManifest)), /version|manifest/i);
});

test("offline builder rejects mismatched bytes and existing output", async () => {
  const value = await fixture();
  const feed = await buildUpdateFeed(feedOptions(value));
  const feedPath = path.join(value.feedDir, "stable.json");
  const publishedRuntime = path.join(value.feedDir, "packages", feed.id, "runtime.pkg");
  await writeFile(publishedRuntime, "tampered");
  await assert.rejects(buildOfflineUpdater({
    updaterPath: value.updaterPath,
    feedPath,
    runtimePackagePath: publishedRuntime,
    outputFile: path.join(value.root, "offline.exe"),
  }), /runtime package/i);

  const second = await fixture();
  const secondFeed = await buildUpdateFeed(feedOptions(second));
  const output = path.join(second.root, "existing.exe");
  await writeFile(output, "keep");
  await assert.rejects(buildOfflineUpdater({
    updaterPath: second.updaterPath,
    feedPath: path.join(second.feedDir, "stable.json"),
    runtimePackagePath: path.join(second.feedDir, "packages", secondFeed.id, "runtime.pkg"),
    outputFile: output,
  }), /already exists/i);
  assert.equal(await readFile(output, "utf8"), "keep");
});

test("release signature binds every unsigned feed field", async () => {
  const value = await fixture();
  const feed = await buildUpdateFeed(feedOptions(value));
  const tampered = structuredClone(feed);
  tampered.notes = ["different"];
  assert.equal(verify(null, releaseSigningPayload(tampered), releaseKeys.publicKey, Buffer.from(feed.signature.value, "base64")), false);

  const resigned = { ...tampered, signature: { ...tampered.signature, value: "" } };
  const { signature: ignored, ...unsigned } = resigned;
  resigned.signature.value = sign(null, Buffer.from(JSON.stringify(unsigned)), releaseKeys.privateKey).toString("base64");
  assert.equal(verify(null, releaseSigningPayload(resigned), releaseKeys.publicKey, Buffer.from(resigned.signature.value, "base64")), true);
});

test("package scripts and Windows workflow run update packaging gates", async () => {
  const packageJSON = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(packageJSON.scripts["build:update-feed"], "node packaging/build-update-feed.mjs");
  assert.equal(packageJSON.scripts["build:offline-updater"], "node packaging/build-offline-updater.mjs");
  assert.equal(packageJSON.scripts["test:update-packaging"], "node --test tests/packaging/update-feed.test.mjs");

  const workflow = await readFile(new URL("../../../.github/workflows/portable-launcher.yml", import.meta.url), "utf8");
  assert.match(workflow, /npm run test:update-packaging --prefix product/u);
  assert.match(workflow, /product\/offline-updater\/\*\*/u);
  assert.match(workflow, /product\/tests\/packaging\/update-feed\.test\.mjs/u);
});
