import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertCommercialBuildInputs,
  buildReleaseArtifacts,
  promoteReleaseArtifacts,
  runFinalRuntimeSmoke,
  uploadReleaseArtifacts,
  verifyCdnReadback,
  verifyPromotionDigests,
  writePointerSwitchAuthorization,
} from "../../packaging/release-gate.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function fixtureFinalRuntime(root) {
  const runtime = path.join(root, "product", "dist", "windows-runtime");
  await mkdir(path.join(runtime, "electron"), { recursive: true });
  await mkdir(path.join(runtime, "resources"), { recursive: true });
  await writeFile(path.join(runtime, "electron", "electron.exe"), "final-electron");
  await writeFile(path.join(runtime, "resources", "app.asar"), "final-app");
  return runtime;
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
  const keys = generateKeyPairSync("ed25519");
  const result = await buildReleaseArtifacts({
    repoRoot: root,
    runtimeDir: runtime,
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
  assert.equal(inventory.files.length, 2);
  const sbom = JSON.parse(await readFile(path.join(output, "sbom.spdx.json"), "utf8"));
  assert.equal(sbom.spdxVersion, "SPDX-2.3");
  assert.equal(sbom.files.length, 2);
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
    "runtime.pkg",
    "runtime-manifest.json",
    "inventory.json",
    "sbom.spdx.json",
    "runtime-tree.sha256",
  ].map((name) => [name, { bytes: 7, sha256: sha256(name) }]));
  const complete = {
    releaseId: "release-42",
    releaseSequence: 42,
    commitSha: "a".repeat(40),
    build: { releaseId: "release-42", releaseSequence: 42, completedAt: "2026-08-21T00:00:00.000Z", artifacts: artifact },
    smoke: { runtimeKind: "final", completedAt: "2026-08-21T00:01:00.000Z" },
    promotions: { completedAt: "2026-08-21T00:02:00.000Z", artifacts: artifact },
    upload: { completedAt: "2026-08-21T00:03:00.000Z", artifacts: artifact },
    cdnReadback: { completedAt: "2026-08-21T00:04:00.000Z", artifacts: artifact },
  };
  for (const missing of ["build", "smoke", "promotions", "upload", "cdnReadback"]) {
    const evidence = structuredClone(complete);
    delete evidence[missing];
    await assert.rejects(writePointerSwitchAuthorization(proofPath, evidence), new RegExp(missing, "i"));
  }
  const proof = await writePointerSwitchAuthorization(proofPath, complete);
  assert.equal(proof.allowed, true);
  assert.equal(proof.requiredReleaseSequence, 42);
  assert.equal(proof.gate, "cdn-readback-complete");
});

test("final runtime smoke refuses fixture paths and reports command failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-release-smoke-"));
  const finalRuntime = await fixtureFinalRuntime(root);
  const manifest = {
    entrypoint: "electron/electron.exe",
    electronVersion: "40.10.6",
    criticalFiles: [
      { path: "electron/electron.exe", size: 14, sha256: sha256("final-electron") },
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
  await assert.rejects(runFinalRuntimeSmoke({ repoRoot: root, runtimeDir: finalRuntime, manifest, runner: fakeRunner }), /critical file mismatch/i);
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
