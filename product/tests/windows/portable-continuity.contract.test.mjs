import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./portable-continuity.ps1", import.meta.url), "utf8");

test("Windows acceptance workflow gates the continuity harness", async () => {
  const workflow = await readFile(new URL("../../../.github/workflows/phase1-windows-acceptance.yml", import.meta.url), "utf8");
  assert.match(workflow, /portable-continuity\*/);
  assert.match(workflow, /portable-continuity\.contract\.test\.mjs/);
});

test("continuity evidence has a strict machine-readable schema", async () => {
  const schema = JSON.parse(await readFile(new URL("./portable-continuity.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.action.enum, ["Capture", "DeleteCache", "VerifyCacheRecovery", "Verify"]);
  assert.deepEqual(schema.properties.status.enum, ["passed", "needs-input", "failed"]);
  for (const field of ["machineIdSha256", "driveRoot", "physicalUsbVerified", "assertions", "blockers"]) {
    assert.ok(schema.required.includes(field), field);
  }
  assert.equal(schema.properties.assertions.items.additionalProperties, false);
  assert.equal(schema.properties.blockers.items.additionalProperties, false);
});

test("continuity harness snapshots USB data without drive-letter binding", () => {
  assert.match(source, /\.uclaw[\\']+data/i);
  assert.match(source, /Get-FileHash/);
  assert.match(source, /relativePath/);
  assert.match(source, /snapshotSha256/);
  assert.match(source, /ConvertTo-Json -InputObject @\(\$files\)/);
  assert.doesNotMatch(source, /[A-Za-z]:\\\.uclaw/);
});

test("cache deletion requires an exact ownership marker and protects USB data", () => {
  assert.match(source, /\.uclaw-cache\.json/);
  assert.match(source, /rebuildable-cache/);
  assert.match(source, /CACHE_OWNERSHIP_MARKER_INVALID/);
  assert.match(source, /Remove-Item -LiteralPath \$cacheRoot -Recurse -Force/);
  assert.match(source, /USB_DATA_CHANGED_DURING_CACHE_DELETE/);
  assert.match(source, /GetPathRoot/);
  assert.match(source, /ReparsePoint/);
  assert.match(source, /CACHE_ROOT_MUST_EQUAL_LOCALAPPDATA_UCLAW/);
  assert.match(source, /OrdinalIgnoreCase/);
  assert.match(source, /GetFolderPath\(\[Environment\+SpecialFolder\]::LocalApplicationData\)/);
  assert.match(source, /VerifyCacheRecovery/);
  assert.match(source, /CACHE_RUNTIME_NOT_REBUILT/);
});

test("evidence distinguishes automation from two-machine physical acceptance", () => {
  assert.match(source, /machineIdSha256/);
  assert.match(source, /driveRoot/);
  assert.match(source, /physicalUsbVerified/);
  assert.match(source, /needs-input/);
  assert.match(source, /TWO_REAL_WINDOWS_AND_PHYSICAL_USB_REQUIRED/);
  assert.match(source, /ContinuityConfirmed/);
  assert.match(source, /HostAuditEvidencePath/);
  assert.match(source, /HOST_USER_DATA_AUDIT_NOT_PASSED/);
});
