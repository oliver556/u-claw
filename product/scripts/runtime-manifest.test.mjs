import assert from "node:assert/strict";
import test from "node:test";

import {
  isSafeWindowsRelativePath,
  runtimeManifestSigningPayload,
  signRuntimeManifest,
  validateRuntimeManifest,
} from "./runtime-manifest.mjs";
import { createHash, generateKeyPairSync, verify } from "node:crypto";

function validManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    productVersion: "0.1.0",
    nodeVersion: "24.15.0",
    electronVersion: "40.10.6",
    runtimeVersion: "2026.7.1-2",
    runtimeId: "openclaw-2026.7.1-2-win-x64",
    targetPlatform: "win32",
    targetArch: "x64",
    runtimeArchive: "runtime.pkg",
    runtimeSha256: "a".repeat(64),
    runtimeTreeSha256: "b".repeat(64),
    runtimeBytes: 1024,
    unpackedBytes: 4096,
    fileCount: 8,
    entrypoint: "electron/electron.exe",
    entryArgs: ["resources/app.asar"],
    ...overrides,
  };
}

test("accepts the frozen runtime manifest", () => {
  const manifest = validManifest();
  assert.equal(validateRuntimeManifest(manifest), manifest);
});

test("rejects unknown or missing manifest fields", () => {
  assert.throws(
    () => validateRuntimeManifest({ ...validManifest(), unexpected: true }),
    /unexpected field/,
  );
  const missing = validManifest();
  delete missing.runtimeId;
  assert.throws(() => validateRuntimeManifest(missing), /invalid runtime manifest/);
});

test("accepts Unicode base-independent runtime paths", () => {
  for (const value of [
    "electron/electron.exe",
    "resources/app.asar",
    "node_modules/@scope/package/index.js",
    "资源/客户端.exe",
  ]) {
    assert.equal(isSafeWindowsRelativePath(value), true, value);
  }
});

test("rejects unsafe Windows runtime paths", () => {
  for (const value of [
    "",
    "/runtime.pkg",
    "\\runtime.pkg",
    "C:\\runtime.pkg",
    "C:runtime.pkg",
    "\\\\server\\share\\runtime.pkg",
    "../runtime.pkg",
    "..\\runtime.pkg",
    "packages/../runtime.pkg",
    "packages/.hidden/../runtime.pkg",
    "runtime.pkg:payload",
    "runtime.pkg\0payload",
    "runtime.pkg.",
    "runtime.pkg ",
    "CON",
    "packages/nul.txt",
    "COM1.log",
    "lpt9",
    "CONIN$.txt",
    "packages/com¹.bin",
  ]) {
    assert.equal(isSafeWindowsRelativePath(value), false, value);
  }
});

test("validates both archive and entrypoint paths", () => {
  for (const field of ["runtimeArchive", "entrypoint"]) {
    assert.throws(
      () => validateRuntimeManifest(validManifest({ [field]: "../outside" })),
      new RegExp(field),
    );
  }
});

test("rejects malformed identifiers and digests", () => {
  for (const runtimeId of ["", " openclaw", "openclaw/win", "openclaw win", "运行时"]) {
    assert.throws(() => validateRuntimeManifest(validManifest({ runtimeId })), /runtimeId/);
  }
  for (const runtimeSha256 of ["", "abc", "a".repeat(63), "a".repeat(65), "g".repeat(64)]) {
    assert.throws(
      () => validateRuntimeManifest(validManifest({ runtimeSha256 })),
      /runtimeSha256|invalid runtime manifest/,
    );
  }
});

test("requires positive safe integer package bounds", () => {
  for (const field of ["runtimeBytes", "unpackedBytes", "fileCount"]) {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => validateRuntimeManifest(validManifest({ [field]: value })),
        /invalid runtime manifest/,
      );
    }
  }
});

test("rejects unsafe entry arguments", () => {
  assert.throws(
    () => validateRuntimeManifest(validManifest({ entryArgs: ["safe", "bad\0argument"] })),
    /entryArgs/,
  );
  assert.throws(
    () => validateRuntimeManifest(validManifest({ entryArgs: ["safe", 1] })),
    /invalid runtime manifest/,
  );
});

test("signature binds key, lifetime and anti-replay sequence", () => {
  const keys = generateKeyPairSync("ed25519");
  const signed = signRuntimeManifest(validManifest(), {
    keyId: "fixture",
    privateKey: keys.privateKey,
    signedAt: "2026-08-09T00:00:00.000Z",
    expiresAt: "2027-08-09T00:00:00.000Z",
    sequence: 42,
  });
  for (const mutate of [
    (value) => { value.signature.keyId = "other"; },
    (value) => { value.signature.signedAt = "2026-08-08T00:00:00.000Z"; },
    (value) => { value.signature.expiresAt = "2028-08-09T00:00:00.000Z"; },
    (value) => { value.signature.sequence = 43; },
  ]) {
    const tampered = structuredClone(signed);
    mutate(tampered);
    assert.equal(verify(null, runtimeManifestSigningPayload(tampered), keys.publicKey, Buffer.from(signed.signature.value, "base64")), false);
  }
});

test("uses the cross-language canonical signing payload", () => {
  const manifest = validManifest({
    productVersion: "0.1.0<>&\u2028",
    runtimeId: "openclaw-test",
    runtimeBytes: 7,
    unpackedBytes: 9,
    fileCount: 1,
    entryArgs: ["<arg>", "line\u2029end"],
    signature: {
      algorithm: "ed25519",
      keyId: "fixture",
      signedAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2027-08-09T00:00:00.000Z",
      sequence: 42,
      value: "",
    },
  });
  assert.equal(createHash("sha256").update(runtimeManifestSigningPayload(manifest)).digest("hex"), "bb7ad70619f7524d325cf326d432a5a6be0bb84aa87ea24aa6ac7623b6cd4754");
});
