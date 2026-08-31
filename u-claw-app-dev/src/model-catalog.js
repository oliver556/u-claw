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
 * Updates routed OpenClaw defaults from cloud model names without changing
 * provider routing.
 */
function rebaseDefaultModelsToCatalog(config, providerRoutes, models) {
  const defaults = config?.agents?.defaults;
  if (!defaults || !providerRoutes || !Array.isArray(models) || models.length === 0) return false;

  let changed = false;
  const pickModelID = (currentValue, kind) => {
    const current = splitQualifiedModelID(currentValue);
    const candidates = models.filter((model) => catalogModelMatchesKind(model, kind));
    const exact = candidates.find((model) => model.id === current.id);
    if (exact) return exact.id;
    if ((!current.provider || current.provider === providerRoutes[kind]) && candidates.length > 0) return candidates[0].id;
    return '';
  };
  const patchPrimary = (container, key, kind) => {
    const current = String(container?.[key] || '').trim();
    const picked = pickModelID(current, kind);
    if (!picked) return;
    const providerID = providerRoutes[kind];
    if (!providerID) return;
    const next = `${providerID}/${picked}`;
    if (current !== next) {
      container[key] = next;
      changed = true;
    }
  };

  if (defaults.model && typeof defaults.model === 'object') {
    patchPrimary(defaults.model, 'primary', 'text');
  } else if (typeof defaults.model === 'string') {
    const picked = pickModelID(defaults.model, 'text');
    if (picked) {
      const providerID = providerRoutes.text;
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
        const providerID = providerRoutes.image;
        const next = `${providerID}/${picked}`;
        if (defaults[key] !== next) {
          defaults[key] = next;
          changed = true;
        }
      }
    }
  }
  if (defaults.videoGenerationModel && typeof defaults.videoGenerationModel === 'object') {
    patchPrimary(defaults.videoGenerationModel, 'primary', 'video');
  } else if (typeof defaults.videoGenerationModel === 'string') {
    const picked = pickModelID(defaults.videoGenerationModel, 'video');
    if (picked) {
      const next = `${providerRoutes.video}/${picked}`;
      if (defaults.videoGenerationModel !== next) {
        defaults.videoGenerationModel = next;
        changed = true;
      }
    }
  }
  return changed;
}

function ensureProvider(config, providerID, baseURL, apiKey, models) {
  config.models = config.models || {};
  config.models.mode = config.models.mode || 'merge';
  config.models.providers = config.models.providers || {};
  const existingProvider = config.models.providers[providerID] || {};
  config.models.providers[providerID] = {
    ...existingProvider,
    baseUrl: baseURL || existingProvider.baseUrl,
    api: existingProvider.api || 'openai-completions',
    models: models.map(toOpenClawModelConfig),
  };
  if (apiKey || existingProvider.apiKey) {
    config.models.providers[providerID].apiKey = apiKey || existingProvider.apiKey;
  }
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

  const baseURL = String(catalog.provider?.baseUrl || options.baseURL || '').replace(/\/+$/, '');
  if (!baseURL) {
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
  const apiKey = findReusableApiKey(nextConfig, 'custom', baseURL) || String(options.apiKey || '').trim();
  const providerRoutes = {
    text: options.textProviderID || 'custom',
    image: options.imageProviderID || 'litellm',
    video: options.videoProviderID || 'xai',
  };
  const existingModels = Object.entries(providerRoutes)
    .flatMap(([, routeProviderID]) => {
      const provider = nextConfig.models.providers[routeProviderID] || {};
      return Array.isArray(provider.models) ? provider.models.map(normalizeCatalogModel).filter(Boolean) : [];
    });
  const effectiveModels = mergedModels.length > 0
    ? mergedModels
    : [...new Map(existingModels.map((model) => [model.id, model])).values()];

  const modelsForKind = (kind) => effectiveModels.filter((model) => catalogModelMatchesKind(model, kind));
  const fallbackModelsForKind = (kind, providerID) => {
    const existingProvider = nextConfig.models.providers[providerID] || {};
    return Array.isArray(existingProvider.models)
      ? existingProvider.models.map(normalizeCatalogModel).filter(Boolean)
      : [];
  };
  const textModels = modelsForKind('text');
  const imageModels = modelsForKind('image');
  const videoModels = modelsForKind('video');

  ensureProvider(nextConfig, providerRoutes.text, baseURL, apiKey, textModels.length ? textModels : fallbackModelsForKind('text', providerRoutes.text));
  ensureProvider(nextConfig, providerRoutes.image, baseURL, apiKey, imageModels.length ? imageModels : fallbackModelsForKind('image', providerRoutes.image));
  ensureProvider(nextConfig, providerRoutes.video, baseURL, apiKey, videoModels.length ? videoModels : fallbackModelsForKind('video', providerRoutes.video));

  delete nextConfig.models.providers.newapi;

  nextConfig.agents = nextConfig.agents || {};
  nextConfig.agents.defaults = nextConfig.agents.defaults || {};
  rebaseDefaultModelsToCatalog(nextConfig, providerRoutes, mergedModels);

  const changed = JSON.stringify(config || {}) !== JSON.stringify(nextConfig);
  return {
    config: nextConfig,
    changed,
    count: mergedModels.length,
    availableCount: effectiveModels.length,
    usedLocalCatalog: mergedModels.length === 0 && effectiveModels.length > 0,
  };
}

function normalizeLocalProviderModels(config) {
  const providers = config?.models?.providers || {};
  let changed = false;
  for (const providerID of ['custom', 'litellm', 'xai']) {
    const provider = providers[providerID];
    if (!provider || !Array.isArray(provider.models) || provider.models.length === 0) continue;
    const normalizedModels = provider.models
      .map(normalizeCatalogModel)
      .filter(Boolean)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(toOpenClawModelConfig);
    if (JSON.stringify(provider.models) !== JSON.stringify(normalizedModels)) {
      provider.models = normalizedModels;
      changed = true;
    }
  }
  return changed;
}

module.exports = {
  catalogModelMatchesKind,
  capabilitiesToInput,
  findReusableApiKey,
  inferCapabilitiesFromModelID,
  mergeModelCatalogIntoConfig,
  normalizeCatalogModel,
  normalizeLocalProviderModels,
  rebaseDefaultModelsToCatalog,
  splitQualifiedModelID,
  toOpenClawModelConfig,
};
