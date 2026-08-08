import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => readFile(path.join(here, name), "utf8");

const requiredScripts = [
  "first-launch.ps1",
  "second-launch.ps1",
  "portable-data-audit.ps1",
  "process-cleanup.ps1",
  "phase1-acceptance.ps1",
];

test("P1-T23 ships every acceptance entry point", async () => {
  for (const script of requiredScripts) {
    assert.ok((await read(script)).includes("Set-StrictMode -Version Latest"), script);
  }
});

test("orchestrator rejects simulated drives by default and records every hard gate", async () => {
  const source = await read("phase1-acceptance.ps1");
  assert.match(source, /AllowSimulatedDrive/);
  assert.match(source, /PHYSICAL_USB_REQUIRED/);
  assert.match(source, /Get-CimInstance\s+-ClassName\s+Win32_DiskDrive/);
  for (const gate of [
    "windows-10",
    "windows-11",
    "standard-user",
    "defender-enabled",
    "physical-usb",
    "two-machine-continuity",
    "usb-removal",
    "host-residue",
  ]) {
    assert.ok(source.includes(gate), gate);
  }
});

test("evidence schema requires environment, device, hashes, cases, blockers and timestamps", async () => {
  const schema = JSON.parse(await read("phase1-acceptance.schema.json"));
  assert.equal(schema.additionalProperties, false);
  for (const key of [
    "schemaVersion",
    "runId",
    "startedAtUtc",
    "completedAtUtc",
    "status",
    "environment",
    "device",
    "artifacts",
    "cases",
    "blockers",
  ]) {
    assert.ok(schema.required.includes(key), key);
  }
  assert.equal(schema.properties.status.enum.includes("blocked"), true);
  assert.equal(schema.properties.device.required.includes("physicalUsbVerified"), true);
  assert.equal(schema.$defs.artifact.required.includes("sha256"), true);
});

test("portable audit has an explicit host scan and never serializes secret contents", async () => {
  const source = await read("portable-data-audit.ps1");
  assert.match(source, /USERPROFILE/);
  assert.match(source, /LOCALAPPDATA/);
  assert.match(source, /APPDATA/);
  assert.match(source, /TEMP/);
  assert.match(source, /sensitiveRuntimePattern/);
  assert.match(source, /Get-FileHash/);
  assert.doesNotMatch(source, /Get-Content\s+[^\r\n]*(key|token|session)/i);
});

test("README labels real Windows hardware gates as unresolved by hosted automation", async () => {
  const source = await read("README-P1-T23.md");
  assert.match(source, /Windows 10/);
  assert.match(source, /Windows 11/);
  assert.match(source, /physical USB/i);
  assert.match(source, /blocked/i);
  assert.match(source, /Hosted Runner/);
});

test("the canonical checklist contains all 44 base and phase-one requirement ids", async () => {
  const checklist = JSON.parse(await read("phase1-requirements.json"));
  assert.equal(checklist.schemaVersion, 1);
  assert.equal(checklist.requirements.length, 44);
  assert.equal(new Set(checklist.requirements.map(({ id }) => id)).size, 44);
  assert.deepEqual(
    checklist.requirements.reduce((counts, item) => ({ ...counts, [item.phase]: (counts[item.phase] ?? 0) + 1 }), {}),
    { base: 6, "phase-one": 38 },
  );
  const source = await read("phase1-acceptance.ps1");
  assert.match(source, /phase1-requirements\.json/);
  assert.match(source, /REQUIREMENT_EVIDENCE_MISSING/);
});

test("the case fixture is blocked by default and contains no secret payload fields", async () => {
  const fixture = JSON.parse(await read("fixtures/p1-t23-case.template.json"));
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.status, "blocked");
  assert.ok(fixture.blockers.length > 0);
  assert.deepEqual(Object.keys(fixture).sort(), [
    "artifacts", "assertions", "blockers", "caseId", "completedAtUtc", "schemaVersion", "startedAtUtc", "status",
  ]);
});

test("process cleanup does not classify its own PowerShell host as product residue", async () => {
  const source = await read("process-cleanup.ps1");
  assert.match(source, /ProcessId\s+-ne\s+\$PID/);
});

test("all three release artifacts are mandatory evidence", async () => {
  const schema = JSON.parse(await read("phase1-acceptance.schema.json"));
  assert.equal(schema.properties.artifacts.minItems, 3);
  const source = await read("phase1-acceptance.ps1");
  assert.match(source, /RELEASE_ARTIFACT_MISSING/);
  assert.match(source, /release-artifacts/);
});

test("machine B requires the peer to have the complete repeated suite", async () => {
  const source = await read("phase1-acceptance.ps1");
  assert.match(source, /peerRequiredCaseIds/);
  for (const id of [
    "first-launch", "second-launch", "process-cleanup", "usb-removal", "host-residue",
    "standard-user", "defender-enabled", "physical-usb", "windows-x64",
  ]) {
    assert.ok(source.includes(`'${id}'`), id);
  }
  assert.match(source, /peerUnexpectedBlockers/);
  assert.match(source, /peerSuitePassed/);
});

test("standard user evidence separates administrator membership from token elevation", async () => {
  const schema = JSON.parse(await read("phase1-acceptance.schema.json"));
  assert.ok(schema.properties.environment.required.includes("accountInAdministrators"));
  assert.ok(schema.properties.environment.required.includes("tokenElevated"));
  const source = await read("phase1-acceptance.ps1");
  assert.match(source, /S-1-5-32-544/);
  assert.match(source, /standardUser\s*=\s*\(-not \$accountInAdministrators\)/);
});

test("host audit stores only path hashes, never absolute paths or file names", async () => {
  const source = await read("portable-data-audit.ps1");
  assert.match(source, /pathSha256/);
  assert.doesNotMatch(source, /path\s*=\s*\$item\.FullName/);
  assert.doesNotMatch(source, /Sort-Object\s+path(?:\s|\))/);
});
