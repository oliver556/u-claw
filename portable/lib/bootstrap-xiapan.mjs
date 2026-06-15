// Bootstrap: ensure data/.openclaw/openclaw.json contains the uclaw-cloud provider
// pointing to the device-bound apiKey derived from the local fingerprint.
//
// Idempotent: if the provider already exists with the correct apiKey, do nothing.
// If it exists but the apiKey differs (USB swapped, machine changed), leave the
// existing entry alone and log a hint — never overwrite user data silently.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getFingerprint } from './fingerprint.mjs';
import { buildApiKey, provisionApiKey } from './xiapan-client.mjs';

const PROVIDER_ID = 'uclaw-cloud';

// Mirror ClawX commercial schema: keep models[] empty and steer model selection
// via agents.defaults.model.primary + fallbacks. OpenClaw 2026.4.x accepts both
// shapes, but the empty-models form lets the runtime auto-discover model ids
// from /v1/models without us hard-coding a list that drifts from the backend.
const DEFAULT_PROVIDER_TEMPLATE = {
  baseUrl: 'https://api.u-claw.org/v1',
  api: 'openai-completions',
  models: [],
};

const DEFAULT_PRIMARY_MODEL = `${PROVIDER_ID}/deepseek-v4-flash`;
const DEFAULT_FALLBACK_MODELS = [
  `${PROVIDER_ID}/deepseek-chat`,
  `${PROVIDER_ID}/qwen-plus`,
  `${PROVIDER_ID}/qwen-turbo`,
];

function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`[bootstrap-xiapan] Cannot parse ${filePath}: ${err.message}\n`);
    return null;
  }
}

function writeJson(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function ensureModelsContainer(config) {
  if (!config.models || typeof config.models !== 'object') {
    config.models = { mode: 'merge', providers: {} };
  }
  if (!config.models.mode) config.models.mode = 'merge';
  if (!config.models.providers || typeof config.models.providers !== 'object') {
    config.models.providers = {};
  }
  return config.models.providers;
}

// Set agents.defaults.model.primary to uclaw-cloud only when the user has not
// configured a primary model already. If they've picked a different provider
// (e.g. DeepSeek BYOK), leave their choice untouched.
function ensureAgentsDefaults(config) {
  if (!config.agents || typeof config.agents !== 'object') {
    config.agents = {};
  }
  if (!config.agents.defaults || typeof config.agents.defaults !== 'object') {
    config.agents.defaults = {};
  }
  const defaults = config.agents.defaults;
  if (!defaults.model || typeof defaults.model !== 'object') {
    defaults.model = {};
  }
  let changed = false;
  if (!defaults.model.primary) {
    defaults.model.primary = DEFAULT_PRIMARY_MODEL;
    changed = true;
  }
  if (!Array.isArray(defaults.model.fallbacks) || defaults.model.fallbacks.length === 0) {
    defaults.model.fallbacks = [...DEFAULT_FALLBACK_MODELS];
    changed = true;
  }
  return changed;
}

export async function bootstrapXiapan({ configPath, appRoot, log = console } = {}) {
  if (!configPath) {
    throw new Error('bootstrapXiapan: configPath is required.');
  }
  const root = appRoot || process.cwd();

  let fingerprintInfo;
  try {
    fingerprintInfo = await getFingerprint(root);
  } catch (err) {
    log.warn?.(`[bootstrap-xiapan] Fingerprint detection failed: ${err.message}`);
    return { ok: false, reason: 'fingerprint-failed' };
  }

  const config = readJsonSafe(configPath) || { gateway: { mode: 'local', auth: { token: 'uclaw' } } };
  const providers = ensureModelsContainer(config);
  const existing = providers[PROVIDER_ID];

  // 幂等：配置里已有 uclaw-cloud apiKey → 保持不动，不再打网络 provision。
  // （后端 provision 本身也按 deviceId 幂等，但客户端先短路可避免每次启动都请求。）
  if (existing && typeof existing === 'object' && existing.apiKey) {
    const changedDefaults = ensureAgentsDefaults(config);
    if (changedDefaults) {
      writeJson(configPath, config);
      log.info?.('[bootstrap-xiapan] Added agents.defaults to existing config');
    }
    return {
      ok: true,
      action: changedDefaults ? 'agents-defaults-added' : 'noop',
      source: fingerprintInfo.source,
      apiKey: existing.apiKey,
    };
  }

  // 首启（配置里还没有 cloud key）：静默开户。把指纹送到虾盘云后台自动开一个带
  // 试用额度的 token。成功 → 用后端真正注册过的 key（可直接聊天，解决 Invalid token）。
  // 失败（离线/后端不可达）→ 回退到指纹派生 key，至少配置不空、不阻塞启动。
  let apiKey = buildApiKey(fingerprintInfo.fingerprint);
  let provisioned = false;
  try {
    const prov = await provisionApiKey(fingerprintInfo.fingerprint, { source: 'uclaw-portable' });
    if (prov.ok && prov.apiKey) {
      apiKey = prov.apiKey;
      provisioned = true;
      log.info?.(`[bootstrap-xiapan] Provisioned cloud token (reused=${prov.reused})`);
    } else {
      log.info?.(`[bootstrap-xiapan] Provision skipped (${prov.reason}); using fingerprint key`);
    }
  } catch (err) {
    log.info?.(`[bootstrap-xiapan] Provision failed (${err.message}); using fingerprint key`);
  }

  providers[PROVIDER_ID] = {
    ...DEFAULT_PROVIDER_TEMPLATE,
    ...(existing && typeof existing === 'object' ? existing : {}),
    baseUrl: existing?.baseUrl || DEFAULT_PROVIDER_TEMPLATE.baseUrl,
    api: existing?.api || DEFAULT_PROVIDER_TEMPLATE.api,
    apiKey,
    models: existing?.models ?? DEFAULT_PROVIDER_TEMPLATE.models,
  };
  ensureAgentsDefaults(config);

  writeJson(configPath, config);
  log.info?.(
    `[bootstrap-xiapan] Wrote uclaw-cloud provider (source=${fingerprintInfo.source}, `
    + `provisioned=${provisioned}, key=${apiKey.slice(0, 12)}…)`,
  );
  return {
    ok: true,
    action: 'created',
    provisioned,
    source: fingerprintInfo.source,
    apiKey,
  };
}

// CLI:
//   node bootstrap-xiapan.mjs <config-path>
//   env UCLAW_CONFIG_PATH=... node bootstrap-xiapan.mjs
import { pathToFileURL } from 'node:url';
const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const configPath = process.argv[2] || process.env.UCLAW_CONFIG_PATH;
  if (!configPath) {
    process.stderr.write('Usage: node bootstrap-xiapan.mjs <openclaw.json path>\n');
    process.exit(2);
  }
  const appRoot = process.env.UCLAW_APP_ROOT || resolve(configPath, '../../..');
  bootstrapXiapan({ configPath, appRoot })
    .then((res) => {
      process.stdout.write(`${JSON.stringify(res)}\n`);
    })
    .catch((err) => {
      process.stderr.write(`bootstrap-xiapan error: ${err.message}\n`);
      process.exit(1);
    });
}
