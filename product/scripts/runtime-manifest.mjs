import { readFileSync } from "node:fs";
import { sign, verify } from "node:crypto";

import Ajv2020 from "ajv/dist/2020.js";

const schemaUrl = new URL("../packaging/runtime-manifest.schema.json", import.meta.url);
const schema = JSON.parse(readFileSync(schemaUrl, "utf8"));
const validateSchema = new Ajv2020({ allErrors: true, formats: { "date-time": true } }).compile(schema);

const invalidWindowsCharacters = /[<>:"|?*\u0000-\u001f\u007f]/u;
const windowsDeviceName = /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;

export const runtimeTargets = Object.freeze({
  "win-x64": Object.freeze({ targetPlatform: "win32", targetArch: "x64" }),
  "macos-arm64": Object.freeze({ targetPlatform: "darwin", targetArch: "arm64" }),
});

function schemaErrorFields(errors) {
  return [...new Set(errors.map((error) => {
    const path = error.instancePath.replaceAll("/", ".").replace(/^\./u, "");
    if (error.keyword === "required") return error.params.missingProperty;
    if (error.keyword === "additionalProperties") return error.params.additionalProperty;
    return path || "manifest";
  }))];
}

export function runtimeTargetForPlatformArch(targetPlatform, targetArch) {
  return Object.entries(runtimeTargets).find(
    ([, target]) => target.targetPlatform === targetPlatform && target.targetArch === targetArch,
  )?.[0];
}

export function runtimeManifestTarget(value) {
  const inferred = runtimeTargetForPlatformArch(value?.targetPlatform, value?.targetArch);
  if (!inferred) throw new Error("targetPlatform/targetArch: unsupported runtime target");
  if (value.target !== undefined && value.target !== inferred) throw new Error("target: must match targetPlatform and targetArch");
  return value.target ?? inferred;
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

export function isSafeMacOSRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 32767) return false;
  if (value.startsWith("/") || value.includes("\0")) return false;

  return value.split("/").every((segment) => (
    segment.length > 0 && segment !== "." && segment !== ".."
  ));
}

function targetPathValidator(target) {
  return target === "win-x64" ? isSafeWindowsRelativePath : isSafeMacOSRelativePath;
}

function canonicalRuntimePath(target, value) {
  const normalized = value.replaceAll("\\", "/");
  return target === "win-x64" ? normalized.toLowerCase() : normalized.normalize("NFC").toLowerCase();
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
  const target = runtimeManifestTarget(value);
  const isSafeRuntimePath = targetPathValidator(target);
  for (const field of ["runtimeArchive", "entrypoint", ...value.criticalFiles.map((file) => file.path)]) {
    const candidate = field === "runtimeArchive" || field === "entrypoint" ? value[field] : field;
    if (!isSafeRuntimePath(candidate)) {
      throw new Error(`${field}: unsafe ${target} relative path`);
    }
  }
  if (value.entryArgs.some((argument) => argument.includes("\0"))) {
    throw new Error("entryArgs: NUL is forbidden");
  }
  if (value.entryArgs.some((argument) => argument.startsWith("--uclaw-startup-mode"))) {
    throw new Error("entryArgs: startup mode is launcher-owned");
  }
  const canonicalCritical = value.criticalFiles.map((file) => canonicalRuntimePath(target, file.path));
  if (new Set(canonicalCritical).size !== canonicalCritical.length || !canonicalCritical.includes(canonicalRuntimePath(target, value.entrypoint))) {
    throw new Error("criticalFiles: must uniquely include entrypoint");
  }
  if (value.signature && value.signature.sequence !== value.releaseSequence) {
    throw new Error("signature.sequence: must equal releaseSequence");
  }
  return value;
}

export function runtimeManifestSigningPayload(value) {
  if (!value.signature) throw new Error("runtime manifest signature metadata is required");
  const signature = value.signature;
  if (value.target !== undefined) {
    return Buffer.from(JSON.stringify([
      "uclaw-runtime-manifest-v3",
      value.schemaVersion, value.releaseId, value.releaseSequence, value.productVersion, value.nodeVersion, value.electronVersion,
      value.runtimeVersion, value.runtimeId, value.targetPlatform, value.targetArch, value.target,
      value.runtimeArchive, value.runtimeSha256, value.runtimeTreeSha256, value.runtimeBytes,
      value.unpackedBytes, value.fileCount, value.entrypoint, value.entryArgs, value.criticalFiles,
      signature.algorithm, signature.keyId, signature.signedAt, signature.expiresAt,
      signature.sequence,
    ]));
  }
  return Buffer.from(JSON.stringify([
    "uclaw-runtime-manifest-v2",
    value.schemaVersion, value.releaseId, value.releaseSequence, value.productVersion, value.nodeVersion, value.electronVersion,
    value.runtimeVersion, value.runtimeId, value.targetPlatform, value.targetArch,
    value.runtimeArchive, value.runtimeSha256, value.runtimeTreeSha256, value.runtimeBytes,
    value.unpackedBytes, value.fileCount, value.entrypoint, value.entryArgs, value.criticalFiles,
    signature.algorithm, signature.keyId, signature.signedAt, signature.expiresAt,
    signature.sequence,
  ]));
}

export function signRuntimeManifest(manifest, { keyId, privateKey, signedAt, expiresAt, sequence }) {
  validateRuntimeManifest(manifest);
  if (manifest.signature !== undefined) throw new Error("runtime manifest is already signed");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(keyId) || !Number.isSafeInteger(sequence) || sequence < 1 || manifest.releaseSequence !== sequence) throw new Error("invalid runtime signing metadata");
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
