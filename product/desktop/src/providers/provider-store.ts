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

import { createProviderCredentialStore, type ProviderCredentialStore } from "./provider-credential-store.js";
import type { OpenClawProviderConfigBackend } from "./openclaw-provider-config.js";

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
  getNetworkForRuntime(): Promise<ProviderNetworkSettings>;
  getSelectedForRuntime(): Promise<ProviderConfigEntry | null>;
  getForRuntime(providerId: string): Promise<ProviderConfigEntry>;
}

export interface CreateProviderStoreOptions {
  dataDir: string;
  platformForTest?: NodeJS.Platform;
  writeAtomically?: (path: string, body: string) => Promise<void>;
  credentials?: ProviderCredentialStore;
  openClawConfig?: OpenClawProviderConfigBackend;
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

async function toSnapshot(document: ProviderConfigDocument, credentials: ProviderCredentialStore): Promise<ProviderSnapshot> {
  return ProviderSnapshotSchema.parse({
    schemaVersion: document.schemaVersion,
    selectedProviderId: document.selectedProviderId,
    providers: await Promise.all(document.providers.map(async ({ apiKey: legacyKey, ...provider }) => {
      const apiKey = legacyKey ?? await credentials.get(provider.id);
      return {
        ...provider,
        apiKeyConfigured: apiKey !== undefined,
        ...(apiKey === undefined ? {} : { apiKeyHint: `...${apiKey.slice(-4)}` }),
        verification: { state: "unverified" },
      };
    })),
    network: document.network,
  });
}

function cloneDocument(document: ProviderConfigDocument): ProviderConfigDocument {
  return structuredClone(document);
}

export function createProviderStore({
  dataDir,
  platformForTest,
  writeAtomically = defaultAtomicWrite,
  credentials = createProviderCredentialStore({ dataDir, platformForTest }),
  openClawConfig,
}: CreateProviderStoreOptions): ProviderStore {
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
      const legacyKeys = loaded.providers.flatMap((provider) => provider.apiKey === undefined ? [] : [[provider.id, provider.apiKey] as const]);
      if (legacyKeys.length > 0) {
        for (const [providerId, apiKey] of legacyKeys) await credentials.set(providerId, apiKey);
        loaded = ProviderConfigDocumentSchema.parse({
          ...loaded,
          providers: loaded.providers.map(({ apiKey: _apiKey, ...provider }) => provider),
        });
        await writeAtomically(configPath, `${JSON.stringify(loaded, null, 2)}\n`);
      }
    } catch {
      throw providerError("OPERATION_FAILED", "Provider configuration could not be loaded.");
    }
    return loaded;
  };

  const persist = async (next: ProviderConfigDocument): Promise<ProviderConfigDocument> => {
    const parsed = ProviderConfigDocumentSchema.parse(next);
    try {
      await writeAtomically(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
    } catch {
      throw providerError("OPERATION_FAILED", "Provider configuration could not be saved.");
    }
    loaded = parsed;
    return parsed;
  };
  const commit = async (next: ProviderConfigDocument): Promise<ProviderSnapshot> => toSnapshot(await persist(next), credentials);

  const withCredentials = async (document: ProviderConfigDocument): Promise<ProviderConfigDocument> => ProviderConfigDocumentSchema.parse({
    ...document,
    providers: await Promise.all(document.providers.map(async (provider) => {
      const apiKey = await credentials.get(provider.id);
      return { ...provider, ...(apiKey === undefined ? {} : { apiKey }) };
    })),
  });

  const synchronizeAndCommit = async (
    previous: ProviderConfigDocument,
    next: ProviderConfigDocument,
    metadata: ProviderConfigDocument,
  ): Promise<ProviderConfigDocument> => {
    if (openClawConfig === undefined) return persist(metadata);
    await openClawConfig.synchronize(previous, next);
    let persisted: ProviderConfigDocument;
    try {
      persisted = await persist(metadata);
    } catch (commitError) {
      try {
        await openClawConfig.synchronize(next, previous);
      } catch (rollbackError) {
        throw new AggregateError([commitError, rollbackError], "Provider metadata commit and OpenClaw compensation both failed.");
      }
      throw commitError;
    }
    return persisted;
  };

  const mutate = (change: (document: ProviderConfigDocument) => void): Promise<ProviderSnapshot> => serialize(async () => {
    const next = cloneDocument(await load());
    const previous = cloneDocument(await load());
    change(next);
    return toSnapshot(await synchronizeAndCommit(await withCredentials(previous), await withCredentials(next), next), credentials);
  });
  const mutateLocal = (change: (document: ProviderConfigDocument) => void): Promise<ProviderSnapshot> => serialize(async () => {
    const next = cloneDocument(await load());
    change(next);
    return commit(next);
  });

  const requireProvider = (document: ProviderConfigDocument, providerId: string): ProviderConfigEntry => {
    const provider = document.providers.find(({ id }) => id === providerId);
    if (provider === undefined) throw providerError("NOT_FOUND", "Provider was not found.");
    return provider;
  };

  const restoreCredentialsOrThrow = async (
    operationError: unknown,
    restorations: readonly (() => Promise<void>)[],
  ): Promise<never> => {
    const failures: unknown[] = [operationError];
    for (const restore of restorations) {
      try {
        await restore();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 1) throw new AggregateError(failures, "Provider credential operation and restoration both failed.");
    throw operationError;
  };

  return {
    list: () => serialize(async () => toSnapshot(await load(), credentials)),
    create: (draft) => mutate((document) => {
      const provider = ProviderDraftSchema.parse(draft);
      if (document.providers.some(({ id }) => id === provider.id)) throw providerError("CONFLICT", "Provider ID already exists.");
      document.providers.push(provider);
      if (provider.enabled) document.selectedProviderId = provider.id;
    }),
    update: (providerId, draft) => serialize(async () => {
      const document = cloneDocument(await load());
      const index = document.providers.findIndex(({ id }) => id === providerId);
      if (index < 0) throw providerError("NOT_FOUND", "Provider was not found.");
      const provider = ProviderDraftSchema.parse(draft);
      if (provider.id !== providerId && document.providers.some(({ id }) => id === provider.id)) throw providerError("CONFLICT", "Provider ID already exists.");
      const previous = document.providers[index];
      const previousDocument = cloneDocument(document);
      const apiKey = await credentials.get(providerId);
      document.providers[index] = provider;
      if (document.selectedProviderId === providerId) {
        document.selectedProviderId = provider.enabled ? provider.id : null;
      }
      if (!previous.enabled && provider.enabled) document.selectedProviderId = provider.id;
      const renamedWithCredential = provider.id !== providerId && apiKey !== undefined;
      const previousRuntime = ProviderConfigDocumentSchema.parse({
        ...previousDocument,
        providers: previousDocument.providers.map((entry) => entry.id === providerId && apiKey !== undefined ? { ...entry, apiKey } : entry),
      });
      if (renamedWithCredential) {
        try {
          await credentials.set(provider.id, apiKey);
          await credentials.remove(providerId);
        } catch (error) {
          return restoreCredentialsOrThrow(error, [
            () => credentials.set(providerId, apiKey),
            () => credentials.remove(provider.id),
          ]);
        }
      }
      let persisted: ProviderConfigDocument;
      try {
        persisted = await synchronizeAndCommit(previousRuntime, await withCredentials(document), document);
      } catch (error) {
        if (!renamedWithCredential) throw error;
        return restoreCredentialsOrThrow(error, [
          () => credentials.set(providerId, apiKey),
          () => credentials.remove(provider.id),
        ]);
      }
      return toSnapshot(persisted, credentials);
    }),
    remove: (providerId) => serialize(async () => {
      const previous = cloneDocument(await load());
      const document = cloneDocument(previous);
      const index = document.providers.findIndex(({ id }) => id === providerId);
      if (index < 0) throw providerError("NOT_FOUND", "Provider was not found.");
      const previousKey = await credentials.get(providerId);
      const previousRuntime = ProviderConfigDocumentSchema.parse({
        ...previous,
        providers: previous.providers.map((provider) => provider.id === providerId && previousKey !== undefined ? { ...provider, apiKey: previousKey } : provider),
      });
      document.providers.splice(index, 1);
      if (document.selectedProviderId === providerId) document.selectedProviderId = null;
      if (previousKey !== undefined) {
        try {
          await credentials.remove(providerId);
        } catch (error) {
          return restoreCredentialsOrThrow(error, [() => credentials.set(providerId, previousKey)]);
        }
      }
      let persisted: ProviderConfigDocument;
      try {
        persisted = await synchronizeAndCommit(previousRuntime, await withCredentials(document), document);
      } catch (error) {
        if (previousKey === undefined) throw error;
        return restoreCredentialsOrThrow(error, [() => credentials.set(providerId, previousKey)]);
      }
      return toSnapshot(persisted, credentials);
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
    setApiKey: (providerId, apiKey) => serialize(async () => {
      if (!ProviderIpcRequestSchema.safeParse({ method: "providers.set-api-key", requestId: "store-validation", params: { providerId, apiKey } }).success) {
        throw providerError("INVALID_ARGUMENT", "Invalid provider API key.");
      }
      const document = await load();
      requireProvider(document, providerId);
      const previousKey = await credentials.get(providerId);
      await credentials.set(providerId, apiKey);
      let persisted: ProviderConfigDocument;
      try {
        const previous = ProviderConfigDocumentSchema.parse({ ...document, providers: document.providers.map((provider) => provider.id === providerId && previousKey !== undefined ? { ...provider, apiKey: previousKey } : provider) });
        persisted = await synchronizeAndCommit(previous, await withCredentials(document), document);
      } catch (error) {
        if (previousKey === undefined) await credentials.remove(providerId); else await credentials.set(providerId, previousKey);
        throw error;
      }
      return toSnapshot(persisted, credentials);
    }),
    clearApiKey: (providerId) => serialize(async () => {
      const document = await load();
      requireProvider(document, providerId);
      const previousKey = await credentials.get(providerId);
      await credentials.remove(providerId);
      let persisted: ProviderConfigDocument;
      try {
        const previous = ProviderConfigDocumentSchema.parse({ ...document, providers: document.providers.map((provider) => provider.id === providerId && previousKey !== undefined ? { ...provider, apiKey: previousKey } : provider) });
        persisted = await synchronizeAndCommit(previous, await withCredentials(document), document);
      } catch (error) {
        if (previousKey !== undefined) await credentials.set(providerId, previousKey);
        throw error;
      }
      return toSnapshot(persisted, credentials);
    }),
    setNetwork: (network) => mutateLocal((document) => {
      const parsed = ProviderNetworkSettingsSchema.safeParse(network);
      if (!parsed.success) throw providerError("INVALID_ARGUMENT", "Invalid provider network settings.");
      document.network = parsed.data;
    }),
    getNetworkForRuntime: () => serialize(async () => structuredClone((await load()).network)),
    getSelectedForRuntime: () => serialize(async () => {
      const document = await load();
      const selected = document.providers.find(({ id }) => id === document.selectedProviderId);
      if (selected === undefined) return null;
      const apiKey = await credentials.get(selected.id);
      return structuredClone({ ...selected, ...(apiKey === undefined ? {} : { apiKey }) });
    }),
    getForRuntime: (providerId) => serialize(async () => {
      const provider = requireProvider(await load(), providerId);
      const apiKey = await credentials.get(providerId);
      return structuredClone({ ...provider, ...(apiKey === undefined ? {} : { apiKey }) });
    }),
  };
}
