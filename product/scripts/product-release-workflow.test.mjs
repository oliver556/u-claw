import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(new URL("../../.github/workflows/product-release.yml", import.meta.url), "utf8");

test("commercial release workflow uses only product inputs", () => {
  assert.match(workflow, /product\/packaging\/release-gate-cli\.mjs/u);
  assert.doesNotMatch(workflow, /(?:^|[\s'"/])u-claw-app\//mu);
  assert.doesNotMatch(workflow, /(?:^|[\s'"/])portable\//mu);
  assert.doesNotMatch(workflow, /@latest|\|\|\s*true/u);
});

test("commercial release workflow gates pointer authorization after CDN readback", () => {
  const ordered = [
    "name: Build signed release artifacts",
    "name: Smoke final runtime",
    "name: Promote candidate to acceptance",
    "name: Promote acceptance to production",
    "name: Verify promotion SHA-256 equality",
    "name: Upload complete production artifact set",
    "name: CDN readback verification",
    "name: Emit requiredReleaseSequence switch authorization",
  ];
  let previous = -1;
  for (const marker of ordered) {
    const index = workflow.indexOf(marker);
    assert.ok(index > previous, `${marker} must follow previous release gate`);
    previous = index;
  }
  assert.doesNotMatch(workflow, /(?:set|switch|update)[^\n]*requiredReleaseSequence/iu);
  assert.match(workflow, /pointer-switch-authorization\.json/u);
  assert.match(workflow, /RELEASE_AUTHORIZATION_PRIVATE_KEY/u);
  assert.match(workflow, /authorize[\s\S]*--key-id production-release-gate-v1[\s\S]*--private-key/u);
});

test("workflow runs build, typecheck, tests, secret scan, and final runtime smoke without silent failures", () => {
  for (const command of [
    "npm run build --prefix product",
    "npm run typecheck --prefix product",
    "npm test --prefix product",
    "npm run test:secrets --prefix product",
    "release-gate-cli.mjs smoke",
  ]) assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/u);
});

test("official release builds and verifies Bootstrap with production release policy trust", () => {
  assert.match(workflow, /name: Build official Bootstrap launcher/u);
  assert.match(workflow, /UCLAW_RELEASE_POLICY_ENDPOINT:\s*\$\{\{\s*vars\.UCLAW_RELEASE_POLICY_ENDPOINT\s*\}\}/u);
  assert.match(workflow, /UCLAW_RELEASE_POLICY_TRUSTED_PUBLIC_KEYS:\s*\$\{\{\s*vars\.UCLAW_RELEASE_POLICY_TRUSTED_PUBLIC_KEYS\s*\}\}/u);
  assert.match(workflow, /GetEnvironmentVariable\(\$name\)[\s\S]*throw/u);
  assert.match(workflow, /main\.releasePolicyEndpoint=\$releasePolicyEndpoint/u);
  assert.match(workflow, /main\.trustedReleasePolicyKeys=\$releasePolicyKeysJson/u);
  assert.match(workflow, /--verify-official-release-policy-config/u);
  assert.match(workflow, /--launcher\s+product\/dist\/launcher\/U-Claw\.exe/u);
  assert.doesNotMatch(workflow, /--test-fixture-launcher/u);
});
