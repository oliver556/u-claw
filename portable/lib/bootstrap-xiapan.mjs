// Bootstrap: ensure data/.openclaw/openclaw.json contains the uclaw-cloud provider
// pointing to the device-bound apiKey derived from the local fingerprint.
//
// Idempotent: if the provider already exists with the correct apiKey, do nothing.
// If it exists but the apiKey differs (USB swapped, machine changed), leave the
// existing entry alone and log a hint — never overwrite user data silently.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getFingerprint } from './fingerprint.mjs';
import { buildApiKey } from './xiapan-client.mjs';

const PROVIDER_ID = 'uclaw-cloud';

const DEFAULT_PROVIDER_TEMPLATE = {
  baseUrl: 'https://api.u-claw.org/v1',
  api: 'openai-completions',
  models: [
    { id: 'deepseek-chat', name: 'DeepSeek Chat' },
    { id: 'qwen-plus', name: 'Qwen Plus' },
    { id: 'qwen-turbo', name: 'Qwen Turbo' },
  ],
};

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

  const apiKey = buildApiKey(fingerprintInfo.fingerprint);

  const config = readJsonSafe(configPath) || { gateway: { mode: 'local', auth: { token: 'uclaw' } } };
  const providers = ensureModelsContainer(config);
  const existing = providers[PROVIDER_ID];

  if (existing && typeof existing === 'object') {
    if (existing.apiKey && existing.apiKey !== apiKey) {
      log.info?.(
        `[bootstrap-xiapan] uclaw-cloud apiKey already configured (different fingerprint). `
        + `Current source=${fingerprintInfo.source}. Use Config UI to rebind if needed.`,
      );
      return {
        ok: true,
        action: 'kept',
        source: fingerprintInfo.source,
        apiKey: existing.apiKey,
      };
    }
    if (existing.apiKey === apiKey) {
      return {
        ok: true,
        action: 'noop',
        source: fingerprintInfo.source,
        apiKey,
      };
    }
  }

  providers[PROVIDER_ID] = {
    ...DEFAULT_PROVIDER_TEMPLATE,
    ...(existing && typeof existing === 'object' ? existing : {}),
    baseUrl: existing?.baseUrl || DEFAULT_PROVIDER_TEMPLATE.baseUrl,
    api: existing?.api || DEFAULT_PROVIDER_TEMPLATE.api,
    apiKey,
    models: existing?.models?.length ? existing.models : DEFAULT_PROVIDER_TEMPLATE.models,
  };

  writeJson(configPath, config);
  log.info?.(
    `[bootstrap-xiapan] Wrote uclaw-cloud provider (source=${fingerprintInfo.source}, key=${apiKey.slice(0, 12)}…)`,
  );
  return {
    ok: true,
    action: existing ? 'updated' : 'created',
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
