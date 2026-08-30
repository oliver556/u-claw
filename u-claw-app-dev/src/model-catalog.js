/**
 * Normalizes model IDs into OpenClaw-compatible model entries while preserving user labels.
 */
function normalizeCatalogModel(model) {
  const id = String(model?.id || model?.name || '').trim();
  if (!id) return null;
  const capabilities = Array.isArray(model.capabilities)
    ? model.capabilities.map((value) => String(value).toLowerCase()).filter(Boolean)
    : [];
  const inferredCapabilities = inferCapabilitiesFromModelID(id);
  let normalizedCapabilities = capabilities.length ? capabilities : inferredCapabilities;
  if (inferredCapabilities.includes('video') && !normalizedCapabilities.includes('video')) {
    normalizedCapabilities = inferredCapabilities;
  } else if (inferredCapabilities.includes('image') && !normalizedCapabilities.includes('image') && !normalizedCapabilities.includes('video')) {
    normalizedCapabilities = inferredCapabilities;
  }
  return {
    id,
    name: String(model?.name || id).trim() || id,
    capabilities: normalizedCapabilities,
    reasoning: Boolean(model?.reasoning),
    input: capabilitiesToInput(normalizedCapabilities),
    cost: model?.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Number(model?.contextWindow) || 128000,
    maxTokens: Number(model?.maxTokens) || 8192,
  };
}

/**
 * Infers broad Bavi-box capability buckets from model naming conventions.
 */
function inferCapabilitiesFromModelID(modelID) {
  const lower = String(modelID || '').toLowerCase();
  if (/video|jimeng|kling|runway|seedance/.test(lower)) return ['video'];
  if (/image|gpt-image|dall|flux|midjourney/.test(lower)) return ['image'];
  return ['text'];
}

/**
 * Converts catalog capability buckets to OpenClaw input metadata.
 */
function capabilitiesToInput(capabilities) {
  if (capabilities.includes('video')) return ['text', 'image'];
  if (capabilities.includes('image')) return ['text', 'image'];
  return ['text'];
}

/**
 * Returns the provider and bare model id from an OpenClaw qualified model id.
 */
function splitQualifiedModelID(value) {
  const text = String(value || '').trim();
  const slash = text.indexOf('/');
  if (slash <= 0) return { provider: '', id: text };
  return {
    provider: text.slice(0, slash),
    id: text.slice(slash + 1),
  };
}

/**
 * Checks whether a normalized catalog model belongs to the requested Bavi-box slot.
 */
function catalogModelMatchesKind(model, kind) {
  const id = String(model?.id || '').toLowerCase();
  const capabilities = Array.isArray(model?.capabilities)
    ? model.capabilities.map((value) => String(value).toLowerCase()).filter(Boolean)
    : [];
  if (kind === 'video') {
    return capabilities.includes('video') || (!capabilities.length && /video|jimeng|kling|runway|seedance/.test(id));
  }
  if (kind === 'image') {
    return capabilities.includes('image') || (!capabilities.length && /image|gpt-image|dall|flux|midjourney/.test(id));
  }
  if (kind === 'text') {
    if (capabilities.length) return capabilities.includes('text') && !capabilities.includes('image') && !capabilities.includes('video');
    return !(/video|jimeng|kling|runway|seedance|gpt-image|image|dall|flux|midjourney/.test(id));
  }
  return false;
}

/**
 * Removes legacy local model providers after their New API key has been reused.
 */
function scrubLegacyModelProviders(config) {
  const providers = config?.models?.providers;
  if (!providers) return false;
  let changed = false;
  for (const providerID of ['custom', 'litellm', 'xai']) {
    if (providers[providerID]) {
      delete providers[providerID];
      changed = true;
    }
  }
  return changed;
}

/**
 * Removes Bavi-box-only catalog metadata before writing OpenClaw config.
 */
function toOpenClawModelConfig(model) {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

/**
 * Moves cloud-managed default model selections onto the synced New API provider.
 */
function rebaseDefaultModelsToCatalog(config, providerID, models) {
  const defaults = config?.agents?.defaults;
  if (!defaults || !providerID || !Array.isArray(models) || models.length === 0) return false;

  let changed = false;
  const managedProviders = new Set(['', 'custom', 'litellm', 'xai', providerID]);
  const pickModelID = (currentValue, kind) => {
    const current = splitQualifiedModelID(currentValue);
    const candidates = models.filter((model) => catalogModelMatchesKind(model, kind));
    const exact = candidates.find((model) => model.id === current.id);
    if (exact) return exact.id;
    if (managedProviders.has(current.provider) && candidates.length > 0) return candidates[0].id;
    return '';
  };
  const patchPrimary = (container, key, kind) => {
    const current = String(container?.[key] || '').trim();
    const picked = pickModelID(current, kind);
    if (!picked) return;
    const next = `${providerID}/${picked}`;
    if (current !== next) {
      container[key] = next;
      changed = true;
    }
  };
  const clearManagedVideoPrimary = (container, key) => {
    const current = splitQualifiedModelID(container?.[key]);
    if (managedProviders.has(current.provider) && container?.[key]) {
      delete container[key];
      changed = true;
    }
  };

  if (defaults.model && typeof defaults.model === 'object') {
    patchPrimary(defaults.model, 'primary', 'text');
  } else if (typeof defaults.model === 'string') {
    const picked = pickModelID(defaults.model, 'text');
    if (picked) {
      const next = `${providerID}/${picked}`;
      if (defaults.model !== next) {
        defaults.model = next;
        changed = true;
      }
    }
  }
  for (const key of ['imageGenerationModel', 'imageModel']) {
    if (defaults[key] && typeof defaults[key] === 'object') {
      patchPrimary(defaults[key], 'primary', 'image');
    } else if (typeof defaults[key] === 'string') {
      const picked = pickModelID(defaults[key], 'image');
      if (picked) {
        const next = `${providerID}/${picked}`;
        if (defaults[key] !== next) {
          defaults[key] = next;
          changed = true;
        }
      }
    }
  }
  if (defaults.videoGenerationModel && typeof defaults.videoGenerationModel === 'object') {
    const before = defaults.videoGenerationModel.primary;
    patchPrimary(defaults.videoGenerationModel, 'primary', 'video');
    if (defaults.videoGenerationModel.primary === before) {
      clearManagedVideoPrimary(defaults.videoGenerationModel, 'primary');
    }
    if (!defaults.videoGenerationModel.primary) {
      delete defaults.videoGenerationModel;
      changed = true;
    }
  } else if (typeof defaults.videoGenerationModel === 'string') {
    const picked = pickModelID(defaults.videoGenerationModel, 'video');
    if (picked) {
      const next = `${providerID}/${picked}`;
      if (defaults.videoGenerationModel !== next) {
        defaults.videoGenerationModel = next;
        changed = true;
      }
    } else if (managedProviders.has(splitQualifiedModelID(defaults.videoGenerationModel).provider)) {
      delete defaults.videoGenerationModel;
      changed = true;
    }
  }
  return changed;
}

/**
 * Finds an API key already present in config so catalog refresh does not store a new secret.
 */
function findReusableApiKey(config, providerID, baseURL) {
  const providers = config?.models?.providers || {};
  const candidates = [providerID, 'custom', 'litellm']
    .map((name) => providers[name])
    .filter(Boolean);
  const normalizedBaseURL = String(baseURL || '').replace(/\/+$/, '');
  for (const provider of candidates) {
    const apiKey = String(provider.apiKey || provider.api_key || provider.key || '').trim();
    const providerBaseURL = String(provider.baseUrl || provider.baseURL || provider.base_url || '').replace(/\/+$/, '');
    if (!apiKey) continue;
    if (!normalizedBaseURL || !providerBaseURL || providerBaseURL === normalizedBaseURL) return apiKey;
  }
  return '';
}

/**
 * Merges a cloud catalog into an OpenClaw provider without mutating unrelated providers.
 */
function mergeModelCatalogIntoConfig(config, catalog, options = {}) {
  if (!catalog || !Array.isArray(catalog.models)) {
    return { config, changed: false, count: 0, availableCount: 0, usedLocalCatalog: false };
  }

  const providerID = String(catalog.provider?.id || options.providerID || 'newapi').trim();
  const baseURL = String(catalog.provider?.baseUrl || options.baseURL || '').replace(/\/+$/, '');
  if (!providerID || !baseURL) {
    return { config, changed: false, count: 0, availableCount: 0, usedLocalCatalog: false };
  }

  const nextConfig = JSON.parse(JSON.stringify(config || {}));
  nextConfig.models = nextConfig.models || {};
  nextConfig.models.mode = nextConfig.models.mode || 'merge';
  nextConfig.models.providers = nextConfig.models.providers || {};
  const normalizedModels = catalog.models
    .map(normalizeCatalogModel)
    .filter(Boolean);
  const byID = new Map();
  for (const model of normalizedModels) {
    byID.set(model.id, { ...byID.get(model.id), ...model });
  }
  const mergedModels = [...byID.values()].sort((left, right) => left.id.localeCompare(right.id));
  const apiKey = findReusableApiKey(nextConfig, providerID, baseURL) || String(options.apiKey || '').trim();
  const existingProvider = nextConfig.models.providers[providerID] || {};
  const existingModels = Array.isArray(existingProvider.models)
    ? existingProvider.models.map(normalizeCatalogModel).filter(Boolean)
    : [];
  const effectiveModels = mergedModels.length > 0 ? mergedModels : existingModels;
  scrubLegacyModelProviders(nextConfig);

  nextConfig.models.providers[providerID] = {
    ...existingProvider,
    baseUrl: baseURL,
    api: catalog.provider?.api || existingProvider.api || 'openai-completions',
    models: effectiveModels.map(toOpenClawModelConfig),
  };
  if (apiKey) {
    nextConfig.models.providers[providerID].apiKey = apiKey;
  }
  nextConfig.agents = nextConfig.agents || {};
  nextConfig.agents.defaults = nextConfig.agents.defaults || {};
  rebaseDefaultModelsToCatalog(nextConfig, providerID, mergedModels);

  const changed = JSON.stringify(config || {}) !== JSON.stringify(nextConfig);
  return {
    config: nextConfig,
    changed,
    count: mergedModels.length,
    availableCount: effectiveModels.length,
    usedLocalCatalog: mergedModels.length === 0 && effectiveModels.length > 0,
  };
}

module.exports = {
  catalogModelMatchesKind,
  capabilitiesToInput,
  findReusableApiKey,
  inferCapabilitiesFromModelID,
  mergeModelCatalogIntoConfig,
  normalizeCatalogModel,
  rebaseDefaultModelsToCatalog,
  scrubLegacyModelProviders,
  splitQualifiedModelID,
  toOpenClawModelConfig,
};
