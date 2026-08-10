import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  BUILT_IN_PROVIDER_TEMPLATES,
  PROVIDER_CONFIG_VERSION,
  ProviderConfigDocumentSchema,
  ProviderDraftSchema,
  ProviderIpcRequestSchema,
  ProviderNetworkSettingsSchema,
  ProviderSnapshotSchema,
  UClawErrorSchema,
  type ProviderConfigDocument,
  type ProviderConfigEntry,
  type ProviderDraft,
  type ProviderSnapshot,
  type ProviderNetworkSettings,
  type UClawError,
} from "@uclaw/shared";

export interface ProviderStore {
  list(): Promise<ProviderSnapshot>;
  create(provider: ProviderDraft): Promise<ProviderSnapshot>;
  update(providerId: string, provider: ProviderDraft): Promise<ProviderSnapshot>;
  remove(providerId: string): Promise<ProviderSnapshot>;
  setEnabled(providerId: string, enabled: boolean): Promise<ProviderSnapshot>;
  move(providerId: string, direction: "up" | "down"): Promise<ProviderSnapshot>;
  select(providerId: string): Promise<ProviderSnapshot>;
  setApiKey(providerId: string, apiKey: string): Promise<ProviderSnapshot>;
  clearApiKey(providerId: string): Promise<ProviderSnapshot>;
  setNetwork(network: ProviderNetworkSettings): Promise<ProviderSnapshot>;
  getSelectedForRuntime(): Promise<ProviderConfigEntry | null>;
  getForRuntime(providerId: string): Promise<ProviderConfigEntry>;
}

export interface CreateProviderStoreOptions {
  dataDir: string;
  writeAtomically?: (path: string, body: string) => Promise<void>;
}

const configFileName = "provider-config.v1.json";

function providerError(code: UClawError["code"], message: string): UClawError {
  return UClawErrorSchema.parse({ code, message, retryable: code === "OPERATION_FAILED", recoveryActions: [], causeDetails: {} });
}

function defaultDocument(): ProviderConfigDocument {
  return ProviderConfigDocumentSchema.parse({
    schemaVersion: PROVIDER_CONFIG_VERSION,
    selectedProviderId: null,
    providers: BUILT_IN_PROVIDER_TEMPLATES.map(({ id, name, baseUrl, model }) => ({
      id,
      templateId: id,
      name,
      enabled: false,
      baseUrl,
      model,
    })),
  });
}

function migrateLegacyBuiltin(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const document = structuredClone(value) as Record<string, unknown>;
  if (!Array.isArray(document.providers)) return document;
  document.providers = document.providers.filter((provider) => {
    if (provider === null || typeof provider !== "object" || Array.isArray(provider)) return true;
    const entry = provider as Record<string, unknown>;
    return entry.id !== "uclaw-cloud" && entry.templateId !== "uclaw-cloud";
  });
  if (document.selectedProviderId === "uclaw-cloud") document.selectedProviderId = null;
  return document;
}

async function defaultAtomicWrite(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${configFileName}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function toSnapshot(document: ProviderConfigDocument): ProviderSnapshot {
  return ProviderSnapshotSchema.parse({
    schemaVersion: document.schemaVersion,
    selectedProviderId: document.selectedProviderId,
    providers: document.providers.map(({ apiKey, ...provider }) => ({
      ...provider,
      apiKeyConfigured: apiKey !== undefined,
      ...(apiKey === undefined ? {} : { apiKeyHint: `...${apiKey.slice(-4)}` }),
      verification: { state: "unverified" },
    })),
    network: document.network,
  });
}

function cloneDocument(document: ProviderConfigDocument): ProviderConfigDocument {
  return structuredClone(document);
}

export function createProviderStore({ dataDir, writeAtomically = defaultAtomicWrite }: CreateProviderStoreOptions): ProviderStore {
  const configPath = join(dataDir, "providers", configFileName);
  let loaded: ProviderConfigDocument | undefined;
  let queue = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  const load = async (): Promise<ProviderConfigDocument> => {
    if (loaded !== undefined) return loaded;
    let body: string;
    try {
      body = await readFile(configPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        loaded = defaultDocument();
        return loaded;
      }
      throw providerError("OPERATION_FAILED", "Provider configuration could not be loaded.");
    }
    try {
      loaded = ProviderConfigDocumentSchema.parse(migrateLegacyBuiltin(JSON.parse(body)));
    } catch {
      throw providerError("OPERATION_FAILED", "Provider configuration could not be loaded.");
    }
    return loaded;
  };

  const commit = async (next: ProviderConfigDocument): Promise<ProviderSnapshot> => {
    const parsed = ProviderConfigDocumentSchema.parse(next);
    try {
      await writeAtomically(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
    } catch {
      throw providerError("OPERATION_FAILED", "Provider configuration could not be saved.");
    }
    loaded = parsed;
    return toSnapshot(parsed);
  };

  const mutate = (change: (document: ProviderConfigDocument) => void): Promise<ProviderSnapshot> => serialize(async () => {
    const next = cloneDocument(await load());
    change(next);
    return commit(next);
  });

  const requireProvider = (document: ProviderConfigDocument, providerId: string): ProviderConfigEntry => {
    const provider = document.providers.find(({ id }) => id === providerId);
    if (provider === undefined) throw providerError("NOT_FOUND", "Provider was not found.");
    return provider;
  };

  return {
    list: () => serialize(async () => toSnapshot(await load())),
    create: (draft) => mutate((document) => {
      const provider = ProviderDraftSchema.parse(draft);
      if (document.providers.some(({ id }) => id === provider.id)) throw providerError("CONFLICT", "Provider ID already exists.");
      document.providers.push(provider);
      if (provider.enabled) document.selectedProviderId = provider.id;
    }),
    update: (providerId, draft) => mutate((document) => {
      const index = document.providers.findIndex(({ id }) => id === providerId);
      if (index < 0) throw providerError("NOT_FOUND", "Provider was not found.");
      const provider = ProviderDraftSchema.parse(draft);
      if (provider.id !== providerId && document.providers.some(({ id }) => id === provider.id)) throw providerError("CONFLICT", "Provider ID already exists.");
      const previous = document.providers[index];
      const apiKey = previous.apiKey;
      document.providers[index] = { ...provider, ...(apiKey === undefined ? {} : { apiKey }) };
      if (document.selectedProviderId === providerId) {
        document.selectedProviderId = provider.enabled ? provider.id : null;
      }
      if (!previous.enabled && provider.enabled) document.selectedProviderId = provider.id;
    }),
    remove: (providerId) => mutate((document) => {
      const index = document.providers.findIndex(({ id }) => id === providerId);
      if (index < 0) throw providerError("NOT_FOUND", "Provider was not found.");
      document.providers.splice(index, 1);
      if (document.selectedProviderId === providerId) document.selectedProviderId = null;
    }),
    setEnabled: (providerId, enabled) => mutate((document) => {
      const provider = requireProvider(document, providerId);
      provider.enabled = enabled;
      if (!enabled && document.selectedProviderId === providerId) document.selectedProviderId = null;
      if (enabled) document.selectedProviderId = providerId;
    }),
    move: (providerId, direction) => mutate((document) => {
      const index = document.providers.findIndex(({ id }) => id === providerId);
      if (index < 0) throw providerError("NOT_FOUND", "Provider was not found.");
      const target = direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= document.providers.length) return;
      [document.providers[index], document.providers[target]] = [document.providers[target], document.providers[index]];
    }),
    select: (providerId) => mutate((document) => {
      const provider = requireProvider(document, providerId);
      if (!provider.enabled) throw providerError("INVALID_ARGUMENT", "Disabled provider cannot be selected.");
      document.selectedProviderId = providerId;
    }),
    setApiKey: (providerId, apiKey) => mutate((document) => {
      if (!ProviderIpcRequestSchema.safeParse({ method: "providers.set-api-key", requestId: "store-validation", params: { providerId, apiKey } }).success) {
        throw providerError("INVALID_ARGUMENT", "Invalid provider API key.");
      }
      requireProvider(document, providerId).apiKey = apiKey;
    }),
    clearApiKey: (providerId) => mutate((document) => {
      delete requireProvider(document, providerId).apiKey;
    }),
    setNetwork: (network) => mutate((document) => {
      const parsed = ProviderNetworkSettingsSchema.safeParse(network);
      if (!parsed.success) throw providerError("INVALID_ARGUMENT", "Invalid provider network settings.");
      document.network = parsed.data;
    }),
    getSelectedForRuntime: () => serialize(async () => {
      const document = await load();
      const selected = document.providers.find(({ id }) => id === document.selectedProviderId);
      return selected === undefined ? null : structuredClone(selected);
    }),
    getForRuntime: (providerId) => serialize(async () => structuredClone(requireProvider(await load(), providerId))),
  };
}
