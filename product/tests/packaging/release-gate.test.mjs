import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertCommercialBuildInputs,
  buildReleaseArtifacts,
  promoteReleaseArtifacts,
  pointerSwitchAuthorizationSigningPayload,
  runFinalRuntimeSmoke,
  uploadReleaseArtifacts,
  verifyCdnReadback,
  verifyPromotionDigests,
  writePointerSwitchAuthorization,
} from "../../packaging/release-gate.mjs";
import { createRuntimeProvenance } from "../../packaging/final-windows-runtime.mjs";
import { inventoryRuntime } from "../../packaging/build-runtime.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function peExecutable() {
  const value = Buffer.alloc(512);
  value.write("MZ", 0, "ascii");
  value.writeUInt32LE(0x80, 0x3c);
  value.write("PE\0\0", 0x80, "binary");
  value.writeUInt16LE(0x8664, 0x84);
  return value;
}

async function fixtureFinalRuntime(root) {
  const runtime = path.join(root, "product", "dist", "windows-runtime");
  await mkdir(path.join(runtime, "electron"), { recursive: true });
  await mkdir(path.join(runtime, "resources"), { recursive: true });
  await mkdir(path.join(runtime, "node_modules", "openclaw"), { recursive: true });
  await writeFile(path.join(runtime, "electron", "electron.exe"), peExecutable());
  await writeFile(path.join(runtime, "resources", "app.asar"), "final-app");
  await writeFile(path.join(runtime, "node_modules", "openclaw", "openclaw.mjs"), "export {};");
  await writeFile(path.join(runtime, "node_modules", "openclaw", "package.json"), JSON.stringify({ name: "openclaw", version: "2026.7.1-2" }));
  const inventory = await inventoryRuntime(runtime);
  const provenance = createRuntimeProvenance({
    commitSha: "a".repeat(40),
    treeSha256: inventory.treeSha256,
    fileCount: inventory.fileCount,
    unpackedBytes: inventory.unpackedBytes,
    host: { os: "win32", arch: "x64", runner: "fixture" },
    toolVersions: { node: "24.15.0", npm: "11.12.1", electron: "40.10.6", openclaw: "2026.7.1-2" },
  });
  await writeFile(path.join(path.dirname(runtime), "runtime-provenance.json"), `${JSON.stringify(provenance)}\n`);
  return runtime;
}

async function fixtureLauncher(root) {
  const launcher = path.join(root, "product", "dist", "launcher", "U-Claw.exe");
  await mkdir(path.dirname(launcher), { recursive: true });
  await writeFile(launcher, "official-launcher");
  return launcher;
}

test("commercial release input rejects archived and fixture roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-release-input-"));
  const valid = path.join(root, "product", "dist", "windows-runtime");
  await mkdir(valid, { recursive: true });
  assert.doesNotThrow(() => assertCommercialBuildInputs(root, [valid]));
  for (const invalid of [
    path.join(root, "portable"),
    path.join(root, "u-claw-app"),
    path.join(root, "product", "tests", "fixtures", "runtime"),
    path.join(root, "outside"),
  ]) {
    assert.throws(() => assertCommercialBuildInputs(root, [invalid]), /commercial build input/i);
  }
});

test("build emits runtime package, inventory, SPDX SBOM, tree digest, and signed frozen manifest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-release-build-"));
  const runtime = await fixtureFinalRuntime(root);
  const output = path.join(root, "candidate");
  const launcher = await fixtureLauncher(root);
  const keys = generateKeyPairSync("ed25519");
  const result = await buildReleaseArtifacts({
    repoRoot: root,
    runtimeDir: runtime,
    launcherPath: launcher,
    verifyLauncherPolicyConfig: async () => {},
    outputDir: output,
    productVersion: "0.1.0",
    releaseId: "release-42",
    releaseSequence: 42,
    runtimeId: "openclaw-2026.7.1-2-win-x64",
    entrypoint: "electron/electron.exe",
    entryArgs: ["resources/app.asar"],
    keyId: "fixture-release-key",
    privateKey: keys.privateKey,
    signedAt: "2026-08-21T00:00:00.000Z",
    expiresAt: "2027-08-21T00:00:00.000Z",
  });

  assert.deepEqual(Object.keys(result.artifacts).sort(), [
    "U-Claw.exe",
    "inventory.json",
    "runtime-manifest.json",
    "runtime-tree.sha256",
    "runtime.pkg",
    "sbom.spdx.json",
  ]);
  const manifest = JSON.parse(await readFile(path.join(output, "runtime-manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.signature.sequence, 42);
  assert.equal(manifest.runtimeTreeSha256, (await readFile(path.join(output, "runtime-tree.sha256"), "utf8")).trim());
  const inventory = JSON.parse(await readFile(path.join(output, "inventory.json"), "utf8"));
  assert.equal(inventory.files.length, 4);
  const sbom = JSON.parse(await readFile(path.join(output, "sbom.spdx.json"), "utf8"));
  assert.equal(sbom.spdxVersion, "SPDX-2.3");
  assert.equal(sbom.files.length, 4);
  assert.equal(await readFile(path.join(output, "U-Claw.exe"), "utf8"), "official-launcher");
});

test("build blocks an official Bootstrap whose embedded release policy config fails verification", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-release-launcher-policy-"));
  const runtime = await fixtureFinalRuntime(root);
  const launcher = await fixtureLauncher(root);
  const keys = generateKeyPairSync("ed25519");
  let verified = false;
  await assert.rejects(buildReleaseArtifacts({
    repoRoot: root,
    runtimeDir: runtime,
    launcherPath: launcher,
    outputDir: path.join(root, "candidate"),
    productVersion: "0.1.0",
    releaseId: "release-42",
    releaseSequence: 42,
    runtimeId: "openclaw-2026.7.1-2-win-x64",
    entrypoint: "electron/electron.exe",
    entryArgs: ["resources/app.asar"],
    keyId: "fixture-release-key",
    privateKey: keys.privateKey,
    signedAt: "2026-08-21T00:00:00.000Z",
    expiresAt: "2027-08-21T00:00:00.000Z",
    verifyLauncherPolicyConfig: async () => {
      verified = true;
      throw new Error("missing release policy endpoint");
    },
  }), /missing release policy endpoint/i);
  assert.equal(verified, true);
});

test("candidate, acceptance, and production are byte-identical promotions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-release-promote-"));
  const candidate = path.join(root, "candidate");
  const acceptance = path.join(root, "acceptance");
  const production = path.join(root, "production");
  await mkdir(candidate);
  await writeFile(path.join(candidate, "runtime.pkg"), "same-runtime");
  await writeFile(path.join(candidate, "runtime-manifest.json"), "same-manifest");

  await promoteReleaseArtifacts(candidate, acceptance);
  await promoteReleaseArtifacts(acceptance, production);
  const evidence = await verifyPromotionDigests({ candidate, acceptance, production });
  assert.equal(evidence["runtime.pkg"].sha256, sha256("same-runtime"));

  await writeFile(path.join(production, "runtime.pkg"), "changed-runtime");
  await assert.rejects(
    verifyPromotionDigests({ candidate, acceptance, production }),
    /promotion digest mismatch.*runtime\.pkg/i,
  );
});

test("CDN readback verifies every production byte and blocks mismatch", async (t) => {
  const bodies = new Map([
    ["/releases/release-42/runtime.pkg", Buffer.from("runtime")],
    ["/releases/release-42/runtime-manifest.json", Buffer.from("manifest")],
  ]);
  const server = createServer((request, response) => {
    const body = bodies.get(request.url);
    if (!body) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-length": body.length });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}/releases/release-42/`;
  const expected = {
    "runtime.pkg": { bytes: 7, sha256: sha256("runtime") },
    "runtime-manifest.json": { bytes: 8, sha256: sha256("manifest") },
  };
  const verified = await verifyCdnReadback(baseUrl, expected);
  assert.deepEqual(Object.keys(verified).sort(), Object.keys(expected).sort());

  await assert.rejects(
    verifyCdnReadback(baseUrl, { ...expected, "runtime.pkg": { bytes: 7, sha256: "0".repeat(64) } }),
    /CDN readback.*runtime\.pkg.*SHA-256/i,
  );
  await assert.rejects(verifyCdnReadback(baseUrl, expected, { releaseId: "release-43" }), /release URL.*release-43/i);
});

test("upload sends every verified production artifact before readback", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-release-upload-"));
  await writeFile(path.join(root, "runtime.pkg"), "runtime");
  const received = new Map();
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received.set(request.url, Buffer.concat(chunks));
      response.writeHead(request.headers.authorization === "Bearer fixture-upload-token" ? 201 : 403).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}/releases/release-42/`;
  const artifacts = { "runtime.pkg": { bytes: 7, sha256: sha256("runtime") } };
  assert.deepEqual(await uploadReleaseArtifacts(baseUrl, root, artifacts, { token: "fixture-upload-token" }), artifacts);
  assert.equal(received.get("/releases/release-42/runtime.pkg").toString(), "runtime");
  await assert.rejects(uploadReleaseArtifacts(baseUrl, root, artifacts, { token: "wrong-token" }), /upload failed.*HTTP 403/i);
  await assert.rejects(uploadReleaseArtifacts(baseUrl, root, artifacts, { token: "fixture-upload-token", releaseId: "release-43" }), /release URL.*release-43/i);
});

test("pointer authorization requires build, final-runtime smoke, promotion, upload, and CDN readback", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-release-proof-"));
  const proofPath = path.join(root, "pointer-switch-authorization.json");
  const artifact = Object.fromEntries([
    "U-Claw.exe",
    "runtime.pkg",
    "runtime-manifest.json",
    "inventory.json",
    "sbom.spdx.json",
    "runtime-tree.sha256",
  ].map((name) => [name, { bytes: 7, sha256: sha256(name) }]));
  const cdnArtifact = Object.fromEntries(Object.entries(artifact).map(([name, record]) => [name, {
    ...record,
    url: `https://cdn.example.test/releases/release-42/${name}`,
  }]));
  const complete = {
    releaseId: "release-42",
    releaseSequence: 42,
    commitSha: "a".repeat(40),
    build: { releaseId: "release-42", releaseSequence: 42, completedAt: "2026-08-21T00:00:00.000Z", artifacts: artifact },
    smoke: { runtimeKind: "final", completedAt: "2026-08-21T00:01:00.000Z" },
    promotions: { completedAt: "2026-08-21T00:02:00.000Z", artifacts: artifact },
    upload: { completedAt: "2026-08-21T00:03:00.000Z", artifacts: artifact },
    cdnReadback: { completedAt: "2026-08-21T00:04:00.000Z", artifacts: cdnArtifact },
  };
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signing = { keyId: "release-gate-2026-01", privateKey, clock: () => new Date("2026-08-21T00:05:00.000Z") };
  for (const missing of ["build", "smoke", "promotions", "upload", "cdnReadback"]) {
    const evidence = structuredClone(complete);
    delete evidence[missing];
    await assert.rejects(writePointerSwitchAuthorization(proofPath, evidence, signing), new RegExp(missing, "i"));
  }
  await assert.rejects(writePointerSwitchAuthorization(proofPath, complete), /authorization signing key/i);
  const proof = await writePointerSwitchAuthorization(proofPath, complete, signing);
  assert.equal(proof.allowed, true);
  assert.equal(proof.requiredReleaseSequence, 42);
  assert.equal(proof.gate, "cdn-readback-complete");
  assert.equal(proof.manifestUrl, cdnArtifact["runtime-manifest.json"].url);
  assert.equal(proof.manifestSha256, artifact["runtime-manifest.json"].sha256);
  assert.equal(proof.runtimeSha256, artifact["runtime.pkg"].sha256);
  assert.equal(proof.signature.keyId, signing.keyId);
  assert.equal(proof.expiresAt, "2026-08-21T00:15:00.000Z");
  assert.equal(verify(null, pointerSwitchAuthorizationSigningPayload(proof), publicKey, Buffer.from(proof.signature.value, "base64")), true);
});

test("final runtime smoke refuses fixture paths and reports command failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-release-smoke-"));
  const finalRuntime = await fixtureFinalRuntime(root);
  const manifest = {
    entrypoint: "electron/electron.exe",
    electronVersion: "40.10.6",
    criticalFiles: [
      { path: "electron/electron.exe", size: 512, sha256: createHash("sha256").update(peExecutable()).digest("hex") },
      { path: "resources/app.asar", size: 9, sha256: sha256("final-app") },
    ],
  };
  const fakeRunner = async (file, args) => ({ file, args, code: 0, stdout: "v40.10.6\n", stderr: "" });
  const result = await runFinalRuntimeSmoke({
    repoRoot: root,
    runtimeDir: finalRuntime,
    manifest,
    runner: fakeRunner,
  });
  assert.equal(result.runtimeKind, "final");
  assert.match(result.executable, /product[/\\]dist[/\\]windows-runtime/);

  await writeFile(path.join(finalRuntime, "resources", "app.asar"), "tampered");
  await assert.rejects(runFinalRuntimeSmoke({ repoRoot: root, runtimeDir: finalRuntime, manifest, runner: fakeRunner }), /artifact hash|critical file mismatch/i);
  await writeFile(path.join(finalRuntime, "resources", "app.asar"), "final-app");

  await assert.rejects(runFinalRuntimeSmoke({
    repoRoot: root,
    runtimeDir: path.join(root, "product", "tests", "fixtures", "runtime"),
    manifest,
    runner: fakeRunner,
  }), /commercial build input|fixture/i);

  await assert.rejects(runFinalRuntimeSmoke({
    repoRoot: root,
    runtimeDir: finalRuntime,
    manifest,
    runner: async () => ({ code: 9, stdout: "", stderr: "failed" }),
  }), /final runtime smoke failed.*code 9/i);
});
