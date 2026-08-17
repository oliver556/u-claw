import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../../.github/workflows/portable-launcher.yml", import.meta.url);
const e2eUrl = new URL("../tests/windows/launcher-e2e.ps1", import.meta.url);
const offlineE2EUrl = new URL("../tests/windows/offline-updater-e2e.ps1", import.meta.url);
const appManifestUrl = new URL("../launcher/app.manifest", import.meta.url);
const updaterManifestUrl = new URL("../offline-updater/app.manifest", import.meta.url);

test("portable launcher workflow pins tools and limits authority", async () => {
  const source = await readFile(workflowUrl, "utf8");
  assert.match(source, /workflow_dispatch:\s*\n\s*push:/u);
  assert.match(source, /\n\s*pull_request:\s*\n/u);
  assert.match(source, /permissions:\s*\n\s*contents:\s*read/u);
  assert.match(source, /runs-on:\s*windows-2022/u);
  assert.match(source, /timeout-minutes:\s*30/u);
  assert.match(source, /go-version:\s*['"]1\.25\.0['"]/u);
  assert.match(source, /node-version:\s*['"]24\.15\.0['"]/u);
  assert.match(source, /npm ci --ignore-scripts --prefix product/u);
  assert.match(source, /persist-credentials:\s*false/u);
  assert.doesNotMatch(source, /pull_request_target|\bsecrets\b|\bRunAs\b|requireAdministrator/iu);
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
  assert.equal((source.match(/-LauncherExe\b/gu) ?? []).length, 2);
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
  assert.match(source, /UCLAW_FIXTURE_UPDATE_RESTART_ONCE/u);
  assert.match(source, /sign-license-fixture\.mjs/u);
  assert.match(source, /-tags\s+licensefixture/u);
  assert.match(source, /main\.trustedStartupLicenseKeys=\$licenseTrustedKeysJson/u);
  assert.match(source, /main\.trustedLicenseStatusKeys=\$licenseStatusTrustedKeysJson/u);
  assert.match(source, /\.status-response\.json/u);
  assert.match(source, /\.partial-/u);
  assert.doesNotMatch(source, /Write-(Host|Verbose|Debug|Warning)|Start-Process[^\n]*-Verb\s+RunAs/iu);
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
  assert.doesNotMatch(offlineE2E, /production|activation[_-]?code|api[_-]?token/iu);
});
