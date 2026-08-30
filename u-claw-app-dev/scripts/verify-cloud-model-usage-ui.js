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
const newAPIE2EChannelID = '910001';
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
 * Seeds a local-only New API channel so user model permissions are deterministic in E2E.
 */
function seedLocalNewAPIModelCatalog() {
  if (!newAPIBaseURL.startsWith('http://127.0.0.1:3000') && !newAPIBaseURL.startsWith('http://localhost:3000')) {
    return;
  }
  const dbPath = path.join(cloudRoot, 'deploy', 'newapi-local', 'data', 'one-api.db');
  if (!fs.existsSync(dbPath)) return;
  run('sqlite3', [dbPath, `
    insert or replace into channels (
      id, type, key, status, name, weight, created_time, test_time, response_time,
      base_url, models, "group", used_quota, model_mapping, status_code_mapping,
      priority, auto_ban, settings
    ) values (
      ${newAPIE2EChannelID}, 1, 'sk-uclaw-ui-e2e-placeholder', 1, 'uclaw-ui-e2e-catalog',
      0, strftime('%s','now'), 0, 0, 'http://127.0.0.1:65535',
      'gpt-5.5,gpt-image-2,jimeng-video-3-720p,seedance-1.5-pro-1080p-10s', 'default', 0, '', '',
      0, 0, '{}'
    );
  `]);
}

/**
 * Removes the local-only New API channel inserted by this verifier.
 */
function cleanupLocalNewAPIModelCatalog() {
  if (!newAPIBaseURL.startsWith('http://127.0.0.1:3000') && !newAPIBaseURL.startsWith('http://localhost:3000')) {
    return;
  }
  const dbPath = path.join(cloudRoot, 'deploy', 'newapi-local', 'data', 'one-api.db');
  if (!fs.existsSync(dbPath)) return;
  try {
    run('sqlite3', [dbPath, `delete from channels where id = ${newAPIE2EChannelID} and name = 'uclaw-ui-e2e-catalog';`]);
  } catch {}
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
 * Keeps the local UI lab open until the developer stops this verifier.
 */
function waitForManualStop() {
  return new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
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
  fs.mkdirSync(path.join(configDir, 'license'), { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(appRoot, 'resources', 'default-openclaw.json'), 'utf8'));
  config.models = config.models || {};
  config.models.providers = config.models.providers || {};
  for (const name of ['custom', 'litellm']) {
    config.models.providers[name] = config.models.providers[name] || {};
    config.models.providers[name].baseUrl = `${newAPIBaseURL}/v1`;
    config.models.providers[name].apiKey = newAPIToken;
  }
  config.models.providers.newapi = {
    baseUrl: `${newAPIBaseURL}/v1`,
    apiKey: newAPIToken,
    api: 'openai-completions',
    models: [
      { id: 'gpt-5.5', name: 'gpt-5.5', capabilities: ['text'], input: ['text'] },
      { id: 'gpt-image-2', name: 'gpt-image-2', capabilities: ['image'], input: ['text', 'image'] },
      { id: 'jimeng-video-3-720p', name: 'jimeng-video-3-720p', capabilities: ['video'], input: ['text', 'image'] },
      { id: 'seedance-1.5-pro-1080p-10s', name: 'seedance-1.5-pro-1080p-10s', capabilities: ['video'], input: ['text', 'image'] },
    ],
  };
  config.agents = config.agents || {};
  config.agents.defaults = config.agents.defaults || {};
  config.agents.defaults.model = { primary: 'custom/gpt-5.5' };
  config.agents.defaults.imageGenerationModel = { primary: 'litellm/gpt-image-2' };
  config.agents.defaults.imageModel = { primary: 'litellm/gpt-image-2' };
  config.agents.defaults.videoGenerationModel = { primary: 'xai/jimeng-video-3-720p' };
  fs.writeFileSync(path.join(configDir, 'openclaw.json'), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(configDir, 'license', 'license.json'), JSON.stringify({
    payload: {
      schemaVersion: 'uclaw.license.v1',
      activationId: 'ui-e2e-activation',
      subject: 'ui-e2e',
    },
    signature: {
      algorithm: 'Ed25519',
      keyId: 'ui-e2e',
      value: Buffer.from('ui-e2e-signature').toString('base64'),
    },
  }, null, 2));
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
 * Navigates to the exact model page before asserting model dashboard controls.
 */
async function openModelPage(evalJS, cdp) {
  for (let i = 0; i < 180; i += 1) {
    const clicked = await evalJS(`(() => {
      const el = [...document.querySelectorAll('a,button,[role="button"]')]
        .find((node) => (node.textContent || '').trim() === '模型' && node.offsetParent !== null);
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (clicked) break;
    await sleep(500);
  }
  for (let i = 0; i < 180; i += 1) {
    const ok = await evalJS(`(() => {
      const text = document.body.innerText || '';
      return text.includes('账户余额') && text.includes('模型能力') && text.includes('同步模型');
    })()`);
    if (ok) return;
    await sleep(500);
  }
  const bodyText = await evalJS('document.body.innerText || ""');
  cdp.close();
  throw new Error(`model page did not open:\n${bodyText.slice(0, 2000)}`);
}

/**
 * Opens the model picker and verifies the change action refreshes cloud catalog data.
 */
async function assertModelChangeLoadsCloudCatalog(evalJS, cdp) {
  const clicked = await evalJS(`(() => {
    const button = [...document.querySelectorAll('.uclaw-config-model-change')]
      .find((node) => (node.textContent || '').trim() === '更换' && !node.disabled && node.offsetParent !== null);
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) {
    const bodyText = await evalJS('document.body.innerText || ""');
    cdp.close();
    throw new Error(`model change button not clickable:\n${bodyText.slice(0, 2000)}`);
  }

  let sawCloudCatalog = false;
  for (let i = 0; i < 120; i += 1) {
    const ok = await evalJS(`(() => {
      const text = document.querySelector('.uclaw-model-picker')?.innerText || '';
      return text.includes('更换文字模型') && text.includes('newapi/gpt-5.5') && !text.includes('gpt-image-2') && !text.includes('jimeng-video-3-720p') && !text.includes('seedance-1.5-pro-1080p-10s');
    })()`);
    if (ok) {
      sawCloudCatalog = true;
      break;
    }
    await sleep(500);
  }
  if (!sawCloudCatalog) {
    const bodyText = await evalJS('document.body.innerText || ""');
    cdp.close();
    throw new Error(`model picker did not load cloud catalog:\n${bodyText.slice(0, 2000)}`);
  }

  await evalJS(`(() => {
    const close = document.querySelector('.uclaw-model-picker__close');
    if (close) close.click();
  })()`);
  for (let i = 0; i < 40; i += 1) {
    const closed = await evalJS('!document.querySelector(".uclaw-model-picker")');
    if (closed) return;
    await sleep(250);
  }
  throw new Error('model picker did not close after cloud catalog assertion');
}

/**
 * Drives the visible Electron page and asserts cloud usage data rendered.
 */
async function assertElectronModelUsageUI(expectedInitialQuota, rechargeQuota) {
  const cdp = await openCDP();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  const evalJS = (expression) => cdp
    .send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    .then((result) => result.result.value);
  const quotaPerCNY = 500000;
  const computePerQuota = 12;
  const expectedInitialText = `¥${(Number(expectedInitialQuota) / quotaPerCNY).toFixed(2)}`;
  const expectedFinalText = `¥${(Number(expectedInitialQuota + rechargeQuota) / quotaPerCNY).toFixed(2)}`;
  const expectedRechargeComputeText = `${((Number(rechargeQuota) * computePerQuota) / 10000).toLocaleString(undefined, { maximumFractionDigits: 2 })}w 算力`;

  for (let i = 0; i < 120; i += 1) {
    if (await evalJS('document.readyState') === 'complete') break;
    await sleep(500);
  }
  await openModelPage(evalJS, cdp);
  let sawInitialUsage = false;
  for (let i = 0; i < 120; i += 1) {
    const ok = await evalJS(`(() => {
      const text = document.body.innerText || '';
      return text.includes('账户余额') && text.includes('已消耗') && text.includes('请求次数') && text.includes(${JSON.stringify(expectedInitialText)}) && text.includes('1 元 = 600w 算力') && text.includes('New API');
    })()`);
    if (ok) {
      sawInitialUsage = true;
      break;
    }
    await sleep(500);
  }
  if (!sawInitialUsage) {
    const bodyText = await evalJS('document.body.innerText || ""');
    cdp.close();
    throw new Error(`model usage UI did not show initial cloud data:\n${bodyText.slice(0, 2000)}`);
  }
  const leakedLoginLog = await evalJS(`(() => {
    const text = document.body.innerText || '';
    return text.includes('Logged in successfully via password');
  })()`);
  if (leakedLoginLog) {
    const bodyText = await evalJS('document.body.innerText || ""');
    cdp.close();
    throw new Error(`New API login log leaked into usage UI:\n${bodyText.slice(0, 2000)}`);
  }
  await assertModelChangeLoadsCloudCatalog(evalJS, cdp);
  const openedRecharge = await evalJS(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => (node.textContent || '').trim() === '充值' && !node.disabled);
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!openedRecharge) {
    const bodyText = await evalJS('document.body.innerText || ""');
    cdp.close();
    throw new Error(`model usage UI recharge button not clickable:\n${bodyText.slice(0, 2000)}`);
  }
  for (let i = 0; i < 60; i += 1) {
    const ok = await evalJS(`(() => {
      const text = document.body.innerText || '';
      return text.includes('选择套餐') || text.includes('虚拟充值 10 元');
    })()`);
    if (ok) break;
    await sleep(500);
  }
  const selectedPlan = await evalJS(`(() => {
    const plan = [...document.querySelectorAll('button,[role="button"],label,article,div')]
      .find((node) => (node.textContent || '').includes('虚拟充值 10 元') && node.offsetParent !== null);
    if (!plan) return false;
    const clickable = plan.closest('button,[role="button"],label') || plan;
    clickable.click();
    return true;
  })()`);
  if (!selectedPlan) {
    const bodyText = await evalJS('document.body.innerText || ""');
    cdp.close();
    throw new Error(`model usage UI recharge plan not selectable:\n${bodyText.slice(0, 2000)}`);
  }
  const confirmedRecharge = await evalJS(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => (node.textContent || '').trim() === '确认充值' && !node.disabled);
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!confirmedRecharge) {
    const bodyText = await evalJS('document.body.innerText || ""');
    cdp.close();
    throw new Error(`model usage UI recharge plan confirm not clickable:\n${bodyText.slice(0, 2000)}`);
  }
  for (let i = 0; i < 120; i += 1) {
    const ok = await evalJS(`(() => {
      const text = document.body.innerText || '';
      return text.includes(${JSON.stringify(expectedFinalText)}) && text.includes('虚拟充值成功');
    })()`);
    if (ok) {
      const openedRecords = await evalJS(`(() => {
        const button = [...document.querySelectorAll('button')]
          .find((node) => (node.textContent || '').trim() === '记录' && !node.disabled);
        if (!button) return false;
        button.click();
        return true;
      })()`);
      if (!openedRecords) {
        const bodyText = await evalJS('document.body.innerText || ""');
        cdp.close();
        throw new Error(`model usage UI recharge records button not clickable:\n${bodyText.slice(0, 2000)}`);
      }
      for (let j = 0; j < 80; j += 1) {
        const recordsVisible = await evalJS(`(() => {
          const text = document.body.innerText || '';
          return text.includes('充值记录') && text.includes('已到账') && text.includes(${JSON.stringify(expectedRechargeComputeText)});
        })()`);
        if (recordsVisible) break;
        await sleep(500);
      }
      const recordsVisible = await evalJS(`(() => {
        const text = document.body.innerText || '';
        return text.includes('充值记录') && text.includes('已到账') && text.includes(${JSON.stringify(expectedRechargeComputeText)});
      })()`);
      if (!recordsVisible) {
        const bodyText = await evalJS('document.body.innerText || ""');
        cdp.close();
        throw new Error(`model usage UI recharge records did not render:\n${bodyText.slice(0, 2000)}`);
      }
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'));
      cdp.close();
      return;
    }
    await sleep(500);
  }
  const bodyText = await evalJS('document.body.innerText || ""');
  cdp.close();
  throw new Error(`model usage UI did not show recharged cloud data:\n${bodyText.slice(0, 2000)}`);
}

/**
 * Stops local processes and PostgreSQL container after verification.
 */
function cleanup() {
  cleanupLocalNewAPIModelCatalog();
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
    for (let i = 0; i < 60; i += 1) {
      const ready = spawnSync('docker', ['exec', pgContainer, 'psql', '-U', 'uclaw', '-d', 'uclaw_cloud', '-tc', 'SELECT 1'], { stdio: 'ignore' });
      if (ready.status === 0) break;
      await sleep(300);
    }
    run('docker', ['exec', '-i', pgContainer, 'psql', '-U', 'uclaw', '-d', 'uclaw_cloud'], {
      input: fs.readFileSync(path.join(cloudRoot, 'migrations', '000001_init.sql')),
      encoding: null,
    });

    await sleep(3000);
    seedLocalNewAPIModelCatalog();
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
    const initialUsage = await requestJSONWithRetry('uclaw initial usage summary', () => fetch(`http://${apiAddr}/v1/newapi/usage/summary`, {
      headers: { Authorization: `Bearer ${login.accessToken}` },
    }));
    const initialBalance = Number(initialUsage.accountBalance) || 0;
    writeActivatedClientState(login.accessToken, redeem.newapiToken);

    start(path.join(appRoot, 'node_modules/.bin/electron'), ['.', '--dev', `--remote-debugging-port=${debugPort}`], {
      cwd: appRoot,
      env: {
        UCLAW_DEV_DATA_DIR: devDataDir,
        UCLAW_ACTIVATION_ENDPOINT: `http://${apiAddr}`,
      },
    });
    await sleep(3000);
    await assertElectronModelUsageUI(initialBalance, 5000000);
    console.log(JSON.stringify({
      ok: true,
      step: 'electron_model_usage_ui',
      screenshot: screenshotPath,
    }));
    if (process.env.UCLAW_UI_E2E_KEEPALIVE === '1') {
      console.log(JSON.stringify({
        ok: true,
        step: 'manual_verification_ready',
        gateway: 'http://127.0.0.1:18789/chat?session=main',
        screenshot: screenshotPath,
      }));
      await waitForManualStop();
    }
  } finally {
    cleanup();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
