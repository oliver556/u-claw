import { describe, expect, it, vi } from "vitest";

import {
  createOpenClawProviderConfigBackend,
  type OpenClawConfigRpc,
} from "../src/providers/openclaw-provider-config.js";

function configFixture(apiKey = "sk-live-secret") {
  return {
    models: {
      mode: "merge",
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey,
          api: "openai-completions",
          models: [{ id: "gpt-5.4", name: "gpt-5.4" }],
        },
      },
    },
    agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
  };
}

function fakeRpc(initial: Record<string, unknown> = configFixture()) {
  let config = structuredClone(initial) as Record<string, unknown>;
  let hash = "hash-1";
  const merge = (target: any, patch: any): any => {
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
    const result = { ...(target ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete result[key]; else result[key] = merge(result[key], value);
    }
    return result;
  };
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "config.schema") return { schema: { type: "object" }, uiHints: {} };
    if (method === "config.get") return { config: structuredClone(config), hash, valid: true };
    if (method === "config.patch") {
      expect(params.baseHash).toBe(hash);
      const patch = JSON.parse(String(params.raw)) as Record<string, any>;
      config = merge(config, patch);
      hash = "hash-2";
      return { ok: true };
    }
    if (method === "config.apply") {
      expect(params.baseHash).toBe(hash);
      config = JSON.parse(String(params.raw));
      hash = "hash-3";
      return { ok: true };
    }
    throw new Error(`unexpected ${method}`);
  });
  return { rpc: { request } as OpenClawConfigRpc, request };
}

describe("OpenClaw provider config backend", () => {
  it("stages a compact valid config before deleting the final Provider to satisfy OpenClaw size-drop protection", async () => {
    const initial = configFixture("sk-live-secret");
    Object.assign(initial.models.providers.openai.models[0], {
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    });
    const { rpc, request } = fakeRpc({
      ...initial,
      gateway: { mode: "local", auth: { mode: "token", token: "gateway-token" } },
      meta: { lastTouchedVersion: "2026.7.1-2", lastTouchedAt: "2026-08-11T00:00:00.000Z" },
    });
    const backend = createOpenClawProviderConfigBackend(rpc);
    const previous = {
      schemaVersion: 1 as const,
      selectedProviderId: "openai",
      providers: [{ id: "openai", templateId: "openai" as const, name: "OpenAI", enabled: true, baseUrl: "https://api.openai.com/v1", model: "gpt-5.4", apiKey: "sk-live-secret" }],
      network: { httpProxy: null, httpsProxy: null, noProxy: [] },
    };
    const next = { ...previous, selectedProviderId: null, providers: [] };

    await backend.synchronize(previous, next);

    const applies = request.mock.calls.filter(([method]) => method === "config.apply");
    expect(applies).toHaveLength(3);
    expect(JSON.parse(String(applies[0]?.[1].raw))).toMatchObject({
      models: {
        mode: "merge",
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions",
            models: [{ id: "gpt-5.4", name: "gpt-5.4" }],
          },
        },
      },
    });
    expect(JSON.parse(String(applies[0]?.[1].raw))).toHaveProperty("models.providers.openai.apiKey", "sk-live-secret");
    expect(JSON.parse(String(applies[1]?.[1].raw))).not.toHaveProperty("models.providers.openai.apiKey");
    expect(JSON.parse(String(applies[1]?.[1].raw))).not.toHaveProperty("agents.defaults.model.primary");
    expect(JSON.parse(String(applies[2]?.[1].raw))).not.toHaveProperty("models");
    expect(applies[0]?.[1]).toHaveProperty("restartDelayMs", 60_000);
    expect(applies[1]?.[1]).toHaveProperty("restartDelayMs", 60_000);
    expect(applies[2]?.[1]).not.toHaveProperty("restartDelayMs");
  });

  it("uses the same size-drop bridge when disabling the final Provider", async () => {
    const initial = configFixture("sk-live-secret");
    Object.assign(initial.models.providers.openai.models[0], {
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    });
    const { rpc, request } = fakeRpc({
      ...initial,
      gateway: { mode: "local", auth: { mode: "token", token: "gateway-token" } },
      meta: { lastTouchedVersion: "2026.7.1-2", lastTouchedAt: "2026-08-11T00:00:00.000Z" },
    });
    const previous = {
      schemaVersion: 1 as const,
      selectedProviderId: "openai",
      providers: [{ id: "openai", templateId: "openai" as const, name: "OpenAI", enabled: true, baseUrl: "https://api.openai.com/v1", model: "gpt-5.4", apiKey: "sk-live-secret" }],
      network: { httpProxy: null, httpsProxy: null, noProxy: [] },
    };
    const next = { ...structuredClone(previous), selectedProviderId: null as string | null };
    next.providers[0].enabled = false;

    await createOpenClawProviderConfigBackend(rpc).synchronize(previous, next);

    const applies = request.mock.calls.filter(([method]) => method === "config.apply");
    expect(applies).toHaveLength(3);
    expect(JSON.parse(String(applies[2]?.[1].raw))).not.toHaveProperty("models");
  });

  it("applies Provider config with CAS and verifies a real config.get readback", async () => {
    const { rpc, request } = fakeRpc();
    const backend = createOpenClawProviderConfigBackend(rpc);
    const previous = {
      schemaVersion: 1 as const,
      selectedProviderId: "openai",
      providers: [{ id: "openai", templateId: "openai" as const, name: "OpenAI", enabled: true, baseUrl: "https://api.openai.com/v1", model: "gpt-5.4", apiKey: "sk-live-secret" }],
      network: { httpProxy: null, httpsProxy: null, noProxy: [] },
    };
    const next = structuredClone(previous);
    next.providers[0].model = "gpt-5.5";

    await backend.synchronize(previous, next);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config.schema", "config.get", "config.apply", "config.get",
    ]);
    expect(request.mock.calls[2]?.[1]).toMatchObject({ baseHash: "hash-1" });
    expect(JSON.parse(String(request.mock.calls[2]?.[1].raw))).toMatchObject({
      models: { mode: "merge", providers: { openai: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-live-secret", models: [{ id: "gpt-5.5" }] } } },
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    });
  });

  it("does not project unchanged ZAI env while writing an unrelated Provider", async () => {
    const { rpc, request } = fakeRpc();
    const backend = createOpenClawProviderConfigBackend(rpc);
    const previous = {
      schemaVersion: 1 as const,
      selectedProviderId: "openai",
      providers: [
        { id: "zai", templateId: "zai" as const, name: "Z.AI", enabled: false, baseUrl: null, model: "glm-5" },
        { id: "openai", templateId: "openai" as const, name: "OpenAI", enabled: true, baseUrl: "https://api.openai.com/v1", model: "gpt-5.4", apiKey: "sk-live-secret" },
      ],
      network: { httpProxy: null, httpsProxy: null, noProxy: [] },
    };
    const next = structuredClone(previous);
    next.providers[1].model = "gpt-5.5";

    await backend.synchronize(previous, next);

    expect(JSON.parse(String(request.mock.calls[2]?.[1].raw))).not.toHaveProperty("env");
  });

  it("rejects a mismatched write readback and never includes secrets in the error", async () => {
    const { rpc, request } = fakeRpc();
    (request.mockImplementation as any)(async (method: string) => {
      if (method === "config.schema") return { schema: { type: "object" }, uiHints: {} };
      if (method === "config.get") return { config: configFixture("different-secret"), hash: "hash-1", valid: true };
      if (method === "config.apply") return { ok: true };
      throw new Error("unexpected");
    });
    const backend = createOpenClawProviderConfigBackend(rpc);
    const document = {
      schemaVersion: 1 as const, selectedProviderId: "openai",
      providers: [{ id: "openai", templateId: "openai" as const, name: "OpenAI", enabled: true, baseUrl: "https://api.openai.com/v1", model: "gpt-5.4", apiKey: ["never", "render", "this"].join("-") }],
      network: { httpProxy: null, httpsProxy: null, noProxy: [] },
    };
    const error = await backend.synchronize(document, document).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "OPERATION_FAILED" });
    expect(JSON.stringify(error)).not.toContain("never-render-this");
    expect(JSON.stringify(error)).not.toContain("different-secret");
  });

  it("compensates the authoritative config when post-write readback mismatches", async () => {
    const original = configFixture("original-secret");
    let config: Record<string, unknown> = structuredClone(original);
    let hash = "hash-1";
    let applyCount = 0;
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "config.schema") return { schema: { type: "object" }, uiHints: {} };
      if (method === "config.get") {
        if (applyCount === 1) {
          const mismatched = structuredClone(config) as any;
          mismatched.models.providers.openai.baseUrl = "https://wrong.example.com/v1";
          mismatched.gateway = { port: 19_000 };
          return { sourceConfig: mismatched, hash, valid: true };
        }
        return { sourceConfig: structuredClone(config), hash, valid: true };
      }
      if (method === "config.apply") {
        config = JSON.parse(String(params.raw));
        applyCount += 1;
        hash = `hash-${applyCount + 1}`;
        return { ok: true };
      }
      throw new Error("unexpected");
    });
    const backend = createOpenClawProviderConfigBackend({ request } as OpenClawConfigRpc);
    const previous = {
      schemaVersion: 1 as const, selectedProviderId: "openai",
      providers: [{ id: "openai", templateId: "openai" as const, name: "OpenAI", enabled: true, baseUrl: "https://api.openai.com/v1", model: "gpt-5.4", apiKey: "original-secret" }],
      network: { httpProxy: null, httpsProxy: null, noProxy: [] },
    };
    const next = structuredClone(previous);
    next.providers[0].model = "gpt-5.5";

    await expect(backend.synchronize(previous, next)).rejects.toMatchObject({ code: "CONFLICT" });

    const applies = request.mock.calls.filter(([method]) => method === "config.apply");
    expect(applies).toHaveLength(2);
    expect(JSON.parse(String(applies[1]?.[1].raw))).toMatchObject({
      gateway: { port: 19_000 },
      models: { providers: { openai: { baseUrl: "https://api.openai.com/v1", apiKey: "original-secret", models: [{ id: "gpt-5.4" }] } } },
      agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
    });
    expect(config).toMatchObject({ gateway: { port: 19_000 }, models: { providers: { openai: { models: [{ id: "gpt-5.4" }] } } } });
  });

  it("does not compensate an unacknowledged CAS rejection", async () => {
    const { rpc, request } = fakeRpc();
    (request.mockImplementation as any)(async (method: string) => {
      if (method === "config.schema") return { schema: { type: "object" }, uiHints: {} };
      if (method === "config.get") return { sourceConfig: configFixture(), hash: "newer-hash", valid: true };
      if (method === "config.apply") return { ok: false };
      throw new Error("unexpected");
    });
    const backend = createOpenClawProviderConfigBackend(rpc);
    const previous = {
      schemaVersion: 1 as const, selectedProviderId: "openai",
      providers: [{ id: "openai", templateId: "openai" as const, name: "OpenAI", enabled: true, baseUrl: "https://api.openai.com/v1", model: "gpt-5.4", apiKey: "sk-live-secret" }],
      network: { httpProxy: null, httpsProxy: null, noProxy: [] },
    };
    const next = structuredClone(previous);
    next.providers[0].model = "gpt-5.5";

    await expect(backend.synchronize(previous, next)).rejects.toMatchObject({ code: "OPERATION_FAILED" });
    expect(request.mock.calls.filter(([method]) => method === "config.apply")).toHaveLength(1);
  });

  it("accepts OpenClaw secret-redacted config.get as configured readback", async () => {
    const { rpc, request } = fakeRpc();
    let reads = 0;
    (request.mockImplementation as any)(async (method: string, params: Record<string, unknown>) => {
      if (method === "config.schema") return { schema: { type: "object" }, uiHints: {} };
      if (method === "config.apply") return { ok: true };
      if (method === "config.get") {
        reads += 1;
        return { sourceConfig: configFixture(reads === 1 ? "sk-live-secret" : "__OPENCLAW_REDACTED__"), hash: `hash-${reads}`, valid: true };
      }
      throw new Error(`unexpected ${method} ${JSON.stringify(params)}`);
    });
    const backend = createOpenClawProviderConfigBackend(rpc);
    const document = {
      schemaVersion: 1 as const, selectedProviderId: "openai",
      providers: [{ id: "openai", templateId: "openai" as const, name: "OpenAI", enabled: true, baseUrl: "https://api.openai.com/v1", model: "gpt-5.4", apiKey: "sk-live-secret" }],
      network: { httpProxy: null, httpsProxy: null, noProxy: [] },
    };
    await expect(backend.synchronize(document, document)).resolves.toBeUndefined();
  });

  it("clears an enabled Provider key explicitly and verifies it disappeared", async () => {
    const { rpc, request } = fakeRpc();
    const backend = createOpenClawProviderConfigBackend(rpc);
    const previous = {
      schemaVersion: 1 as const, selectedProviderId: "openai",
      providers: [{ id: "openai", templateId: "openai" as const, name: "OpenAI", enabled: true, baseUrl: "https://api.openai.com/v1", model: "gpt-5.4", apiKey: "sk-old" }],
      network: { httpProxy: null, httpsProxy: null, noProxy: [] },
    };
    const next = structuredClone(previous);
    delete (next.providers[0] as { apiKey?: string }).apiKey;

    await backend.synchronize(previous, next);

    expect(JSON.parse(String(request.mock.calls[2]?.[1].raw)).models.providers.openai.apiKey).toBeUndefined();
  });

  it("accepts missing primary after disabling the selected Provider", async () => {
    const { rpc } = fakeRpc();
    const backend = createOpenClawProviderConfigBackend(rpc);
    const previous = {
      schemaVersion: 1 as const, selectedProviderId: "openai",
      providers: [{ id: "openai", templateId: "openai" as const, name: "OpenAI", enabled: true, baseUrl: "https://api.openai.com/v1", model: "gpt-5.4", apiKey: "sk-old" }],
      network: { httpProxy: null, httpsProxy: null, noProxy: [] },
    };
    const next = structuredClone(previous);
    (next as { selectedProviderId: string | null }).selectedProviderId = null;
    next.providers[0].enabled = false;
    await expect(backend.synchronize(previous, next)).resolves.toBeUndefined();
  });

  it("rejects readback that retained a removed Provider", async () => {
    const { rpc, request } = fakeRpc();
    let reads = 0;
    request.mockImplementation(async (method: string) => {
      if (method === "config.schema") return { schema: { type: "object" }, uiHints: {} };
      if (method === "config.apply") return { ok: true };
      if (method === "config.get") {
        reads += 1;
        const config = configFixture();
        if (reads > 1) delete (config.agents.defaults.model as any).primary;
        return { config, hash: `hash-${reads}`, valid: true };
      }
      throw new Error("unexpected");
    });
    const backend = createOpenClawProviderConfigBackend(rpc);
    const previous = {
      schemaVersion: 1 as const, selectedProviderId: "openai",
      providers: [{ id: "openai", templateId: "openai" as const, name: "OpenAI", enabled: true, baseUrl: "https://api.openai.com/v1", model: "gpt-5.4", apiKey: "sk-live-secret" }],
      network: { httpProxy: null, httpsProxy: null, noProxy: [] },
    };
    const next = { ...previous, selectedProviderId: null, providers: [] };
    await expect(backend.synchronize(previous, next)).rejects.toMatchObject({ code: "OPERATION_FAILED" });
  });

  it("accepts OpenClaw sentinel for ZAI and verifies ZAI clear", async () => {
    const initial = { env: { ZAI_API_KEY: "zai-old" }, models: { providers: {} }, agents: { defaults: { model: { primary: "zai/glm-5" } } } };
    const { rpc, request } = fakeRpc(initial as any);
    const backend = createOpenClawProviderConfigBackend(rpc);
    const previous = {
      schemaVersion: 1 as const, selectedProviderId: "zai",
      providers: [{ id: "zai", templateId: "zai" as const, name: "ZAI", enabled: true, baseUrl: null, model: "glm-5", apiKey: "zai-old" }],
      network: { httpProxy: null, httpsProxy: null, noProxy: [] },
    };
    request.mockImplementationOnce(async () => ({ schema: { type: "object" }, uiHints: {} }));
    request.mockImplementationOnce(async () => ({ config: initial, hash: "hash-1", valid: true }));
    request.mockImplementationOnce(async () => ({ ok: true }));
    request.mockImplementationOnce(async () => ({ config: { ...initial, env: { ZAI_API_KEY: "__OPENCLAW_REDACTED__" } }, hash: "hash-2", valid: true }));
    await expect(backend.synchronize(previous, previous)).resolves.toBeUndefined();

    const next = structuredClone(previous);
    delete (next.providers[0] as { apiKey?: string }).apiKey;
    await expect(backend.synchronize(previous, next)).resolves.toBeUndefined();
    expect(JSON.parse(String(request.mock.calls.at(-2)?.[1].raw)).env).toBeUndefined();
  });

  it("applies a complete valid config when removing the last configured Provider", async () => {
    const { rpc, request } = fakeRpc();
    const backend = createOpenClawProviderConfigBackend(rpc);
    const previous = {
      schemaVersion: 1 as const,
      selectedProviderId: "openai",
      providers: [{ id: "openai", templateId: "openai" as const, name: "OpenAI", enabled: true, baseUrl: "https://api.openai.com/v1", model: "gpt-5.4", apiKey: "sk-live-secret" }],
      network: { httpProxy: null, httpsProxy: null, noProxy: [] },
    };
    const next = { ...previous, selectedProviderId: null, providers: [] };

    await backend.synchronize(previous, next);

    const applied = JSON.parse(String(request.mock.calls.find(([method]) => method === "config.apply")?.[1].raw));
    expect(applied.models).toBeUndefined();
    expect(applied.agents?.defaults?.model).toBeUndefined();
  });

  it("returns only redacted raw config and rejects secret-bearing renderer patches", async () => {
    const { rpc, request } = fakeRpc();
    const backend = createOpenClawProviderConfigBackend(rpc);

    const snapshot = await backend.getRendererConfig();
    expect(snapshot.config).toMatchObject({ models: { providers: { openai: { apiKey: "[REDACTED]" } } } });
    expect(JSON.stringify(snapshot)).not.toContain("sk-live-secret");
    await expect(backend.patchRendererConfig({ models: { providers: { openai: { apiKey: "[REDACTED]" } } } })).resolves.toBeTruthy();
    expect(String(request.mock.calls.find(([method]) => method === "config.patch")?.[1].raw)).toContain("__OPENCLAW_REDACTED__");
    expect(String(request.mock.calls.find(([method]) => method === "config.patch")?.[1].raw)).not.toContain('"[REDACTED]"');
    await expect(backend.patchRendererConfig({ gateway: { port: 18790 } })).resolves.toMatchObject({ config: { gateway: { port: 18790 } } });
    await expect(backend.patchRendererConfig({ models: { providers: { openai: { apiKey: "sk-injected" } } } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(backend.patchRendererConfig({ env: { SOME_VALUE: "Bearer sk-injected" } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(JSON.stringify(request.mock.calls)).not.toContain("sk-injected");
  });

  it("prevents raw patch/apply from changing Provider-owned config paths", async () => {
    const { rpc, request } = fakeRpc();
    const backend = createOpenClawProviderConfigBackend(rpc);
    await expect(backend.patchRendererConfig({ models: { providers: { openai: null } } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(backend.patchRendererConfig({ models: { mode: "replace" } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(backend.patchRendererConfig({ agents: { defaults: { model: { primary: "other/model" } } } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(backend.applyRendererConfig({ ...configFixture("[REDACTED]"), gateway: { port: 18790 }, agents: { defaults: { model: { primary: "other/model" } } } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(request.mock.calls.filter(([method]) => method === "config.patch" || method === "config.apply")).toHaveLength(0);
  });

  it("uses authoritative sourceConfig instead of resolved runtime defaults", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "config.schema") return { schema: { type: "object" }, uiHints: {} };
      if (method === "config.get") return {
        config: { meta: { lastTouchedVersion: "derived" }, gateway: { mode: "local" } },
        sourceConfig: { gateway: { mode: "local" } },
        hash: "hash-source",
        valid: true,
      };
      throw new Error("unexpected");
    });
    const backend = createOpenClawProviderConfigBackend({ request } as OpenClawConfigRpc);

    await expect(backend.getRendererConfig()).resolves.toMatchObject({ config: { gateway: { mode: "local" } } });
    expect((await backend.getRendererConfig()).config).not.toHaveProperty("meta");
  });

  it("applies full main-process config and verifies exact readback", async () => {
    const { rpc, request } = fakeRpc();
    const backend = createOpenClawProviderConfigBackend(rpc);
    const next = { gateway: { mode: "local" }, models: { mode: "merge", providers: {} } };

    await backend.applyMainConfig(next);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config.schema", "config.get", "config.apply", "config.get",
    ]);
  });
});
