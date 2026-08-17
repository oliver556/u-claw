import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertExactNodeVersion,
  assertExactNpmVersion,
  validateWindowsArtifacts,
  verifyWorkspacePins,
} from "./verify-reproducibility.mjs";

test("pins immutable Windows runtime artifacts", async () => {
  const versions = JSON.parse(
    await readFile(new URL("../runtime-versions.json", import.meta.url), "utf8"),
  );

  assert.deepEqual(versions.windowsArtifacts, {
    electron: {
      url: "https://github.com/electron/electron/releases/download/v40.10.6/electron-v40.10.6-win32-x64.zip",
      sha256: "072480360a5d5e3ec0d4173b1f9d7d0bca435098567d7e6bb5829638072febfd",
    },
    node: {
      url: "https://nodejs.org/dist/v24.15.0/node-v24.15.0-win-x64.zip",
      sha256: "cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62",
    },
    openclaw: {
      url: "https://registry.npmjs.org/openclaw/-/openclaw-2026.7.1-2.tgz",
      integrity: "sha512-ycF3yPcbjN6bUPeaUx6Mh6vze1hQWoD3CT/wWcmD7a8xaHHHRUaAlaq+lFxMHf1ssEgODVAwjlzYqp2twkYZ7g==",
    },
  });
});

test("rejects mutable Windows runtime artifact pins", async () => {
  const versions = JSON.parse(
    await readFile(new URL("../runtime-versions.json", import.meta.url), "utf8"),
  );
  const cases = [
    {
      name: "wrong Electron URL",
      mutate: (candidate) => {
        candidate.windowsArtifacts.electron.url = "https://github.com/electron/electron/releases/download/v40.10.5/electron-v40.10.5-win32-x64.zip";
      },
      message: "Windows Electron artifact URL must match pinned version",
    },
    {
      name: "wrong Node URL",
      mutate: (candidate) => {
        candidate.windowsArtifacts.node.url = "https://nodejs.org/dist/v24.14.0/node-v24.14.0-win-x64.zip";
      },
      message: "Windows Node artifact URL must match pinned version",
    },
    {
      name: "short SHA-256",
      mutate: (candidate) => {
        candidate.windowsArtifacts.electron.sha256 = "07248036";
      },
      message: "Windows Electron artifact SHA-256 must be a lowercase 64-character SHA-256 digest",
    },
    {
      name: "uppercase SHA-256",
      mutate: (candidate) => {
        candidate.windowsArtifacts.node.sha256 = candidate.windowsArtifacts.node.sha256.toUpperCase();
      },
      message: "Windows Node artifact SHA-256 must be a lowercase 64-character SHA-256 digest",
    },
    {
      name: "OpenClaw integrity mismatch",
      mutate: (candidate) => {
        candidate.windowsArtifacts.openclaw.integrity = "sha512-invalid";
      },
      message: "Windows OpenClaw artifact integrity must match openclawNpmIntegrity",
    },
  ];

  for (const { name, mutate, message } of cases) {
    const candidate = structuredClone(versions);
    mutate(candidate);
    assert.throws(
      () => validateWindowsArtifacts(candidate),
      (error) => {
        assert.equal(error.message, message, name);
        return true;
      },
    );
  }
});

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
