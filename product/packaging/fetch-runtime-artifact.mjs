import { createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import path from "node:path";

export async function fetchRuntimeArtifact({ url, output, sha256, maxBytes, trustedCa }) {
  const targetURL = validateURL(url);
  validateSHA256(sha256);
  validateMaxBytes(maxBytes);
  const outputPath = path.resolve(output);
  await requireMissing(outputPath, "runtime artifact output already exists");
  await mkdir(path.dirname(outputPath), { recursive: true });

  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}-${randomBytes(16).toString("hex")}.tmp`,
  );
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      const response = await request(targetURL, trustedCa);
      if (response.statusCode !== 200) {
        response.resume();
        throw new Error("runtime artifact response status must be 200");
      }

      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of response) {
        bytes += chunk.length;
        if (!Number.isSafeInteger(bytes) || bytes > maxBytes) {
          response.destroy();
          throw new Error("runtime artifact exceeds maxBytes");
        }
        hash.update(chunk);
        await writeAll(handle, chunk);
      }
      if (hash.digest("hex") !== sha256) throw new Error("runtime artifact SHA-256 mismatch");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, outputPath);
    } catch (error) {
      if (error.code === "EEXIST") throw new Error("runtime artifact output already exists");
      throw error;
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function validateURL(value) {
  if (typeof value !== "string") throw new Error("runtime artifact URL is invalid");
  const hasRawQueryOrFragment = value.includes("?") || value.includes("#");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("runtime artifact URL is invalid");
  }
  if (url.protocol !== "https:") throw new Error("runtime artifact URL must use HTTPS");
  if (url.username || url.password) throw new Error("runtime artifact URL must not include credentials");
  if (hasRawQueryOrFragment || url.search || url.hash) throw new Error("runtime artifact URL must not include query or fragment");
  return url;
}

function validateSHA256(value) {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("runtime artifact SHA-256 must be 64 lowercase hex characters");
  }
}

function validateMaxBytes(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("runtime artifact maxBytes must be a positive safe integer");
  }
}

async function requireMissing(target, message) {
  const info = await lstat(target).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info) throw new Error(message);
}

function request(url, trustedCa) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { ca: trustedCa, method: "GET" }, resolve);
    request.once("error", reject);
    request.end();
  });
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    offset += bytesWritten;
  }
}
