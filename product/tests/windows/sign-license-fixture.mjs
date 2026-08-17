import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function readArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) throw new Error("invalid arguments");
    values.set(name.slice(2), value);
  }
  if (values.size !== 2 || !values.has("license-dir") || !values.has("trusted-keys")) {
    throw new Error("expected --license-dir and --trusted-keys");
  }
  return values;
}

function secretDigest(secret, salt) {
  return createHash("sha256")
    .update(Buffer.from("uclaw-startup-secret-v1\0", "utf8"))
    .update(salt)
    .update(Buffer.from([0]))
    .update(Buffer.from(secret, "utf8"))
    .digest("hex");
}

async function main() {
  const args = readArguments(process.argv.slice(2));
  const licenseDir = path.resolve(args.get("license-dir"));
  const trustedKeysPath = path.resolve(args.get("trusted-keys"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = "test-license-key";
  const startupSecret = randomBytes(32).toString("base64url");
  const salt = randomBytes(16);
  const now = Date.now();
  const credential = {
    schemaVersion: 1,
    deviceId: "dev_windows_fixture_001",
    licenseId: "lic_windows_fixture_001",
    startupSecret,
  };
  const license = {
    schemaVersion: 1,
    usernameId: "usr_windows_fixture_001",
    deviceId: credential.deviceId,
    licenseId: credential.licenseId,
    usbFingerprint: { scheme: "uclaw-usb-v1", sha256: "f".repeat(64) },
    startupSecretProof: {
      algorithm: "sha256-salt-v1",
      startupSecretSalt: salt.toString("hex"),
      startupSecretHash: secretDigest(startupSecret, salt),
    },
    notBefore: new Date(now - 5 * 60_000).toISOString(),
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
    revision: 1,
    signature: { algorithm: "ed25519", keyId, value: "" },
  };
  const payload = [
    "uclaw-startup-license-v1", license.schemaVersion, license.signature.keyId,
    license.usernameId, license.deviceId, license.licenseId,
    license.usbFingerprint.scheme, license.usbFingerprint.sha256,
    license.startupSecretProof.startupSecretSalt, license.startupSecretProof.startupSecretHash,
    license.notBefore, license.expiresAt, license.revision,
  ];
  license.signature.value = sign(null, Buffer.from(JSON.stringify(payload), "utf8"), privateKey).toString("base64");
  const checkedAt = new Date(now).toISOString();
  const status = {
    licenseId: credential.licenseId,
    deviceId: credential.deviceId,
    status: "active",
    revision: 1,
    notBefore: license.notBefore,
    expiresAt: license.expiresAt,
    replacementLicenseId: null,
    updatedAt: checkedAt,
  };
  const statusPayload = [
    "uclaw-license-status-v1", 1, status.licenseId, status.deviceId, status.status, status.revision,
    status.notBefore, status.expiresAt, status.replacementLicenseId, status.updatedAt, checkedAt, license.expiresAt, keyId,
  ];
  const encodedStatus = Buffer.from(JSON.stringify(statusPayload), "utf8").toString("base64url");
  const statusReceipt = `${encodedStatus}.${sign(null, Buffer.from(JSON.stringify(statusPayload), "utf8"), privateKey).toString("base64url")}`;
  const publicJwk = publicKey.export({ format: "jwk" });
  if (typeof publicJwk.x !== "string") throw new Error("fixture public key export failed");

  await mkdir(licenseDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(licenseDir, ".startup-credential.json"), `${JSON.stringify(credential)}\n`, { mode: 0o600 }),
    writeFile(path.join(licenseDir, "license.json"), `${JSON.stringify(license)}\n`, { mode: 0o600 }),
    writeFile(path.join(licenseDir, ".status-response.json"), `${JSON.stringify({ status, receipt: { value: statusReceipt } })}\n`, { mode: 0o600 }),
    writeFile(trustedKeysPath, `${JSON.stringify({ [keyId]: Buffer.from(publicJwk.x, "base64url").toString("base64") })}\n`, { mode: 0o600 }),
  ]);
}

main().catch(() => {
  process.stderr.write("License fixture generation failed\n");
  process.exitCode = 1;
});
