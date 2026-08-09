import { dirname } from "node:path";
import { open, rm } from "node:fs/promises";

import type { PortableDesktopPaths } from "../portable-paths.js";
import { createReleaseService } from "./release-service.js";

// Release builds inject public keys and a fixed feed in source/build configuration. Empty defaults fail closed.
const TRUSTED_RELEASE_PUBLIC_KEYS: Record<string, string> = {};
const REVOKED_RELEASE_KEY_IDS = new Set<string>();
const RELEASE_BASE_URL: string | undefined = undefined;

export async function writeBoundedResponseBody(body: ReadableStream<Uint8Array>, target: string, expectedBytes: number, signal: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1) throw new Error("Invalid signed package size.");
  const handle = await open(target, "wx", 0o600);
  const reader = body.getReader();
  let written = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      written += value.byteLength;
      if (written > expectedBytes) throw new Error("Runtime download size exceeded signed manifest.");
      await handle.writeFile(value);
    }
    if (written !== expectedBytes) throw new Error("Runtime download size did not match signed manifest.");
    await handle.sync();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    await handle.close().catch(() => undefined);
    await rm(target, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
}

export function createProductionReleaseService(paths: PortableDesktopPaths) {
  return createReleaseService({
    currentVersion: "0.1.0",
    channel: "stable",
    platform: "win32",
    arch: "x64",
    runtimeId: "openclaw-2026.7.1-2-win-x64",
    cacheRoot: dirname(paths.cacheDir),
    packageRoot: dirname(paths.dataDir),
    trustedKeys: TRUSTED_RELEASE_PUBLIC_KEYS,
    revokedKeyIds: REVOKED_RELEASE_KEY_IDS,
    async fetchManifest(channel, signal) {
      if (!RELEASE_BASE_URL) throw Object.assign(new Error("Release feed is not configured."), { code: "ENOTFOUND" });
      const response = await fetch(new URL(`${channel}.json`, RELEASE_BASE_URL), { signal, redirect: "error", credentials: "omit" });
      if (!response.ok) throw new Error("Release feed request failed.");
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (contentLength > 1_048_576) throw new Error("Release manifest is too large.");
      const text = await response.text();
      if (Buffer.byteLength(text) > 1_048_576) throw new Error("Release manifest is too large.");
      return JSON.parse(text) as never;
    },
    async download(manifest, target, signal) {
      if (!RELEASE_BASE_URL) throw new Error("Release feed is not configured.");
      const response = await fetch(new URL(`packages/${encodeURIComponent(manifest.id)}/runtime.pkg`, RELEASE_BASE_URL), { signal, redirect: "error", credentials: "omit" });
      if (!response.ok || !response.body) throw new Error("Runtime download failed.");
      await writeBoundedResponseBody(response.body, target, manifest.package.bytes, signal);
    },
  });
}
