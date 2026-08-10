import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PluginDetail } from "@uclaw/shared";

import { createFixturePluginRegistryClient } from "../src/plugins/fixture-client.js";
import { createFixturePluginRuntime } from "../src/plugins/fixture-runtime.js";
import { createPluginService } from "../src/plugins/plugin-service.js";
import { createLivePluginRegistryClient, createUnavailablePluginRegistryClient } from "../src/plugins/registry-client.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const permissionFingerprint = createHash("sha256").update("[]").digest("hex");
const detail = (integritySha256 = "0".repeat(64), version = "1.2.0"): PluginDetail => ({
  packageKind: "plugin",
  slug: "openclaw-calendar",
  name: "Calendar",
  description: "Calendar integration",
  version,
  installedVersion: null,
  enabled: false,
  updateAvailable: false,
  source: { provider: "external", url: "https://plugins.openclaw.ai/openclaw-calendar", packaged: true },
  integritySha256,
  integrityVerified: true,
  managedByUClaw: false,
  availability: "installable",
  compatibility: { state: "compatible", openClawVersion: "2026.7.1-2" },
  permissions: [],
  permissionFingerprint,
  risk: "low",
  nativeCode: false,
  commandExecution: false,
  mode: "live",
  manifest: {
    id: "openclaw-calendar",
    configSchema: { type: "object" },
    packageName: "@uclaw/openclaw-calendar",
    entry: "./dist/index.js",
    minHostVersion: ">=2026.7.1-2",
    pluginApi: ">=2026.7.1-2",
  },
});

const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), {
  ...init,
  status: 200,
  headers: { "content-type": "application/json", ...init.headers },
});

describe("Live Plugin registry client", () => {
  it("fails closed when production registry configuration is unavailable", async () => {
    const client = createUnavailablePluginRegistryClient("Plugin registry URL is not configured.");

    expect(client).toMatchObject({ mode: "live", repositoryVerified: false });
    for (const operation of [
      client.search({ query: "", cursor: null, pageSize: 20 }),
      client.detail("openclaw-calendar"),
      client.download("openclaw-calendar"),
    ]) {
      await expect(operation).rejects.toMatchObject({
        code: "UNAVAILABLE",
        message: "Plugin registry URL is not configured.",
        retryable: false,
      });
    }
  });

  it.each([
    "http://registry.example.test/v1/",
    "https://user:secret@registry.example.test/v1/",
    "https://registry.example.test/v1/?tenant=one",
    "https://registry.example.test/v1/#catalog",
  ])("rejects unsafe registry base URL: %s", (baseUrl) => {
    expect(() => createLivePluginRegistryClient({ baseUrl })).toThrow(/registry base URL/i);
  });

  it("uses bounded no-credential requests without claiming unverified registry compatibility", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      expect(url.href).toBe("https://registry.example.test/v1/plugins?query=calendar&pageSize=20");
      return json({ items: [detail()], nextCursor: null, hasMore: false });
    });
    const client = createLivePluginRegistryClient({ baseUrl: "https://registry.example.test/v1/", fetch: fetchImpl as typeof fetch });

    await expect(client.search({ query: "calendar", cursor: null, pageSize: 20 })).resolves.toMatchObject({
      items: [{ slug: "openclaw-calendar", mode: "live" }],
      mode: "live",
      repositoryVerified: false,
    });
    expect(client.mode).toBe("live");
    expect(client.repositoryVerified).toBe(false);
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      method: "GET",
      redirect: "error",
      credentials: "omit",
      signal: expect.any(AbortSignal),
    }));
  });

  it("encodes detail and bundle slugs into fixed endpoint paths", async () => {
    const requests: string[] = [];
    const entries = [{ path: "openclaw.plugin.json", type: "file" as const, size: 2, contentBase64: "e30=" }];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requests.push(url.href);
      if (url.pathname.endsWith("/bundle")) return json({
        sourceUrl: "https://plugins.openclaw.ai/packages/openclaw-calendar-1.2.0.tgz",
        compressedBytes: 100,
        checksumSha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
        entries,
      });
      return json(detail());
    });
    const client = createLivePluginRegistryClient({ baseUrl: "https://registry.example.test/v1/", fetch: fetchImpl as typeof fetch });

    await client.detail("openclaw-calendar");
    await client.download("openclaw-calendar");
    expect(requests).toEqual([
      "https://registry.example.test/v1/plugins/openclaw-calendar",
      "https://registry.example.test/v1/plugins/openclaw-calendar/bundle",
    ]);
  });

  it("rejects responses outside the strict detail and bundle contracts", async () => {
    const invalidDetail = { ...detail(), undeclaredSignature: "opaque" };
    const invalidBundle = {
      sourceUrl: "https://plugins.openclaw.ai/package.tgz",
      compressedBytes: 1,
      checksumSha256: "0".repeat(64),
      entries: [],
      extra: true,
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(invalidDetail))
      .mockResolvedValueOnce(json(invalidBundle));
    const client = createLivePluginRegistryClient({ baseUrl: "https://registry.example.test/v1/", fetch: fetchImpl as typeof fetch });

    await expect(client.detail("openclaw-calendar")).rejects.toThrow();
    await expect(client.download("openclaw-calendar")).rejects.toThrow();
  });

  it("aborts a request at the configured timeout", async () => {
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const client = createLivePluginRegistryClient({ baseUrl: "https://registry.example.test/v1/", fetch: fetchImpl as typeof fetch, timeoutMs: 5 });

    await expect(client.detail("openclaw-calendar")).rejects.toThrow(/timed out/i);
  });

  it("rejects response bodies above the configured byte limit", async () => {
    const fetchImpl = vi.fn(async () => json(detail(), { headers: { "content-length": "4096" } }));
    const client = createLivePluginRegistryClient({ baseUrl: "https://registry.example.test/v1/", fetch: fetchImpl as typeof fetch, maxResponseBytes: 256 });

    await expect(client.detail("openclaw-calendar")).rejects.toThrow(/too large/i);
  });

  it.each(["install", "update"] as const)("blocks %s before downloading from an unverified live registry", async (action) => {
    const manifest = JSON.stringify({ id: "openclaw-calendar", configSchema: { type: "object" } });
    const packageJson = JSON.stringify({
      name: "@uclaw/openclaw-calendar",
      version: "1.2.0",
      openclaw: { extensions: ["./dist/index.js"], compat: { pluginApi: ">=2026.7.1-2" }, install: { minHostVersion: ">=2026.7.1-2" } },
    });
    const entries = [
      { path: "openclaw.plugin.json", type: "file" as const, size: Buffer.byteLength(manifest), contentBase64: Buffer.from(manifest).toString("base64") },
      { path: "package.json", type: "file" as const, size: Buffer.byteLength(packageJson), contentBase64: Buffer.from(packageJson).toString("base64") },
      { path: "dist/index.js", type: "file" as const, size: 17, contentBase64: Buffer.from("export default {};").toString("base64") },
      { path: "../escape.js", type: "file" as const, size: 1, contentBase64: "eA==" },
    ];
    const digest = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
    let bundleRequests = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname.endsWith("/bundle")) {
        bundleRequests += 1;
        return json({
          sourceUrl: "https://plugins.openclaw.ai/packages/openclaw-calendar-1.2.0.tgz",
          compressedBytes: 100,
          checksumSha256: digest,
          entries,
        });
      }
      return json(detail(digest, action === "update" ? "1.3.0" : "1.2.0"));
    });
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-live-plugin-registry-"));
    roots.push(dataDir);
    if (action === "update") {
      const fixtureService = await createPluginService({
        dataDir,
        client: createFixturePluginRegistryClient(),
        runtime: createFixturePluginRuntime(dataDir),
      });
      const fixtureDetail = await fixtureService.detail("openclaw-calendar");
      const initial = await fixtureService.startInstall({
        slug: fixtureDetail.slug,
        confirmation: { permissionFingerprint: fixtureDetail.permissionFingerprint, acceptedRisk: fixtureDetail.risk },
      });
      await expect(fixtureService.waitForOperation(initial.id)).resolves.toMatchObject({ state: "succeeded" });
    }
    const client = createLivePluginRegistryClient({ baseUrl: "https://registry.example.test/v1/", fetch: fetchImpl as typeof fetch });
    const service = await createPluginService({ dataDir, client, runtime: createFixturePluginRuntime(dataDir) });
    const plugin = await service.detail("openclaw-calendar");
    expect(plugin.integrityVerified).toBe(true);
    const operation = await service[action === "install" ? "startInstall" : "startUpdate"]({
      slug: plugin.slug,
      confirmation: { permissionFingerprint: plugin.permissionFingerprint, acceptedRisk: plugin.risk },
    });

    await expect(service.waitForOperation(operation.id)).resolves.toMatchObject({ state: "failed" });
    expect(bundleRequests).toBe(0);
  });
});
