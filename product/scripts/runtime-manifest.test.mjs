import assert from "node:assert/strict";
import test from "node:test";

import {
  isSafeMacOSRelativePath,
  isSafeWindowsRelativePath,
  runtimeManifestSigningPayload,
  runtimeManifestTarget,
  signRuntimeManifest,
  validateRuntimeManifest,
} from "./runtime-manifest.mjs";
import { createHash, generateKeyPairSync, verify } from "node:crypto";

function validManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    releaseId: "release-42",
    releaseSequence: 42,
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
    criticalFiles: [{ path: "electron/electron.exe", size: 8, sha256: "c".repeat(64) }],
    ...overrides,
  };
}

test("accepts the frozen runtime manifest", () => {
  const manifest = validManifest();
  assert.equal(validateRuntimeManifest(manifest), manifest);
});

test("infers legacy win-x64 runtime target without requiring a v3 field", () => {
  assert.equal(runtimeManifestTarget(validManifest()), "win-x64");
  assert.equal(validateRuntimeManifest(validManifest()).target, undefined);
});

test("accepts target-aware macOS runtime manifests", () => {
  const manifest = validManifest({
    runtimeId: "openclaw-2026.7.1-2-macos-arm64",
    target: "macos-arm64",
    targetPlatform: "darwin",
    targetArch: "arm64",
    entrypoint: "Electron.app/Contents/MacOS/Electron",
    criticalFiles: [{ path: "Electron.app/Contents/MacOS/Electron", size: 8, sha256: "c".repeat(64) }],
  });
  assert.equal(runtimeManifestTarget(manifest), "macos-arm64");
  assert.equal(validateRuntimeManifest(manifest), manifest);
});

test("rejects mismatched runtime target triples", () => {
  assert.throws(
    () => validateRuntimeManifest(validManifest({ target: "macos-arm64" })),
    /target/,
  );
  assert.throws(
    () => validateRuntimeManifest(validManifest({ targetPlatform: "win32", targetArch: "arm64" })),
    /targetPlatform\/targetArch/,
  );
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

test("validates macOS runtime paths and Unicode/case critical-file collisions", () => {
  for (const value of [
    "Electron.app/Contents/MacOS/Electron",
    "Frameworks/U-Claw Helper.app/Contents/MacOS/U-Claw Helper",
    "资源/客户端",
  ]) {
    assert.equal(isSafeMacOSRelativePath(value), true, value);
  }
  for (const value of ["", "/runtime.pkg", "../runtime.pkg", "packages/../runtime.pkg", "runtime.pkg\0payload", "a//b", "a/./b"]) {
    assert.equal(isSafeMacOSRelativePath(value), false, value);
  }
  assert.throws(
    () => validateRuntimeManifest(validManifest({
      runtimeId: "openclaw-2026.7.1-2-macos-arm64",
      target: "macos-arm64",
      targetPlatform: "darwin",
      targetArch: "arm64",
      entrypoint: "Electron.app/Contents/MacOS/Electron",
      criticalFiles: [
        { path: "Electron.app/Contents/MacOS/Electron", size: 8, sha256: "c".repeat(64) },
        { path: "Electron.app/Contents/MacOS/electron", size: 8, sha256: "d".repeat(64) },
      ],
    })),
    /criticalFiles/,
  );
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

test("keeps activation mode outside the signed runtime manifest", () => {
  for (const argument of [
    "--uclaw-startup-mode",
    "--uclaw-startup-mode=activation-only",
    "--uclaw-startup-mode=normal",
    "--uclaw-startup-mode-shadow",
  ]) {
    assert.throws(
      () => validateRuntimeManifest(validManifest({ entryArgs: ["resources/app.asar", argument] })),
      /entryArgs.*startup mode/i,
    );
  }
  assert.throws(
    () => validateRuntimeManifest({ ...validManifest(), activationEntrypoint: "electron/activation.exe" }),
    /unexpected field/,
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

test("uses v3 signing payload when target is explicit", () => {
  const manifest = validManifest({
    target: "macos-arm64",
    targetPlatform: "darwin",
    targetArch: "arm64",
    runtimeId: "openclaw-2026.7.1-2-macos-arm64",
    entrypoint: "Electron.app/Contents/MacOS/Electron",
    criticalFiles: [{ path: "Electron.app/Contents/MacOS/Electron", size: 8, sha256: "c".repeat(64) }],
    signature: {
      algorithm: "ed25519",
      keyId: "fixture",
      signedAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2027-08-09T00:00:00.000Z",
      sequence: 42,
      value: "",
    },
  });
  assert.match(runtimeManifestSigningPayload(manifest).toString("utf8"), /uclaw-runtime-manifest-v3/);
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
  assert.equal(createHash("sha256").update(runtimeManifestSigningPayload(manifest)).digest("hex"), "1d5df2ef301f1e28f55707eaa8a427e3308c2ce8d7a124cfbaac5389db4e9a77");
});
