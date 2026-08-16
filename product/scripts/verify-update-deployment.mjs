import { createHash, verify } from "node:crypto";
import { get } from "node:https";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { releaseSigningPayload } from "../packaging/build-update-feed.mjs";

const maxManifestBytes = 1 << 20;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;

export async function verifyUpdateDeployment(options) {
  const baseURL = parseBaseURL(options.baseURL);
  if (!options.publicKey) throw new Error("release public key is required");
  const manifestURL = new URL("stable.json", baseURL);
  const manifestResponse = await request(manifestURL, options);
  const manifestBytes = await readBounded(manifestResponse, maxManifestBytes, "release manifest");
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes);
  } catch {
    throw new Error("release manifest is invalid JSON");
  }
  validateManifest(manifest, options.publicKey);

  const packageURL = new URL(`packages/${encodeURIComponent(manifest.id)}/runtime.pkg`, baseURL);
  const packageResponse = await request(packageURL, options);
  const declaredLength = contentLength(packageResponse);
  if (declaredLength !== null && declaredLength !== manifest.package.bytes) {
    packageResponse.destroy();
    throw new Error("runtime package Content-Length does not match signed size");
  }
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of packageResponse) {
    bytes += chunk.length;
    if (bytes > manifest.package.bytes) {
      packageResponse.destroy();
      throw new Error("runtime package exceeds signed size");
    }
    digest.update(chunk);
  }
  if (bytes !== manifest.package.bytes) throw new Error("runtime package length does not match signed size");
  if (digest.digest("hex") !== manifest.package.sha256) throw new Error("runtime package SHA-256 does not match manifest");
  return { id: manifest.id, version: manifest.version, bytes };
}

function parseBaseURL(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("update base URL is invalid");
  }
  if (url.protocol !== "https:") throw new Error("update base URL must use HTTPS");
  if (url.username || url.password) throw new Error("update base URL must not contain credentials");
  if (url.search || url.hash || !url.pathname.endsWith("/")) throw new Error("update base URL must be a clean directory URL");
  return url;
}

function request(url, options) {
  return new Promise((resolve, reject) => {
    const request = get(url, {
      ca: options.ca,
      headers: { accept: "application/octet-stream, application/json" },
      rejectUnauthorized: true,
      timeout: options.timeoutMs ?? 15_000,
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`update endpoint returned status ${response.statusCode}`));
        return;
      }
      if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
        response.resume();
        reject(new Error("update endpoint must not transform signed bytes"));
        return;
      }
      resolve(response);
    });
    request.once("timeout", () => request.destroy(new Error("update endpoint timed out")));
    request.once("error", reject);
  });
}

async function readBounded(response, limit, label) {
  const declaredLength = contentLength(response);
  if (declaredLength !== null && declaredLength > limit) {
    response.destroy();
    throw new Error(`${label} is too large`);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > limit) {
      response.destroy();
      throw new Error(`${label} is too large`);
    }
    chunks.push(chunk);
  }
  if (declaredLength !== null && bytes !== declaredLength) throw new Error(`${label} Content-Length is incorrect`);
  return Buffer.concat(chunks, bytes);
}

function contentLength(response) {
  const value = response.headers["content-length"];
  if (value === undefined) return null;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new Error("update endpoint returned invalid Content-Length");
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw new Error("update endpoint returned invalid Content-Length");
  return length;
}

function validateManifest(manifest, publicKey) {
  const signature = manifest?.signature;
  if (!signature || signature.algorithm !== "ed25519" || !identifierPattern.test(signature.keyId ?? "") || typeof signature.value !== "string") {
    throw new Error("release manifest signature metadata is invalid");
  }
  let valid = false;
  try {
    valid = verify(null, releaseSigningPayload(manifest), publicKey, Buffer.from(signature.value, "base64"));
  } catch {
    valid = false;
  }
  if (!valid) throw new Error("release manifest signature verification failed");
  if (manifest.channel !== "stable" || !identifierPattern.test(manifest.id ?? "") || typeof manifest.version !== "string") {
    throw new Error("release manifest identity is invalid");
  }
  if (!Number.isSafeInteger(manifest.package?.bytes) || manifest.package.bytes < 1 || !digestPattern.test(manifest.package.sha256 ?? "")) {
    throw new Error("release manifest package bounds are invalid");
  }
}

async function runCLI() {
  const { values } = parseArgs({ options: {
    "base-url": { type: "string" },
    "public-key-file": { type: "string" },
  } });
  if (!values["base-url"] || !values["public-key-file"]) throw new Error("--base-url and --public-key-file are required");
  const result = await verifyUpdateDeployment({
    baseURL: values["base-url"],
    publicKey: await readFile(values["public-key-file"], "utf8"),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCLI().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
