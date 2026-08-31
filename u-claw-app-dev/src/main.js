const { app, BrowserWindow, Menu, Tray, shell, dialog, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const {
  mergeModelCatalogIntoConfig,
} = require('./model-catalog');

// ── Constants ──
const APP_NAME = 'Bavi-box';
const DEFAULT_PORT = 18789;
const MAX_PORT = 18799;
const DEFAULT_VIDEO_ADAPTER_PORT = 18808;
const MAX_VIDEO_ADAPTER_PORT = 18818;
const DEFAULT_VIDEO_ADAPTER_BASE_URL = 'https://api.yiyong.me/v1';
const UCLAW_VIDEO_MODEL = process.env.UCLAW_VIDEO_MODEL || 'jimeng-video-3-720p';
const UCLAW_VIDEO_ADAPTER_BASE_URL = process.env.UCLAW_VIDEO_ADAPTER_BASE_URL || '';
const UCLAW_VIDEO_ADAPTER_API_KEY = process.env.UCLAW_VIDEO_ADAPTER_API_KEY || '';
const UCLAW_ACTIVATION_ENDPOINT = (process.env.UCLAW_ACTIVATION_ENDPOINT || '').trim().replace(/\/+$/, '');
const UCLAW_PORTABLE_DATA_DIR = process.env.UCLAW_PORTABLE_DATA_DIR?.trim() || '';
const UCLAW_PORTABLE_WORK_DATA_DIR = process.env.UCLAW_PORTABLE_WORK_DATA_DIR?.trim() || '';
const UCLAW_USB_DATA_DIR = (process.env.UCLAW_USB_DATA_DIR?.trim() || UCLAW_PORTABLE_DATA_DIR);
const UCLAW_PORTABLE_ROOT = process.env.UCLAW_PORTABLE_ROOT?.trim() || '';
const UCLAW_CACHE_ROOT = process.env.UCLAW_CACHE_ROOT?.trim() || '';
const UCLAW_APP_CACHE_DIR = process.env.UCLAW_APP_CACHE_DIR?.trim() || '';
const UCLAW_ARCHIVE_CACHE = process.env.UCLAW_ARCHIVE_CACHE?.trim() || '';
const UCLAW_APP_CACHE_STAMP = process.env.UCLAW_APP_CACHE_STAMP?.trim() || '';
const UCLAW_ELECTRON_PROFILE_DIR = process.env.UCLAW_ELECTRON_PROFILE_DIR?.trim() || '';
const UCLAW_LAUNCHER_GUI = process.env.UCLAW_LAUNCHER_GUI === '1';
const UCLAW_INHERIT_SYSTEM_PROXY = process.env.UCLAW_INHERIT_SYSTEM_PROXY === '1';
const SYSTEM_PROXY_ENV_KEYS = [
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'npm_config_proxy',
  'npm_config_https_proxy',
];
const ACTIVATION_ONLY_ARG = '--activation-only';
const isActivationOnlyMode = process.argv.includes(ACTIVATION_ONLY_ARG)
  || process.env.UCLAW_ACTIVATION_ONLY === '1';
const ACTIVATION_STATIC_PREVIEW_COMPLETE = 'ACTIVATION_STATIC_PREVIEW_COMPLETE';
const ACTIVATION_RESTART_EXIT_CODE = 20;
const UCLAW_ACTIVATION_REQUIRE_CLOUD = process.env.UCLAW_ACTIVATION_REQUIRE_CLOUD === '1';
// First cold start builds the V8 compile cache for OpenClaw (a large app) — on a
// fresh machine / freshly-extracted portable exe this can take 30–60s+. Give it
// room so we never hard-fail with a scary dialog before the engine is up. The
// loading.html splash polls and the window navigates as soon as the gateway is
// ready, so a long ceiling only matters on a genuinely stuck start.
const GATEWAY_STARTUP_TIMEOUT = 300000;

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
  const workDataDir = UCLAW_PORTABLE_WORK_DATA_DIR || UCLAW_PORTABLE_DATA_DIR;
  if (workDataDir) {
    const resolvedPortableDir = path.resolve(workDataDir);
    try {
      fs.mkdirSync(resolvedPortableDir, { recursive: true });
      if (!fs.statSync(resolvedPortableDir).isDirectory()) {
        throw new Error('path is not a directory');
      }
    } catch (error) {
      throw new Error(`Invalid portable data dir ${resolvedPortableDir}: ${error.message}`);
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
const usbDataPath = UCLAW_USB_DATA_DIR ? path.resolve(UCLAW_USB_DATA_DIR) : null;
const portableRootPath = UCLAW_PORTABLE_ROOT
  ? path.resolve(UCLAW_PORTABLE_ROOT)
  : usbDataPath
    ? path.dirname(usbDataPath)
    : null;
const runtimeProtocolDir = portableRootPath ? path.join(portableRootPath, 'app', '.runtime') : null;
const updateShutdownRequestPath = runtimeProtocolDir ? path.join(runtimeProtocolDir, 'update-shutdown-request.json') : null;
const shutdownCompletePath = runtimeProtocolDir ? path.join(runtimeProtocolDir, 'shutdown-complete.json') : null;
const runStatePath = runtimeProtocolDir ? path.join(runtimeProtocolDir, 'run-state.json') : null;
const updateTransactionPath = portableRootPath ? path.join(portableRootPath, 'app', 'update-transaction.json') : null;
const syncStateDir = path.join(userDataPath, '.uclaw-sync');
const dirtyMarkerPath = path.join(syncStateDir, 'dirty.json');
const lastSyncPath = path.join(syncStateDir, 'last-sync.json');
const uiStatePath = path.join(configDir, 'uclaw-ui-state.json');
const activationStatePath = path.join(configDir, 'uclaw-activation.json');
const activationLicensePath = path.join(configDir, 'license', 'license.json');
const builtinModelCredentialPath = path.join(configDir, 'builtin-model-credential.v1.json');
const updateCredentialPath = path.join(configDir, 'update-credential.v1.json');
const logsDir = path.join(userDataPath, 'logs');
const portableInstallRoot = UCLAW_USB_DATA_DIR ? path.resolve(UCLAW_USB_DATA_DIR, '..') : (portablePath ? path.dirname(userDataPath) : null);

function readInstalledReleaseInfo() {
  const fallbackVersion = app.getVersion();
  if (!portableInstallRoot) {
    return { version: fallbackVersion, releaseId: null };
  }
  const versionFile = path.join(portableInstallRoot, 'app', 'version.json');
  try {
    if (!fs.existsSync(versionFile)) {
      return { version: fallbackVersion, releaseId: null };
    }
    const payload = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
    const version = typeof payload.version === 'string' && payload.version.trim() ? payload.version.trim() : fallbackVersion;
    const releaseId = typeof payload.releaseId === 'string' && payload.releaseId.trim() ? payload.releaseId.trim() : null;
    return { version, releaseId };
  } catch {
    return { version: fallbackVersion, releaseId: null };
  }
}

const installedReleaseInfo = readInstalledReleaseInfo();

function visibleAppVersion() {
  const version = String(installedReleaseInfo.version || app.getVersion()).trim().replace(/^v/i, '');
  return `v${version}`;
}

function getElectronProfilePath() {
  if (UCLAW_ELECTRON_PROFILE_DIR) return path.resolve(UCLAW_ELECTRON_PROFILE_DIR);
  if (!portablePath) return getDesktopUserDataPath();

  // Control UI device identity lives in Electron storage. Keep it local to this
  // computer, USB root, and OS instead of syncing it with OpenClaw business data.
  const profileKey = crypto
    .createHash('sha256')
    .update(`${process.platform}:${portableRootPath || portablePath}`)
    .digest('hex')
    .slice(0, 16);
  const cacheRoot = UCLAW_CACHE_ROOT || path.join(app.getPath('appData'), APP_NAME);
  return path.join(cacheRoot, 'electron-profile', `${process.platform}-${profileKey}`);
}

const electronProfilePath = getElectronProfilePath();

function removeElectronProfileCacheChild(childName) {
  const root = path.resolve(electronProfilePath);
  const target = path.resolve(root, childName);
  if (!target.startsWith(`${root}${path.sep}`)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

function invalidateControlUiCacheOnVersionChange() {
  const markerPath = path.join(electronProfilePath, 'bavi-box-ui-cache-version.json');
  const currentVersion = String(installedReleaseInfo.version || app.getVersion()).trim();
  let previousVersion = '';
  try {
    if (fs.existsSync(markerPath)) {
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      previousVersion = typeof marker.version === 'string' ? marker.version.trim() : '';
    }
  } catch {}
  if (previousVersion === currentVersion) return;
  for (const child of [
    'Cache',
    'Code Cache',
    'GPUCache',
    'DawnCache',
    'DawnGraphiteCache',
    'DawnWebGPUCache',
    'Service Worker'
  ]) {
    removeElectronProfileCacheChild(child);
  }
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify({
    schemaVersion: 1,
    version: currentVersion,
    updatedAt: new Date().toISOString()
  }, null, 2) + '\n');
  console.log(`[${APP_NAME}] Control UI cache invalidated for version ${currentVersion}`);
}

try {
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.mkdirSync(electronProfilePath, { recursive: true });
  invalidateControlUiCacheOnVersionChange();
  app.setPath('userData', electronProfilePath);
  console.log(`[${APP_NAME}] Electron profile: ${electronProfilePath}`);
} catch (error) {
  console.warn(`[${APP_NAME}] Failed to set Electron profile path: ${error.message}`);
}
const singleInstanceLock = app.requestSingleInstanceLock({ portableRootPath, userDataPath });
if (!singleInstanceLock) {
  console.log(`[${APP_NAME}] Another instance is already running for this portable profile.`);
  app.exit(0);
}

// ── State ──
let mainWindow = null;
let tray = null;
let gatewayProcess = null;
let gatewayPort = DEFAULT_PORT;
let gatewayReady = false;
let configServer = null;
let configServerPort = null; // mini HTTP server for Config.html
let appIsQuitting = false;
let quitConfirmationOpen = false;
let gatewayStopping = false;
let gatewayRestartTimer = null;
let gatewayRestartAttempts = 0;
let portableSyncTimer = null;
let portableSyncPromise = null;
let portableFinalSyncDone = false;
let shutdownPromise = null;
let updateShutdownRequest = null;
let updateShutdownWatcher = null;
let normalStartupPromise = null;
let normalIPCRegistered = false;
let suppressWindowAllClosedQuit = false;
let requestedExitCode = 0;
const holdMainWindowUntilReady = UCLAW_LAUNCHER_GUI && Boolean(UCLAW_PORTABLE_WORK_DATA_DIR || UCLAW_PORTABLE_DATA_DIR);
let activationWindowMode = isActivationOnlyMode;

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

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
    const provider = providers[providerName];
    if (!provider) continue;
    if (newApiKey) provider.apiKey = newApiKey;
    if (newApiBaseUrl) provider.baseUrl = newApiBaseUrl;
  }

  if (providers.xai) {
    if (newApiKey || videoAdapterApiKey) providers.xai.apiKey = videoAdapterApiKey || newApiKey;
    if (videoAdapterBaseUrl || newApiBaseUrl) providers.xai.baseUrl = (videoAdapterBaseUrl || newApiBaseUrl).replace(/\/+$/, '');
  }

  return nextConfig;
}

function ensureConfig() {
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(userDataPath, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(userDataPath, 'backups'), { recursive: true });

  if (!fs.existsSync(configPath)) {
    const defaultConfig = applyRuntimeConfigEnv(loadBundledDefaultConfig());
    applyPortableLocalDesktopConfig(defaultConfig);
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
    console.log(`[${APP_NAME}] Created default config at ${configPath}`);
    return;
  }

  const config = getConfig();
  const nextConfig = applyRuntimeConfigEnv(config);
  const changedPortableConfig = applyPortableLocalDesktopConfig(nextConfig);
  const changedRuntimeConfig = JSON.stringify(nextConfig) !== JSON.stringify(config);
  if (changedPortableConfig || changedRuntimeConfig) {
    fs.writeFileSync(configPath, JSON.stringify(nextConfig, null, 2));
    console.log(`[${APP_NAME}] Updated runtime config`);
  }
}

function getConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    const fallback = { gateway: { mode: 'local', auth: { token: 'uclaw' } } };
    applyPortableLocalDesktopConfig(fallback);
    return fallback;
  }
}

function saveConfig(config) {
  applyPortableLocalDesktopConfig(config);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  writeDirtyMarker('config');
}

function applyPortableLocalDesktopConfig(config) {
  if (!portablePath || !config || typeof config !== 'object') return false;
  config.gateway = config.gateway || {};
  config.gateway.controlUi = config.gateway.controlUi || {};
  let changed = false;
  if (config.gateway.controlUi.allowInsecureAuth !== true) {
    config.gateway.controlUi.allowInsecureAuth = true;
    changed = true;
  }
  if (config.gateway.controlUi.dangerouslyDisableDeviceAuth !== true) {
    config.gateway.controlUi.dangerouslyDisableDeviceAuth = true;
    changed = true;
  }
  return changed;
}

function safeWriteJson(filePath, value) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
    return true;
  } catch (error) {
    console.warn(`[${APP_NAME}] Failed to write ${filePath}: ${error.message}`);
    return false;
  }
}

function writeRuntimeJson(filePath, value) {
  if (!filePath) return false;
  return safeWriteJson(filePath, value);
}

/**
 * Rejects unsafe activation targets before writing secret-bearing JSON. This is
 * a local defense for portable media, where stale symlinks would be surprising.
 */
function assertSafeJsonTarget(filePath) {
  const resolved = path.resolve(filePath);
  const resolvedRoot = path.resolve(configDir);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`refusing to write outside activation data dir: ${resolved}`);
  }
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) throw new Error('target is a symbolic link');
    if (!stat.isFile()) throw new Error('target is not a regular file');
    if (stat.nlink > 1) throw new Error('target has multiple hard links');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}

/**
 * Atomically writes bounded JSON and reads it back so activation only commits
 * after local material is durably present.
 */
function atomicWriteJson(filePath, value) {
  assertSafeJsonTarget(filePath);
  const json = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(json, 'utf8') > 1024 * 1024) {
    throw new Error('activation material is too large');
  }
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, json, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
    if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
    return readJsonFile(filePath);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {}
  }
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function redactLogLine(value) {
  return String(value)
    .replace(/(api[_-]?key["'=:\s]+)[^"',\s]+/ig, '$1[redacted]')
    .replace(/(authorization["'=:\s]+bearer\s+)[^"',\s]+/ig, '$1[redacted]');
}

function appendLogFile(fileName, message) {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    const line = `[${new Date().toISOString()}] ${redactLogLine(message)}\n`;
    fs.appendFileSync(path.join(logsDir, fileName), line);
  } catch {}
}

function logLifecycle(message) {
  console.log(`[${APP_NAME}] ${message}`);
  appendLogFile('main.log', message);
}

function writeRunState(state = 'running') {
  if (!runStatePath) return;
  writeRuntimeJson(runStatePath, {
    schemaVersion: 1,
    state,
    launcherPid: Number(process.env.UCLAW_LAUNCHER_PID || 0) || null,
    appPid: process.pid,
    gatewayPid: gatewayProcess?.pid || null,
    configServerPid: null,
    configServerPort,
    videoAdapterPid: null,
    videoAdapterPort: null,
    startedAt: new Date().toISOString(),
    cacheRoot: UCLAW_CACHE_ROOT || null,
    appCacheDir: UCLAW_APP_CACHE_DIR || null,
    archiveCache: UCLAW_ARCHIVE_CACHE || null,
    stampFile: UCLAW_APP_CACHE_STAMP || null,
    electronProfileDir: electronProfilePath || null
  });
}

function readUpdateShutdownRequest() {
  const payload = readJsonFile(updateShutdownRequestPath);
  if (payload?.schemaVersion !== 1) return null;
  if (payload.reason !== 'update') return null;
  if (typeof payload.transactionId !== 'string' || !payload.transactionId.trim()) return null;
  const transaction = readJsonFile(updateTransactionPath);
  const currentTransactionId = typeof transaction?.id === 'string' ? transaction.id.trim() : '';
  if (transaction?.state !== 'staged' || currentTransactionId !== payload.transactionId.trim()) {
    try {
      fs.rmSync(updateShutdownRequestPath, { force: true });
      if (shutdownCompletePath) fs.rmSync(shutdownCompletePath, { force: true });
    } catch {}
    logLifecycle(`Ignored stale update shutdown request transaction=${payload.transactionId}`);
    return null;
  }
  return payload;
}

function writeShutdownComplete() {
  if (!shutdownCompletePath || !updateShutdownRequest) return;
  writeRuntimeJson(shutdownCompletePath, {
    schemaVersion: 1,
    reason: 'update',
    transactionId: updateShutdownRequest.transactionId,
    completedAt: new Date().toISOString()
  });
}

function startUpdateShutdownWatcher() {
  if (!updateShutdownRequestPath || updateShutdownWatcher) return;
  updateShutdownWatcher = setInterval(() => {
    if (appIsQuitting || shutdownPromise) return;
    const request = readUpdateShutdownRequest();
    if (!request) return;
    updateShutdownRequest = request;
    logLifecycle(`Update shutdown requested transaction=${request.transactionId}`);
    requestAppQuit({ confirm: false, reason: 'update' })
      .catch(error => logLifecycle(`Update shutdown request error: ${error.message}`));
  }, 1000);
}

function stopUpdateShutdownWatcher() {
  if (!updateShutdownWatcher) return;
  clearInterval(updateShutdownWatcher);
  updateShutdownWatcher = null;
}

function portableUsbSyncEnabled() {
  return Boolean(
    usbDataPath &&
    portablePath &&
    path.resolve(usbDataPath) !== path.resolve(userDataPath) &&
    fs.existsSync(usbDataPath)
  );
}

function writeDirtyMarker(reason) {
  if (!portablePath) return;
  const marker = {
    dirty: true,
    reason,
    updatedAt: new Date().toISOString(),
    workDataDir: userDataPath,
    usbDataDir: usbDataPath || ''
  };
  safeWriteJson(dirtyMarkerPath, marker);
  if (portableUsbSyncEnabled()) {
    safeWriteJson(path.join(usbDataPath, '.uclaw-sync', 'dirty.json'), marker);
  }
}

function writeLastSyncMarker(reason, success) {
  const marker = {
    success,
    reason,
    syncedAt: new Date().toISOString(),
    workDataDir: userDataPath,
    usbDataDir: usbDataPath || ''
  };
  safeWriteJson(lastSyncPath, marker);
  if (portableUsbSyncEnabled()) {
    safeWriteJson(path.join(usbDataPath, '.uclaw-sync', 'last-sync.json'), marker);
  }
}

function clearDirtyMarker() {
  for (const filePath of [
    dirtyMarkerPath,
    portableUsbSyncEnabled() ? path.join(usbDataPath, '.uclaw-sync', 'dirty.json') : ''
  ].filter(Boolean)) {
    try { fs.rmSync(filePath, { force: true }); } catch {}
  }
}

function spawnForSync(command, args, successExitCode) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', data => appendLogFile('main.log', data.toString().trim()));
    child.stderr.on('data', data => appendLogFile('main.log', data.toString().trim()));
    child.on('error', (error) => {
      logLifecycle(`portable sync failed to start: ${error.message}`);
      resolve(false);
    });
    child.on('exit', (code) => {
      resolve(successExitCode(code));
    });
  });
}

function portableSyncExcludeArgs() {
  if (process.platform === 'win32') {
    return {
      dirs: [
        path.join(userDataPath, '.cache', 'v8-compile-cache'),
        path.join(userDataPath, '.home', 'AppData', 'Roaming', 'u-claw', 'Cache'),
        path.join(userDataPath, '.home', 'AppData', 'Roaming', 'u-claw', 'Code Cache'),
        path.join(userDataPath, '.home', 'AppData', 'Roaming', 'u-claw', 'GPUCache'),
        path.join(userDataPath, '.home', 'AppData', 'Roaming', 'u-claw', 'DawnCache'),
        path.join(userDataPath, '.home', 'AppData', 'Roaming', 'u-claw', 'Crashpad'),
        path.join(userDataPath, 'Cache'),
        path.join(userDataPath, 'Code Cache'),
        path.join(userDataPath, 'GPUCache'),
        path.join(userDataPath, 'DawnGraphiteCache'),
        path.join(userDataPath, 'DawnWebGPUCache'),
        path.join(userDataPath, 'Network'),
        path.join(userDataPath, 'Local Storage'),
        path.join(userDataPath, 'Session Storage'),
        path.join(userDataPath, 'Service Worker'),
        path.join(userDataPath, 'WebStorage'),
        path.join(userDataPath, 'Shared Dictionary'),
        path.join(userDataPath, 'Dictionaries'),
        path.join(userDataPath, 'blob_storage'),
      ],
      files: [
        'Cookies',
        'Cookies-journal',
        'DIPS',
        'DIPS-shm',
        'DIPS-wal',
        'Local State',
        'Network Persistent State',
        'Preferences',
        'SharedStorage',
        'SharedStorage-wal',
        'Trust Tokens',
        'Trust Tokens-journal',
        'LOCK',
        'SingletonCookie',
        'SingletonLock',
        'SingletonSocket'
      ]
    };
  }

  return [
    '--exclude', '.cache/v8-compile-cache/',
    '--exclude', '**/Cache/',
    '--exclude', '**/Code Cache/',
    '--exclude', '**/GPUCache/',
    '--exclude', '**/DawnCache/',
    '--exclude', '**/Crashpad/',
    '--exclude', '**/Network/Cookies',
    '--exclude', '**/Network/Cookies-journal',
    '--exclude', '**/LOCK',
    '--exclude', '**/SingletonCookie',
    '--exclude', '**/SingletonLock',
    '--exclude', '**/SingletonSocket',
    '--exclude', '/Cookies',
    '--exclude', '/Cookies-journal',
    '--exclude', '/DIPS',
    '--exclude', '/DIPS-shm',
    '--exclude', '/DIPS-wal',
    '--exclude', '/Local State',
    '--exclude', '/Network Persistent State',
    '--exclude', '/Preferences',
    '--exclude', '/SharedStorage',
    '--exclude', '/SharedStorage-wal',
    '--exclude', '/Trust Tokens',
    '--exclude', '/Trust Tokens-journal',
    '--exclude', '/Cache/',
    '--exclude', '/Code Cache/',
    '--exclude', '/GPUCache/',
    '--exclude', '/DawnGraphiteCache/',
    '--exclude', '/DawnWebGPUCache/',
    '--exclude', '/Network/',
    '--exclude', '/Local Storage/',
    '--exclude', '/Session Storage/',
    '--exclude', '/Service Worker/',
    '--exclude', '/WebStorage/',
    '--exclude', '/Shared Dictionary/',
    '--exclude', '/Dictionaries/',
    '--exclude', '/blob_storage/',
    '--exclude', '.openclaw/openclaw.json',
    '--exclude', '.openclaw/openclaw.json.last-good',
  ];
}

async function runPortableDataSync(reason, options = {}) {
  if (!portableUsbSyncEnabled()) return true;
  if (portableSyncPromise) return portableSyncPromise;

  portableSyncPromise = (async () => {
    try {
      fs.mkdirSync(usbDataPath, { recursive: true });
      const success = process.platform === 'win32'
        ? await (() => {
          const excludes = portableSyncExcludeArgs();
          return spawnForSync('robocopy', [
          userDataPath,
          usbDataPath,
          '/E',
          '/XD',
          ...excludes.dirs,
          '/XF',
          ...excludes.files,
          '/R:2',
          '/W:1',
          '/XJ',
          '/NFL',
          '/NDL',
          '/NJH',
          '/NJS',
          '/NP'
          ], code => code !== null && code < 8);
        })()
        : await spawnForSync('rsync', [
          '-a',
          ...portableSyncExcludeArgs(),
          `${userDataPath}${path.sep}`,
          `${usbDataPath}${path.sep}`
        ], code => code === 0);

      writeLastSyncMarker(reason, success);
      if (success && options.clearDirty) clearDirtyMarker();
      logLifecycle(`portable sync ${success ? 'ok' : 'failed'} (${reason})`);
      return success;
    } finally {
      portableSyncPromise = null;
    }
  })();

  return portableSyncPromise;
}

function startPortableSyncTimer() {
  if (!portableUsbSyncEnabled() || portableSyncTimer) return;
  writeDirtyMarker('running');
  portableSyncTimer = setInterval(() => {
    runPortableDataSync('periodic').catch(error => {
      logLifecycle(`portable sync error: ${error.message}`);
    });
  }, 30000);
}

async function finalPortableDataSync(reason) {
  if (portableSyncTimer) {
    clearInterval(portableSyncTimer);
    portableSyncTimer = null;
  }
  const success = await runPortableDataSync(reason, { clearDirty: true });
  if (reason === 'after-stop') portableFinalSyncDone = success;
  return success;
}

function syncActivationMaterialToUsb() {
  if (!portableUsbSyncEnabled()) return true;

  const relativeFiles = [
    path.join('.openclaw', 'openclaw.json'),
    path.join('.openclaw', 'uclaw-activation.json'),
    path.join('.openclaw', 'builtin-model-credential.v1.json'),
    path.join('.openclaw', 'update-credential.v1.json'),
    path.join('.openclaw', 'license', 'license.json'),
  ];

  let success = true;
  for (const relativeFile of relativeFiles) {
    const source = path.join(userDataPath, relativeFile);
    if (!fs.existsSync(source)) continue;
    const destination = path.join(usbDataPath, relativeFile);
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    } catch (error) {
      success = false;
      logLifecycle(`activation material sync failed for ${relativeFile}: ${error.message}`);
    }
  }
  if (success) logLifecycle('activation material synced to USB');
  return success;
}

function persistActiveSessionKey(sessionKey) {
  const key = typeof sessionKey === 'string' ? sessionKey.trim() : '';
  if (!key || key.toLowerCase() === 'unknown') return;
  safeWriteJson(uiStatePath, {
    activeSessionKey: key,
    updatedAt: new Date().toISOString()
  });
  writeDirtyMarker('active-session');
}

function readActiveSessionKey() {
  const state = readJsonFile(uiStatePath);
  return typeof state?.activeSessionKey === 'string' && state.activeSessionKey.trim()
    ? state.activeSessionKey.trim()
    : '';
}

/**
 * Returns true when local activation material exists. The current preview marker
 * is intentionally minimal; real cloud activation will replace it with signed
 * license metadata and encrypted New API token state.
 */
function hasCompletedActivation() {
  if (process.env.UCLAW_SKIP_ACTIVATION_GATE === '1') return true;
  const state = readJsonFile(activationStatePath);
  const license = readJsonFile(activationLicensePath);
  const hasAccountMarker = [state?.phoneMasked, state?.usernameMasked, state?.accountMasked]
    .some((value) => typeof value === 'string' && value.trim());
  return state?.status === 'activated'
    && typeof state.activatedAt === 'string'
    && hasAccountMarker
    && license?.payload?.schemaVersion === 'uclaw.license.v1'
    && license?.signature?.algorithm === 'Ed25519'
    && typeof license?.signature?.value === 'string'
    && license.signature.value.length > 0;
}

/**
 * Decides whether normal startup must stop at the first-login activation page.
 */
function shouldShowActivationOnStartup() {
  if (isActivationOnlyMode) return true;
  return !hasCompletedActivation();
}

/**
 * Persists the preview activation marker used to avoid showing first-login UI on
 * every launch. Later slices will store signed cloud license data here.
 */
function writeActivationState(payload) {
  const phone = String(payload.phone || '').trim();
  const username = String(payload.username || '').trim().toUpperCase();
  const activationCode = String(payload.activationCode || '').trim().toUpperCase();
  const token = String(payload.newapiToken || '').trim();
  const updateToken = String(payload.updateDeviceToken || '').trim();
  const accountMasked = payload.usernameMasked
    || payload.phoneMasked
    || (phone ? `${phone.slice(0, 3)}****${phone.slice(7)}` : username);
  const marker = {
    schemaVersion: 1,
    status: payload.status || 'activated',
    source: payload.source || 'local-preview',
    phoneMasked: payload.phoneMasked || '',
    usernameMasked: payload.usernameMasked || (username ? username.replace(/^UCLAW-([A-Z0-9]{2})[A-Z0-9]+([A-Z0-9]{2})$/, 'UCLAW-$1****$2') : ''),
    accountMasked,
    activationId: payload.activationId || '',
    artifactStatus: payload.artifactStatus || '',
    commitStatus: payload.commitStatus || '',
    activationCodeSuffix: activationCode.replace(/-/g, '').slice(-4),
    activationEndpoint: payload.activationEndpoint || UCLAW_ACTIVATION_ENDPOINT,
    newapiBaseUrl: payload.newapiBaseUrl || '',
    tokenVersion: Number(payload.tokenVersion) || 1,
    tokenStatus: token ? 'configured' : 'pending_cloud_activation',
    tokenFingerprint: token ? crypto.createHash('sha256').update(token).digest('hex').slice(0, 16) : '',
    updateCredentialStatus: updateToken ? 'configured' : 'missing',
    updateCheckUrl: String(payload.updateCheckUrl || '').trim(),
    updateDeviceId: String(payload.updateDeviceId || '').trim(),
    updateTokenFingerprint: updateToken ? crypto.createHash('sha256').update(updateToken).digest('hex').slice(0, 16) : '',
    uclawAccessToken: String(payload.uclawAccessToken || '').trim(),
    activatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(configDir, { recursive: true });
  safeWriteJson(activationStatePath, marker);
  writeDirtyMarker('activation');
  return marker;
}

/**
 * Allows local UI acceptance to proceed when an optional cloud endpoint is set
 * but not reachable. Production can opt out with UCLAW_ACTIVATION_REQUIRE_CLOUD.
 */
function canUseActivationStaticFallback() {
  return isDev && !UCLAW_ACTIVATION_REQUIRE_CLOUD;
}

/**
 * Persists and returns the static activation preview result used before the
 * real cloud redeem + privileged write-helper slice is enabled.
 */
function createStaticActivationResult(payload, message) {
  const activationState = writeActivationState({ ...payload, status: 'preview' });
  return {
    ok: true,
    code: ACTIVATION_STATIC_PREVIEW_COMPLETE,
    message: message || '首启登录流程已通过本地验证；真实激活服务接入后会写入授权材料。',
    phoneMasked: activationState.phoneMasked,
    activationPersisted: true,
    retryable: false,
  };
}

/**
 * Normalizes the legacy sales-issued first-start username for compatibility
 * with activation records created before phone login became the default.
 */
function normalizeActivationUsername(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 38);
}

/**
 * Creates a stable idempotency key so retrying the same first-start submission
 * can recover from network loss without consuming another activation.
 */
function createActivationIdempotencyKey({ account, activationCode, usbSummary }) {
  const source = [
    'uclaw-first-start-v1',
    account,
    activationCode.replace(/-/g, ''),
    usbSummary,
  ].join(':');
  return `electron-${crypto.createHash('sha256').update(source).digest('hex')}`;
}

/**
 * Parses Cloud API JSON and preserves enough HTTP context when a proxy or old
 * service returns plain text instead of the expected JSON envelope.
 */
function parseActivationResponseJSON(text, options = {}) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    const pathname = options.pathname || 'request';
    const status = options.status ? `HTTP ${options.status}` : 'HTTP unknown';
    const preview = String(text).replace(/\s+/g, ' ').trim().slice(0, 160) || 'empty response';
    throw new Error(`Cloud API ${pathname} 返回非 JSON 响应（${status}）：${preview}`);
  }
}

/**
 * Posts JSON to the Bavi-box activation service from the trusted main process.
 */
async function postActivationJSON(pathname, payload, options = {}) {
  const endpoint = String(options.endpoint || UCLAW_ACTIVATION_ENDPOINT).trim().replace(/\/+$/, '');
  if (!endpoint) {
    throw new Error('activation endpoint is not configured');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 12000);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;
    const response = await fetch(`${endpoint}${pathname}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload || {}),
      signal: controller.signal,
    });
    const text = await response.text();
    const data = parseActivationResponseJSON(text, { pathname, status: response.status });
    if (!response.ok) {
      throw new Error(data?.error?.message || data?.message || `activation request failed: ${response.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads authenticated JSON from the Bavi-box cloud service through Electron main.
 */
async function getActivationJSON(pathname, options = {}) {
  const endpoint = String(options.endpoint || UCLAW_ACTIVATION_ENDPOINT).trim().replace(/\/+$/, '');
  if (!endpoint) {
    throw new Error('activation endpoint is not configured');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 12000);
  try {
    const headers = {};
    if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;
    const response = await fetch(`${endpoint}${pathname}`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    const text = await response.text();
    const data = parseActivationResponseJSON(text, { pathname, status: response.status });
    if (!response.ok) {
      throw new Error(data?.error?.message || data?.message || `activation request failed: ${response.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches New API usage summary via Bavi-box cloud using the local activation token.
 */
async function getCloudModelUsageSummary() {
  const state = readJsonFile(activationStatePath);
  const endpoint = String(state?.activationEndpoint || UCLAW_ACTIVATION_ENDPOINT).trim().replace(/\/+$/, '');
  const accessToken = String(state?.uclawAccessToken || '').trim();
  if (!endpoint) {
    return { ok: false, message: 'activation endpoint is not configured' };
  }
  if (!accessToken) {
    return { ok: false, message: 'uclaw access token is not available' };
  }
  return getActivationJSON('/v1/newapi/usage/summary', { endpoint, accessToken });
}

/**
 * Fetches the New API model catalog via Bavi-box cloud using the activation token.
 */
async function getCloudModelCatalog() {
  const state = readJsonFile(activationStatePath);
  const endpoint = String(state?.activationEndpoint || UCLAW_ACTIVATION_ENDPOINT).trim().replace(/\/+$/, '');
  const accessToken = String(state?.uclawAccessToken || '').trim();
  if (!endpoint) {
    return { ok: false, message: 'activation endpoint is not configured', models: [] };
  }
  if (!accessToken) {
    return { ok: false, message: 'uclaw access token is not available', models: [] };
  }
  try {
    const catalog = await getActivationJSON('/v1/newapi/models/catalog', { endpoint, accessToken });
    return { ok: true, ...catalog, models: Array.isArray(catalog.models) ? catalog.models : [] };
  } catch (error) {
    return { ok: false, message: error?.message || String(error), models: [] };
  }
}

/**
 * Refreshes local OpenClaw provider config from the cloud model catalog.
 */
async function refreshCloudModelCatalog() {
  const catalog = await getCloudModelCatalog();
  if (!catalog.ok) return catalog;
  const currentConfig = fs.existsSync(configPath) ? getConfig() : applyRuntimeConfigEnv(loadBundledDefaultConfig());
  const merged = mergeModelCatalogIntoConfig(currentConfig, catalog);
  if (merged.changed) {
    saveConfig(merged.config);
  }
  return {
    ...catalog,
    merged: merged.changed,
    modelCount: merged.availableCount,
    syncedModelCount: merged.count,
    usedLocalCatalog: merged.usedLocalCatalog,
    message: merged.count > 0
      ? `已同步 ${merged.count} 个 New API 模型。`
      : merged.availableCount > 0
        ? `New API 本次未返回新模型，已保留本地 ${merged.availableCount} 个模型。`
        : 'New API 未返回可用模型。',
  };
}

/**
 * Best-effort model catalog sync after activation has persisted its access token.
 */
async function syncModelCatalogAfterActivation() {
  try {
    const result = await refreshCloudModelCatalog();
    if (!result.ok) {
      logLifecycle(`activation model catalog sync skipped: ${result.message || 'unknown error'}`);
      return { ok: false, message: result.message || '模型目录同步未完成' };
    }
    return { ok: true, modelCount: result.modelCount || 0, status: result.status || 'ok' };
  } catch (error) {
    logLifecycle(`activation model catalog sync failed: ${error.message}`);
    return { ok: false, message: error?.message || String(error) };
  }
}

/**
 * Fetches recharge plans from the Bavi-box cloud service for the in-app top-up dialog.
 */
async function getCloudRechargePlans() {
  const state = readJsonFile(activationStatePath);
  const endpoint = String(state?.activationEndpoint || UCLAW_ACTIVATION_ENDPOINT).trim().replace(/\/+$/, '');
  const accessToken = String(state?.uclawAccessToken || '').trim();
  if (!endpoint) {
    return { ok: false, message: 'activation endpoint is not configured', plans: [] };
  }
  if (!accessToken) {
    return { ok: false, message: 'uclaw access token is not available', plans: [] };
  }
  try {
    const result = await getActivationJSON('/v1/recharge/plans', { endpoint, accessToken });
    return { ok: true, plans: Array.isArray(result.plans) ? result.plans : [] };
  } catch (error) {
    return { ok: false, message: error?.message || String(error), plans: [] };
  }
}

/**
 * Fetches recent recharge orders for the model page records dialog.
 */
async function getCloudRechargeOrders() {
  const state = readJsonFile(activationStatePath);
  const endpoint = String(state?.activationEndpoint || UCLAW_ACTIVATION_ENDPOINT).trim().replace(/\/+$/, '');
  const accessToken = String(state?.uclawAccessToken || '').trim();
  if (!endpoint) {
    return { ok: false, message: 'activation endpoint is not configured', orders: [] };
  }
  if (!accessToken) {
    return { ok: false, message: 'uclaw access token is not available', orders: [] };
  }
  try {
    const result = await getActivationJSON('/v1/recharge/orders', { endpoint, accessToken });
    return { ok: true, orders: Array.isArray(result.orders) ? result.orders : [] };
  } catch (error) {
    return { ok: false, message: error?.message || String(error), orders: [] };
  }
}

/**
 * Creates a virtual recharge order and immediately simulates the local callback for UI validation.
 */
async function rechargeCloudModelQuota(payload = {}) {
  const state = readJsonFile(activationStatePath);
  const endpoint = String(state?.activationEndpoint || UCLAW_ACTIVATION_ENDPOINT).trim().replace(/\/+$/, '');
  const accessToken = String(state?.uclawAccessToken || '').trim();
  const planCode = String(payload.planCode || 'dev_10').trim();
  if (!endpoint) {
    return { ok: false, message: 'activation endpoint is not configured' };
  }
  if (!accessToken) {
    return { ok: false, message: 'uclaw access token is not available' };
  }
  if (!planCode) {
    return { ok: false, message: 'recharge plan is required' };
  }
  try {
    const created = await postActivationJSON('/v1/recharge/orders', {
      planCode,
      provider: 'virtual',
    }, { endpoint, accessToken });
    const orderNo = String(created?.order?.orderNo || '').trim();
    if (!orderNo) {
      throw new Error('recharge order response missing orderNo');
    }
    const callback = await postActivationJSON('/v1/payments/virtual/notify', {
      orderNo,
      providerEventId: `electron-${orderNo}-${Date.now()}`,
    }, { endpoint });
    const usage = await getCloudModelUsageSummary();
    return {
      ok: true,
      order: callback.order || created.order,
      usage,
      message: '虚拟充值成功，余额已刷新。',
    };
  } catch (error) {
    return { ok: false, message: error?.message || String(error) };
  }
}

/**
 * Writes New API credentials and default model selections into OpenClaw config.
 */
function writeOpenClawActivationConfig(result) {
  const baseUrl = String(result.newapiBaseUrl || '').replace(/\/+$/, '');
  const token = String(result.newapiToken || '').trim();
  if (!baseUrl || !token) {
    throw new Error('activation response missing New API config');
  }
  const config = fs.existsSync(configPath) ? getConfig() : applyRuntimeConfigEnv(loadBundledDefaultConfig());
  config.models = config.models || {};
  config.models.providers = config.models.providers || {};
  const templateProviders = loadBundledDefaultConfig().models?.providers || {};
  for (const providerName of ['custom', 'litellm']) {
    config.models.providers[providerName] = {
      ...(templateProviders[providerName] || {}),
      ...(config.models.providers[providerName] || {}),
      baseUrl,
      apiKey: token,
      api: 'openai-completions',
    };
  }
  config.models.providers.xai = {
    ...(templateProviders.xai || {}),
    ...(config.models.providers.xai || {}),
    baseUrl,
    apiKey: token,
    api: 'openai-completions',
  };
  delete config.models.providers.newapi;
  config.agents = config.agents || {};
  config.agents.defaults = config.agents.defaults || {};
  config.agents.defaults.model = { ...(config.agents.defaults.model || {}), primary: 'custom/gpt-5.5' };
  config.agents.defaults.imageGenerationModel = {
    ...(config.agents.defaults.imageGenerationModel || {}),
    primary: 'litellm/gpt-image-2',
    timeoutMs: Math.max(Number(config.agents.defaults.imageGenerationModel?.timeoutMs) || 0, 180000),
  };
  config.agents.defaults.imageModel = {
    ...(config.agents.defaults.imageModel || {}),
    primary: 'litellm/gpt-image-2',
    timeoutMs: Math.max(Number(config.agents.defaults.imageModel?.timeoutMs) || 0, 180000),
  };
  config.agents.defaults.videoGenerationModel = {
    ...(config.agents.defaults.videoGenerationModel || {}),
    primary: `xai/${UCLAW_VIDEO_MODEL}`,
    timeoutMs: Math.max(Number(config.agents.defaults.videoGenerationModel?.timeoutMs) || 0, 600000),
  };
  saveConfig(config);
}

/**
 * Writes and verifies the signed startup license returned by Bavi-box Cloud API.
 */
function writeActivationLicenseArtifact(result) {
  const activationID = String(result.activationId || '').trim();
  const artifact = result.licenseArtifact;
  if (!activationID) throw new Error('activation response missing activationId');
  if (artifact?.payload?.schemaVersion !== 'uclaw.license.v1') {
    throw new Error('activation response missing license payload');
  }
  if (artifact.payload.activationId !== activationID) {
    throw new Error('activation license activationId mismatch');
  }
  if (artifact?.signature?.algorithm !== 'Ed25519' || !artifact.signature.value) {
    throw new Error('activation response missing license signature');
  }
  const written = atomicWriteJson(activationLicensePath, artifact);
  if (written?.payload?.activationId !== activationID || written?.signature?.value !== artifact.signature.value) {
    throw new Error('activation license readback verification failed');
  }
  writeDirtyMarker('activation-license');
  return written;
}

/**
 * Persists the client New API credential separately from OpenClaw config so
 * support and later rotation code have a stable local contract.
 */
function writeBuiltinModelCredential(result) {
  const baseUrl = String(result.newapiBaseUrl || '').replace(/\/+$/, '');
  const token = String(result.newapiToken || '').trim();
  if (!baseUrl || !token) throw new Error('activation response missing model credential');
  const credential = {
    schemaVersion: 'uclaw.builtin-model-credential.v1',
    provider: 'newapi',
    baseUrl,
    token,
    tokenVersion: Number(result.tokenVersion) || 1,
    tokenFingerprint: crypto.createHash('sha256').update(token).digest('hex').slice(0, 16),
    defaultModels: result.defaultModels || {},
    issuedAt: new Date().toISOString(),
  };
  const written = atomicWriteJson(builtinModelCredentialPath, credential);
  if (written?.tokenFingerprint !== credential.tokenFingerprint) {
    throw new Error('builtin model credential readback verification failed');
  }
  writeDirtyMarker('builtin-model-credential');
  return written;
}

/**
 * Persists the hard-update credential used by launcher/bootstrap update checks.
 */
function writeUpdateCredential(result) {
  const source = result.updateCredential;
  if (!source) return null;
  const schemaVersion = String(source.schemaVersion || '').trim();
  const updateCheckUrl = String(source.updateCheckUrl || '').trim().replace(/\/+$/, '');
  const deviceId = String(source.deviceId || '').trim();
  const deviceToken = String(source.deviceToken || '').trim();
  if (schemaVersion !== 'uclaw.update-credential.v1') {
    throw new Error('activation response has invalid update credential schema');
  }
  if (!updateCheckUrl || !deviceId || !deviceToken) {
    throw new Error('activation response missing update credential');
  }
  const credential = {
    schemaVersion,
    updateCheckUrl,
    deviceId,
    deviceToken,
    platformKeys: Array.isArray(source.platformKeys) ? source.platformKeys.filter(Boolean) : [],
    tokenFingerprint: crypto.createHash('sha256').update(deviceToken).digest('hex').slice(0, 16),
    issuedAt: source.issuedAt || new Date().toISOString(),
  };
  const written = atomicWriteJson(updateCredentialPath, credential);
  if (written?.tokenFingerprint !== credential.tokenFingerprint || written?.deviceId !== deviceId) {
    throw new Error('update credential readback verification failed');
  }
  writeDirtyMarker('update-credential');
  return written;
}

function extractSessionKeyFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const session = url.searchParams.get('session');
    if (session?.trim()) return session.trim();
  } catch {}
  return '';
}

function dashboardUrl() {
  const token = getToken();
  const activeSessionKey = readActiveSessionKey();
  const sessionSearch = activeSessionKey ? `?session=${encodeURIComponent(activeSessionKey)}` : '';
  const routePath = activeSessionKey ? '/chat' : '/';
  return `http://127.0.0.1:${gatewayPort}${routePath}${sessionSearch}#token=${token}`;
}

function normalizePortableDataPathString(value) {
  if (!portablePath || typeof value !== 'string') return value;
  return value
    .replace(/~[\\/]Library[\\/]Caches[\\/]U-Claw[\\/]usb-portable[\\/]data/g, userDataPath)
    .replace(/~[\\/]Library[\\/]Caches[\\/]Bavi-box[\\/]usb-portable[\\/]data/g, userDataPath)
    .replace(/(?:[A-Za-z]:)?[\\/](?:Users|home)[^"'\r\n]*?[\\/]Library[\\/]Caches[\\/]U-Claw[\\/]usb-portable(?:-[^\\/:"'\r\n]+)?[\\/]data/g, userDataPath)
    .replace(/(?:[A-Za-z]:)?[\\/](?:Users|home)[^"'\r\n]*?[\\/]Library[\\/]Caches[\\/]Bavi-box[\\/]usb-portable(?:-[^\\/:"'\r\n]+)?[\\/]data/g, userDataPath)
    .replace(/[A-Za-z]:[\\/](?:Users|home)[^"'\r\n]*?[\\/]AppData[\\/]Local[\\/]U-Claw[\\/]usb-portable[\\/]data-[^\\/:"'\r\n]+/g, userDataPath)
    .replace(/[A-Za-z]:[\\/](?:Users|home)[^"'\r\n]*?[\\/]AppData[\\/]Local[\\/]Bavi-box[\\/]usb-portable[\\/]data-[^\\/:"'\r\n]+/g, userDataPath)
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

function extractPortableSessionId(value) {
  const match = String(value || '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match ? match[0] : '';
}

function portableSessionArtifactSuffix(fileName) {
  const value = String(fileName || '');
  if (/\.trajectory-path\.json$/i.test(value)) return '.trajectory-path.json';
  if (/\.trajectory\.jsonl$/i.test(value)) return '.trajectory.jsonl';
  if (/\.jsonl(?:\.bak-\d+-\d+)?$/i.test(value)) return '.jsonl';
  return '';
}

function isPollutedPortableSessionFileName(fileName) {
  const value = String(fileName || '');
  return /[A-Za-z]:\\/.test(value) || value.includes('\\.openclaw\\') || value.includes('\\agents\\');
}

function mergeJsonlFile(targetPath, sourcePath) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  if (!source.trim()) return false;

  if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size === 0) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, source.endsWith('\n') ? source : `${source}\n`);
    return true;
  }

  const existingLines = new Set(fs.readFileSync(targetPath, 'utf8').split(/\r?\n/).filter(Boolean));
  const missingLines = source.split(/\r?\n/).filter(line => line && !existingLines.has(line));
  if (missingLines.length === 0) return false;
  fs.appendFileSync(targetPath, `${missingLines.join('\n')}\n`);
  return true;
}

function writePortableTrajectoryPointer(sessionsDir, sessionId) {
  const pointerPath = path.join(sessionsDir, `${sessionId}.trajectory-path.json`);
  const runtimeFile = path.join(sessionsDir, `${sessionId}.trajectory.jsonl`);
  const nextPointer = {
    traceSchema: 'openclaw-trajectory-pointer',
    schemaVersion: 1,
    sessionId,
    runtimeFile
  };
  const current = readJsonFile(pointerPath);
  if (JSON.stringify(current) === JSON.stringify(nextPointer)) return false;
  safeWriteJson(pointerPath, nextPointer);
  return true;
}

function migratePortableSessionArtifacts(sessionsDir, sessionId) {
  if (!sessionId || !fs.existsSync(sessionsDir)) return { changed: false, removed: 0 };

  let changed = false;
  let removed = 0;
  const entries = fs.readdirSync(sessionsDir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name);

  for (const fileName of entries) {
    if (!isPollutedPortableSessionFileName(fileName)) continue;
    if (extractPortableSessionId(fileName) !== sessionId) continue;
    const suffix = portableSessionArtifactSuffix(fileName);
    if (!suffix) continue;

    const sourcePath = path.join(sessionsDir, fileName);
    const targetPath = path.join(sessionsDir, `${sessionId}${suffix}`);
    try {
      if (suffix.endsWith('.jsonl')) changed = mergeJsonlFile(targetPath, sourcePath) || changed;
      if (suffix === '.trajectory-path.json') changed = writePortableTrajectoryPointer(sessionsDir, sessionId) || changed;
      if (fs.existsSync(targetPath)) {
        fs.rmSync(sourcePath, { force: true });
        removed += 1;
      }
    } catch (error) {
      console.warn(`[${APP_NAME}] Failed to migrate portable session artifact ${sourcePath}: ${error.message}`);
    }
  }

  changed = writePortableTrajectoryPointer(sessionsDir, sessionId) || changed;
  return { changed, removed };
}

function sanitizePortableSessionsIndex() {
  const agentsDir = path.join(configDir, 'agents');
  if (!fs.existsSync(agentsDir)) return { changedFiles: 0, removedFiles: 0 };

  let changedFiles = 0;
  let removedFiles = 0;
  for (const agentEntry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!agentEntry.isDirectory()) continue;
    const sessionsDir = path.join(agentsDir, agentEntry.name, 'sessions');
    const sessionsIndexPath = path.join(sessionsDir, 'sessions.json');
    const sessions = readJsonFile(sessionsIndexPath);
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) continue;

    let changed = false;
    for (const [sessionKey, session] of Object.entries(sessions)) {
      if (!session || typeof session !== 'object') continue;
      const sessionId = extractPortableSessionId(session.sessionId) || extractPortableSessionId(session.sessionFile);
      if (!sessionId) continue;

      const artifactStats = migratePortableSessionArtifacts(sessionsDir, sessionId);
      changed = artifactStats.changed || artifactStats.removed > 0 || changed;
      removedFiles += artifactStats.removed;

      const canonicalSessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
      if (session.sessionFile !== canonicalSessionFile) {
        session.sessionFile = canonicalSessionFile;
        changed = true;
      }

      if (sessionKey.startsWith('agent:') && sessionKey.split(':')[1] !== agentEntry.name) {
        continue;
      }
    }

    if (changed) {
      safeWriteJson(sessionsIndexPath, sessions);
      changedFiles += 1;
    }
  }

  return { changedFiles, removedFiles };
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
  const sessionsStats = sanitizePortableSessionsIndex();
  changedFiles += sessionsStats.changedFiles;
  if (changedFiles > 0) {
    console.log(`[${APP_NAME}] Migrated portable state paths in ${changedFiles} file(s), removed ${sessionsStats.removedFiles} polluted session artifact(s)`);
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

/**
 * Detects NewAPI-compatible Bavi-box cloud endpoints used across old configs.
 */
function isKnownNewApiBaseUrl(baseUrl) {
  return /(?:api\.gmnlee\.com|api\.yiyong\.me)/i.test(String(baseUrl || ''));
}

function findNewApiCredentials(config) {
  const env = config.env || {};
  const envBaseUrl = process.env.UCLAW_NEW_API_BASE_URL || env.UCLAW_NEW_API_BASE_URL;
  const envApiKey = process.env.UCLAW_NEW_API_KEY || env.UCLAW_NEW_API_KEY;
  if (envBaseUrl || envApiKey) {
    return { newApiBaseUrl: envBaseUrl, newApiKey: envApiKey };
  }

  const providers = config.models?.providers || {};
  for (const [providerName, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== 'object') continue;
    const baseUrl = getProviderValue(provider, ['baseUrl', 'baseURL', 'base_url', 'apiBaseUrl', 'api_base_url']);
    const apiKey = getProviderValue(provider, ['apiKey', 'api_key', 'key']);
    if (baseUrl && apiKey && (providerName === 'newapi' || isKnownNewApiBaseUrl(baseUrl))) {
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
  const targetProviders = targetConfig.models?.providers || {};
  let changed = false;
  const sourceNewApi = findNewApiCredentials(sourceConfig);
  if (sourceNewApi.newApiKey || sourceNewApi.newApiBaseUrl) {
    targetConfig.models = targetConfig.models || {};
    targetConfig.models.providers = targetConfig.models.providers || {};
    targetConfig.models.providers.newapi = targetProviders.newapi || {};
    if (sourceNewApi.newApiKey && !getProviderValue(targetConfig.models.providers.newapi, ['apiKey', 'api_key', 'key'])) {
      targetConfig.models.providers.newapi.apiKey = sourceNewApi.newApiKey;
      changed = true;
    }
    if (sourceNewApi.newApiBaseUrl && !getProviderValue(targetConfig.models.providers.newapi, ['baseUrl', 'baseURL', 'base_url', 'apiBaseUrl', 'api_base_url'])) {
      targetConfig.models.providers.newapi.baseUrl = sourceNewApi.newApiBaseUrl;
      changed = true;
    }
  }

  if (changed) {
    saveConfig(targetConfig);
    console.log(`[${APP_NAME}] Synced dev New API credentials from desktop config`);
  }
}

/**
 * Normalizes persisted model metadata without changing OpenClaw provider routes.
 */
function normalizeRoutedModelProviderConfig() {
  const config = getConfig();
  const before = JSON.stringify(config);
  config.models = config.models || {};
  config.models.providers = config.models.providers || {};
  const providers = config.models.providers;
  const newApiCredentials = findNewApiCredentials(config);
  const templateProviders = loadBundledDefaultConfig().models?.providers || {};
  for (const providerName of ['custom', 'litellm', 'xai']) {
    providers[providerName] = {
      ...(templateProviders[providerName] || {}),
      ...(providers[providerName] || {}),
      api: providers[providerName]?.api || 'openai-completions',
    };
    if (newApiCredentials.newApiBaseUrl && !providers[providerName].baseUrl) {
      providers[providerName].baseUrl = newApiCredentials.newApiBaseUrl;
    }
    if (newApiCredentials.newApiKey && !providers[providerName].apiKey) {
      providers[providerName].apiKey = newApiCredentials.newApiKey;
    }
  }
  delete providers.newapi;
  if (JSON.stringify(config) !== before) {
    saveConfig(config);
    console.log(`[${APP_NAME}] Normalized routed model provider config`);
  }
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
            writeDirtyMarker('config-server');
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
            mainWindow.loadURL(dashboardUrl());
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
      configServer = server;
      configServerPort = server.address().port;
      console.log(`[${APP_NAME}] Config server on http://127.0.0.1:${configServerPort}`);
      resolve(configServerPort);
    });
  });
}

function stopConfigServer() {
  if (!configServer) return Promise.resolve();

  const serverToStop = configServer;
  configServer = null;
  configServerPort = null;
  logLifecycle('Stopping config server...');
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    serverToStop.close(finish);
    setTimeout(finish, 2000);
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

function stripSystemProxyEnv(baseEnv) {
  if (UCLAW_INHERIT_SYSTEM_PROXY) return baseEnv;

  const nextEnv = { ...baseEnv };
  let stripped = false;
  for (const key of SYSTEM_PROXY_ENV_KEYS) {
    if (nextEnv[key]) stripped = true;
    delete nextEnv[key];
  }
  if (stripped) {
    logLifecycle('System proxy env stripped for gateway; set UCLAW_INHERIT_SYSTEM_PROXY=1 to keep shell proxy env.');
  }
  return nextEnv;
}

// ── Gateway Management ──
function parseGatewayStartupRetryAt(message) {
  const match = String(message || '').match(/startup migrations are already running[\s\S]*?\bafter\s+([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z)/i);
  if (!match) return null;
  const retryAt = Date.parse(match[1]);
  return Number.isFinite(retryAt) ? retryAt : null;
}

function taskkillProcessTree(pid, force = false) {
  if (process.platform !== 'win32' || !pid) return;
  const args = ['/PID', String(pid), '/T'];
  if (force) args.push('/F');
  try {
    spawn('taskkill', args, {
      stdio: 'ignore',
      windowsHide: true,
    }).on('error', () => {});
  } catch {}
}

function startGateway(port) {
  return new Promise((resolve, reject) => {
    gatewayStopping = false;
    logLifecycle(`Starting OpenClaw gateway on port ${port}...`);
    const startTime = Date.now();
    let settled = false;
    let migrationRetryAt = null;

    const nodeBin = getNodeBin();
    logLifecycle(`Using Node.js: ${nodeBin}`);

    // Persist the V8 compile cache to a fixed local dir under userData so the
    // gateway's heavy first-run compile is paid only once. userDataPath is stable
    // across launches even for the portable exe (which self-extracts to a random
    // temp dir each time), so the cache survives and subsequent starts are fast.
    const compileCacheDir = path.join(userDataPath, '.cache', 'v8-compile-cache');
    try { fs.mkdirSync(compileCacheDir, { recursive: true }); } catch {}
    const mediaPreviewRoots = [
      process.env.UCLAW_MEDIA_PREVIEW_ROOTS,
      path.join(configDir, 'media'),
      usbDataPath ? path.join(usbDataPath, '.openclaw', 'media') : '',
    ].filter(Boolean).join(path.delimiter);

    const env = stripSystemProxyEnv(portableChildHomeEnv({
      ...process.env,
      OPENCLAW_HOME: userDataPath,
      OPENCLAW_STATE_DIR: configDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_EMBEDDED_IN: APP_NAME,
      NODE_COMPILE_CACHE: compileCacheDir,
      UCLAW_MEDIA_PREVIEW_ROOTS: mediaPreviewRoots,
    }));

    if (process.platform === 'win32') {
      env.OPENCLAW_DISABLE_BONJOUR = '1';
    }

    const processToStart = spawn(nodeBin, [
      openclawEntry,
      'gateway', 'run',
      '--allow-unconfigured',
      '--force',
      '--port', String(port),
    ], {
      env,
      cwd: openclawPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    gatewayProcess = processToStart;

    processToStart.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) {
        console.log(`[OpenClaw] ${msg}`);
        appendLogFile('gateway.log', msg);
      }
    });

    processToStart.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) {
        console.error(`[OpenClaw:err] ${msg}`);
        appendLogFile('gateway.log', `ERR ${msg}`);
        const retryAt = parseGatewayStartupRetryAt(msg);
        if (retryAt) migrationRetryAt = Math.max(migrationRetryAt || 0, retryAt);
      }
    });

    processToStart.on('error', (err) => {
      logLifecycle(`Gateway process error: ${err.message}`);
      reject(err);
    });

    processToStart.on('exit', (code, signal) => {
      logLifecycle(`Gateway exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`);
      if (gatewayProcess === processToStart) gatewayProcess = null;
      gatewayReady = false;
      if (!settled && migrationRetryAt && !gatewayStopping && !appIsQuitting) {
        settled = true;
        const delay = Math.max(1000, migrationRetryAt - Date.now() + 2000);
        logLifecycle(`Gateway startup migration lock active; retrying in ${Math.ceil(delay / 1000)}s.`);
        setTimeout(() => {
          if (appIsQuitting) {
            reject(new Error('Gateway startup cancelled'));
            return;
          }
          startGateway(port).then(resolve, reject);
        }, delay);
        return;
      }
      if (!gatewayStopping && !appIsQuitting) {
        scheduleGatewayRestart(`exit code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      }
    });

    // Poll for gateway readiness
    const checkReady = () => {
      if (settled) return;
      if (gatewayReady) {
        settled = true;
        resolve(gatewayPort);
        return;
      }

      if (Date.now() - startTime > GATEWAY_STARTUP_TIMEOUT) {
        settled = true;
        gatewayStopping = true;
        if (gatewayProcess === processToStart) processToStart.kill('SIGTERM');
        reject(new Error('Gateway startup timeout'));
        return;
      }

      const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
        if (settled) return;
        settled = true;
        gatewayReady = true;
        gatewayPort = port;
        gatewayRestartAttempts = 0;
        logLifecycle(`Gateway ready on port ${port}`);
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

function scheduleGatewayRestart(reason) {
  if (gatewayRestartTimer || appIsQuitting) return;
  gatewayRestartAttempts += 1;
  const delay = Math.min(30000, 1000 * (2 ** Math.min(gatewayRestartAttempts - 1, 5)));
  logLifecycle(`Gateway restart scheduled in ${delay}ms (${reason})`);
  gatewayRestartTimer = setTimeout(async () => {
    gatewayRestartTimer = null;
    if (appIsQuitting || gatewayProcess) return;
    try {
      const port = await findAvailablePort();
      await startGateway(port);
      loadAppPage();
    } catch (error) {
      logLifecycle(`Gateway restart failed: ${error.message}`);
      scheduleGatewayRestart(error.message);
    }
  }, delay);
}

function stopGateway() {
  gatewayStopping = true;
  if (gatewayRestartTimer) {
    clearTimeout(gatewayRestartTimer);
    gatewayRestartTimer = null;
  }
  if (!gatewayProcess) return Promise.resolve();

  const processToStop = gatewayProcess;
  logLifecycle('Stopping gateway...');
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    processToStop.once('exit', finish);
    taskkillProcessTree(processToStop.pid);
    try { processToStop.kill('SIGTERM'); } catch {}
    setTimeout(() => {
      if (!settled && gatewayProcess === processToStop) {
        logLifecycle('Gateway did not stop after SIGTERM; sending SIGKILL');
        taskkillProcessTree(processToStop.pid, true);
        try { processToStop.kill('SIGKILL'); } catch {}
      }
    }, 5000);
    setTimeout(finish, 6500);
  });
}

// ── Activation-only Mode ──
/**
 * Builds the sanitized startup snapshot exposed to the activation renderer.
 * Launcher-owned hardware data must be passed in via env/argv; never infer or
 * expose full USB descriptors from the Electron page.
 */
function getActivationPreflight() {
  const usbSummary = (process.env.UCLAW_USB_FINGERPRINT_SUMMARY || '').trim();
  const usbLabel = (process.env.UCLAW_USB_LABEL || '').trim();
  const usbStatus = usbSummary ? 'pass' : 'preview';

  return {
    mode: 'activation-only',
    appVersion: installedReleaseInfo.version,
    appReleaseId: installedReleaseInfo.releaseId,
    platform: process.platform,
    arch: process.arch,
    activationEndpointConfigured: Boolean(UCLAW_ACTIVATION_ENDPOINT),
    usb: {
      label: usbLabel || '静态预览产品盘（未读取真实 U 盘）',
      summary: usbSummary || 'PREVIEW-ONLY',
      status: usbStatus,
    },
    checks: [
      {
        id: 'os',
        label: '操作系统与架构',
        status: 'pass',
        detail: `${process.platform} · ${process.arch}`,
      },
      {
        id: 'runtime',
        label: '受信客户端 runtime',
        status: 'pass',
        detail: app.isPackaged ? '已由当前客户端加载' : '开发模式客户端',
      },
      {
        id: 'usb',
        label: 'U 盘身份与数据目录',
        status: usbStatus,
        detail: usbSummary ? `设备标识摘要 ${usbSummary}` : '静态预览：未读取真实 USB 指纹',
      },
      {
        id: 'gateway',
        label: 'Gateway 启动条件',
        status: 'preview',
        detail: '静态预览：正式授权通过后再启动 OpenClaw Gateway',
      },
    ],
  };
}

/**
 * Handles SMS requests for the first-login activation page. The local dev code
 * keeps the renderer flow testable until Aliyun SMS is wired behind this seam.
 */
async function sendActivationSMS(payload = {}) {
  const phone = String(payload.phone || '').trim();
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return { ok: false, message: '请输入有效的手机号。', retryable: true };
  }
  if (UCLAW_ACTIVATION_ENDPOINT) {
    try {
      const result = await postActivationJSON('/v1/auth/sms/send', { phone, purpose: 'login' });
      return {
        ok: true,
        status: result.status || 'sent',
        devCode: result.devCode || '',
        message: result.devCode ? `验证码为 ${result.devCode}。` : '验证码已发送。',
      };
    } catch (error) {
      if (!canUseActivationStaticFallback()) throw error;
      logLifecycle(`activation cloud sms fallback: ${error.message}`);
    }
  }
  return {
    ok: true,
    status: 'sent',
    devCode: isDev ? '123456' : '',
    message: isDev ? '验证码已发送，开发环境验证码为 123456。' : '验证码已发送。',
  };
}

/**
 * Handles first-start activation. The current release uses a real phone number
 * plus a fixed SMS code while Aliyun SMS delivery is pending approval.
 */
async function submitActivation(payload = {}) {
  const phone = String(payload.phone || '').trim();
  const smsCode = String(payload.smsCode || '').trim();
  const username = normalizeActivationUsername(payload.username);
  const activationCode = String(payload.activationCode || '').trim().toUpperCase();
  if (phone && !/^1[3-9]\d{9}$/.test(phone)) {
    return { ok: false, message: '请输入有效的手机号。', retryable: true };
  }
  if (phone && !/^\d{6}$/.test(smsCode)) {
    return { ok: false, message: '请输入 6 位验证码。', retryable: true };
  }
  if (!phone && !/^UCLAW-[A-Z0-9]{6,32}$/.test(username)) {
    return { ok: false, message: '请输入手机号，或提供兼容用户名。', retryable: true };
  }
  if (!/^(?:[A-Z0-9]{4}(?:-[A-Z0-9]{4}){2,5}|[A-Z0-9]{5}(?:-[A-Z0-9]{5}){3}-[A-Z0-9]{6})$/.test(activationCode)) {
    return { ok: false, message: '激活码格式不正确。', retryable: true };
  }
  if (UCLAW_ACTIVATION_ENDPOINT) {
    let serverBound = false;
    try {
      const usbSummary = process.env.UCLAW_USB_FINGERPRINT_SUMMARY || 'PREVIEW-ONLY';
      const activationAccount = phone || username;
      const activationResult = await postActivationJSON('/v1/activations', {
        phone,
        smsCode,
        username,
        activationCode,
        usbFingerprintSummary: usbSummary,
        idempotencyKey: createActivationIdempotencyKey({ account: activationAccount, activationCode, usbSummary }),
      });
      serverBound = true;
      writeActivationLicenseArtifact(activationResult);
      writeBuiltinModelCredential(activationResult);
      const updateCredential = writeUpdateCredential(activationResult);
      writeOpenClawActivationConfig(activationResult);
      const activationID = String(activationResult.activationId || '').trim();
      const commitResult = await postActivationJSON(`/v1/activations/${activationID}/commit`, {
        writeStatus: 'verified',
      });
      const activationState = writeActivationState({
        phone,
        username,
        activationCode,
        source: 'cloud-first-start',
        phoneMasked: activationResult.phoneMasked,
        usernameMasked: activationResult.usernameMasked,
        activationId: activationID,
        artifactStatus: activationResult.artifactStatus,
        commitStatus: commitResult.status || 'committed',
        newapiBaseUrl: activationResult.newapiBaseUrl,
        newapiToken: activationResult.newapiToken,
        tokenVersion: activationResult.tokenVersion,
        updateCheckUrl: updateCredential?.updateCheckUrl,
        updateDeviceId: updateCredential?.deviceId,
        updateDeviceToken: updateCredential?.deviceToken,
        uclawAccessToken: activationResult.accessToken,
      });
      const modelCatalogSync = await syncModelCatalogAfterActivation();
      const activationUsbSync = syncActivationMaterialToUsb();
      setTimeout(() => {
        requestAppQuit({ confirm: false, exitCode: ACTIVATION_RESTART_EXIT_CODE, showShutdownPage: false })
          .catch(error => logLifecycle(`Activation restart request failed: ${error.message}`));
      }, 250);
      return {
        ok: true,
        code: 'ACTIVATION_CLOUD_COMPLETE',
        message: modelCatalogSync.ok
          ? '激活完成，授权材料、New API 配置与模型目录已写入本地。'
          : '激活完成，授权材料与 New API 配置已写入本地；模型目录可稍后在模型页同步。',
        phoneMasked: activationState.phoneMasked || activationState.accountMasked,
        usernameMasked: activationState.usernameMasked,
        activationPersisted: true,
        activationId: activationID,
        commitStatus: commitResult.status || 'committed',
        modelCatalogSync,
        activationUsbSync,
        restartRequired: true,
        launchReady: false,
        retryable: false,
      };
    } catch (error) {
      if (serverBound || !canUseActivationStaticFallback()) throw error;
      logLifecycle(`activation cloud submit fallback: ${error.message}`);
      return createStaticActivationResult({ phone, username, activationCode }, '激活服务未连通，已进入本地静态验收完成态。');
    }
  }
  return createStaticActivationResult({ phone, username, activationCode });
}

/**
 * Starts the normal Bavi-box runtime after activation files are verified.
 * Keeping the transition inside the same app avoids the visible close/reopen
 * gap that made first activation look like a failed launch.
 */
async function launchMainAfterActivation() {
  if (!hasCompletedActivation()) {
    return { ok: false, message: '授权材料尚未写入，请先完成激活。' };
  }
  try {
    await startNormalApplication({ replaceActivationWindow: true });
    return { ok: true, status: 'launched' };
  } catch (error) {
    logLifecycle(`Activation launch-main failed: ${error.message}`);
    return { ok: false, message: `进入主界面失败：${error.message}` };
  }
}

/**
 * Registers only the activation IPC surface. Do not add normal dashboard,
 * config, Gateway, file, or OpenClaw handlers here.
 */
function setupActivationIPC() {
  ipcMain.handle('activation:get-preflight', () => getActivationPreflight());
  ipcMain.handle('activation:send-sms', (_event, payload) => sendActivationSMS(payload));
  ipcMain.handle('activation:submit', (_event, payload) => submitActivation(payload));
  ipcMain.handle('activation:launch-main', () => launchMainAfterActivation());
  ipcMain.handle('activation:complete', () => launchMainAfterActivation());
  ipcMain.handle('activation:window-action', (_event, action) => {
    if (!mainWindow) return { ok: false };
    if (action === 'minimize') mainWindow.minimize();
    if (action === 'maximize') {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    }
    if (action === 'close') mainWindow.close();
    return { ok: true };
  });
}

/**
 * Loads the repository-owned activation page without starting Gateway or the
 * Config.html server.
 */
function loadActivationPage() {
  if (!mainWindow) return;
  const load = mainWindow.loadFile(path.join(__dirname, 'activation.html'));
  Promise.resolve(load)
    .then(() => revealMainWindow())
    .catch(error => logLifecycle(`Failed to load activation page: ${error.message}`));
}

// ── Window Management ──
function persistMainWindowSession() {
  if (!mainWindow) return;
  const sessionKey = extractSessionKeyFromUrl(mainWindow.webContents.getURL());
  if (sessionKey) persistActiveSessionKey(sessionKey);
}

/**
 * Creates the main Electron window. In activation-only mode it uses frameless
 * chrome so the high-fidelity startup page owns its titlebar controls.
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: activationWindowMode ? 960 : 1200,
    height: activationWindowMode ? 760 : 800,
    minWidth: activationWindowMode ? 720 : 800,
    minHeight: activationWindowMode ? 620 : 600,
    title: `${APP_NAME} ${visibleAppVersion()}`,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    frame: !activationWindowMode,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: activationWindowMode ? [ACTIVATION_ONLY_ARG] : [],
    },
    show: false,
    backgroundColor: activationWindowMode ? '#f1f5f9' : '#0a0a0a',
  });

  if (process.platform === 'win32') {
    // Remove the native menu bar entirely on Windows; auto-hide can reappear via Alt.
    mainWindow.setMenu(null);
  }

  mainWindow.once('ready-to-show', () => {
    if (activationWindowMode || !holdMainWindowUntilReady || gatewayReady || appIsQuitting) {
      mainWindow.show();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('did-navigate', persistMainWindowSession);
  mainWindow.webContents.on('did-navigate-in-page', persistMainWindowSession);

  mainWindow.on('close', (event) => {
    if (appIsQuitting) return;
    event.preventDefault();
    requestAppQuit().catch(error => logLifecycle(`Quit request error: ${error.message}`));
  });

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (activationWindowMode) {
    loadActivationPage();
  } else {
    loadAppPage();
  }
}

function loadAppPage() {
  if (!mainWindow) return;

  if (gatewayReady) {
    const load = mainWindow.loadURL(dashboardUrl());
    Promise.resolve(load)
      .then(() => revealMainWindow())
      .catch(error => logLifecycle(`Failed to load dashboard: ${error.message}`));
  } else {
    const loadingHtml = path.join(__dirname, 'loading.html');
    const load = mainWindow.loadFile(loadingHtml);
    Promise.resolve(load)
      .then(() => {
        if (!holdMainWindowUntilReady) {
          revealMainWindow();
          return;
        }
        setTimeout(() => {
          if (!gatewayReady && !appIsQuitting) revealMainWindow();
        }, 2000);
      })
      .catch(error => logLifecycle(`Failed to load loading page: ${error.message}`));
  }
}

function loadConfigPage() {
  if (!mainWindow || !gatewayReady || !configServerPort) return;
  const load = mainWindow.loadURL(getConfigURL());
  Promise.resolve(load)
    .then(() => revealMainWindow())
    .catch(error => logLifecycle(`Failed to load config page: ${error.message}`));
}

function revealMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

async function loadShutdownPage() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const shutdownHtml = path.join(__dirname, 'shutdown.html');
  try {
    await mainWindow.loadFile(shutdownHtml);
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  } catch (error) {
    logLifecycle(`Failed to load shutdown page: ${error.message}`);
  }
}

async function confirmAppQuit() {
  if (quitConfirmationOpen) return false;
  quitConfirmationOpen = true;
  try {
    const options = {
      type: 'warning',
      title: `退出 ${APP_NAME}?`,
      message: `退出 ${APP_NAME}?`,
      detail: '将安全停止本地服务、清理运行进程，并把运行数据同步回 U 盘。',
      buttons: ['取消', '退出'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const result = mainWindow
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    return result.response === 1;
  } finally {
    quitConfirmationOpen = false;
  }
}

async function requestAppQuit({ confirm = true, exitCode = 0, showShutdownPage = true } = {}) {
  if (shutdownPromise) return shutdownPromise;
  if (confirm && !(await confirmAppQuit())) return null;

  requestedExitCode = exitCode;
  appIsQuitting = true;
  logLifecycle('Shutdown requested');
  persistMainWindowSession();
  if (showShutdownPage) {
    await loadShutdownPage();
    await new Promise(resolve => setTimeout(resolve, 150));
  }

  return shutdownApp()
    .catch(error => logLifecycle(`Shutdown error: ${error.message}`))
    .finally(() => app.exit(requestedExitCode));
}

// ── Menu ──
/**
 * Creates a minimal activation menu with no dashboard/config/data-folder entry.
 */
function createActivationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: APP_NAME,
      submenu: [
        { label: `About ${APP_NAME}`, role: 'about' },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
  ]));
}

/**
 * Creates the normal application menu. Activation-only mode uses a separate,
 * smaller menu so users cannot navigate to normal app capabilities.
 */
function createMenu() {
  if (process.platform === 'win32') {
    // Windows renders this menu inside the app chrome; remove it entirely.
    Menu.setApplicationMenu(null);
    return;
  }

  if (activationWindowMode) {
    createActivationMenu();
    return;
  }

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
              mainWindow.loadURL(dashboardUrl());
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Open Data Folder',
          click: () => shell.openPath(userDataPath)
        },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            requestAppQuit().catch(error => logLifecycle(`Quit request error: ${error.message}`));
          }
        }
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
    appVersion: installedReleaseInfo.version,
    appReleaseId: installedReleaseInfo.releaseId,
  }));

  ipcMain.handle('open-dashboard', () => {
    if (mainWindow && gatewayReady) {
      mainWindow.loadURL(dashboardUrl());
    }
  });

  ipcMain.handle('open-config', () => loadConfigPage());
  ipcMain.handle('uclaw:get-model-usage-summary', () => getCloudModelUsageSummary());
  ipcMain.handle('uclaw:get-model-catalog', () => getCloudModelCatalog());
  ipcMain.handle('uclaw:refresh-model-catalog', () => refreshCloudModelCatalog());
  ipcMain.handle('uclaw:get-recharge-plans', () => getCloudRechargePlans());
  ipcMain.handle('uclaw:get-recharge-orders', () => getCloudRechargeOrders());
  ipcMain.handle('uclaw:recharge-model-quota', (_event, payload) => rechargeCloudModelQuota(payload));
}

// ── App Lifecycle ──
/**
 * Boots the normal OpenClaw runtime and routes the window to dashboard/config.
 * Activation mode uses this after local license material is written.
 */
async function startNormalApplication({ replaceActivationWindow = false } = {}) {
  if (normalStartupPromise) return normalStartupPromise;

  normalStartupPromise = (async () => {
    activationWindowMode = false;
    delete process.env.UCLAW_ACTIVATION_ONLY;

    if (replaceActivationWindow && mainWindow && !mainWindow.isDestroyed()) {
      const activationWindow = mainWindow;
      mainWindow = null;
      suppressWindowAllClosedQuit = true;
      activationWindow.removeAllListeners('close');
      activationWindow.once('closed', () => {
        setImmediate(() => {
          suppressWindowAllClosedQuit = false;
        });
      });
      activationWindow.destroy();
    }

    ensureConfig();
    startPortableSyncTimer();
    syncDevNewApiCredentialsFromDesktop();
    sanitizePortableStatePaths();
    startUpdateShutdownWatcher();
    writeRunState('starting');
    createMenu();
    if (!normalIPCRegistered) {
      setupIPC();
      normalIPCRegistered = true;
    }
    createWindow();

    await startConfigServer();

    try {
      normalizeRoutedModelProviderConfig();

      const port = await findAvailablePort();
      await startGateway(port);
      writeRunState('gateway-ready');

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
      throw err;
    }
  })().catch((error) => {
    normalStartupPromise = null;
    throw error;
  });

  return normalStartupPromise;
}

app.whenReady().then(async () => {
  logLifecycle(`v${app.getVersion()} starting...`);

  if (isActivationOnlyMode) {
    console.log(`[${APP_NAME}] Activation-only mode starting...`);
    activationWindowMode = true;
    createMenu();
    setupActivationIPC();
    createWindow();
    return;
  }

  if (shouldShowActivationOnStartup()) {
    console.log(`[${APP_NAME}] Activation gate starting...`);
    activationWindowMode = true;
    createMenu();
    setupActivationIPC();
    createWindow();
    return;
  }

  await startNormalApplication();
});

function shutdownApp() {
  if (shutdownPromise) return shutdownPromise;
  appIsQuitting = true;
  shutdownPromise = (async () => {
    logLifecycle('Shutdown started');
    stopUpdateShutdownWatcher();
    writeRunState('stopping');
    await finalPortableDataSync('before-stop');
    await stopGateway();
    await stopConfigServer();
    await finalPortableDataSync('after-stop');
    writeShutdownComplete();
    writeRunState('shutdown-complete');
    logLifecycle('Shutdown complete');
  })();
  return shutdownPromise;
}

app.on('window-all-closed', () => {
  if (suppressWindowAllClosedQuit) return;
  app.quit();
});

app.on('before-quit', (event) => {
  if (appIsQuitting && portableFinalSyncDone) return;
  event.preventDefault();
  requestAppQuit({ confirm: false, exitCode: requestedExitCode })
    .catch(error => logLifecycle(`Quit request error: ${error.message}`));
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
