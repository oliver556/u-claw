const { app, BrowserWindow, Menu, Tray, shell, dialog, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { createVideoAdapterServer } = require('./video-adapter');

// ── Constants ──
const APP_NAME = 'U-Claw';
const DEFAULT_PORT = 18789;
const MAX_PORT = 18799;
const DEFAULT_VIDEO_ADAPTER_PORT = 18808;
const MAX_VIDEO_ADAPTER_PORT = 18818;
const UCLAW_VIDEO_MODEL = process.env.UCLAW_VIDEO_MODEL || 'jimeng-video-3-720p';
const UCLAW_VIDEO_ADAPTER_BASE_URL = process.env.UCLAW_VIDEO_ADAPTER_BASE_URL || '';
const UCLAW_VIDEO_ADAPTER_API_KEY = process.env.UCLAW_VIDEO_ADAPTER_API_KEY || '';
// First cold start builds the V8 compile cache for OpenClaw (a large app) — on a
// fresh machine / freshly-extracted portable exe this can take 30–60s+. Give it
// room so we never hard-fail with a scary dialog before the engine is up. The
// loading.html splash polls and the window navigates as soon as the gateway is
// ready, so a long ceiling only matters on a genuinely stuck start.
const GATEWAY_STARTUP_TIMEOUT = 180000;

// ── Paths ──
const isDev = process.argv.includes('--dev') || process.defaultApp || !app.isPackaged;
const appRoot = isDev ? __dirname + '/..' : process.resourcesPath + '/..';
const resourcesPath = isDev
  ? path.join(__dirname, '..', 'resources')
  : path.join(process.resourcesPath, 'resources');

// OpenClaw core location
const openclawPath = isDev
  ? path.join(__dirname, '..', 'node_modules', 'openclaw')
  : path.join(process.resourcesPath, 'app', 'node_modules', 'openclaw');

const openclawEntry = path.join(openclawPath, 'openclaw.mjs');

/**
 * Looks up an executable in PATH so dev launches do not depend on shell
 * expansion. macOS GUI/Electron processes can have a different PATH from zsh.
 */
function findExecutableInPath(command) {
  const pathValue = process.env.PATH || '';
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];

  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, process.platform === 'win32' ? command + ext : command);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }

  return null;
}

/**
 * Resolves the standalone Node.js runtime used by OpenClaw Gateway.
 * Packaged builds must use bundled runtime; dev builds may fall back to PATH.
 */
function getNodeBin() {
  const platform = process.platform;
  const arch = process.arch;
  const envNodeBin = process.env.UCLAW_NODE_BIN;
  if (envNodeBin && fs.existsSync(envNodeBin)) return envNodeBin;

  if (isDev) {
    const devNodeDir = path.join(__dirname, '..', 'resources', 'runtime', `node-${platform}-${arch}`);
    const devNodeBin = platform === 'win32'
      ? path.join(devNodeDir, 'node.exe')
      : path.join(devNodeDir, 'bin', 'node');
    if (fs.existsSync(devNodeBin)) return devNodeBin;
    const pathNodeBin = findExecutableInPath('node');
    if (pathNodeBin) return pathNodeBin;
    throw new Error('Node.js executable not found. Set UCLAW_NODE_BIN or install Node.js for dev launch.');
  }

  const nodeDir = path.join(process.resourcesPath, 'resources', 'runtime', `node-${platform}-${arch}`);
  const nodeBin = platform === 'win32'
    ? path.join(nodeDir, 'node.exe')
    : path.join(nodeDir, 'bin', 'node');
  if (fs.existsSync(nodeBin)) return nodeBin;
  throw new Error(`Bundled Node.js runtime not found: ${nodeBin}`);
}

// Portable mode: launcher-provided data dir wins in both dev and packaged runs.
// Falling back to desktop userData when this env is present would write portable
// installs into the host machine's platform-specific app data directory.
function getPortableDataPath() {
  const envPortableDir = process.env.UCLAW_PORTABLE_DATA_DIR?.trim();
  if (envPortableDir) {
    const resolvedPortableDir = path.resolve(envPortableDir);
    try {
      fs.mkdirSync(resolvedPortableDir, { recursive: true });
      if (!fs.statSync(resolvedPortableDir).isDirectory()) {
        throw new Error('path is not a directory');
      }
    } catch (error) {
      throw new Error(`Invalid UCLAW_PORTABLE_DATA_DIR ${resolvedPortableDir}: ${error.message}`);
    }
    console.log(`[${APP_NAME}] Portable mode: data in ${resolvedPortableDir}`);
    return resolvedPortableDir;
  }

  if (!app.isPackaged) return null;

  const appPath = app.getAppPath(); // inside .app/Contents/Resources/app
  // Walk up to the .app's parent directory
  const appBundleDir = path.resolve(appPath, '..', '..', '..', '..');
  const portableDir = path.join(appBundleDir, 'portable');
  if (fs.existsSync(portableDir)) {
    console.log(`[${APP_NAME}] Portable mode: data in ${portableDir}`);
    return portableDir;
  }
  return null;
}

function getDesktopUserDataPath() {
  const envDevDataDir = process.env.UCLAW_DEV_DATA_DIR?.trim();
  if (isDev && envDevDataDir) return path.resolve(envDevDataDir);
  if (isDev) return path.join(app.getPath('appData'), 'u-claw-dev');
  return app.getPath('userData');
}

// User data — portable or default
const portablePath = getPortableDataPath();
const userDataPath = portablePath || getDesktopUserDataPath();
const configDir = path.join(userDataPath, '.openclaw');
const configPath = path.join(configDir, 'openclaw.json');

// ── State ──
let mainWindow = null;
let tray = null;
let gatewayProcess = null;
let gatewayPort = DEFAULT_PORT;
let gatewayReady = false;
let configServerPort = null; // mini HTTP server for Config.html
let videoAdapterServer = null;
let videoAdapterPort = null;

// ── Config Management ──
function loadBundledDefaultConfig() {
  const defaultConfigPath = path.join(resourcesPath, 'default-openclaw.json');
  try {
    if (fs.existsSync(defaultConfigPath)) {
      return JSON.parse(fs.readFileSync(defaultConfigPath, 'utf8'));
    }
  } catch (error) {
    console.warn(`[${APP_NAME}] Failed to load bundled default config: ${error.message}`);
  }

  return {
    gateway: {
      mode: 'local',
      auth: { token: 'uclaw' }
    }
  };
}

function applyRuntimeConfigEnv(config) {
  const nextConfig = JSON.parse(JSON.stringify(config));
  const newApiKey = process.env.UCLAW_NEW_API_KEY || '';
  const newApiBaseUrl = process.env.UCLAW_NEW_API_BASE_URL || '';
  const videoAdapterBaseUrl = process.env.UCLAW_VIDEO_ADAPTER_BASE_URL || '';
  const videoAdapterApiKey = process.env.UCLAW_VIDEO_ADAPTER_API_KEY || '';

  const providers = nextConfig.models?.providers || {};
  for (const providerName of ['custom', 'litellm']) {
    if (!providers[providerName]) continue;
    if (newApiKey) providers[providerName].apiKey = newApiKey;
    if (newApiBaseUrl) providers[providerName].baseUrl = newApiBaseUrl;
  }

  if (providers.xai) {
    if (videoAdapterBaseUrl) providers.xai.baseUrl = videoAdapterBaseUrl.replace(/\/+$/, '');
    if (videoAdapterApiKey) providers.xai.apiKey = videoAdapterApiKey;
  }

  return nextConfig;
}

function ensureConfig() {
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(userDataPath, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(userDataPath, 'backups'), { recursive: true });

  if (!fs.existsSync(configPath)) {
    const defaultConfig = applyRuntimeConfigEnv(loadBundledDefaultConfig());
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
    console.log(`[${APP_NAME}] Created default config at ${configPath}`);
  }
}

function getConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return { gateway: { mode: 'local', auth: { token: 'uclaw' } } };
  }
}

function saveConfig(config) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function normalizePortableDataPathString(value) {
  if (!portablePath || typeof value !== 'string') return value;
  return value
    .replace(/~[\\/]Library[\\/]Caches[\\/]U-Claw[\\/]usb-portable[\\/]data/g, userDataPath)
    .replace(/(?:[A-Za-z]:)?[\\/](?:Users|home)[^"'\r\n]*?[\\/]Library[\\/]Caches[\\/]U-Claw[\\/]usb-portable[\\/]data/g, userDataPath);
}

function normalizePortableDataPathsInJson(value, stats) {
  if (typeof value === 'string') {
    const nextValue = normalizePortableDataPathString(value);
    if (nextValue !== value) stats.changed += 1;
    return nextValue;
  }
  if (Array.isArray(value)) {
    return value.map(item => normalizePortableDataPathsInJson(item, stats));
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      value[key] = normalizePortableDataPathsInJson(value[key], stats);
    }
  }
  return value;
}

function listJsonFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) files.push(...listJsonFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(entryPath);
  }
  return files;
}

function sanitizePortableStatePaths() {
  if (!portablePath) return;
  const agentsDir = path.join(configDir, 'agents');
  let changedFiles = 0;
  for (const filePath of listJsonFiles(agentsDir)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const stats = { changed: 0 };
      const next = normalizePortableDataPathsInJson(parsed, stats);
      if (stats.changed > 0) {
        fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
        changedFiles += 1;
      }
    } catch (error) {
      console.warn(`[${APP_NAME}] Skipped portable state path migration for ${filePath}: ${error.message}`);
    }
  }
  if (changedFiles > 0) {
    console.log(`[${APP_NAME}] Migrated portable state paths in ${changedFiles} file(s)`);
  }
}

function getProviderValue(provider, keys) {
  for (const key of keys) {
    if (typeof provider[key] === 'string' && provider[key].trim()) {
      return provider[key].trim();
    }
  }
  return '';
}

function findNewApiCredentials(config) {
  const env = config.env || {};
  const envBaseUrl = process.env.UCLAW_NEW_API_BASE_URL || env.UCLAW_NEW_API_BASE_URL;
  const envApiKey = process.env.UCLAW_NEW_API_KEY || env.UCLAW_NEW_API_KEY;
  if (envBaseUrl || envApiKey) {
    return { newApiBaseUrl: envBaseUrl, newApiKey: envApiKey };
  }

  const providers = config.models?.providers || {};
  for (const provider of Object.values(providers)) {
    if (!provider || typeof provider !== 'object') continue;
    const baseUrl = getProviderValue(provider, ['baseUrl', 'baseURL', 'base_url', 'apiBaseUrl', 'api_base_url']);
    const apiKey = getProviderValue(provider, ['apiKey', 'api_key', 'key']);
    if (baseUrl && apiKey && /api\.gmnlee\.com/i.test(baseUrl)) {
      return { newApiBaseUrl: baseUrl, newApiKey: apiKey };
    }
  }

  return {};
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.warn(`[${APP_NAME}] Failed to read config ${filePath}: ${error.message}`);
    return null;
  }
}

function syncDevNewApiCredentialsFromDesktop() {
  if (!isDev || portablePath) return;
  if (process.env.UCLAW_NEW_API_KEY?.trim()) return;

  const desktopConfigPath = path.join(app.getPath('appData'), 'u-claw', '.openclaw', 'openclaw.json');
  if (path.resolve(desktopConfigPath) === path.resolve(configPath)) return;

  const sourceConfig = readJsonIfExists(desktopConfigPath);
  if (!sourceConfig) return;

  const targetConfig = getConfig();
  const sourceProviders = sourceConfig.models?.providers || {};
  const targetProviders = targetConfig.models?.providers || {};
  let changed = false;

  for (const providerName of ['custom', 'litellm']) {
    const sourceProvider = sourceProviders[providerName];
    const targetProvider = targetProviders[providerName];
    if (!sourceProvider || !targetProvider) continue;

    const sourceApiKey = getProviderValue(sourceProvider, ['apiKey', 'api_key', 'key']);
    const sourceBaseUrl = getProviderValue(sourceProvider, ['baseUrl', 'baseURL', 'base_url', 'apiBaseUrl', 'api_base_url']);
    if (sourceApiKey && !getProviderValue(targetProvider, ['apiKey', 'api_key', 'key'])) {
      targetProvider.apiKey = sourceApiKey;
      changed = true;
    }
    if (sourceBaseUrl && !getProviderValue(targetProvider, ['baseUrl', 'baseURL', 'base_url', 'apiBaseUrl', 'api_base_url'])) {
      targetProvider.baseUrl = sourceBaseUrl;
      changed = true;
    }
  }

  if (changed) {
    saveConfig(targetConfig);
    console.log(`[${APP_NAME}] Synced dev New API credentials from desktop config`);
  }
}

function getVideoAdapterOptions() {
  const config = getConfig();
  const env = config.env || {};
  const newApiCredentials = findNewApiCredentials(config);
  return {
    defaultModel: UCLAW_VIDEO_MODEL,
    newApiBaseUrl: newApiCredentials.newApiBaseUrl,
    newApiKey: newApiCredentials.newApiKey,
    videoProvider: process.env.UCLAW_VIDEO_PROVIDER || env.UCLAW_VIDEO_PROVIDER || ''
  };
}

function ensureVideoAdapterConfig(adapterBaseUrl) {
  const config = getConfig();
  const existingLitellm = config.models?.providers?.litellm;
  if (existingLitellm && !Array.isArray(existingLitellm.models)) {
    existingLitellm.models = [{
      id: 'gpt-image-2',
      name: 'gpt-image-2',
      reasoning: false,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192
    }];
  }

  const existingXai = config.models?.providers?.xai || {};
  const newApiCredentials = findNewApiCredentials(config);
  const adapterApiKey = UCLAW_VIDEO_ADAPTER_API_KEY
    || (UCLAW_VIDEO_ADAPTER_BASE_URL ? newApiCredentials.newApiKey : '')
    || existingXai.apiKey
    || 'uclaw-video-adapter';
  const existingModels = Array.isArray(existingXai.models) ? existingXai.models : [];
  const hasVideoModel = existingModels.some(model => model && model.id === UCLAW_VIDEO_MODEL);

  const xaiModels = hasVideoModel ? existingModels : [
    ...existingModels,
    {
      id: UCLAW_VIDEO_MODEL,
      name: UCLAW_VIDEO_MODEL,
      reasoning: false,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192
    }
  ];

  config.models = config.models || {};
  config.models.mode = config.models.mode || 'merge';
  config.models.providers = config.models.providers || {};
  config.models.providers.xai = {
    ...existingXai,
    baseUrl: adapterBaseUrl,
    apiKey: adapterApiKey,
    api: existingXai.api || 'openai-completions',
    models: xaiModels
  };

  config.agents = config.agents || {};
  config.agents.defaults = config.agents.defaults || {};
  config.agents.defaults.videoGenerationModel = {
    ...(config.agents.defaults.videoGenerationModel || {}),
    primary: `xai/${UCLAW_VIDEO_MODEL}`,
    timeoutMs: Math.max(Number(config.agents.defaults.videoGenerationModel?.timeoutMs) || 0, 600000)
  };
  if (!config.agents.defaults.imageModel && config.agents.defaults.imageGenerationModel?.primary) {
    config.agents.defaults.imageModel = {
      primary: config.agents.defaults.imageGenerationModel.primary,
      timeoutMs: config.agents.defaults.imageGenerationModel.timeoutMs || 180000
    };
  }
  config.agents.defaults.mediaMaxMb = Math.max(Number(config.agents.defaults.mediaMaxMb) || 0, 256);

  saveConfig(config);
  console.log(`[${APP_NAME}] Video adapter config set to ${adapterBaseUrl}`);
}

function hasModelConfigured() {
  const config = getConfig();
  // Check new format: agents.defaults.model.primary or env with API key or models.providers
  if (config.agents?.defaults?.model?.primary) return true;
  if (config.env && Object.keys(config.env).some(k => k.includes('API_KEY'))) return true;
  if (config.models?.providers && Object.keys(config.models.providers).length > 0) return true;
  // Legacy format
  if (config.agent?.model) return true;
  return false;
}

function getToken() {
  const config = getConfig();
  return config?.gateway?.auth?.token || 'uclaw';
}

// ── Port Detection ──
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = require('net').createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port, '127.0.0.1');
  });
}

async function findAvailablePort(start = DEFAULT_PORT, end = MAX_PORT) {
  for (let port = start; port <= end; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available port in range ${start}-${end}`);
}

function startVideoAdapter(port) {
  return new Promise((resolve, reject) => {
    const server = createVideoAdapterServer(getVideoAdapterOptions());
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      videoAdapterServer = server;
      videoAdapterPort = port;
      console.log(`[${APP_NAME}] Video adapter ready on http://127.0.0.1:${port}/xai/v1`);
      resolve(port);
    });
  });
}

function stopVideoAdapter() {
  if (videoAdapterServer) {
    console.log(`[${APP_NAME}] Stopping video adapter...`);
    videoAdapterServer.close();
    videoAdapterServer = null;
    videoAdapterPort = null;
  }
}

// ── Mini HTTP Server for Config.html ──
// Serves Config.html on localhost so WebSocket origin is http://127.0.0.1:xxx
// (OpenClaw gateway rejects non-http origins like file:// or custom protocols)
function startConfigServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);

      // GET /api/config — return current config
      if (req.method === 'GET' && url.pathname === '/api/config') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getConfig()));
        return;
      }

      // POST /api/config — save/merge config
      if (req.method === 'POST' && url.pathname === '/api/config') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const newConfig = JSON.parse(body);
            const existing = getConfig();
            const merged = Object.assign(existing, newConfig);
            fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
            console.log(`[${APP_NAME}] Config saved`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }

      // POST /api/done — config complete, load dashboard
      if (req.method === 'POST' && url.pathname === '/api/done') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        // Switch to dashboard after short delay
        setTimeout(() => {
          if (mainWindow && gatewayReady) {
            const token = getToken();
            mainWindow.loadURL(`http://127.0.0.1:${gatewayPort}/#token=${token}`);
          }
        }, 500);
        return;
      }

      // Default: serve Config.html
      const configHtml = path.join(resourcesPath, 'Config.html');
      if (fs.existsSync(configHtml)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(configHtml).pipe(res);
      } else {
        res.writeHead(404);
        res.end('Config.html not found');
      }
    });
    // Listen on random available port
    server.listen(0, '127.0.0.1', () => {
      configServerPort = server.address().port;
      console.log(`[${APP_NAME}] Config server on http://127.0.0.1:${configServerPort}`);
      resolve(configServerPort);
    });
  });
}

function getConfigURL() {
  return `http://127.0.0.1:${configServerPort}/?port=${gatewayPort}`;
}

function portableChildHomeEnv(baseEnv) {
  if (!portablePath) return baseEnv;

  const portableHome = path.join(userDataPath, '.home');
  const codexHome = path.join(userDataPath, '.codex');
  const appData = path.join(portableHome, 'AppData', 'Roaming');
  const localAppData = path.join(portableHome, 'AppData', 'Local');
  for (const dir of [portableHome, codexHome, appData, localAppData]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }

  const nextEnv = {
    ...baseEnv,
    HOME: portableHome,
    CODEX_HOME: codexHome,
  };

  if (process.platform === 'win32') {
    const parsedHome = path.parse(portableHome);
    nextEnv.USERPROFILE = portableHome;
    nextEnv.APPDATA = appData;
    nextEnv.LOCALAPPDATA = localAppData;
    if (parsedHome.root) nextEnv.HOMEDRIVE = parsedHome.root.replace(/[\\/]$/, '');
    if (parsedHome.root) nextEnv.HOMEPATH = portableHome.slice(parsedHome.root.length - 1);
  }

  return nextEnv;
}

// ── Gateway Management ──
function startGateway(port) {
  return new Promise((resolve, reject) => {
    console.log(`[${APP_NAME}] Starting OpenClaw gateway on port ${port}...`);

    const nodeBin = getNodeBin();
    console.log(`[${APP_NAME}] Using Node.js: ${nodeBin}`);

    // Persist the V8 compile cache to a fixed local dir under userData so the
    // gateway's heavy first-run compile is paid only once. userDataPath is stable
    // across launches even for the portable exe (which self-extracts to a random
    // temp dir each time), so the cache survives and subsequent starts are fast.
    const compileCacheDir = path.join(userDataPath, '.cache', 'v8-compile-cache');
    try { fs.mkdirSync(compileCacheDir, { recursive: true }); } catch {}
    const mediaPreviewRoots = [
      process.env.UCLAW_MEDIA_PREVIEW_ROOTS,
      path.join(configDir, 'media'),
    ].filter(Boolean).join(path.delimiter);

    const env = portableChildHomeEnv({
      ...process.env,
      OPENCLAW_HOME: userDataPath,
      OPENCLAW_STATE_DIR: configDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_EMBEDDED_IN: APP_NAME,
      NODE_COMPILE_CACHE: compileCacheDir,
      UCLAW_MEDIA_PREVIEW_ROOTS: mediaPreviewRoots,
    });

    if (process.platform === 'win32') {
      env.OPENCLAW_DISABLE_BONJOUR = '1';
    }

    gatewayProcess = spawn(nodeBin, [
      openclawEntry,
      'gateway', 'run',
      '--allow-unconfigured',
      '--force',
      '--port', String(port),
    ], {
      env,
      cwd: openclawPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    gatewayProcess.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.log(`[OpenClaw] ${msg}`);
    });

    gatewayProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.error(`[OpenClaw:err] ${msg}`);
    });

    gatewayProcess.on('error', (err) => {
      console.error(`[${APP_NAME}] Gateway process error:`, err);
      reject(err);
    });

    gatewayProcess.on('exit', (code) => {
      console.log(`[${APP_NAME}] Gateway exited with code ${code}`);
      gatewayProcess = null;
      gatewayReady = false;
    });

    // Poll for gateway readiness
    const startTime = Date.now();
    let settled = false;
    const checkReady = () => {
      if (settled) return;

      if (Date.now() - startTime > GATEWAY_STARTUP_TIMEOUT) {
        settled = true;
        reject(new Error('Gateway startup timeout'));
        return;
      }

      const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
        if (settled) return;
        settled = true;
        gatewayReady = true;
        gatewayPort = port;
        console.log(`[${APP_NAME}] Gateway ready on port ${port}`);
        res.resume();
        resolve(port);
      });
      req.on('error', () => {
        if (!settled) setTimeout(checkReady, 500);
      });
      req.setTimeout(2000, () => {
        if (settled) return;
        req.destroy();
        setTimeout(checkReady, 500);
      });
    };

    setTimeout(checkReady, 1000);
  });
}

function stopGateway() {
  if (gatewayProcess) {
    console.log(`[${APP_NAME}] Stopping gateway...`);
    gatewayProcess.kill('SIGTERM');
    setTimeout(() => {
      if (gatewayProcess) gatewayProcess.kill('SIGKILL');
    }, 5000);
  }
}

// ── Window Management ──
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: APP_NAME,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
    backgroundColor: '#0a0a0a',
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  loadAppPage();
}

function loadAppPage() {
  if (!mainWindow) return;

  if (gatewayReady) {
    const token = getToken();
    mainWindow.loadURL(`http://127.0.0.1:${gatewayPort}/#token=${token}`);
  } else {
    const loadingHtml = path.join(__dirname, 'loading.html');
    mainWindow.loadFile(loadingHtml);
  }
}

function loadConfigPage() {
  if (!mainWindow || !gatewayReady || !configServerPort) return;
  mainWindow.loadURL(getConfigURL());
}

// ── Menu ──
function createMenu() {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { label: `About ${APP_NAME}`, role: 'about' },
        { type: 'separator' },
        {
          label: '配置助手 / Configuration',
          accelerator: 'CmdOrCtrl+,',
          click: () => loadConfigPage()
        },
        {
          label: 'Dashboard',
          accelerator: 'CmdOrCtrl+D',
          click: () => {
            if (mainWindow && gatewayReady) {
              const token = getToken();
              mainWindow.loadURL(`http://127.0.0.1:${gatewayPort}/#token=${token}`);
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Open Data Folder',
          click: () => shell.openPath(userDataPath)
        },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Website',
          click: () => shell.openExternal('https://u-claw.org')
        },
        {
          label: 'WeChat: hecare888',
          click: () => {
            dialog.showMessageBox({ message: 'WeChat / 微信: hecare888', type: 'info' });
          }
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── IPC Handlers ──
function setupIPC() {
  ipcMain.handle('get-gateway-status', () => ({
    ready: gatewayReady,
    port: gatewayPort,
    token: getToken(),
    hasModel: hasModelConfigured(),
    videoAdapterPort,
  }));

  ipcMain.handle('open-dashboard', () => {
    if (mainWindow && gatewayReady) {
      const token = getToken();
      mainWindow.loadURL(`http://127.0.0.1:${gatewayPort}/#token=${token}`);
    }
  });

  ipcMain.handle('open-config', () => loadConfigPage());
}

// ── App Lifecycle ──
app.whenReady().then(async () => {
  console.log(`[${APP_NAME}] v${app.getVersion()} starting...`);

  // Setup
  ensureConfig();
  syncDevNewApiCredentialsFromDesktop();
  sanitizePortableStatePaths();
  createMenu();
  setupIPC();
  createWindow();

  // Start mini HTTP server for Config.html
  await startConfigServer();

  try {
    const configuredVideoAdapterBaseUrl = UCLAW_VIDEO_ADAPTER_BASE_URL.trim();
    if (configuredVideoAdapterBaseUrl) {
      ensureVideoAdapterConfig(configuredVideoAdapterBaseUrl.replace(/\/+$/, ''));
      console.log(`[${APP_NAME}] Using external video adapter ${configuredVideoAdapterBaseUrl}`);
    } else {
      const adapterPort = await findAvailablePort(DEFAULT_VIDEO_ADAPTER_PORT, MAX_VIDEO_ADAPTER_PORT);
      await startVideoAdapter(adapterPort);
      ensureVideoAdapterConfig(`http://127.0.0.1:${adapterPort}/xai/v1`);
    }

    // Find port and start gateway
    const port = await findAvailablePort();
    await startGateway(port);

    // Gateway is ready — if no model configured, show Config.html first
    if (hasModelConfigured()) {
      loadAppPage();
    } else {
      console.log(`[${APP_NAME}] No model configured, opening Config.html`);
      loadConfigPage();
    }
  } catch (err) {
    console.error(`[${APP_NAME}] Failed to start gateway:`, err);
    dialog.showErrorBox(
      `${APP_NAME} - Startup Error`,
      `Failed to start OpenClaw gateway.\n\n${err.message}\n\nPlease check if Node.js is available and try again.`
    );
  }
});

app.on('window-all-closed', () => {
  stopGateway();
  stopVideoAdapter();
  app.quit();
});

app.on('before-quit', () => {
  stopGateway();
  stopVideoAdapter();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
