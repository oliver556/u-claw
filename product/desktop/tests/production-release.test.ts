import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createProductionReleaseService, parseProductionReleaseConfig, readBoundedResponseText, writeBoundedResponseBody } from "../src/release/production-release.js";

const body = (...chunks: string[]) => new ReadableStream<Uint8Array>({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
    controller.close();
  },
});

describe("production release download", () => {
  it("writes exactly the signed byte count", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-download-"));
    const target = join(root, "runtime.pkg");
    await writeBoundedResponseBody(body("run", "time"), target, 7, new AbortController().signal);
    expect(await readFile(target, "utf8")).toBe("runtime");
  });

  it.each([["oversized", ["runtime", "overflow"], 7], ["truncated", ["run"], 7]])("rejects %s bodies and removes partial files", async (_name, chunks, expected) => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-download-"));
    const target = join(root, "runtime.pkg");
    await expect(writeBoundedResponseBody(body(...chunks), target, expected, new AbortController().signal)).rejects.toThrow(/size/i);
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("production release manifest response", () => {
  it("cancels a headerless response as soon as the manifest exceeds 1 MiB", async () => {
    let cancelled = false;
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.alloc(1_048_577)); },
      cancel() { cancelled = true; },
    });
    await expect(readBoundedResponseText(responseBody, 1_048_576, new AbortController().signal)).rejects.toThrow(/large/i);
    expect(cancelled).toBe(true);
  });
});

describe("production release configuration", () => {
  const rawPublicKey = () => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");

  it("fails closed when the trust root or feed is missing", async () => {
    expect(parseProductionReleaseConfig({})).toMatchObject({ ok: false, message: "发布更新配置缺失。" });
    expect(parseProductionReleaseConfig({
      UCLAW_RELEASE_TRUSTED_PUBLIC_KEYS: JSON.stringify({ "release-2026": rawPublicKey() }),
    })).toMatchObject({ ok: false, message: "发布更新配置缺失。" });
  });

  it.each([
    ["non-HTTPS feed", { UCLAW_RELEASE_TRUSTED_PUBLIC_KEYS: JSON.stringify({ "release-2026": rawPublicKey() }), UCLAW_RELEASE_BASE_URL: "http://updates.example.test/" }],
    ["credentialed feed", { UCLAW_RELEASE_TRUSTED_PUBLIC_KEYS: JSON.stringify({ "release-2026": rawPublicKey() }), UCLAW_RELEASE_BASE_URL: "https://user:pass@updates.example.test/" }],
    ["malformed key", { UCLAW_RELEASE_TRUSTED_PUBLIC_KEYS: JSON.stringify({ "release-2026": "not-a-key" }), UCLAW_RELEASE_BASE_URL: "https://updates.example.test/" }],
    ["invalid revoked list", { UCLAW_RELEASE_TRUSTED_PUBLIC_KEYS: JSON.stringify({ "release-2026": rawPublicKey() }), UCLAW_RELEASE_REVOKED_KEY_IDS: "{}", UCLAW_RELEASE_BASE_URL: "https://updates.example.test/" }],
  ])("rejects %s", (_name, source) => {
    expect(parseProductionReleaseConfig(source)).toMatchObject({ ok: false, message: "发布更新配置无效。" });
  });

  it("uses valid injected configuration on the production fetch path", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-production-release-"));
    const cacheDir = join(root, "host", "cache");
    const dataDir = join(root, "portable", ".uclaw", "data");
    await mkdir(cacheDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ invalid: true }), {
      status: 200,
      headers: { "content-length": "16" },
    }));
    const service = createProductionReleaseService({ cacheDir, dataDir } as never, {
      UCLAW_RELEASE_TRUSTED_PUBLIC_KEYS: JSON.stringify({ "release-2026": rawPublicKey() }),
      UCLAW_RELEASE_REVOKED_KEY_IDS: JSON.stringify([]),
      UCLAW_RELEASE_BASE_URL: "https://updates.example.test/releases/",
    }, fetchImpl);

    expect(await service.check("stable")).toMatchObject({ state: "unavailable", retryable: false, message: "更新签名或兼容性验证失败。" });
    expect(fetchImpl).toHaveBeenCalledWith(new URL("https://updates.example.test/releases/stable.json"), expect.objectContaining({ redirect: "error", credentials: "omit" }));
  });

  it("reports configuration failure without attempting network access", async () => {
    const fetchImpl = vi.fn();
    const service = createProductionReleaseService({ cacheDir: "cache", dataDir: "data" } as never, {}, fetchImpl);
    expect(await service.check("stable")).toMatchObject({ state: "unavailable", retryable: false, message: "发布更新配置缺失。" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
