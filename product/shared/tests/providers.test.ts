import { describe, expect, it } from "vitest";

import * as shared from "../src/index.js";

type Schema = { parse(value: unknown): unknown };

describe("provider contracts", () => {
  const contract = shared as unknown as Record<string, unknown>;

  it("publishes only renderer-visible external provider templates", () => {
    expect(contract.PROVIDER_CONFIG_VERSION).toBe(1);
    expect(contract.BUILT_IN_PROVIDER_TEMPLATES).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "minimax", name: "MiniMax" }),
      expect.objectContaining({ id: "kimi", name: "Kimi" }),
      expect.objectContaining({ id: "deepseek", name: "DeepSeek" }),
      expect.objectContaining({ id: "zai", name: "智谱 GLM" }),
      expect.objectContaining({ id: "qwen", name: "通义千问" }),
      expect.objectContaining({ id: "doubao", name: "豆包" }),
      expect.objectContaining({ id: "openai", name: "OpenAI" }),
      expect.objectContaining({ id: "anthropic", name: "Claude" }),
      expect.objectContaining({ id: "groq", name: "Groq" }),
      expect.objectContaining({ id: "siliconflow", name: "硅基流动" }),
    ]));
    expect(contract.BUILT_IN_PROVIDER_TEMPLATES).toHaveLength(10);
    expect(JSON.stringify(contract.BUILT_IN_PROVIDER_TEMPLATES)).not.toMatch(/uclaw-cloud|api\.u-claw\.org|虾盘云/u);
  });

  it("accepts multiple providers while rejecting duplicate IDs and invalid selection", () => {
    const schema = contract.ProviderConfigDocumentSchema as Schema;
    expect(schema).toBeDefined();
    const provider = {
      id: "openai-primary", templateId: "openai", name: "OpenAI 工作账号", enabled: true,
      baseUrl: "https://api.openai.com/v1", model: "gpt-5.4", apiKey: "sk-secret",
    };
    expect(schema.parse({ schemaVersion: 1, selectedProviderId: provider.id, providers: [provider] })).toBeTruthy();
    expect(() => schema.parse({ schemaVersion: 1, selectedProviderId: provider.id, providers: [provider, provider] })).toThrow();
    expect(() => schema.parse({ schemaVersion: 1, selectedProviderId: "missing", providers: [provider] })).toThrow();
    expect(() => schema.parse({ schemaVersion: 1, selectedProviderId: provider.id, providers: [{ ...provider, enabled: false }] })).toThrow();
  });

  it.each([
    "file:///C:/Users/name/.openclaw/openclaw.json", "javascript:alert(1)", "data:text/plain,secret",
    "ftp://example.com/v1", "http://example.com/v1", "https://user:password@example.com/v1",
    "https://example.com/v1?token=secret", "https://example.com/v1#secret",
  ])("rejects unsafe custom Base URL: %s", (baseUrl) => {
    const schema = contract.ProviderDraftSchema as Schema;
    expect(schema).toBeDefined();
    expect(() => schema.parse({ id: "custom-service", name: "自定义服务", enabled: true, baseUrl, model: "model-1" })).toThrow();
  });

  it.each(["https://example.com/v1", "http://127.0.0.1:1234/v1", "http://localhost:11434/v1", "http://[::1]:8080/v1"])(
    "accepts a safe OpenAI-compatible Base URL: %s",
    (baseUrl) => {
      const schema = contract.ProviderDraftSchema as Schema;
      expect(schema.parse({ id: "custom-service", name: "自定义服务", enabled: true, baseUrl, model: "model-1" })).toBeTruthy();
    },
  );

  it("keeps plaintext API keys out of renderer-readable provider responses", () => {
    const responseSchema = contract.ProviderIpcResponseSchema as Schema;
    expect(responseSchema).toBeDefined();
    expect(responseSchema.parse({
      method: "providers.list", requestId: "provider-list-1", ok: true,
      result: { schemaVersion: 1, selectedProviderId: "openai-primary", providers: [{
        id: "openai-primary", templateId: "openai", name: "OpenAI", enabled: true,
        baseUrl: "https://api.openai.com/v1", model: "gpt-5.4", apiKeyConfigured: true,
        apiKeyHint: "...cdef", verification: { state: "unverified" },
      }] },
    })).toBeTruthy();
    expect(() => responseSchema.parse({
      method: "providers.list", requestId: "provider-list-2", ok: true,
      result: { schemaVersion: 1, selectedProviderId: null, providers: [{ apiKey: "sk-leak" }] },
    })).toThrow();
  });

  it("uses a strict whitelist for provider mutations", () => {
    const requestSchema = contract.ProviderIpcRequestSchema as Schema;
    expect(requestSchema).toBeDefined();
    expect(requestSchema.parse({ method: "providers.set-api-key", requestId: "key-1", params: { providerId: "openai", apiKey: "sk-once" } })).toBeTruthy();
    expect(requestSchema.parse({ method: "providers.clear-api-key", requestId: "key-2", params: { providerId: "openai" } })).toBeTruthy();
    expect(requestSchema.parse({ method: "providers.move", requestId: "move-1", params: { providerId: "openai", direction: "up" } })).toBeTruthy();
    expect(() => requestSchema.parse({ method: "providers.read-api-key", requestId: "key-3", params: { providerId: "openai" } })).toThrow();
    expect(() => requestSchema.parse({ method: "providers.set-api-key", requestId: "key-4", params: { providerId: "openai", apiKey: "sk-once", path: "C:\\secret" } })).toThrow();
  });

  it("defines schema-driven OpenClaw config IPC without a secret read path", () => {
    const requestSchema = contract.ProviderIpcRequestSchema as Schema;
    const responseSchema = contract.ProviderIpcResponseSchema as Schema;
    expect(requestSchema.parse({ method: "providers.config-schema", requestId: "schema-1", params: {} })).toBeTruthy();
    expect(requestSchema.parse({ method: "providers.config-get", requestId: "get-1", params: {} })).toBeTruthy();
    expect(requestSchema.parse({ method: "providers.config-patch", requestId: "patch-1", params: { patch: { gateway: { port: 18790 } } } })).toBeTruthy();
    expect(requestSchema.parse({ method: "providers.config-apply", requestId: "apply-1", params: { config: { gateway: { port: 18790 } } } })).toBeTruthy();
    expect(responseSchema.parse({ method: "providers.config-get", requestId: "get-1", ok: true, result: { config: { models: { providers: { openai: { apiKey: "[REDACTED]" } } } } } })).toBeTruthy();
    expect(() => responseSchema.parse({ method: "providers.config-get", requestId: "get-2", ok: true, result: { config: { apiKey: "sk-leak" } } })).toThrow();
  });

  it("publishes strict discovery, connectivity, cancellation, and proxy contracts", () => {
    const requestSchema = contract.ProviderIpcRequestSchema as Schema;
    const responseSchema = contract.ProviderIpcResponseSchema as Schema;
    expect(requestSchema.parse({ method: "providers.discover-local", requestId: "discover-1", params: {} })).toBeTruthy();
    expect(requestSchema.parse({ method: "providers.cancel", requestId: "cancel-1", params: { operationRequestId: "verify-1" } })).toBeTruthy();
    expect(requestSchema.parse({
      method: "providers.set-network", requestId: "network-1", params: {
        network: { httpProxy: "http://proxy.example.com:8080", httpsProxy: "https://proxy.example.com:8443", noProxy: ["localhost", "127.0.0.1", "::1", ".example.com"] },
      },
    })).toBeTruthy();
    expect(() => requestSchema.parse({
      method: "providers.set-network", requestId: "network-2", params: {
        network: { httpProxy: "file:///tmp/proxy", httpsProxy: null, noProxy: ["*"] },
      },
    })).toThrow();
    expect(() => requestSchema.parse({
      method: "providers.set-network", requestId: "network-3", params: {
        network: { httpProxy: "socks5://127.0.0.1:1080", httpsProxy: null, noProxy: [] },
      },
    })).toThrow();
    expect(() => requestSchema.parse({
      method: "providers.set-network", requestId: "network-4", params: {
        network: { httpProxy: "http://169.254.169.254", httpsProxy: null, noProxy: [] },
      },
    })).toThrow();
    expect(responseSchema.parse({
      method: "providers.discover-local", requestId: "discover-1", ok: true,
      result: { state: "ready", models: [{ id: "llama3.2", label: "llama3.2", source: "ollama", baseUrl: "http://127.0.0.1:11434/v1" }] },
    })).toBeTruthy();
    expect(responseSchema.parse({
      method: "providers.verify", requestId: "verify-1", ok: true,
      result: { state: "failed", category: "authentication", code: "PROVIDER_AUTH_FAILED", message: "认证失败，请检查 API Key。", retryable: false },
    })).toBeTruthy();
    expect(() => responseSchema.parse({
      method: "providers.verify", requestId: "verify-leak", ok: true,
      result: { state: "failed", category: "authentication", code: "PROVIDER_AUTH_FAILED", message: "Bearer sk-secret-value", retryable: false, body: "secret" },
    })).toThrow();
  });

  it("includes renderer-safe proxy state without proxy credentials", () => {
    const schema = contract.ProviderSnapshotSchema as Schema;
    expect(schema.parse({
      schemaVersion: 1, selectedProviderId: null, providers: [],
      network: { httpProxy: null, httpsProxy: null, noProxy: ["localhost", "127.0.0.1", "::1"] },
    })).toBeTruthy();
    expect(() => schema.parse({
      schemaVersion: 1, selectedProviderId: null, providers: [],
      network: { httpProxy: "http://user:secret@proxy.example.com", httpsProxy: null, noProxy: [] },
    })).toThrow();
  });
});
