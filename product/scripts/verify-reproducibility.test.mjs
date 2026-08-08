import assert from "node:assert/strict";
import test from "node:test";

import {
  assertExactNodeVersion,
  assertExactNpmVersion,
  verifyWorkspacePins,
} from "./verify-reproducibility.mjs";

test("rejects any Node version other than the canonical pin", () => {
  assert.throws(() => assertExactNodeVersion("22.18.0"), /Node\.js 24\.15\.0 required; found 22\.18\.0/u);
  assert.doesNotThrow(() => assertExactNodeVersion("24.15.0"));
});

test("rejects any npm version other than the canonical Node bundle", () => {
  assert.throws(() => assertExactNpmVersion("npm/10.9.3 node/v24.15.0"), /npm 11\.12\.1 required; found 10\.9\.3/u);
  assert.doesNotThrow(() => assertExactNpmVersion("npm/11.12.1 node/v24.15.0"));
});

test("verifies manifests, lockfile, and runtime pins without rewriting them", async () => {
  await assert.doesNotReject(verifyWorkspacePins());
});
