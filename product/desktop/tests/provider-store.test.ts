import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as desktop from "../src/index.js";

type Store = {
  list(): Promise<any>;
  create(provider: any): Promise<any>;
  update(providerId: string, provider: any): Promise<any>;
  remove(providerId: string): Promise<any>;
  setEnabled(providerId: string, enabled: boolean): Promise<any>;
  move(providerId: string, direction: "up" | "down"): Promise<any>;
  select(providerId: string): Promise<any>;
  setApiKey(providerId: string, apiKey: string): Promise<any>;
  clearApiKey(providerId: string): Promise<any>;
  getSelectedForRuntime(): Promise<any>;
  getForRuntime(providerId: string): Promise<any>;
  setNetwork(network: any): Promise<any>;
};

describe("provider store", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  async function setup(options: Record<string, unknown> = {}) {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-provider-store-"));
    roots.push(dataDir);
    const create = (desktop as any).createProviderStore;
    expect(create).toBeTypeOf("function");
    return { dataDir, store: create({ dataDir, ...options }) as Store };
  }

  const custom = (id: string) => ({
    id, name: `Custom ${id}`, enabled: true, baseUrl: "https://models.example.com/v1", model: "model-1",
  });

  it("starts with every supported built-in provider without exposing keys", async () => {
    const { store } = await setup();
    const snapshot = await store.list();
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.providers).toHaveLength(11);
    expect(snapshot.providers.map((provider: any) => provider.templateId)).toEqual([
      "uclaw-cloud", "minimax", "kimi", "deepseek", "zai", "qwen", "doubao", "openai", "anthropic", "groq", "siliconflow",
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/apiKey":/u);
  });

  it("keeps providers independent and makes selection and ordering effective", async () => {
    const { store } = await setup();
    await store.create(custom("custom-a"));
    await store.create({ ...custom("custom-b"), model: "model-2" });
    await store.setApiKey("custom-a", "secret-custom-a");
    await store.setApiKey("custom-b", "secret-custom-b");
    await store.select("custom-b");
    await store.move("custom-b", "up");

    const snapshot = await store.list();
    expect(snapshot.selectedProviderId).toBe("custom-b");
    expect(snapshot.providers.at(-2)?.id).toBe("custom-b");
    expect(snapshot.providers.find((provider: any) => provider.id === "custom-a")).toMatchObject({ apiKeyConfigured: true, apiKeyHint: "...om-a" });
    expect(await store.getSelectedForRuntime()).toMatchObject({ id: "custom-b", model: "model-2", apiKey: "secret-custom-b" });
  });

  it("rejects duplicate IDs and preserves all existing providers", async () => {
    const { store } = await setup();
    await store.create(custom("custom-a"));
    await expect(store.create(custom("custom-a"))).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await store.list()).providers.filter((provider: any) => provider.id === "custom-a")).toHaveLength(1);
  });

  it("updates every editable field, keeps the key, and follows a renamed selected ID", async () => {
    const { store } = await setup();
    await store.create(custom("custom-old"));
    await store.setApiKey("custom-old", "preserved-secret");
    await store.select("custom-old");
    const updated = await store.update("custom-old", {
      id: "custom-new", name: "Renamed", enabled: true, baseUrl: "https://new.example.com/v1", model: "model-2",
    });
    expect(updated.selectedProviderId).toBe("custom-new");
    expect(updated.providers.find((provider: any) => provider.id === "custom-new")).toMatchObject({
      name: "Renamed", enabled: true, baseUrl: "https://new.example.com/v1", model: "model-2", apiKeyConfigured: true,
    });
    expect(await store.getSelectedForRuntime()).toMatchObject({ id: "custom-new", apiKey: "preserved-secret" });
  });

  it("moves selection to the next enabled provider when current one is disabled or removed", async () => {
    const { store } = await setup();
    await store.select("deepseek");
    expect((await store.setEnabled("deepseek", false)).selectedProviderId).toBe("zai");
    await store.select("qwen");
    expect((await store.remove("qwen")).selectedProviderId).toBe("doubao");
    await expect(store.select("deepseek")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("updates and clears a key without returning plaintext to renderer snapshots", async () => {
    const { store, dataDir } = await setup();
    const updated = await store.setApiKey("openai", "sk-live-12345678");
    expect(updated.providers.find((provider: any) => provider.id === "openai")).toMatchObject({ apiKeyConfigured: true, apiKeyHint: "...5678" });
    expect(JSON.stringify(updated)).not.toContain("sk-live-12345678");
    expect(await store.getSelectedForRuntime()).not.toMatchObject({ apiKey: "sk-live-12345678" });
    const disk = await readFile(join(dataDir, "providers", "provider-config.v1.json"), "utf8");
    expect(disk).toContain("sk-live-12345678");
    const cleared = await store.clearApiKey("openai");
    expect(cleared.providers.find((provider: any) => provider.id === "openai")).toMatchObject({ apiKeyConfigured: false });
    expect(await readFile(join(dataDir, "providers", "provider-config.v1.json"), "utf8")).not.toContain("sk-live-12345678");
  });

  it("persists validated proxy settings and exposes defaults without credentials", async () => {
    const { store, dataDir } = await setup();
    expect((await store.list()).network).toEqual({
      httpProxy: null, httpsProxy: null, noProxy: ["localhost", "127.0.0.1", "::1"],
    });
    await store.setApiKey("openai", "sk-main-only-secret");
    const snapshot = await store.setNetwork({
      httpProxy: "http://proxy.example.com:8080", httpsProxy: null,
      noProxy: ["localhost", "127.0.0.1", "::1", ".example.com"],
    });
    expect(snapshot.network.httpProxy).toBe("http://proxy.example.com:8080");
    expect(JSON.stringify(snapshot)).not.toContain("sk-main-only-secret");
    expect(await store.getForRuntime("openai")).toMatchObject({ apiKey: "sk-main-only-secret" });
    const disk = await readFile(join(dataDir, "providers", "provider-config.v1.json"), "utf8");
    expect(disk).toContain("proxy.example.com:8080");
    await expect(store.setNetwork({ httpProxy: "socks5://127.0.0.1:1080", httpsProxy: null, noProxy: [] })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("serializes concurrent mutations so neither provider is lost", async () => {
    const { store } = await setup();
    await Promise.all([store.create(custom("parallel-a")), store.create(custom("parallel-b"))]);
    expect((await store.list()).providers.map((provider: any) => provider.id)).toEqual(expect.arrayContaining(["parallel-a", "parallel-b"]));
  });

  it("keeps the old document when an atomic write fails", async () => {
    const writeAtomically = vi.fn(async (path: string, body: string) => {
      if (body.includes("will-fail")) throw new Error("disk contained secret-key-value");
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, body, "utf8");
    });
    const { store, dataDir } = await setup({ writeAtomically });
    await store.create(custom("saved"));
    const before = await readFile(join(dataDir, "providers", "provider-config.v1.json"), "utf8");
    const error = await store.create(custom("will-fail")).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "OPERATION_FAILED" });
    expect(JSON.stringify(error)).not.toContain("secret-key-value");
    const after = await readFile(join(dataDir, "providers", "provider-config.v1.json"), "utf8");
    expect(after).toBe(before);
    expect((await store.list()).providers.some((provider: any) => provider.id === "will-fail")).toBe(false);
  });

  it("falls back to the built-in catalog when persisted JSON is corrupted", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-provider-corrupt-"));
    roots.push(dataDir);
    await mkdir(join(dataDir, "providers"), { recursive: true });
    await writeFile(join(dataDir, "providers", "provider-config.v1.json"), "{ secret-key-fragment", "utf8");
    const create = (desktop as any).createProviderStore;
    const snapshot = await (create({ dataDir }) as Store).list();
    expect(snapshot.providers).toHaveLength(11);
    expect(JSON.stringify(snapshot)).not.toContain("secret-key-fragment");
  });
});
