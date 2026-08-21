import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildFinalWindowsRuntime,
  createRuntimeProvenance,
  validateFinalWindowsRuntime,
  validateRuntimeProvenance,
} from "../../packaging/final-windows-runtime.mjs";
import { inventoryRuntime } from "../../packaging/build-runtime.mjs";

function peExecutable() {
  const value = Buffer.alloc(512);
  value.write("MZ", 0, "ascii");
  value.writeUInt32LE(0x80, 0x3c);
  value.write("PE\0\0", 0x80, "binary");
  value.writeUInt16LE(0x8664, 0x84);
  return value;
}

async function fixtureRuntime() {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-final-runtime-"));
  const runtimeDir = path.join(root, "windows-runtime");
  await mkdir(path.join(runtimeDir, "electron"), { recursive: true });
  await mkdir(path.join(runtimeDir, "resources"), { recursive: true });
  await writeFile(path.join(runtimeDir, "electron", "electron.exe"), peExecutable());
  await writeFile(path.join(runtimeDir, "resources", "app.asar"), "asar");
  await mkdir(path.join(runtimeDir, "node_modules", "openclaw"), { recursive: true });
  await writeFile(path.join(runtimeDir, "node_modules", "openclaw", "openclaw.mjs"), "export {};");
  await writeFile(path.join(runtimeDir, "node_modules", "openclaw", "package.json"), JSON.stringify({ name: "openclaw", version: "2026.7.1-2" }));
  const inventory = await inventoryRuntime(runtimeDir);
  const provenance = createRuntimeProvenance({
    commitSha: "a".repeat(40),
    treeSha256: inventory.treeSha256,
    fileCount: inventory.fileCount,
    unpackedBytes: inventory.unpackedBytes,
    host: { os: "win32", arch: "x64", runner: "windows-2022" },
    toolVersions: { node: "24.15.0", npm: "11.12.1", electron: "40.10.6", openclaw: "2026.7.1-2" },
  });
  const provenancePath = path.join(root, "runtime-provenance.json");
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  return { root, runtimeDir, provenance, provenancePath };
}

test("runtime provenance schema accepts final Windows build evidence", async () => {
  const fixture = await fixtureRuntime();
  const schema = JSON.parse(await readFile(new URL("../../packaging/runtime-provenance.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.runtimeKind.const, "final");
  assert.deepEqual(schema.required, ["schemaVersion", "runtimeKind", "commitSha", "buildHost", "toolVersions", "artifact"]);
  assert.equal(validateRuntimeProvenance(fixture.provenance), fixture.provenance);
  await assert.doesNotReject(validateFinalWindowsRuntime({ runtimeDir: fixture.runtimeDir, provenancePath: fixture.provenancePath, expectedCommitSha: "a".repeat(40) }));
});

test("official builder refuses non-Windows hosts", async () => {
  await assert.rejects(buildFinalWindowsRuntime({
    repoRoot: "/not-used",
    outputDir: "/not-used/output",
    commitSha: "a".repeat(40),
    platform: "darwin",
    arch: "arm64",
  }), /must be built on Windows x64/i);
});

test("final runtime rejects non-final provenance and missing provenance", async () => {
  const fixture = await fixtureRuntime();
  await writeFile(fixture.provenancePath, `${JSON.stringify({ ...fixture.provenance, runtimeKind: "diagnostic" })}\n`);
  await assert.rejects(validateFinalWindowsRuntime({ runtimeDir: fixture.runtimeDir, provenancePath: fixture.provenancePath }), /runtimeKind.*final/i);
  await rm(fixture.provenancePath);
  await assert.rejects(validateFinalWindowsRuntime({ runtimeDir: fixture.runtimeDir, provenancePath: fixture.provenancePath }), /provenance/i);
});

test("final runtime rejects macOS Electron and missing app.asar", async () => {
  const fixture = await fixtureRuntime();
  const macho = Buffer.from("cffaedfe00000000", "hex");
  await writeFile(path.join(fixture.runtimeDir, "electron", "electron.exe"), macho);
  await assert.rejects(validateFinalWindowsRuntime({ runtimeDir: fixture.runtimeDir, provenancePath: fixture.provenancePath }), /Mach-O|Windows PE/i);

  const fresh = await fixtureRuntime();
  await rm(path.join(fresh.runtimeDir, "resources", "app.asar"));
  await assert.rejects(validateFinalWindowsRuntime({ runtimeDir: fresh.runtimeDir, provenancePath: fresh.provenancePath }), /app\.asar/i);
});

test("final runtime rejects provenance artifact hash mismatch", async () => {
  const fixture = await fixtureRuntime();
  await writeFile(path.join(fixture.runtimeDir, "node_modules", "openclaw", "extra.js"), createHash("sha256").update("changed").digest("hex"));
  await assert.rejects(validateFinalWindowsRuntime({ runtimeDir: fixture.runtimeDir, provenancePath: fixture.provenancePath }), /artifact hash|treeSha256/i);
});
