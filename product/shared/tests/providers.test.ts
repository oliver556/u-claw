import { describe, expect, it } from "vitest";

import * as shared from "../src/index.js";

type Schema = { parse(value: unknown): unknown };

describe("provider contracts", () => {
  const contract = shared as unknown as Record<string, unknown>;

  it("publishes the versioned built-in provider catalog", () => {
    expect(contract.PROVIDER_CONFIG_VERSION).toBe(1);
    expect(contract.BUILT_IN_PROVIDER_TEMPLATES).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "uclaw-cloud", name: "虾盘云" }),
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
    expect(contract.BUILT_IN_PROVIDER_TEMPLATES).toHaveLength(11);
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
});
