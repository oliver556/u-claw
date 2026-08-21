import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../../.github/workflows/portable-launcher.yml", import.meta.url);
const e2eUrl = new URL("../tests/windows/launcher-e2e.ps1", import.meta.url);
const appManifestUrl = new URL("../launcher/app.manifest", import.meta.url);

test("portable launcher workflow pins tools and limits authority", async () => {
  const source = await readFile(workflowUrl, "utf8");
  assert.match(source, /workflow_dispatch:\s*\n\s*pull_request:/u);
  assert.match(source, /permissions:\s*\n\s*contents:\s*read/u);
  assert.match(source, /runs-on:\s*windows-2022/u);
  assert.match(source, /timeout-minutes:\s*30/u);
  assert.match(source, /go-version:\s*['"]1\.25\.0['"]/u);
  assert.match(source, /node-version:\s*['"]24\.15\.0['"]/u);
  assert.match(source, /npm ci --ignore-scripts --prefix product/u);
  assert.match(source, /persist-credentials:\s*false/u);
  assert.doesNotMatch(source, /pull_request_target|\bsecrets\b|\bRunAs\b|requireAdministrator/iu);
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

test("production launcher build requires and injects an Ed25519 trust root", async () => {
  const source = await readFile(workflowUrl, "utf8");
  assert.match(source, /UCLAW_RUNTIME_TRUSTED_PUBLIC_KEYS:\s*\$\{\{\s*vars\.UCLAW_RUNTIME_TRUSTED_PUBLIC_KEYS\s*\}\}/u);
  assert.match(source, /UCLAW_RUNTIME_REVOKED_KEY_IDS:\s*\$\{\{\s*vars\.UCLAW_RUNTIME_REVOKED_KEY_IDS\s*\}\}/u);
  assert.match(source, /UCLAW_RELEASE_BASE_URL:\s*\$\{\{\s*vars\.UCLAW_RELEASE_BASE_URL\s*\}\}/u);
  assert.match(source, /UCLAW_RELEASE_POLICY_ENDPOINT:\s*\$\{\{\s*vars\.UCLAW_RELEASE_POLICY_ENDPOINT\s*\}\}/u);
  assert.match(source, /UCLAW_RELEASE_POLICY_TRUSTED_PUBLIC_KEYS:\s*\$\{\{\s*vars\.UCLAW_RELEASE_POLICY_TRUSTED_PUBLIC_KEYS\s*\}\}/u);
  assert.match(source, /UCLAW_ACTIVATION_ENDPOINT:\s*\$\{\{\s*vars\.UCLAW_ACTIVATION_ENDPOINT\s*\}\}/u);
  assert.doesNotMatch(source, /UCLAW_ACTIVATION_TRUSTED_PUBLIC_KEYS|trustedActivationKeys|activationKeysJson/u);
  assert.match(source, /IsNullOrWhiteSpace\(\$env:UCLAW_RUNTIME_TRUSTED_PUBLIC_KEYS\)[\s\S]*throw/u);
  assert.match(source, /FromBase64String[\s\S]*Length\s*-ne\s*32/u);
  assert.match(source, /main\.trustedRuntimeKeys=\$trustedKeysJson/u);
  assert.match(source, /UCLAW_LICENSE_TRUSTED_PUBLIC_KEYS:\s*\$\{\{\s*vars\.UCLAW_LICENSE_TRUSTED_PUBLIC_KEYS\s*\}\}/u);
  assert.match(source, /IsNullOrWhiteSpace\(\$env:UCLAW_LICENSE_TRUSTED_PUBLIC_KEYS\)[\s\S]*throw/u);
  assert.match(source, /main\.trustedStartupLicenseKeys=\$licenseKeysJson/u);
  assert.match(source, /UCLAW_LICENSE_STATUS_ENDPOINT:\s*\$\{\{\s*vars\.UCLAW_LICENSE_STATUS_ENDPOINT\s*\}\}/u);
  assert.match(source, /UCLAW_LICENSE_STATUS_TRUSTED_PUBLIC_KEYS:\s*\$\{\{\s*vars\.UCLAW_LICENSE_STATUS_TRUSTED_PUBLIC_KEYS\s*\}\}/u);
  assert.match(source, /IsNullOrWhiteSpace\(\$env:UCLAW_LICENSE_STATUS_ENDPOINT\)[\s\S]*throw/u);
  assert.match(source, /main\.licenseStatusEndpoint=\$licenseStatusEndpoint/u);
  assert.match(source, /main\.trustedLicenseStatusKeys=\$licenseStatusKeysJson/u);
  assert.match(source, /IsNullOrWhiteSpace\(\$env:UCLAW_ACTIVATION_ENDPOINT\)[\s\S]*throw/u);
  assert.match(source, /\$activationURI\.Scheme\s+-cne\s+'https'/u);
  assert.match(source, /UCLAW_ACTIVATION_ENDPOINT[^\n]*-match[^\n]*\\s[^\n]*'[^\n]*\\\\/u);
  assert.match(source, /main\.activationServiceEndpoint=\$activationEndpoint/u);
  assert.equal((source.match(/main\.trustedStartupLicenseKeys=\$licenseKeysJson/gu) ?? []).length, 1);
  assert.match(source, /\$env:GOFLAGS\s*=\s*''/u);
  assert.match(source, /main\.revokedRuntimeKeyIDs=\$revokedKeyIDsJson/u);
  assert.match(source, /main\.releaseFeedBaseURL=\$releaseBaseURL/u);
  assert.match(source, /IsNullOrWhiteSpace\(\$env:UCLAW_RELEASE_POLICY_ENDPOINT\)[\s\S]*throw/u);
  assert.match(source, /IsNullOrWhiteSpace\(\$env:UCLAW_RELEASE_POLICY_TRUSTED_PUBLIC_KEYS\)[\s\S]*throw/u);
  assert.match(source, /main\.releasePolicyEndpoint=\$releasePolicyEndpoint/u);
  assert.match(source, /main\.trustedReleasePolicyKeys=\$releasePolicyKeysJson/u);
  assert.match(source, /--verify-official-release-policy-config/u);
  assert.doesNotMatch(source, /go build[^\n]*-tags\s+licensefixture/iu);
  assert.doesNotMatch(source, /--test-fixture-launcher/u);
  assert.doesNotMatch(source, /BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY/u);
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
    "truncatedPackageIgnoredOnWarm",
    "partialCacheIgnored",
    "unicodeSpacePath",
    "duplicateLaunchRejected",
    "dataStayedOnUSB",
    "missingStartupCredentialRejected",
    "missingLicenseRejected",
    "tamperedLicenseRejected",
  ]) {
    assert.match(source, new RegExp(`\\b${check}\\b`, "u"));
  }
  assert.match(source, /UCLAW_LAUNCHER_HEADLESS/u);
  assert.match(source, /sign-license-fixture\.mjs/u);
  assert.match(source, /-tags\s+licensefixture/u);
  assert.match(source, /main\.trustedStartupLicenseKeys=\$licenseTrustedKeysJson/u);
  assert.match(source, /main\.trustedLicenseStatusKeys=\$licenseStatusTrustedKeysJson/u);
  assert.match(source, /\.status-response\.json/u);
  assert.match(source, /\.partial-/u);
  assert.doesNotMatch(source, /Write-(Host|Verbose|Debug|Warning)|Start-Process[^\n]*-Verb\s+RunAs/iu);
});
