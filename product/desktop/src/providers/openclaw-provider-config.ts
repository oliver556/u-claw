import { isAbsolute } from "node:path";

import {
  UClawErrorSchema,
  normalizeKey,
  type ProviderConfigDocument,
  type ProviderConfigEntry,
  type UClawError,
} from "@uclaw/shared";

type JsonObject = Record<string, unknown>;

export interface OpenClawConfigRpc {
  request(method: "config.get" | "config.schema" | "config.patch" | "config.apply", params: JsonObject): Promise<unknown>;
}

export interface RendererConfigSnapshot {
  config: JsonObject;
  schema: JsonObject;
  uiHints?: JsonObject;
}

export interface OpenClawProviderConfigBackend {
  synchronize(previous: ProviderConfigDocument, next: ProviderConfigDocument): Promise<void>;
  synchronizeCommercial(input: CommercialProviderConfig): Promise<boolean>;
  readCommercial(): Promise<{ configured: boolean }>;
  getRendererConfig(): Promise<RendererConfigSnapshot>;
  patchRendererConfig(patch: JsonObject): Promise<RendererConfigSnapshot>;
  applyRendererConfig(config: JsonObject): Promise<RendererConfigSnapshot>;
  applyMainConfig(config: JsonObject): Promise<void>;
}

export interface CommercialProviderModel {
  id: string;
  name: string;
}

export interface CommercialProviderConfig {
  endpoint: string;
  credentialPath: string;
  models: readonly CommercialProviderModel[];
}

interface ConfigReadback {
  config: JsonObject;
  hash: string;
}

const SENSITIVE_VALUE = /(?:bearer\s+|\bsk[-_]|api[-_ ]?key\s*[:=]|token\s*[:=]|secret\s*[:=])/iu;
const RENDERER_REDACTED = "[REDACTED]";
const OPENCLAW_REDACTED = "__OPENCLAW_REDACTED__";

function backendError(code: UClawError["code"], message: string, retryable = false): UClawError {
  return UClawErrorSchema.parse({ code, message, retryable, recoveryActions: retryable ? ["retry"] : [], causeDetails: {} });
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertJsonObject(value: unknown, message: string): JsonObject {
  if (!isObject(value)) throw backendError("PROTOCOL_MAPPING_FAILED", message);
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!isObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function getPath(value: JsonObject, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (!isObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function secretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return /(?:^|_)(?:authorization|cookie|credential|key|password|private_key|secret|token)(?:_|$)/u.test(normalized);
}

function redact(value: unknown, key = ""): unknown {
  if (secretKey(key)) return RENDERER_REDACTED;
  if (Array.isArray(value)) return value.map((entry) => redact(entry));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, redact(entry, entryKey)]));
}

function restoreOpenClawRedaction(value: unknown, key = ""): unknown {
  if (secretKey(key) && value === RENDERER_REDACTED) return OPENCLAW_REDACTED;
  if (Array.isArray(value)) return value.map((entry) => restoreOpenClawRedaction(entry));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, restoreOpenClawRedaction(entry, entryKey)]));
}

function assertRendererPatchSafe(value: unknown, key = ""): void {
  if (secretKey(key) && value !== RENDERER_REDACTED) throw backendError("INVALID_ARGUMENT", "Secret configuration must use the controlled credential operation.");
  if (secretKey(key)) return;
  if (typeof value === "string" && SENSITIVE_VALUE.test(value)) {
    throw backendError("INVALID_ARGUMENT", "Secret configuration must use the controlled credential operation.");
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertRendererPatchSafe(entry);
    return;
  }
  if (!isObject(value)) return;
  for (const [entryKey, entry] of Object.entries(value)) assertRendererPatchSafe(entry, entryKey);
}

function providerConfig(provider: ProviderConfigEntry): JsonObject {
  return {
    baseUrl: provider.baseUrl,
    ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
    api: "openai-completions",
    models: [{
      id: provider.model,
      name: provider.model,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    }],
  };
}

function compactProviderConfig(provider: ProviderConfigEntry, includeCredential: boolean): JsonObject {
  return {
    baseUrl: provider.baseUrl,
    ...(includeCredential && provider.apiKey !== undefined ? { apiKey: provider.apiKey } : {}),
    ...(includeCredential ? { api: "openai-completions" } : {}),
    models: [{ id: provider.model, name: provider.model }],
  };
}

function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch;
  const result: JsonObject = isObject(target) ? structuredClone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

function pruneProviderOwnedEmptyContainers(config: JsonObject): JsonObject {
  const result = structuredClone(config);
  const models = result.models;
  if (isObject(models)) {
    if (isObject(models.providers) && Object.keys(models.providers).length === 0) delete models.providers;
    if (Object.keys(models).length === 0) delete result.models;
  }
  const agents = result.agents;
  if (isObject(agents) && isObject(agents.defaults)) {
    if (isObject(agents.defaults.model) && Object.keys(agents.defaults.model).length === 0) delete agents.defaults.model;
    if (Object.keys(agents.defaults).length === 0) delete agents.defaults;
    if (Object.keys(agents).length === 0) delete result.agents;
  }
  if (isObject(result.env) && Object.keys(result.env).length === 0) delete result.env;
  return result;
}

function serializedConfigBytes(config: JsonObject): number {
  return new TextEncoder().encode(`${JSON.stringify(config, null, 2)}\n`).byteLength;
}

function compactRemovedProviders(config: JsonObject, providers: readonly ProviderConfigEntry[]): JsonObject {
  const result = structuredClone(config);
  const models = isObject(result.models) ? result.models : (result.models = {} as JsonObject);
  const configured = isObject(models.providers) ? models.providers : (models.providers = {} as JsonObject);
  for (const provider of providers) configured[provider.id] = compactProviderConfig(provider, true);
  return result;
}

function providerDeletionBridge(config: JsonObject, providers: readonly ProviderConfigEntry[]): JsonObject {
  const result = structuredClone(config);
  const models = isObject(result.models) ? result.models : (result.models = {} as JsonObject);
  const configured = isObject(models.providers) ? models.providers : (models.providers = {} as JsonObject);
  for (const provider of providers) configured[provider.id] = compactProviderConfig(provider, false);
  return result;
}

function providerOwnedState(config: JsonObject): string {
  const zaiApiKey = getPath(config, ["env", "ZAI_API_KEY"]);
  return canonical({
    mode: getPath(config, ["models", "mode"]) ?? null,
    providers: redact(getPath(config, ["models", "providers"]) ?? {}),
    primary: getPath(config, ["agents", "defaults", "model", "primary"]) ?? null,
    zaiApiKey: zaiApiKey === undefined || zaiApiKey === null ? null : RENDERER_REDACTED,
  });
}

function assertProviderOwnedPathsUnchanged(before: JsonObject, after: JsonObject): void {
  if (providerOwnedState(before) !== providerOwnedState(after)) {
    throw backendError("INVALID_ARGUMENT", "Raw configuration cannot change Provider-owned paths.");
  }
}

function providerPatch(previous: ProviderConfigDocument, next: ProviderConfigDocument): JsonObject {
  const previousIds = new Set(previous.providers.map(({ id }) => id));
  const nextIds = new Set(next.providers.map(({ id }) => id));
  const providers: JsonObject = {};
  const env: JsonObject = {};
  for (const id of previousIds) {
    if (!nextIds.has(id)) providers[id] = null;
  }
  for (const provider of next.providers) {
    if (provider.id === "zai" && provider.baseUrl === null) {
      continue;
    }
    if (!provider.enabled) {
      providers[provider.id] = null;
      continue;
    }
    const projected = providerConfig(provider);
    const previousProvider = previous.providers.find(({ id }) => id === provider.id);
    if (previousProvider?.apiKey !== undefined && provider.apiKey === undefined) projected.apiKey = null;
    providers[provider.id] = projected;
  }
  const zaiValue = (document: ProviderConfigDocument): string | null => {
    const provider = document.providers.find(({ id, baseUrl }) => id === "zai" && baseUrl === null);
    return provider?.enabled === true ? provider.apiKey ?? null : null;
  };
  const previousZaiValue = zaiValue(previous);
  const nextZaiValue = zaiValue(next);
  if (previousZaiValue !== nextZaiValue) env.ZAI_API_KEY = nextZaiValue;
  const selected = next.providers.find(({ id }) => id === next.selectedProviderId);
  const hasOpenAiCompatibleProvider = next.providers.some((provider) => provider.enabled && !(provider.id === "zai" && provider.baseUrl === null));
  return {
    models: { mode: hasOpenAiCompatibleProvider ? "merge" : null, providers },
    agents: { defaults: { model: { primary: selected === undefined ? null : `${selected.id}/${selected.model}` } } },
    ...(Object.keys(env).length === 0 ? {} : { env }),
  };
}

function assertProviderReadback(previous: ProviderConfigDocument, next: ProviderConfigDocument, readback: JsonObject): void {
  const providers = getPath(readback, ["models", "providers"]);
  const mode = getPath(readback, ["models", "mode"]);
  const primary = getPath(readback, ["agents", "defaults", "model", "primary"]);
  const selected = next.providers.find(({ id }) => id === next.selectedProviderId);
  const expectedMode = next.providers.some((provider) => provider.enabled && !(provider.id === "zai" && provider.baseUrl === null)) ? "merge" : undefined;
  if (expectedMode === undefined ? mode !== undefined && mode !== null : mode !== expectedMode) {
    throw backendError("CONFLICT", "OpenClaw provider configuration readback did not match the write.");
  }
  const expectedPrimary = selected === undefined ? undefined : `${selected.id}/${selected.model}`;
  if (selected === undefined ? primary !== undefined && primary !== null : primary !== expectedPrimary) {
    throw backendError("CONFLICT", "OpenClaw provider configuration readback did not match the write.");
  }
  for (const provider of next.providers) {
    if (provider.id === "zai" && provider.baseUrl === null) {
      const actual = getPath(readback, ["env", "ZAI_API_KEY"]);
      const configured = actual === provider.apiKey || actual === RENDERER_REDACTED || actual === OPENCLAW_REDACTED;
      if (provider.enabled && provider.apiKey !== undefined ? !configured : actual !== undefined && actual !== null) {
        throw backendError("CONFLICT", "OpenClaw provider configuration readback did not match the write.");
      }
      continue;
    }
    const actual = isObject(providers) ? providers[provider.id] : undefined;
    if (!provider.enabled) {
      if (actual !== undefined && actual !== null) throw backendError("CONFLICT", "OpenClaw provider configuration readback did not match the write.");
      continue;
    }
    if (!isObject(actual)
      || actual.baseUrl !== provider.baseUrl
      || provider.apiKey !== undefined && actual.apiKey !== provider.apiKey && actual.apiKey !== RENDERER_REDACTED && actual.apiKey !== OPENCLAW_REDACTED
      || provider.apiKey === undefined && actual.apiKey !== undefined && actual.apiKey !== null
      || !Array.isArray(actual.models)
      || !isObject(actual.models[0])
      || actual.models[0].id !== provider.model) {
      throw backendError("CONFLICT", "OpenClaw provider configuration readback did not match the write.");
    }
  }
  const nextIds = new Set(next.providers.map(({ id }) => id));
  for (const provider of previous.providers) {
    if (nextIds.has(provider.id)) continue;
    if (provider.id === "zai" && provider.baseUrl === null) {
      const actual = getPath(readback, ["env", "ZAI_API_KEY"]);
      if (actual !== undefined && actual !== null) throw backendError("CONFLICT", "OpenClaw provider configuration readback did not match the write.");
      continue;
    }
    const actual = isObject(providers) ? providers[provider.id] : undefined;
    if (actual !== undefined && actual !== null) throw backendError("CONFLICT", "OpenClaw provider configuration readback did not match the write.");
  }
}

export function createOpenClawProviderConfigBackend(rpc: OpenClawConfigRpc): OpenClawProviderConfigBackend {
  const getSchema = async (): Promise<{ schema: JsonObject; uiHints?: JsonObject }> => {
    const response = assertJsonObject(await rpc.request("config.schema", {}), "OpenClaw config schema response is invalid.");
    const schema = assertJsonObject(response.schema, "OpenClaw config schema response is invalid.");
    const uiHints = response.uiHints === undefined ? undefined : assertJsonObject(response.uiHints, "OpenClaw config schema response is invalid.");
    return { schema, ...(uiHints === undefined ? {} : { uiHints }) };
  };
  const getConfig = async (): Promise<ConfigReadback> => {
    const response = assertJsonObject(await rpc.request("config.get", {}), "OpenClaw config response is invalid.");
    if (response.valid !== true || typeof response.hash !== "string" || response.hash.length === 0) {
      throw backendError("PROTOCOL_MAPPING_FAILED", "OpenClaw config response is invalid.");
    }
    return {
      config: assertJsonObject(response.sourceConfig ?? response.config, "OpenClaw config response is invalid."),
      hash: response.hash,
    };
  };
  const mutate = async (
    method: "config.patch" | "config.apply",
    value: JsonObject,
    validate?: (before: JsonObject, value: JsonObject) => void,
  ): Promise<ConfigReadback> => {
    await getSchema();
    const before = await getConfig();
    validate?.(before.config, value);
    const response = assertJsonObject(await rpc.request(method, { raw: JSON.stringify(value), baseHash: before.hash }), "OpenClaw config write response is invalid.");
    if (response.ok !== true) throw backendError("OPERATION_FAILED", "OpenClaw config write failed.", true);
    return getConfig();
  };
  const synchronizeProviderConfig = async (previous: ProviderConfigDocument, next: ProviderConfigDocument): Promise<ConfigReadback> => {
    await getSchema();
    let current = await getConfig();
    let writeAcknowledged = false;
    const config = pruneProviderOwnedEmptyContainers(assertJsonObject(
      mergePatch(current.config, providerPatch(previous, next)),
      "OpenClaw provider config patch is invalid.",
    ));
    const apply = async (nextConfig: JsonObject, restartDelayMs?: number): Promise<void> => {
      if (canonical(current.config) === canonical(nextConfig)) return;
      const response = assertJsonObject(
        await rpc.request("config.apply", {
          raw: JSON.stringify(nextConfig),
          baseHash: current.hash,
          ...(restartDelayMs === undefined ? {} : { restartDelayMs }),
        }),
        "OpenClaw config write response is invalid.",
      );
      if (response.ok !== true) throw backendError("OPERATION_FAILED", "OpenClaw config write failed.", true);
      writeAcknowledged = true;
      current = await getConfig();
    };
    const removed = previous.providers.filter((provider) =>
      provider.enabled
      && !(provider.id === "zai" && provider.baseUrl === null)
      && !next.providers.some(({ id, enabled }) => id === provider.id && enabled));
    const needsSizeDropBridge = removed.length > 0
      && next.providers.every((provider) => provider.id === "zai" && provider.baseUrl === null || !provider.enabled)
      && serializedConfigBytes(current.config) >= 512
      && serializedConfigBytes(config) < Math.floor(serializedConfigBytes(current.config) * 0.5);
    try {
      if (needsSizeDropBridge) {
        await apply(compactRemovedProviders(current.config, removed), 60_000);
        let bridge = providerDeletionBridge(config, removed);
        await apply(bridge, 60_000);
        for (const [index, provider] of removed.entries()) {
          bridge = structuredClone(bridge);
          const models = bridge.models;
          if (isObject(models) && isObject(models.providers)) delete models.providers[provider.id];
          bridge = pruneProviderOwnedEmptyContainers(bridge);
          await apply(bridge, index === removed.length - 1 ? undefined : 60_000);
        }
      } else {
        await apply(config);
      }
      assertProviderReadback(previous, next, current.config);
      return current;
    } catch (error) {
      if (!writeAcknowledged) throw error;
      try {
        const remote = await getConfig();
        const rollbackConfig = pruneProviderOwnedEmptyContainers(assertJsonObject(
          mergePatch(remote.config, providerPatch(next, previous)),
          "OpenClaw provider compensation patch is invalid.",
        ));
        if (canonical(remote.config) !== canonical(rollbackConfig)) {
          const response = assertJsonObject(
            await rpc.request("config.apply", { raw: JSON.stringify(rollbackConfig), baseHash: remote.hash }),
            "OpenClaw config compensation response is invalid.",
          );
          if (response.ok !== true) throw new Error("compensation rejected");
          const restored = await getConfig();
          assertProviderReadback(next, previous, restored.config);
        }
      } catch {
        throw backendError("OPERATION_FAILED", "OpenClaw provider configuration write and compensation failed.", true);
      }
      throw error;
    }
  };
  return {
    async synchronize(previous, next) {
      await synchronizeProviderConfig(previous, next);
    },
    async synchronizeCommercial(input) {
      const endpoint = new URL(input.endpoint);
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw backendError("INVALID_ARGUMENT", "Commercial Provider endpoint is invalid.");
      }
      endpoint.pathname = endpoint.pathname.replace(/\/+$/u, "");
      if (!endpoint.pathname.endsWith("/v1")) endpoint.pathname = `${endpoint.pathname}/v1`;
      if (!isAbsolute(input.credentialPath) || input.credentialPath.includes("\0")) {
        throw backendError("INVALID_ARGUMENT", "Commercial credential path is invalid.");
      }
      if (input.models.length === 0 || input.models.some(({ id, name }) => id.trim() === "" || name.trim() === "")) {
        throw backendError("INVALID_ARGUMENT", "Commercial model catalog is empty or invalid.");
      }
      const uniqueModels = [...new Map(input.models.map((model) => [model.id, { id: model.id, name: model.name }])).values()];
      await getSchema();
      const before = await getConfig();
      const next = structuredClone(before.config);
      const secrets = isObject(next.secrets) ? next.secrets : (next.secrets = {});
      const secretProviders = isObject(secrets.providers) ? secrets.providers : (secrets.providers = {});
      secretProviders.uclaw_commercial = { source: "file", path: input.credentialPath, mode: "json" };
      const models = isObject(next.models) ? next.models : (next.models = {});
      models.mode = "merge";
      const providers = isObject(models.providers) ? models.providers : (models.providers = {});
      providers["uclaw-commercial"] = {
        baseUrl: endpoint.href,
        apiKey: { source: "file", provider: "uclaw_commercial", id: "/deviceToken" },
        api: "openai-completions",
        models: uniqueModels,
      };
      if (canonical(before.config) === canonical(next)) return false;
      const response = assertJsonObject(await rpc.request("config.apply", {
        raw: JSON.stringify(next),
        baseHash: before.hash,
        restartDelayMs: 60_000,
      }), "OpenClaw commercial Provider write response is invalid.");
      if (response.ok !== true) throw backendError("OPERATION_FAILED", "OpenClaw commercial Provider write failed.", true);
      const readback = await getConfig();
      const provider = getPath(readback.config, ["models", "providers", "uclaw-commercial"]);
      const secretProvider = getPath(readback.config, ["secrets", "providers", "uclaw_commercial"]);
      if (!isObject(provider) || provider.baseUrl !== endpoint.href
        || !isObject(provider.apiKey) || provider.apiKey.source !== "file" || provider.apiKey.provider !== "uclaw_commercial" || provider.apiKey.id !== "/deviceToken"
        || !Array.isArray(provider.models) || provider.models.length !== uniqueModels.length
        || !isObject(secretProvider) || secretProvider.source !== "file" || secretProvider.path !== input.credentialPath || secretProvider.mode !== "json") {
        throw backendError("CONFLICT", "OpenClaw commercial Provider readback did not match the write.");
      }
      return true;
    },
    async readCommercial() {
      const { config } = await getConfig();
      const provider = getPath(config, ["models", "providers", "uclaw-commercial"]);
      const secretProvider = getPath(config, ["secrets", "providers", "uclaw_commercial"]);
      return {
        configured: isObject(provider)
          && typeof provider.baseUrl === "string"
          && isObject(provider.apiKey)
          && provider.apiKey.source === "file"
          && provider.apiKey.provider === "uclaw_commercial"
          && provider.apiKey.id === "/deviceToken"
          && isObject(secretProvider)
          && secretProvider.source === "file",
      };
    },
    async getRendererConfig() {
      const [{ schema, uiHints }, { config }] = await Promise.all([getSchema(), getConfig()]);
      return { config: redact(config) as JsonObject, schema, ...(uiHints === undefined ? {} : { uiHints }) };
    },
    async patchRendererConfig(patch) {
      assertRendererPatchSafe(patch);
      const restored = restoreOpenClawRedaction(patch) as JsonObject;
      const readback = await mutate("config.patch", restored, (before, value) => {
        assertProviderOwnedPathsUnchanged(before, assertJsonObject(mergePatch(before, value), "OpenClaw config patch is invalid."));
      });
      const { schema, uiHints } = await getSchema();
      return { config: redact(readback.config) as JsonObject, schema, ...(uiHints === undefined ? {} : { uiHints }) };
    },
    async applyRendererConfig(config) {
      assertRendererPatchSafe(config);
      const restored = restoreOpenClawRedaction(config) as JsonObject;
      const readback = await mutate("config.apply", restored, assertProviderOwnedPathsUnchanged);
      const { schema, uiHints } = await getSchema();
      return { config: redact(readback.config) as JsonObject, schema, ...(uiHints === undefined ? {} : { uiHints }) };
    },
    async applyMainConfig(config) {
      const readback = await mutate("config.apply", config);
      if (canonical(readback.config) !== canonical(config)) {
        throw backendError("CONFLICT", "OpenClaw configuration readback did not match the write.");
      }
    },
  };
}
