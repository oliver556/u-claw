import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const matrixUrl = new URL("../tests/windows/physical-usb-gate.matrix.json", import.meta.url);
const scriptUrl = new URL("../tests/windows/physical-usb-gate.ps1", import.meta.url);
const readmeUrl = new URL("../tests/windows/README-physical-usb-gate.md", import.meta.url);

test("physical USB gate freezes the required host and acceptance matrix", async () => {
  const matrix = JSON.parse(await readFile(matrixUrl, "utf8"));
  assert.equal(matrix.schemaVersion, 1);
  assert.deepEqual(matrix.requiredHostMatrix, [
    { osFamily: "windows-10", usbClass: "recommended" },
    { osFamily: "windows-10", usbClass: "low-speed" },
    { osFamily: "windows-11", usbClass: "recommended" },
    { osFamily: "windows-11", usbClass: "low-speed" },
  ]);
  const ids = matrix.cases.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of [
    "first-install", "warm-startup", "warm-without-runtime-package",
    "offline", "proxy-failure", "firewall-failure", "policy-service-failure", "cdn-failure",
    "license-expired", "license-revoked", "license-binding-failure",
    "gateway-missing-timeout", "gateway-crash-retry", "renderer-crash", "main-crash",
    "disk-space", "second-usb-blocked", "drive-letter-change", "usb-removal", "update-interruption",
    "forward-rollback", "text-streaming", "multi-turn-context", "background-session",
    "image-first-turn", "image-edit", "tool-calling", "dynamic-model-catalog",
    "byok-commercial-isolation", "data-secret-boundary",
  ]) {
    assert.ok(ids.includes(id), `missing physical gate case ${id}`);
  }
  for (const entry of matrix.cases) {
    assert.match(entry.category, /^[a-z-]+$/u);
    assert.ok(entry.title.length > 0);
    assert.ok(entry.pass.length > 0);
  }
});

test("PowerShell collector fails closed and never elevates", async () => {
  const source = await readFile(scriptUrl, "utf8");
  assert.match(source, /Set-StrictMode -Version Latest/u);
  assert.match(source, /\$ErrorActionPreference\s*=\s*'Stop'/u);
  assert.match(source, /Prepare.*Record.*FinalizeHost.*Aggregate/u);
  assert.match(source, /Get-MpComputerStatus/u);
  assert.match(source, /Get-Command node/u);
  assert.match(source, /DriveType.*Removable/su);
  assert.match(source, /BusType.*USB/su);
  assert.match(source, /ATTACHMENT_REQUIRED/u);
  assert.match(source, /POTENTIAL_SECRET_IN_EVIDENCE/u);
  assert.match(source, /HOST_MATRIX_MISSING/u);
  assert.match(source, /RELEASE_ARTIFACTS_DIFFER_ACROSS_HOSTS/u);
  assert.doesNotMatch(source, /-Verb\s+RunAs|requireAdministrator|highestAvailable/iu);
});

test("runbook states real hardware boundary and executable commands", async () => {
  const source = await readFile(readmeUrl, "utf8");
  for (const command of ["-Action Prepare", "-Action Record", "-Action FinalizeHost", "-Action Aggregate"]) {
    assert.match(source, new RegExp(command, "u"));
  }
  assert.match(source, /Windows 10 \+ 推荐 U 盘/u);
  assert.match(source, /Windows 11 \+ 低速 U 盘/u);
  assert.match(source, /macOS、Windows CI、fixture launcher、模拟盘只能证明脚本\/合同，不满足本门禁/u);
  assert.match(source, /requiredReleaseSequence/u);
});
