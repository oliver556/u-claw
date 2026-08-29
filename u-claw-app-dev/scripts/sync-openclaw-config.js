#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const templatePath = path.join(repoRoot, 'resources', 'default-openclaw.json');
const openclawPackagePath = path.join(repoRoot, 'node_modules', 'openclaw', 'package.json');
const appSupportPath = path.join(os.homedir(), 'Library', 'Application Support');
const appDataNames = ['u-claw', 'Bavi-box'];
const desktopConfigPaths = appDataNames.map(name => path.join(appSupportPath, name, '.openclaw', 'openclaw.json'));
const portableCacheConfigPaths = appDataNames.map(name => path.join(appSupportPath, name, 'usb-portable', 'data', '.openclaw', 'openclaw.json'));
const DEFAULT_NEW_API_BASE_URL = 'https://api.yiyong.me/v1';
const LEGACY_VIDEO_ADAPTER_API_KEY = 'uclaw-video-adapter';

function usage() {
  console.log(`Usage:
  npm run sync:config
  npm run sync:config -- --desktop
  npm run sync:config -- --portable-cache
  npm run sync:config -- --customer --dest /absolute/path/openclaw.json
  npm run sync:config -- --streamer --dest /absolute/path/openclaw.json
  UCLAW_USB_ROOT=/Volumes/UCLAW-04 npm run sync:config -- --streamer
  npm run sync:config -- --streamer --usb /Volumes/UCLAW-04
  npm run sync:config -- --dest /absolute/path/openclaw.json

Options:
  --source <path>        Read existing key from another openclaw.json.
  --new-api-key <key>    Override New API key for custom/litellm.
  --customer            Generate a clean customer config with empty New API keys.
  --streamer            Require a real New API key inherited from desktop config.
  --desktop             Write desktop config only. Writes both u-claw and Bavi-box app data dirs.
  --portable-cache      Write local portable cache config only. Writes both u-claw and Bavi-box app data dirs.
  --usb <mount>         Write <mount>/Bavi-box/data/.openclaw/openclaw.json.
  --dest <path>         Write an exact openclaw.json path.
`);
}

function parseArgs(argv) {
  const options = {
    sources: [],
    destinations: [],
    desktop: false,
    portableCache: false,
    customer: false,
    streamer: false,
    usbRoots: [],
    newApiKey: process.env.UCLAW_NEW_API_KEY || '',
    newApiBaseUrl: process.env.UCLAW_NEW_API_BASE_URL || DEFAULT_NEW_API_BASE_URL,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--source') {
      options.sources.push(readValue());
    } else if (arg === '--new-api-key') {
      options.newApiKey = readValue();
    } else if (arg === '--new-api-base-url') {
      options.newApiBaseUrl = readValue();
    } else if (arg === '--customer') {
      options.customer = true;
    } else if (arg === '--streamer') {
      options.streamer = true;
    } else if (arg === '--desktop') {
      options.desktop = true;
    } else if (arg === '--portable-cache') {
      options.portableCache = true;
    } else if (arg === '--usb') {
      options.usbRoots.push(readValue());
    } else if (arg === '--dest') {
      options.destinations.push(readValue());
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (process.env.UCLAW_USB_ROOT) {
    options.usbRoots.push(process.env.UCLAW_USB_ROOT);
  }

  const hasExplicitTarget = options.desktop || options.portableCache || options.usbRoots.length || options.destinations.length;
  if (options.customer && options.streamer) {
    throw new Error('--customer and --streamer cannot be used together');
  }
  if (options.customer && !hasExplicitTarget) {
    throw new Error('--customer requires an explicit --dest or --usb target');
  }
  if (!hasExplicitTarget) {
    options.desktop = true;
    options.portableCache = true;
  }

  return options;
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function readJsonIfExists(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (error) {
    console.warn(`[sync:config] skip unreadable source ${filePath}: ${error.message}`);
  }
  return null;
}

function providerValue(provider, keys) {
  for (const key of keys) {
    if (typeof provider?.[key] === 'string' && provider[key].trim()) return provider[key].trim();
  }
  return '';
}

function isNewApiBaseUrl(baseUrl) {
  return /(?:api\.gmnlee\.com|api\.yiyong\.me)/i.test(String(baseUrl || ''));
}

function findNewApiKey(configs) {
  for (const config of configs) {
    if (!config) continue;
    const envKey = config.env?.UCLAW_NEW_API_KEY;
    if (typeof envKey === 'string'
      && envKey.trim()
      && envKey.trim() !== LEGACY_VIDEO_ADAPTER_API_KEY) {
      return envKey.trim();
    }

    const providers = config.models?.providers || {};
    for (const [providerName, provider] of Object.entries(providers)) {
      const baseUrl = providerValue(provider, ['baseUrl', 'baseURL', 'base_url', 'apiBaseUrl']);
      const apiKey = providerValue(provider, ['apiKey', 'api_key', 'key']);
      if (apiKey
        && apiKey !== LEGACY_VIDEO_ADAPTER_API_KEY
        && (providerName === 'newapi' || isNewApiBaseUrl(baseUrl))) {
        return apiKey;
      }
    }
  }
  return '';
}

function readOpenClawVersion() {
  const packageJson = readJsonIfExists(openclawPackagePath);
  return typeof packageJson?.version === 'string' && packageJson.version.trim()
    ? packageJson.version.trim()
    : '2026.7.1-2';
}

function findConfigMeta(configs) {
  for (const config of configs) {
    const meta = config?.meta;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
    const lastTouchedVersion = typeof meta.lastTouchedVersion === 'string' ? meta.lastTouchedVersion.trim() : '';
    const lastTouchedAt = typeof meta.lastTouchedAt === 'string' ? meta.lastTouchedAt.trim() : '';
    if (lastTouchedVersion || lastTouchedAt) {
      return {
        ...(lastTouchedVersion ? { lastTouchedVersion } : {}),
        ...(lastTouchedAt ? { lastTouchedAt } : {})
      };
    }
  }
  return null;
}

function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function describeKey(key) {
  return key ? `present (len=${key.length})` : 'empty';
}

function mergeObjects(base, override) {
  if (!base || typeof base !== 'object' || Array.isArray(base)) return override;
  if (!override || typeof override !== 'object' || Array.isArray(override)) return override === undefined ? base : override;

  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = mergeObjects(base[key], value);
  }
  return result;
}

function buildConfig(options, sourceConfigs) {
  const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  const existingConfig = (options.customer || options.streamer) ? {} : (sourceConfigs[0] || {});
  const mergedConfig = mergeObjects(template, existingConfig);
  mergedConfig.meta = {
    lastTouchedVersion: findConfigMeta(sourceConfigs)?.lastTouchedVersion || readOpenClawVersion(),
    lastTouchedAt: new Date().toISOString()
  };
  const requestedNewApiKey = String(options.newApiKey || '').trim();
  const newApiKey = options.customer
    ? ''
    : requestedNewApiKey && requestedNewApiKey !== LEGACY_VIDEO_ADAPTER_API_KEY
      ? requestedNewApiKey
      : findNewApiKey(sourceConfigs);
  mergedConfig.models = mergedConfig.models || {};
  mergedConfig.models.mode = 'merge';
  mergedConfig.models.providers = mergedConfig.models.providers || {};
  mergedConfig.agents = mergedConfig.agents || {};
  mergedConfig.agents.defaults = mergedConfig.agents.defaults || {};

  const providers = mergedConfig.models.providers;
  const templateProviders = template.models.providers;

  for (const providerName of ['custom', 'litellm', 'xai']) {
    delete providers[providerName];
  }

  providers.newapi = {
    ...templateProviders.newapi,
    ...(providers.newapi || {})
  };
  providers.newapi.baseUrl = normalizeBaseUrl(options.newApiBaseUrl);
  providers.newapi.apiKey = newApiKey || '';
  providers.newapi.api = 'openai-completions';
  providers.newapi.models = templateProviders.newapi.models;

  mergedConfig.agents.defaults.model = { primary: 'newapi/gpt-5.5' };
  mergedConfig.agents.defaults.imageGenerationModel = {
    primary: 'newapi/gpt-image-2',
    timeoutMs: 180000
  };
  mergedConfig.agents.defaults.imageModel = {
    primary: 'newapi/gpt-image-2',
    timeoutMs: 180000
  };
  delete mergedConfig.agents.defaults.videoGenerationModel;
  mergedConfig.agents.defaults.mediaMaxMb = Math.max(Number(mergedConfig.agents.defaults.mediaMaxMb) || 0, 256);

  return { config: mergedConfig, newApiKey };
}

function validateConfig(config, options, newApiKey) {
  const providers = config.models?.providers || {};

  if (options.streamer
    && (!newApiKey || newApiKey === LEGACY_VIDEO_ADAPTER_API_KEY)) {
    throw new Error('streamer config requires a real New API key in desktop config or UCLAW_NEW_API_KEY');
  }
  if (options.customer
    && providers.newapi?.apiKey) {
    throw new Error('customer config must not contain a New API key');
  }
  if (providers.xai) {
    throw new Error('config must not include legacy xai video adapter provider');
  }
}

function usbConfigPath(root) {
  const resolved = path.resolve(expandHome(root));
  const uClawRoot = path.basename(resolved).toLowerCase() === 'u-claw'
    ? resolved
    : path.join(resolved, 'Bavi-box');
  return path.join(uClawRoot, 'data', '.openclaw', 'openclaw.json');
}

function collectDestinations(options) {
  const destinations = [];
  if (options.desktop) destinations.push(...desktopConfigPaths);
  if (options.portableCache) destinations.push(...portableCacheConfigPaths);
  for (const root of options.usbRoots) destinations.push(usbConfigPath(root));
  for (const dest of options.destinations) destinations.push(path.resolve(expandHome(dest)));
  return [...new Set(destinations)];
}

function writeConfig(filePath, config) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`[sync:config] wrote ${filePath}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const sourcePaths = [
    ...options.sources.map(source => path.resolve(expandHome(source))),
    ...desktopConfigPaths,
    ...portableCacheConfigPaths
  ];
  const sourceConfigs = sourcePaths.map(readJsonIfExists).filter(Boolean);
  const { config, newApiKey } = buildConfig(options, sourceConfigs);
  validateConfig(config, options, newApiKey);
  const destinations = collectDestinations(options);

  const mode = options.customer ? 'customer' : options.streamer ? 'streamer/internal' : 'standard';
  console.log(`[sync:config] mode: ${mode}`);
  console.log(`[sync:config] New API key: ${describeKey(newApiKey)}`);
  for (const destination of destinations) writeConfig(destination, config);
}

try {
  main();
} catch (error) {
  console.error(`[sync:config] ${error.message}`);
  process.exit(1);
}
