/**
 * Normalizes model IDs into OpenClaw-compatible model entries while preserving user labels.
 */
function normalizeCatalogModel(model) {
  const id = String(model?.id || model?.name || '').trim();
  if (!id) return null;
  const capabilities = Array.isArray(model.capabilities)
    ? model.capabilities.map((value) => String(value).toLowerCase()).filter(Boolean)
    : ['text'];
  return {
    id,
    name: String(model?.name || id).trim() || id,
    reasoning: Boolean(model?.reasoning),
    input: capabilitiesToInput(capabilities),
    cost: model?.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Number(model?.contextWindow) || 128000,
    maxTokens: Number(model?.maxTokens) || 8192,
  };
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
    return { config, changed: false, count: 0 };
  }

  const providerID = String(catalog.provider?.id || options.providerID || 'newapi').trim();
  const baseURL = String(catalog.provider?.baseUrl || options.baseURL || '').replace(/\/+$/, '');
  if (!providerID || !baseURL) {
    return { config, changed: false, count: 0 };
  }

  const nextConfig = JSON.parse(JSON.stringify(config || {}));
  nextConfig.models = nextConfig.models || {};
  nextConfig.models.mode = nextConfig.models.mode || 'merge';
  nextConfig.models.providers = nextConfig.models.providers || {};

  const existingProvider = nextConfig.models.providers[providerID] || {};
  const normalizedModels = catalog.models
    .map(normalizeCatalogModel)
    .filter(Boolean);
  const byID = new Map();
  for (const model of normalizedModels) {
    byID.set(model.id, { ...byID.get(model.id), ...model });
  }
  const mergedModels = [...byID.values()].sort((left, right) => left.id.localeCompare(right.id));
  const apiKey = findReusableApiKey(nextConfig, providerID, baseURL) || String(options.apiKey || '').trim();

  nextConfig.models.providers[providerID] = {
    ...existingProvider,
    baseUrl: baseURL,
    api: catalog.provider?.api || existingProvider.api || 'openai-completions',
    models: mergedModels,
  };
  if (apiKey) {
    nextConfig.models.providers[providerID].apiKey = apiKey;
  }

  const changed = JSON.stringify(config || {}) !== JSON.stringify(nextConfig);
  return { config: nextConfig, changed, count: mergedModels.length };
}

module.exports = {
  capabilitiesToInput,
  findReusableApiKey,
  mergeModelCatalogIntoConfig,
  normalizeCatalogModel,
};
