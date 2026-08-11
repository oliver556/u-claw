import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
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

  it("starts on hidden builtin while preserving every external provider template", async () => {
    const { store } = await setup();
    const snapshot = await store.list();
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.selectedProviderId).toBeNull();
    expect(snapshot.providers).toHaveLength(10);
    expect(snapshot.providers.map((provider: any) => provider.templateId)).toEqual([
      "minimax", "kimi", "deepseek", "zai", "qwen", "doubao", "openai", "anthropic", "groq", "siliconflow",
    ]);
    expect(snapshot.providers.every((provider: any) => provider.enabled === false)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/uclaw-cloud|api\.u-claw\.org|虾盘云/u);
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

  it("uses last explicit enable and returns to builtin when current source is disabled or removed", async () => {
    const { store } = await setup();
    expect((await store.setEnabled("deepseek", true)).selectedProviderId).toBe("deepseek");
    expect((await store.setEnabled("qwen", true)).selectedProviderId).toBe("qwen");
    expect((await store.setEnabled("deepseek", true)).selectedProviderId).toBe("deepseek");
    expect((await store.setEnabled("deepseek", false)).selectedProviderId).toBeNull();
    expect((await store.setEnabled("qwen", true)).selectedProviderId).toBe("qwen");
    expect((await store.remove("qwen")).selectedProviderId).toBeNull();
    await expect(store.select("deepseek")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("updates and clears a key without returning plaintext to renderer snapshots", async () => {
    const { store, dataDir } = await setup();
    const updated = await store.setApiKey("openai", "fixture-sk-live-12345678");
    expect(updated.providers.find((provider: any) => provider.id === "openai")).toMatchObject({ apiKeyConfigured: true, apiKeyHint: "...5678" });
    expect(JSON.stringify(updated)).not.toContain("fixture-sk-live-12345678");
    expect(await store.getSelectedForRuntime()).not.toMatchObject({ apiKey: "fixture-sk-live-12345678" });
    const disk = await readFile(join(dataDir, "providers", "provider-config.v1.json"), "utf8");
    expect(disk).not.toContain("fixture-sk-live-12345678");
    expect(disk).not.toContain("apiKey");
    const credentialsPath = join(dataDir, ".uclaw", "provider-credentials.v1.json");
    expect(await readFile(credentialsPath, "utf8")).toContain("fixture-sk-live-12345678");
    expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600);
    const cleared = await store.clearApiKey("openai");
    expect(cleared.providers.find((provider: any) => provider.id === "openai")).toMatchObject({ apiKeyConfigured: false });
    expect(await readFile(join(dataDir, "providers", "provider-config.v1.json"), "utf8")).not.toContain("fixture-sk-live-12345678");
    expect(await readFile(credentialsPath, "utf8")).not.toContain("fixture-sk-live-12345678");
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

  it("commits only after OpenClaw config write and readback succeed", async () => {
    const openClawConfig = { synchronize: vi.fn(async (_previous: any, _next: any) => undefined) };
    const { store } = await setup({ openClawConfig });
    await store.create(custom("authoritative"));
    expect(openClawConfig.synchronize).toHaveBeenCalledOnce();
    expect(openClawConfig.synchronize.mock.calls[0]?.[1]).toMatchObject({
      selectedProviderId: "authoritative",
      providers: expect.arrayContaining([expect.objectContaining({ id: "authoritative", enabled: true })]),
    });

    openClawConfig.synchronize.mockRejectedValueOnce({ code: "CONFLICT", message: "readback mismatch" });
    await expect(store.create(custom("rejected"))).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await store.list()).providers.some((provider: any) => provider.id === "rejected")).toBe(false);
  });

  it("keeps proxy settings local instead of writing unrelated OpenClaw Provider config", async () => {
    const openClawConfig = { synchronize: vi.fn(async (_previous: any, _next: any) => undefined) };
    const { store } = await setup({ openClawConfig });
    await store.setNetwork({ httpProxy: "http://proxy.example.com:8080", httpsProxy: null, noProxy: ["localhost"] });
    expect(openClawConfig.synchronize).not.toHaveBeenCalled();
  });

  it("does not let concurrent same-ID recreation inherit a removed Provider key", async () => {
    const values = new Map<string, string>();
    let releaseRemoval!: () => void;
    let removalStarted!: () => void;
    const started = new Promise<void>((resolve) => { removalStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseRemoval = resolve; });
    const credentials = {
      get: async (id: string) => values.get(id),
      has: async (id: string) => values.has(id),
      set: async (id: string, value: string) => { values.set(id, value); },
      remove: async (id: string) => { removalStarted(); await blocked; values.delete(id); },
    };
    const { store } = await setup({ credentials });
    await store.create(custom("same-id"));
    await store.setApiKey("same-id", "old-owner-secret");
    const removing = store.remove("same-id");
    await started;
    const recreatedPromise = store.create(custom("same-id"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseRemoval();
    await removing;
    const recreated = await recreatedPromise;

    expect(recreated.providers.find((provider: any) => provider.id === "same-id"))
      .toMatchObject({ apiKeyConfigured: false });
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

  it("compensates OpenClaw when local metadata commit fails after synchronization", async () => {
    const writeAtomically = vi.fn(async (_path: string, body: string) => {
      if (body.includes("remote-rollback")) throw new Error("disk failure");
    });
    const openClawConfig = { synchronize: vi.fn(async (_previous: any, _next: any) => undefined) };
    const { store } = await setup({ writeAtomically, openClawConfig });
    await expect(store.create(custom("remote-rollback"))).rejects.toMatchObject({ code: "OPERATION_FAILED" });
    expect(openClawConfig.synchronize).toHaveBeenCalledTimes(2);
    expect(openClawConfig.synchronize.mock.calls[1]?.[0]).toMatchObject({ providers: expect.arrayContaining([expect.objectContaining({ id: "remote-rollback" })]) });
    expect(openClawConfig.synchronize.mock.calls[1]?.[1].providers.some((provider: any) => provider.id === "remote-rollback")).toBe(false);
  });

  it("does not compensate a durable metadata commit when only snapshot generation fails", async () => {
    let synchronized = false;
    const credentials = {
      get: vi.fn(async () => {
        if (synchronized) throw new Error("credential read unavailable");
        return undefined;
      }),
      has: vi.fn(async () => false),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    const openClawConfig = {
      synchronize: vi.fn(async () => { synchronized = true; }),
    };
    const { dataDir, store } = await setup({ credentials, openClawConfig });
    await expect(store.create(custom("durable-snapshot-failure"))).rejects.toThrow("credential read unavailable");
    expect(openClawConfig.synchronize).toHaveBeenCalledOnce();
    expect(await readFile(join(dataDir, "providers", "provider-config.v1.json"), "utf8")).toContain("durable-snapshot-failure");
  });

  it("does not restore an old key after durable commit when only snapshot generation fails", async () => {
    const values = new Map<string, string>();
    let failReads = false;
    const credentials = {
      get: vi.fn(async (id: string) => {
        if (failReads) throw new Error("credential read unavailable");
        return values.get(id);
      }),
      has: vi.fn(async (id: string) => values.has(id)),
      set: vi.fn(async (id: string, value: string) => { values.set(id, value); }),
      remove: vi.fn(async (id: string) => { values.delete(id); }),
    };
    const openClawConfig = {
      synchronize: vi.fn(async () => { failReads = true; }),
    };
    const { store } = await setup({ credentials, openClawConfig });
    await expect(store.setApiKey("openai", "durable-new-key")).rejects.toThrow("credential read unavailable");

    failReads = false;
    expect(values.get("openai")).toBe("durable-new-key");
    expect(credentials.remove).not.toHaveBeenCalledWith("openai");
  });

  it("restores the old key when OpenClaw synchronization fails before metadata commit", async () => {
    const values = new Map<string, string>();
    const credentials = {
      get: vi.fn(async (id: string) => values.get(id)),
      has: vi.fn(async (id: string) => values.has(id)),
      set: vi.fn(async (id: string, value: string) => { values.set(id, value); }),
      remove: vi.fn(async (id: string) => { values.delete(id); }),
    };
    const openClawConfig = { synchronize: vi.fn(async () => { throw new Error("remote write failed"); }) };
    const { store } = await setup({ credentials, openClawConfig });

    await expect(store.setApiKey("openai", "uncommitted-new-key")).rejects.toThrow("remote write failed");
    expect(values.has("openai")).toBe(false);
  });

  it("keeps the old Provider and key when rename credential removal fails before synchronization", async () => {
    const values = new Map<string, string>();
    const credentials = {
      get: vi.fn(async (id: string) => values.get(id)),
      has: vi.fn(async (id: string) => values.has(id)),
      set: vi.fn(async (id: string, value: string) => { values.set(id, value); }),
      remove: vi.fn(async (id: string) => {
        if (id === "rename-old") throw new Error("credential remove failed");
        values.delete(id);
      }),
    };
    const openClawConfig = { synchronize: vi.fn(async () => undefined) };
    const { store } = await setup({ credentials, openClawConfig });
    await store.create(custom("rename-old"));
    await store.setApiKey("rename-old", "rename-secret");
    openClawConfig.synchronize.mockClear();

    await expect(store.update("rename-old", { ...custom("rename-new"), id: "rename-new" }))
      .rejects.toThrow("credential remove failed");

    const snapshot = await store.list();
    expect(snapshot.providers.some((provider: any) => provider.id === "rename-old")).toBe(true);
    expect(snapshot.providers.some((provider: any) => provider.id === "rename-new")).toBe(false);
    expect(values.get("rename-old")).toBe("rename-secret");
    expect(values.has("rename-new")).toBe(false);
    expect(openClawConfig.synchronize).not.toHaveBeenCalled();
  });

  it("keeps Provider metadata and key when credential removal fails before delete synchronization", async () => {
    const values = new Map<string, string>();
    const credentials = {
      get: vi.fn(async (id: string) => values.get(id)),
      has: vi.fn(async (id: string) => values.has(id)),
      set: vi.fn(async (id: string, value: string) => { values.set(id, value); }),
      remove: vi.fn(async (id: string) => {
        if (id === "remove-failure") throw new Error("credential remove failed");
        values.delete(id);
      }),
    };
    const openClawConfig = { synchronize: vi.fn(async () => undefined) };
    const { store } = await setup({ credentials, openClawConfig });
    await store.create(custom("remove-failure"));
    await store.setApiKey("remove-failure", "remove-secret");
    openClawConfig.synchronize.mockClear();

    await expect(store.remove("remove-failure")).rejects.toThrow("credential remove failed");

    expect((await store.list()).providers.some((provider: any) => provider.id === "remove-failure")).toBe(true);
    expect(values.get("remove-failure")).toBe("remove-secret");
    expect(openClawConfig.synchronize).not.toHaveBeenCalled();
  });

  it("fails closed without leaking persisted content when JSON is corrupted", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-provider-corrupt-"));
    roots.push(dataDir);
    await mkdir(join(dataDir, "providers"), { recursive: true });
    await writeFile(join(dataDir, "providers", "provider-config.v1.json"), "{ secret-key-fragment", "utf8");
    const create = (desktop as any).createProviderStore;
    const error = await (create({ dataDir }) as Store).list().catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      code: "OPERATION_FAILED",
      message: "Provider configuration could not be loaded.",
    });
    expect(JSON.stringify(error)).not.toContain("secret-key-fragment");
  });
});
