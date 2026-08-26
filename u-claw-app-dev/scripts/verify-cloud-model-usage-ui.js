#!/usr/bin/env node

/**
 * Runs a local Cloud API + New API + Electron UI check for the model usage page.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '..');
const cloudRoot = path.join(appRoot, 'cloud', 'uclaw-cloud-api');
const newAPIBaseURL = process.env.NEWAPI_ADMIN_BASE_URL || 'http://127.0.0.1:3000';
const rootUsername = process.env.NEWAPI_LOCAL_ROOT_USERNAME || 'root';
const rootPassword = process.env.NEWAPI_LOCAL_ROOT_PASSWORD || 'UclawLocal@2026';
const screenshotPath = '/tmp/uclaw-model-usage-ui.png';
const devDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uclaw-ui-e2e-data-'));
const pgPort = String(55600 + Math.floor(Math.random() * 80));
const apiPort = String(18200 + Math.floor(Math.random() * 80));
const debugPort = String(9230 + Math.floor(Math.random() * 40));
const pgContainer = `uclaw-ui-e2e-pg-${pgPort}-${process.pid}`;
const apiAddr = `127.0.0.1:${apiPort}`;
const activationCode = 'UIE2-E2E2-TEST-0001';
const phone = `138${String(Date.now()).slice(-8)}`;
const children = [];

/**
 * Reads the local New API root token from SQLite to avoid dev login throttles.
 */
function readLocalNewAPIAdminToken() {
  if (!newAPIBaseURL.startsWith('http://127.0.0.1:3000') && !newAPIBaseURL.startsWith('http://localhost:3000')) {
    return '';
  }
  const dbPath = path.join(cloudRoot, 'deploy', 'newapi-local', 'data', 'one-api.db');
  if (!fs.existsSync(dbPath)) return '';
  return run('sqlite3', [dbPath, "select access_token from users where username='root' limit 1;"]).trim();
}

/**
 * Runs a command and fails fast with compact stdout/stderr on errors.
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    input: options.input,
    encoding: options.encoding === null ? null : 'utf8',
    stdio: options.stdio || 'pipe',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout || ''}${result.stderr || ''}`);
  }
  return result.stdout || '';
}

/**
 * Starts a long-running child process and tracks it for cleanup.
 */
function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    stdio: options.stdio || 'ignore',
  });
  children.push(child);
  return child;
}

/**
 * Waits until a URL returns an OK response.
 */
async function waitForURL(url, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/**
 * Sleeps for a short polling interval.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads JSON from an HTTP response and throws the API error message if present.
 */
async function readJSON(response) {
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || `HTTP ${response.status}`);
  }
  return data;
}

/**
 * Retries local New API / Cloud API calls that hit development login throttles.
 */
async function requestJSONWithRetry(label, request, attempts = 10) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await readJSON(await request());
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('429') && !message.includes('rate')) throw error;
      await sleep(1200 * (i + 1));
    }
  }
  throw new Error(`${label} failed after retry: ${lastError?.message || lastError}`);
}

/**
 * Opens a Chrome DevTools Protocol websocket for the Electron page.
 */
async function openCDP() {
  await waitForURL(`http://127.0.0.1:${debugPort}/json/list`, 45000);
  const list = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json());
  const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
  if (!page) throw new Error('Electron CDP page not found');

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const message = { id: ++id, method, params };
          pending.set(message.id, { res, rej });
          ws.send(JSON.stringify(message));
        });
      },
      close() {
        ws.close();
      },
    });
    ws.onerror = reject;
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.rej(new Error(message.error.message));
      else waiter.res(message.result);
    };
  });
}

/**
 * Creates a minimal activated local data directory for normal app startup.
 */
function writeActivatedClientState(accessToken, newAPIToken) {
  const configDir = path.join(devDataDir, '.openclaw');
  fs.mkdirSync(configDir, { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(appRoot, 'resources', 'default-openclaw.json'), 'utf8'));
  config.models = config.models || {};
  config.models.providers = config.models.providers || {};
  for (const name of ['custom', 'litellm']) {
    config.models.providers[name] = config.models.providers[name] || {};
    config.models.providers[name].baseUrl = `${newAPIBaseURL}/v1`;
    config.models.providers[name].apiKey = newAPIToken;
  }
  config.agents = config.agents || {};
  config.agents.defaults = config.agents.defaults || {};
  config.agents.defaults.model = { primary: 'custom/gpt-5.5' };
  config.agents.defaults.imageGenerationModel = { primary: 'litellm/gpt-image-2' };
  config.agents.defaults.imageModel = { primary: 'litellm/gpt-image-2' };
  config.agents.defaults.videoGenerationModel = { primary: 'xai/jimeng-video-3-720p' };
  fs.writeFileSync(path.join(configDir, 'openclaw.json'), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(configDir, 'uclaw-activation.json'), JSON.stringify({
    schemaVersion: 1,
    status: 'activated',
    source: 'cloud',
    phoneMasked: '138****0000',
    activationEndpoint: `http://${apiAddr}`,
    newapiBaseUrl: `${newAPIBaseURL}/v1`,
    tokenVersion: 1,
    tokenStatus: 'configured',
    uclawAccessToken: accessToken,
    activatedAt: new Date().toISOString(),
  }, null, 2));
}

/**
 * Drives the visible Electron page and asserts cloud usage data rendered.
 */
async function assertElectronModelUsageUI() {
  const cdp = await openCDP();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  const evalJS = (expression) => cdp
    .send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    .then((result) => result.result.value);

  for (let i = 0; i < 120; i += 1) {
    if (await evalJS('document.readyState') === 'complete') break;
    await sleep(500);
  }
  for (let i = 0; i < 80; i += 1) {
    const clicked = await evalJS(`(() => {
      const el = [...document.querySelectorAll('a,button,[role="button"]')]
        .find((node) => /模型/.test(node.textContent || ''));
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (clicked) break;
    await sleep(500);
  }
  for (let i = 0; i < 120; i += 1) {
    const ok = await evalJS(`(() => {
      const text = document.body.innerText || '';
      return text.includes('账户余额') && text.includes('100,000') && text.includes('New API');
    })()`);
    if (ok) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'));
      cdp.close();
      return;
    }
    await sleep(500);
  }
  const bodyText = await evalJS('document.body.innerText || ""');
  cdp.close();
  throw new Error(`model usage UI did not show cloud data:\n${bodyText.slice(0, 2000)}`);
}

/**
 * Stops local processes and PostgreSQL container after verification.
 */
function cleanup() {
  for (const child of children.reverse()) {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
  spawnSync('docker', ['stop', pgContainer], { stdio: 'ignore' });
  for (let i = 0; i < 5; i += 1) {
    try {
      fs.rmSync(devDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      break;
    } catch {
      // Electron can flush logs briefly after SIGTERM; cleanup is best-effort.
    }
  }
}

(async () => {
  try {
    run(path.join(cloudRoot, 'deploy/scripts/newapi-local-up.sh'), [], { cwd: cloudRoot });
    spawnSync('docker', ['restart', 'uclaw-newapi-local'], { stdio: 'ignore' });
    run('docker', [
      'run', '--rm', '--name', pgContainer,
      '-e', 'POSTGRES_USER=uclaw',
      '-e', 'POSTGRES_PASSWORD=uclaw',
      '-e', 'POSTGRES_DB=uclaw_cloud',
      '-p', `127.0.0.1:${pgPort}:5432`,
      '-d', 'postgres:16-alpine',
    ]);
    for (let i = 0; i < 60; i += 1) {
      const ready = spawnSync('docker', ['exec', pgContainer, 'pg_isready', '-U', 'uclaw', '-d', 'postgres'], { stdio: 'ignore' });
      if (ready.status === 0) break;
      await sleep(300);
    }
    run('docker', ['exec', '-i', pgContainer, 'psql', '-U', 'uclaw', '-d', 'uclaw_cloud'], {
      input: fs.readFileSync(path.join(cloudRoot, 'migrations', '000001_init.sql')),
      encoding: null,
    });

    await sleep(3000);
    const localAdminToken = readLocalNewAPIAdminToken();
    const adminLogin = localAdminToken ? { data: { access_token: localAdminToken } } : await requestJSONWithRetry('newapi admin login', () => fetch(`${newAPIBaseURL}/api/user/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: rootUsername, password: rootPassword }),
    }));
    const databaseURL = `postgres://uclaw:uclaw@127.0.0.1:${pgPort}/uclaw_cloud?sslmode=disable`;
    run('go', ['run', './cmd/adminctl', 'activation', 'seed', '--code', activationCode], {
      cwd: cloudRoot,
      env: { DATABASE_URL: databaseURL, ACTIVATION_CODE_PEPPER: 'ui-e2e-activation-pepper' },
    });
    start('go', ['run', './cmd/api', 'serve'], {
      cwd: cloudRoot,
      env: {
        APP_ENV: 'development',
        UCLAW_HTTP_ADDR: apiAddr,
        DATABASE_URL: databaseURL,
        JWT_SECRET: 'ui-e2e-jwt-secret-at-least-32-bytes',
        SMS_CODE_PEPPER: 'ui-e2e-sms-pepper',
        ACTIVATION_CODE_PEPPER: 'ui-e2e-activation-pepper',
        NEWAPI_ADMIN_BASE_URL: newAPIBaseURL,
        NEWAPI_ADMIN_TOKEN: adminLogin.data.access_token,
        NEWAPI_CLIENT_BASE_URL: `${newAPIBaseURL}/v1`,
        NEWAPI_ACTIVATION_QUOTA: '100000',
        NEWAPI_USER_PASSWORD_SECRET: 'ui-e2e-newapi-password-secret',
      },
    });
    await waitForURL(`http://${apiAddr}/healthz`, 30000);
    await requestJSONWithRetry('uclaw sms send', () => fetch(`http://${apiAddr}/v1/auth/sms/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, purpose: 'login' }),
    }));
    const login = await requestJSONWithRetry('uclaw sms login', () => fetch(`http://${apiAddr}/v1/auth/sms/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, purpose: 'login', code: '123456' }),
    }));
    const redeem = await requestJSONWithRetry('uclaw activation redeem', () => fetch(`http://${apiAddr}/v1/activation/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` },
      body: JSON.stringify({ activationCode, deviceSummary: 'UI-E2E' }),
    }));
    if (!redeem.newapiToken) throw new Error('activation did not return New API token');
    writeActivatedClientState(login.accessToken, redeem.newapiToken);

    start(path.join(appRoot, 'node_modules/.bin/electron'), ['.', '--dev', `--remote-debugging-port=${debugPort}`], {
      cwd: appRoot,
      env: {
        UCLAW_DEV_DATA_DIR: devDataDir,
        UCLAW_ACTIVATION_ENDPOINT: `http://${apiAddr}`,
      },
    });
    await sleep(3000);
    await assertElectronModelUsageUI();
    console.log(JSON.stringify({
      ok: true,
      step: 'electron_model_usage_ui',
      screenshot: screenshotPath,
    }));
  } finally {
    cleanup();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
