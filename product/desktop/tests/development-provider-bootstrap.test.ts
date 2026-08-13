import { describe, expect, it, vi } from "vitest";

import {
  DEVELOPMENT_PROVIDER_ID,
  bootstrapDevelopmentProvider,
  readDevelopmentProvider,
} from "../src/providers/development-provider-bootstrap.js";
import type { ProviderStore } from "../src/providers/provider-store.js";

describe("development provider bootstrap", () => {
  it("requires a complete fixed GPT-5.6 Sol configuration", () => {
    expect(readDevelopmentProvider({})).toBeNull();
    expect(() => readDevelopmentProvider({ UCLAW_TEST_PROVIDER_BASE_URL: "https://provider.example/v1" })).toThrowError(expect.objectContaining({ code: "UNCONFIGURED" }));
    expect(() => readDevelopmentProvider({
      UCLAW_TEST_PROVIDER_BASE_URL: "https://provider.example/v1",
      UCLAW_TEST_PROVIDER_API_KEY: "test-secret",
      UCLAW_TEST_PROVIDER_MODEL: "gpt-5.6-luna",
    })).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(readDevelopmentProvider({
      UCLAW_TEST_PROVIDER_BASE_URL: "https://provider.example/v1",
      UCLAW_TEST_PROVIDER_API_KEY: "test-secret",
      UCLAW_TEST_PROVIDER_MODEL: "gpt-5.6-sol",
    })).toEqual({
      id: DEVELOPMENT_PROVIDER_ID,
      name: "U-Claw GPT",
      enabled: true,
      baseUrl: "https://provider.example/v1",
      model: "gpt-5.6-sol",
      apiKey: "test-secret",
    });
  });

  it("uses the only public model when the optional model value is empty", () => {
    expect(readDevelopmentProvider({
      UCLAW_TEST_PROVIDER_BASE_URL: "https://provider.example/v1",
      UCLAW_TEST_PROVIDER_API_KEY: "test-secret",
      UCLAW_TEST_PROVIDER_MODEL: "",
    })).toMatchObject({
      model: "gpt-5.6-sol",
    });
  });

  it("creates once, refreshes the credential, and selects idempotently", async () => {
    let providers: Array<{ id: string; name: string; enabled: boolean; baseUrl: string | null; model: string }> = [];
    let selectedProviderId: string | null = null;
    const store = {
      list: vi.fn(async () => ({ schemaVersion: 1 as const, selectedProviderId, providers: providers.map((provider) => ({ ...provider, apiKeyConfigured: false, verification: { state: "unverified" as const } })) })),
      create: vi.fn(async (provider) => { providers = [...providers, provider]; selectedProviderId = provider.id; return store.list(); }),
      update: vi.fn(async (_providerId, provider) => { providers = providers.map((item) => item.id === _providerId ? provider : item); return store.list(); }),
      setApiKey: vi.fn(async () => store.list()),
      select: vi.fn(async (providerId) => { selectedProviderId = providerId; return store.list(); }),
    } as unknown as ProviderStore;
    const configuration = readDevelopmentProvider({
      UCLAW_TEST_PROVIDER_BASE_URL: "https://provider.example/v1",
      UCLAW_TEST_PROVIDER_API_KEY: "test-secret",
      UCLAW_TEST_PROVIDER_MODEL: "gpt-5.6-sol",
    });

    await bootstrapDevelopmentProvider(store, configuration);
    await bootstrapDevelopmentProvider(store, configuration);

    expect(providers.filter(({ id }) => id === DEVELOPMENT_PROVIDER_ID)).toHaveLength(1);
    expect(store.create).toHaveBeenCalledTimes(1);
    expect(store.update).not.toHaveBeenCalled();
    expect(store.setApiKey).toHaveBeenCalledTimes(2);
    expect(store.select).not.toHaveBeenCalled();
  });
});
