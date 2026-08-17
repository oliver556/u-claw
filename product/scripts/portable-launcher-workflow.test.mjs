import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { copyFixtureLicense } from "../tests/windows/copy-fixture-license.mjs";

const execFileAsync = promisify(execFile);

const workflowUrl = new URL("../../.github/workflows/portable-launcher.yml", import.meta.url);
const e2eUrl = new URL("../tests/windows/launcher-e2e.ps1", import.meta.url);
const offlineE2EUrl = new URL("../tests/windows/offline-updater-e2e.ps1", import.meta.url);
const realRuntimeSmokeUrl = new URL("../tests/windows/real-runtime-smoke.ps1", import.meta.url);
const realRuntimeKitUrl = new URL("../tests/windows/build-real-runtime-smoke-kit.mjs", import.meta.url);
const appManifestUrl = new URL("../launcher/app.manifest", import.meta.url);
const updaterManifestUrl = new URL("../offline-updater/app.manifest", import.meta.url);
const signLicenseFixtureUrl = new URL("../tests/windows/sign-license-fixture.mjs", import.meta.url);

test("Windows license fixture matches the Launcher canonical signature contract", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-license-fixture-"));
  try {
    const licenseDir = path.join(root, "license");
    const trustedKeysPath = path.join(root, "trusted-keys.json");
    await execFileAsync(process.execPath, [
      fileURLToPath(signLicenseFixtureUrl),
      "--license-dir", licenseDir,
      "--trusted-keys", trustedKeysPath,
    ]);
    const [license, trustedKeys] = await Promise.all([
      readFile(path.join(licenseDir, "license.json"), "utf8").then(JSON.parse),
      readFile(trustedKeysPath, "utf8").then(JSON.parse),
    ]);
    assert.equal(license.usernameId, "usr_windows_fixture_001");
    assert.equal(license.revision, 1);
    assert.match(license.notBefore, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.match(license.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const rawPublicKey = Buffer.from(trustedKeys[license.signature.keyId], "base64");
    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: rawPublicKey.toString("base64url") },
      format: "jwk",
    });
    const payload = [
      "uclaw-startup-license-v1", license.schemaVersion, license.signature.keyId,
      license.usernameId, license.deviceId, license.licenseId,
      license.usbFingerprint.scheme, license.usbFingerprint.sha256,
      license.startupSecretProof.startupSecretSalt, license.startupSecretProof.startupSecretHash,
      license.notBefore, license.expiresAt, license.revision,
    ];
    assert.equal(verify(
      null,
      Buffer.from(JSON.stringify(payload), "utf8"),
      publicKey,
      Buffer.from(license.signature.value, "base64"),
    ), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable launcher workflow pins tools and limits authority", async () => {
  const source = await readFile(workflowUrl, "utf8");
  assert.match(source, /workflow_dispatch:\s*\n\s*push:/u);
  assert.match(source, /\n\s*pull_request:\s*\n/u);
  assert.match(source, /permissions:\s*\n\s*contents:\s*read/u);
  assert.match(source, /runs-on:\s*windows-2022/u);
  assert.match(source, /timeout-minutes:\s*60/u);
  assert.match(source, /go-version:\s*['"]1\.25\.0['"]/u);
  assert.match(source, /node-version:\s*['"]24\.15\.0['"]/u);
  assert.match(source, /npm ci --ignore-scripts --prefix product/u);
  assert.match(source, /persist-credentials:\s*false/u);
  assert.doesNotMatch(source, /pull_request_target|\bsecrets\b|\bRunAs\b|requireAdministrator/iu);
});

test("Windows CI launches the real runtime offline", async () => {
  const [workflow, smoke, kit] = await Promise.all([
    readFile(workflowUrl, "utf8"),
    readFile(realRuntimeSmokeUrl, "utf8"),
    readFile(realRuntimeKitUrl, "utf8"),
  ]);
  assert.match(workflow, /build-real-runtime-smoke-kit\.mjs/u);
  assert.match(workflow, /copy-fixture-license\.mjs/u);
  assert.equal((workflow.match(/\.\\product\\tests\\windows\\real-runtime-smoke\.ps1/gu) ?? []).length, 2);
  assert.match(workflow, /shell:\s*powershell\b[\s\S]*real-runtime-smoke\.ps1/u);
  assert.match(workflow, /shell:\s*pwsh\b[\s\S]*real-runtime-smoke\.ps1/u);
  assert.match(smoke, /UCLAW_REAL_RUNTIME_READY/u);
  assert.match(smoke, /New-NetFirewallRule/u);
  assert.match(smoke, /Remove-NetFirewallRule/u);
  assert.match(smoke, /runtime-ready\.json/u);
  assert.match(smoke, /2026\.7\.1-2/u);
  assert.match(smoke, /failureCode/u);
  assert.match(smoke, /\^UCLAW_REAL_RUNTIME_\[A-Z_\]\+\$/u);
  assert.match(smoke, /Write-SanitizedDiagnostic \$false \$failureCode/u);
  assert.doesNotMatch(smoke, /throw\s+\$_|Write-SanitizedDiagnostic[^\n]*Exception/iu);
  assert.match(smoke, /Read-SafeLogRecord/u);
  assert.match(smoke, /launcherEvent/u);
  assert.match(smoke, /gatewayEvent/u);
  assert.match(smoke, /gatewayPhase/u);
  assert.match(smoke, /gatewayClassification/u);
  assert.match(smoke, /gatewaySpawned/u);
  assert.match(smoke, /gatewayHealthReady/u);
  assert.match(smoke, /gatewayCapabilityReady/u);
  assert.match(smoke, /runtime-startup-failure\.json/u);
  assert.match(smoke, /startupStage/u);
  assert.match(smoke, /startupErrorCode/u);
  assert.match(smoke, /startupErrorName/u);
  assert.match(smoke, /gateway-spawned/u);
  assert.match(smoke, /gateway-health-ready/u);
  assert.match(smoke, /gateway-capability-ready/u);
  assert.doesNotMatch(smoke, /stderrTail/u);
  assert.match(kit, /buildWindowsValidationKit/u);
  assert.match(kit, /fetchRuntimeArtifact/u);
  assert.match(kit, /-tags["'],\s*["']licensefixture/u);
  assert.match(kit, /runner:\s*instrumentedRunner/u);
  for (const stage of [
    "fixture-license",
    "validation-kit",
    "runtime-v1",
    "runtime-v2",
    "package-v1",
    "package-v2",
    "launcher",
    "release",
    "feed",
    "updater",
    "fixture-copy",
    "fixture-launcher",
    "fixture-check",
  ]) assert.match(kit, new RegExp(`\\b${stage}\\b`, "u"));
  assert.doesNotMatch(workflow.slice(workflow.search(/uses: actions\/upload-artifact@/u)), /real-runtime-smoke|U-Claw-test-USB|\.uclaw[\\/]data/iu);
});

test("real runtime smoke failures emit only a fixed safe stage code", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-real-runtime-smoke-secret-token-"));
  try {
    const output = path.join(root, "private-key-should-never-appear");
    await mkdir(output);
    await assert.rejects(
      execFileAsync(process.execPath, [
        fileURLToPath(realRuntimeKitUrl),
        "--cache", path.join(root, "cache-with-token"),
        "--output", output,
      ]),
      error => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, "");
        assert.equal(error.stderr, "REAL_WINDOWS_RUNTIME_SMOKE_FAILED: setup\n");
        assert.equal(error.stderr.includes(root), false);
        assert.equal(error.stderr.includes("private-key-should-never-appear"), false);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixture license copy is exact, exclusive, and rejects unexpected input", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-fixture-license-copy-"));
  try {
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    await mkdir(source);
    const entries = [".startup-credential.json", ".status-response.json", "license.json"];
    await Promise.all(entries.map(entry => writeFile(path.join(source, entry), entry)));

    await copyFixtureLicense(source, target);

    assert.deepEqual((await readdir(target)).sort(), entries);
    await assert.rejects(copyFixtureLicense(source, target), /already exists/i);
    await writeFile(path.join(source, "unexpected.json"), "unexpected");
    await rm(target, { recursive: true });
    await assert.rejects(copyFixtureLicense(source, target), /unexpected/i);
    await assert.rejects(readFile(target), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable launcher workflow runs after relevant branch pushes", async () => {
  const source = await readFile(workflowUrl, "utf8");
  const push = source.slice(source.search(/\n\s*push:\s*\n/u), source.search(/\n\s*pull_request:\s*\n/u));
  assert.match(push, /product\/launcher\/\*\*/u);
  assert.match(push, /product\/offline-updater\/\*\*/u);
  assert.match(push, /product\/tests\/windows\/offline-updater-e2e\.ps1/u);
});

test("portable launcher workflow builds windowsgui and runs both PowerShell gates", async () => {
  const [source, appManifest] = await Promise.all([
    readFile(workflowUrl, "utf8"),
    readFile(appManifestUrl, "utf8"),
  ]);
  assert.match(source, /CGO_ENABLED[^\n]*0/u);
  assert.match(source, /GOOS[^\n]*windows/u);
  assert.match(source, /GOARCH[^\n]*amd64/u);
  assert.match(source, /go test -race \.\/\.\.\./u);
  assert.match(source, /-H windowsgui/u);
  assert.match(source, /github\.com\/akavel\/rsrc@v0\.10\.2[^\n]*-manifest app\.manifest/u);
  assert.match(appManifest, /requestedExecutionLevel level="asInvoker" uiAccess="false"/u);
  assert.doesNotMatch(appManifest, /requireAdministrator|highestAvailable/u);
  assert.match(source, /portable-runtime\.go/u);
  assert.match(source, /launcher-e2e\.ps1/u);
  assert.equal((source.match(/-LauncherExe\b/gu) ?? []).length, 4);
  assert.match(source, /shell:\s*powershell\b/u);
  assert.match(source, /shell:\s*pwsh\b/u);
});

test("portable lifecycle build is self-contained and never consumes production configuration", async () => {
  const source = await readFile(workflowUrl, "utf8");
  assert.doesNotMatch(source, /\$\{\{\s*(?:vars|secrets)\./u);
  assert.match(source, /\$env:GOFLAGS\s*=\s*''/u);
  assert.match(source, /go build -trimpath -ldflags '-s -w -H windowsgui'/u);
  assert.doesNotMatch(source, /go build[^\n]*-tags\s+licensefixture/iu);
  assert.doesNotMatch(source, /main\.(?:trustedRuntimeKeys|trustedStartupLicenseKeys|trustedLicenseStatusKeys|activationServiceEndpoint)=/u);
});

test("portable launcher artifact contains diagnostics only", async () => {
  const source = await readFile(workflowUrl, "utf8");
  const upload = source.slice(source.search(/uses: actions\/upload-artifact@[0-9a-f]{40}/u));
  assert.match(upload, /name:\s*portable-launcher-diagnostics/u);
  assert.match(upload, /product\/\.portable-launcher\/diagnostics\/\*\.json/u);
  assert.doesNotMatch(upload, /runtime\.pkg|version\.json|U-Claw\.exe|\.uclaw[\\/]data/iu);
});

test("PowerShell E2E covers the frozen portable lifecycle", async () => {
  const source = await readFile(e2eUrl, "utf8");
  assert.match(source, /Set-StrictMode -Version Latest/u);
  assert.match(source, /\$ErrorActionPreference\s*=\s*['"]Stop['"]/u);
  for (const check of [
    "firstLaunch",
    "secondLaunchReused",
    "invalidHashRejected",
    "truncatedPackageRejected",
    "partialCacheRejected",
    "unicodeSpacePath",
    "duplicateLaunchRejected",
    "dataStayedOnUSB",
    "missingStartupCredentialRejected",
    "missingLicenseRejected",
    "tamperedLicenseRejected",
    "updateRestartReranFullGate",
  ]) {
    assert.match(source, new RegExp(`\\b${check}\\b`, "u"));
  }
  assert.match(source, /UCLAW_LAUNCHER_HEADLESS/u);
  assert.match(source, /UCLAW_LAUNCHER_FAILURE_CODE_FILE/u);
  assert.match(source, /\$env:UCLAW_FIXTURE_HOLD_MS\s*=\s*['"]2500['"]/u);
  assert.match(source, /\^E_\[A-Z0-9_\]\{1,62\}\$/u);
  assert.match(source, /\[Console\]::Error\.WriteLine\([^\n]*\$failureCode/u);
  assert.match(source, /UCLAW_FIXTURE_UPDATE_RESTART_ONCE/u);
  assert.match(source, /sign-license-fixture\.mjs/u);
  assert.match(source, /-tags\s+licensefixture/u);
  assert.match(source, /\[Convert\]::ToBase64String/u);
  assert.match(source, /base64:/u);
  assert.match(source, /main\.trustedStartupLicenseKeys=\$licenseTrustedKeysLinkerValue/u);
  assert.match(source, /main\.trustedLicenseStatusKeys=\$licenseStatusTrustedKeysLinkerValue/u);
  assert.match(source, /\.status-response\.json/u);
  assert.match(source, /\.partial-/u);
  assert.doesNotMatch(source, /Write-(Host|Verbose|Debug|Warning)|Start-Process[^\n]*-Verb\s+RunAs/iu);
  const failureDiagnostic = source.slice(source.indexOf("$failure = [ordered]"), source.indexOf("Write-Diagnostics $failure"));
  assert.doesNotMatch(failureDiagnostic, /failureCode/u);
});

test("Windows workflow gates online and offline updates in both PowerShell versions", async () => {
  const [workflow, offlineE2E, updaterManifest] = await Promise.all([
    readFile(workflowUrl, "utf8"),
    readFile(offlineE2EUrl, "utf8"),
    readFile(updaterManifestUrl, "utf8"),
  ]);
  assert.equal((workflow.match(/\.\\product\\tests\\windows\\offline-updater-e2e\.ps1/gu) ?? []).length, 2);
  assert.equal((workflow.match(/\.\\product\\tests\\windows\\launcher-e2e\.ps1/gu) ?? []).length, 2);
  assert.equal((workflow.match(/-OfflineUpdaterExe\b/gu) ?? []).length, 2);
  assert.match(workflow, /offline-updater[\s\S]*rsrc_windows_amd64\.syso[\s\S]*-H windowsgui/u);
  assert.match(workflow, /offline-updater[\s\S]*go test -race \.\/\.\.\./u);
  assert.match(updaterManifest, /requestedExecutionLevel level="asInvoker" uiAccess="false"/u);
  assert.doesNotMatch(`${workflow}\n${offlineE2E}\n${updaterManifest}`, /\bRunAs\b|requireAdministrator/iu);
  assert.match(workflow, /product\/\.portable-launcher\/diagnostics\/\*\.json/u);
  assert.doesNotMatch(workflow.slice(workflow.search(/uses: actions\/upload-artifact@/u)), /U-Claw-Update|runtime\.pkg|stable\.json/iu);
  for (const field of [
    "offlineUpdateSucceeded",
    "licenseUnchanged",
    "startupCredentialUnchanged",
    "userDataUnchanged",
    "tamperedManifestRejected",
    "tamperedRuntimeRejected",
    "downgradeRejected",
    "multipleDrivesRequireSelection",
    "runningApplicationRejected",
    "interruptedSwitchRecovered",
    "newVersionPassedFullLicenseGate",
  ]) {
    assert.match(offlineE2E, new RegExp(`\\b${field}\\b`, "u"));
  }
  assert.match(offlineE2E, /Get-FileHash[^\n]*SHA256/u);
  assert.match(offlineE2E, /2>&1/u);
  assert.match(offlineE2E, /\$ErrorActionPreference\s*=\s*['"]Continue['"]/u);
  assert.match(offlineE2E, /\$ErrorActionPreference\s*=\s*\$originalErrorActionPreference/u);
  assert.match(offlineE2E, /\[Console\]::Error\.WriteLine\(\$line\)/u);
  assert.match(offlineE2E, /\$env:UCLAW_FIXTURE_HOLD_MS\s*=\s*['"]2500['"]/u);
  assert.doesNotMatch(offlineE2E, /Write-Diagnostics[^\n]*(?:output|error|message)/iu);
  assert.doesNotMatch(offlineE2E, /production|activation[_-]?code|api[_-]?token/iu);
});
