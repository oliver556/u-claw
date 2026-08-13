import {
  ProviderDraftSchema,
  UClawErrorSchema,
  type ProviderDraft,
  type UClawError,
} from "@uclaw/shared";

import type { ProviderStore } from "./provider-store.js";

export const DEVELOPMENT_PROVIDER_ID = "uclaw-development-gpt";
const DEVELOPMENT_PROVIDER_MODEL = "gpt-5.6-sol";

export interface DevelopmentProvider extends ProviderDraft {
  apiKey: string;
}

function configurationError(code: UClawError["code"], message: string): UClawError {
  return UClawErrorSchema.parse({ code, message, retryable: false, recoveryActions: [], causeDetails: {} });
}

export function readDevelopmentProvider(env: NodeJS.ProcessEnv): DevelopmentProvider | null {
  const values = [
    env.UCLAW_TEST_PROVIDER_BASE_URL,
    env.UCLAW_TEST_PROVIDER_API_KEY,
    env.UCLAW_TEST_PROVIDER_MODEL,
  ];
  if (values.every((value) => value === undefined)) return null;
  if (values.some((value) => value === undefined)) {
    throw configurationError("UNCONFIGURED", "Development model provider is not configured.");
  }
  const [baseUrl, apiKey, configuredModel] = values as [string, string, string];
  const model = configuredModel === "" ? DEVELOPMENT_PROVIDER_MODEL : configuredModel;
  if (model !== DEVELOPMENT_PROVIDER_MODEL) {
    throw configurationError("INVALID_ARGUMENT", "Development model provider is invalid.");
  }
  let draft: ProviderDraft;
  try {
    draft = ProviderDraftSchema.parse({
      id: DEVELOPMENT_PROVIDER_ID,
      name: "U-Claw GPT",
      enabled: true,
      baseUrl,
      model,
    });
    if (apiKey.length === 0 || apiKey !== apiKey.trim() || apiKey.includes("\0")) throw new Error("invalid key");
  } catch {
    throw configurationError("INVALID_ARGUMENT", "Development model provider is invalid.");
  }
  return { ...draft, apiKey };
}

export async function bootstrapDevelopmentProvider(store: ProviderStore, configuration: DevelopmentProvider | null): Promise<void> {
  if (configuration === null) return;
  const { apiKey, ...draft } = configuration;
  let snapshot = await store.list();
  const existing = snapshot.providers.find(({ id }) => id === configuration.id);
  if (existing === undefined) {
    snapshot = await store.create(draft);
  } else if (
    existing.name !== draft.name || existing.enabled !== draft.enabled ||
    existing.baseUrl !== draft.baseUrl || existing.model !== draft.model ||
    existing.templateId !== draft.templateId
  ) {
    snapshot = await store.update(existing.id, draft);
  }
  snapshot = await store.setApiKey(configuration.id, apiKey);
  if (snapshot.selectedProviderId !== configuration.id) await store.select(configuration.id);
}
