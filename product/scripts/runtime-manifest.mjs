import { readFileSync } from "node:fs";
import { sign, verify } from "node:crypto";

import Ajv2020 from "ajv/dist/2020.js";

const schemaUrl = new URL("../packaging/runtime-manifest.schema.json", import.meta.url);
const schema = JSON.parse(readFileSync(schemaUrl, "utf8"));
const validateSchema = new Ajv2020({ allErrors: true, formats: { "date-time": true } }).compile(schema);

const invalidWindowsCharacters = /[<>:"|?*\u0000-\u001f\u007f]/u;
const windowsDeviceName = /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;

function schemaErrorFields(errors) {
  return [...new Set(errors.map((error) => {
    const path = error.instancePath.replaceAll("/", ".").replace(/^\./u, "");
    if (error.keyword === "required") return error.params.missingProperty;
    if (error.keyword === "additionalProperties") return error.params.additionalProperty;
    return path || "manifest";
  }))];
}

export function isSafeWindowsRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 32767) return false;
  if (value.startsWith("/") || value.startsWith("\\") || invalidWindowsCharacters.test(value)) return false;

  const segments = value.replaceAll("\\", "/").split("/");
  return segments.every((segment) => {
    if (segment.length === 0 || segment === "." || segment === "..") return false;
    if (segment.endsWith(".") || segment.endsWith(" ")) return false;
    const baseName = segment.split(".", 1)[0];
    return !windowsDeviceName.test(baseName);
  });
}

export function validateRuntimeManifest(value) {
  if (!validateSchema(value)) {
    const fields = schemaErrorFields(validateSchema.errors ?? []);
    const hasUnexpected = (validateSchema.errors ?? []).some(
      (error) => error.keyword === "additionalProperties",
    );
    throw new Error(
      hasUnexpected
        ? `${fields.join(", ")}: unexpected field`
        : `invalid runtime manifest: ${fields.join(", ")}`,
    );
  }
  for (const field of ["runtimeArchive", "entrypoint"]) {
    if (!isSafeWindowsRelativePath(value[field])) {
      throw new Error(`${field}: unsafe Windows relative path`);
    }
  }
  if (value.entryArgs.some((argument) => argument.includes("\0"))) {
    throw new Error("entryArgs: NUL is forbidden");
  }
  return value;
}

export function runtimeManifestSigningPayload(value) {
  if (!value.signature) throw new Error("runtime manifest signature metadata is required");
  const signature = value.signature;
  return Buffer.from(JSON.stringify([
    "uclaw-runtime-manifest-v1",
    value.schemaVersion, value.productVersion, value.nodeVersion, value.electronVersion,
    value.runtimeVersion, value.runtimeId, value.targetPlatform, value.targetArch,
    value.runtimeArchive, value.runtimeSha256, value.runtimeTreeSha256, value.runtimeBytes,
    value.unpackedBytes, value.fileCount, value.entrypoint, value.entryArgs,
    signature.algorithm, signature.keyId, signature.signedAt, signature.expiresAt,
    signature.sequence,
  ]));
}

export function signRuntimeManifest(manifest, { keyId, privateKey, signedAt, expiresAt, sequence }) {
  validateRuntimeManifest(manifest);
  if (manifest.signature !== undefined) throw new Error("runtime manifest is already signed");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(keyId) || !Number.isSafeInteger(sequence) || sequence < 1) throw new Error("invalid runtime signing metadata");
  const signedTime = new Date(signedAt); const expiryTime = new Date(expiresAt);
  if (!Number.isFinite(signedTime.getTime()) || !Number.isFinite(expiryTime.getTime()) || expiryTime <= signedTime) throw new Error("invalid runtime signature lifetime");
  const signature = { algorithm: "ed25519", keyId, signedAt: signedTime.toISOString(), expiresAt: expiryTime.toISOString(), sequence, value: "" };
  const value = sign(null, runtimeManifestSigningPayload({ ...manifest, signature }), privateKey).toString("base64");
  return validateRuntimeManifest({ ...manifest, signature: { ...signature, value } });
}

export function validateSignedRuntimeManifest(value) {
  const manifest = validateRuntimeManifest(value);
  if (manifest.signature === undefined) throw new Error("runtime manifest signature is required");
  return manifest;
}

export function verifySignedRuntimeManifest(value, trustedPublicKeys) {
  const manifest = validateSignedRuntimeManifest(value);
  const publicKey = trustedPublicKeys?.[manifest.signature.keyId];
  if (!publicKey || !verify(null, runtimeManifestSigningPayload(manifest), publicKey, Buffer.from(manifest.signature.value, "base64"))) {
    throw new Error("runtime manifest signature verification failed");
  }
  return manifest;
}
