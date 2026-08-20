import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import test from "node:test";

const execFileAsync = promisify(execFile);
const productRoot = path.resolve(import.meta.dirname, "../..");

/** 锁定 fixture license 与 Go launcher 共用的 canonical payload。 */
test("Windows fixture license uses launcher-compatible canonical timestamps and signature", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-license-fixture-test-"));
  try {
    const licenseDir = path.join(root, "license");
    const trustedKeysPath = path.join(root, "trusted.json");
    await execFileAsync(process.execPath, [
      path.join(productRoot, "tests/windows/sign-license-fixture.mjs"),
      "--license-dir", licenseDir,
      "--trusted-keys", trustedKeysPath,
    ]);

    const license = JSON.parse(await readFile(path.join(licenseDir, "license.json"), "utf8"));
    const trustedKeys = JSON.parse(await readFile(trustedKeysPath, "utf8"));
    assert.match(license.notBefore, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
    assert.match(license.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);

    const payload = [
      "uclaw-startup-license-v1", license.schemaVersion, license.signature.keyId,
      license.usernameId, license.deviceId, license.licenseId,
      license.usbFingerprint.scheme, license.usbFingerprint.sha256,
      license.startupSecretProof.startupSecretSalt, license.startupSecretProof.startupSecretHash,
      license.notBefore, license.expiresAt, license.revision,
    ];
    const publicKey = createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: Buffer.from(trustedKeys[license.signature.keyId], "base64").toString("base64url"),
      },
      format: "jwk",
    });
    assert.equal(
      verify(null, Buffer.from(JSON.stringify(payload), "utf8"), publicKey, Buffer.from(license.signature.value, "base64")),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
