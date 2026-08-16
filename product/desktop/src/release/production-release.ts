import { createPublicKey } from "node:crypto";
import { dirname, join } from "node:path";
import { open, rm } from "node:fs/promises";

import type { PortableDesktopPaths } from "../portable-paths.js";
import { createReleaseService } from "./release-service.js";
import { createLauncherReleaseFSHelper } from "./release-fs-helper.js";

type ProductionReleaseConfigSource = Readonly<Record<string, string | undefined>>;

interface ProductionReleaseConfig {
  trustedKeys: Record<string, string>;
  revokedKeyIds: Set<string>;
  baseUrl: URL;
}

type ProductionReleaseConfigResult =
  | { ok: true; value: ProductionReleaseConfig }
  | { ok: false; message: string };

const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
const productionReleaseBaseURL = "https://updates.yiyong.me/releases/";

export function parseProductionReleaseConfig(source: ProductionReleaseConfigSource): ProductionReleaseConfigResult {
  const encodedKeys = source.UCLAW_RELEASE_TRUSTED_PUBLIC_KEYS;
  const testFeed = source.NODE_ENV === "test" ? source.UCLAW_TEST_RELEASE_FEED_URL : undefined;
  const feed = testFeed ?? source.UCLAW_RELEASE_BASE_URL;
  if (!encodedKeys || !feed) return { ok: false, message: "发布更新配置缺失。" };
  try {
    const parsedKeys = JSON.parse(encodedKeys) as unknown;
    const parsedRevoked = JSON.parse(source.UCLAW_RELEASE_REVOKED_KEY_IDS ?? "[]") as unknown;
    if (!parsedKeys || typeof parsedKeys !== "object" || Array.isArray(parsedKeys) || !Array.isArray(parsedRevoked)) throw new Error("invalid release configuration");
    const keyEntries = Object.entries(parsedKeys as Record<string, unknown>);
    if (keyEntries.length < 1 || keyEntries.length > 16 || parsedRevoked.length > 64) throw new Error("invalid release configuration");
    const trustedKeys: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [keyId, encodedKey] of keyEntries) {
      if (!keyIdPattern.test(keyId) || typeof encodedKey !== "string" || encodedKey.length > 128) throw new Error("invalid release key");
      const rawKey = Buffer.from(encodedKey, "base64");
      if (rawKey.length !== 32 || rawKey.toString("base64") !== encodedKey) throw new Error("invalid release key");
      trustedKeys[keyId] = createPublicKey({ key: Buffer.concat([ed25519SpkiPrefix, rawKey]), format: "der", type: "spki" })
        .export({ format: "pem", type: "spki" }).toString();
    }
    if (!parsedRevoked.every((keyId) => typeof keyId === "string" && keyIdPattern.test(keyId))) throw new Error("invalid revocation list");
    const baseUrl = new URL(feed);
    if (testFeed) {
      if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || !baseUrl.pathname.endsWith("/")) throw new Error("invalid test release feed");
    } else if (baseUrl.href !== productionReleaseBaseURL) throw new Error("invalid production release feed");
    return { ok: true, value: { trustedKeys, revokedKeyIds: new Set(parsedRevoked as string[]), baseUrl } };
  } catch {
    return { ok: false, message: "发布更新配置无效。" };
  }
}

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

export async function readBoundedResponseText(body: ReadableStream<Uint8Array>, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid response size limit.");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("Release manifest is too large.");
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function createProductionReleaseService(
  paths: PortableDesktopPaths,
  source: ProductionReleaseConfigSource = process.env,
  fetchImpl: typeof fetch = fetch,
  runMutation?: <T>(operation: () => Promise<T>) => Promise<T>,
) {
  const parsed = parseProductionReleaseConfig(source);
  const configuration = parsed.ok ? parsed.value : undefined;
  const packageRoot = dirname(paths.dataDir);
  const releaseFS = createLauncherReleaseFSHelper({
    launcherPath: join(dirname(packageRoot), "U-Claw.exe"),
    packageRoot,
    cacheRoot: dirname(paths.cacheDir),
  });
  return createReleaseService({
    currentVersion: "0.1.0",
    channel: "stable",
    platform: "win32",
    arch: "x64",
    runtimeId: "openclaw-2026.7.1-2-win-x64",
    cacheRoot: dirname(paths.cacheDir),
    packageRoot,
    trustedKeys: configuration?.trustedKeys ?? {},
    revokedKeyIds: configuration?.revokedKeyIds ?? new Set(),
    configurationError: parsed.ok ? undefined : parsed.message,
    runMutation,
    async fetchManifest(channel, signal) {
      if (!configuration) throw new Error("Release feed is not configured.");
      const response = await fetchImpl(new URL(`${channel}.json`, configuration.baseUrl), { signal, redirect: "error", credentials: "omit" });
      if (!response.ok) throw new Error("Release feed request failed.");
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (contentLength > 1_048_576) throw new Error("Release manifest is too large.");
      if (!response.body) throw new Error("Release manifest response is empty.");
      const text = await readBoundedResponseText(response.body, 1_048_576, signal);
      return JSON.parse(text) as never;
    },
    async download(manifest, target, signal) {
      if (!configuration) throw new Error("Release feed is not configured.");
      const response = await fetchImpl(new URL(`packages/${encodeURIComponent(manifest.id)}/runtime.pkg`, configuration.baseUrl), { signal, redirect: "error", credentials: "omit" });
      if (!response.ok || !response.body) throw new Error("Runtime download failed.");
      await writeBoundedResponseBody(response.body, target, manifest.package.bytes, signal);
    },
    async secureInstall(manifest, signal) {
      if (!configuration) throw new Error("Release feed is not configured.");
      const response = await fetchImpl(new URL(`packages/${encodeURIComponent(manifest.id)}/runtime.pkg`, configuration.baseUrl), { signal, redirect: "error", credentials: "omit" });
      if (!response.ok || !response.body) throw new Error("Runtime download failed.");
      await releaseFS.secureInstall(manifest.runtimeManifest, response.body, signal);
    },
    secureCleanup: (child) => releaseFS.secureCleanup(child),
  });
}
