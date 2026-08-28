#!/usr/bin/env node

/**
 * Drives activation-only Electron against a local Cloud API stub and verifies
 * license/config material is written before commit.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const devDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uclaw-activation-write-'));
const screenshotPath = path.join(appRoot, '..', '.codex-state', 'screenshots', `activation-real-write-${Date.now()}.png`);
const debugPort = 9350 + Math.floor(Math.random() * 100);
const activationID = 'act_electron_write_001';
const username = 'UCLAW-TESTER01';
const activationCode = 'ABCDE-FGHIJ-KLMNO-PQRST-UVWXYZ';
const activationRestartExitCode = 20;
const newapiToken = 'electron-write-token';
const newapiBaseUrl = 'https://newapi.yiyong.me/v1';
const requests = [];
const children = [];

/**
 * Sleeps while Electron and CDP expose page state.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for the Electron child to hand control back to the launcher contract.
 */
function waitForChildExit(child, timeoutMs = 10000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for activation restart exit')), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/**
 * Reads request JSON with a small body cap so the stub cannot mask bad clients.
 */
function readRequestJSON(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Starts a local Cloud API stub with the first-start activation contract.
 */
function startActivationStub() {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', env: 'test' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/activations') {
        const body = await readRequestJSON(req);
        requests.push({ method: req.method, url: req.url, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          activationId: activationID,
          status: 'server_bound',
          stage: 'server_bound',
          usernameMasked: 'UCLAW-TE****01',
          usbFingerprintSummary: body.usbFingerprintSummary,
          artifactStatus: 'pending_client_write',
          message: 'Activation accepted.',
          newapiBaseUrl,
          newapiToken,
          tokenVersion: 1,
          defaultModels: {
            text: 'custom/gpt-5.5',
            image: 'litellm/gpt-image-2',
            video: 'xai/jimeng-video-3-720p',
          },
          licenseArtifact: {
            payload: {
              schemaVersion: 'uclaw.license.v1',
              activationId: activationID,
              subject: 'test',
            },
            signature: {
              algorithm: 'Ed25519',
              keyId: 'test-key',
              value: Buffer.from('test-signature').toString('base64'),
            },
          },
        }));
        return;
      }
      if (req.method === 'POST' && req.url === `/v1/activations/${activationID}/commit`) {
        const body = await readRequestJSON(req);
        requests.push({ method: req.method, url: req.url, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          activationId: activationID,
          status: 'committed',
          stage: 'committed',
          message: 'Committed.',
        }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/**
 * Waits until a URL responds successfully.
 */
async function waitForURL(url, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/**
 * Opens a DevTools protocol session for the activation page.
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
 * Evaluates JavaScript in the renderer and returns a JSON-serializable value.
 */
function makeEval(cdp) {
  return (expression) => cdp
    .send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    .then((result) => result.result.value);
}

/**
 * Drives the four activation screens through visible DOM controls.
 */
async function driveActivationPage() {
  const cdp = await openCDP();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  const evalJS = makeEval(cdp);
  for (let i = 0; i < 80; i += 1) {
    if (await evalJS('document.readyState') === 'complete') break;
    await sleep(250);
  }
  await evalJS(`document.querySelector('#noticeAck').click(); document.querySelector('#nextButton').click();`);
  await sleep(100);
  await evalJS(`document.querySelector('#nextButton').click();`);
  for (let i = 0; i < 80; i += 1) {
    const checksDone = await evalJS(`document.querySelector('#nextButton').textContent.includes('继续激活')`);
    if (checksDone) break;
    await sleep(250);
  }
  await evalJS(`document.querySelector('#nextButton').click();`);
  for (let i = 0; i < 80; i += 1) {
    const active = await evalJS(`document.querySelector('#screen-activate').classList.contains('active')`);
    if (active) break;
    await sleep(250);
  }
  await evalJS(`(() => {
    const username = document.querySelector('#username');
    const code = document.querySelector('#activationCode');
    username.value = ${JSON.stringify(username)};
    username.dispatchEvent(new Event('input', { bubbles: true }));
    code.value = ${JSON.stringify(activationCode)};
    code.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#nextButton').click();
  })()`);
  for (let i = 0; i < 120; i += 1) {
    const ok = await evalJS(`document.body.innerText.includes('U-Claw 首次激活完成') && document.body.innerText.includes('ACTIVATION_CLOUD_COMPLETE')`);
    if (ok) {
      const restartButtonReady = await evalJS(`document.querySelector('#nextButton').textContent.includes('完成并重启') && !document.querySelector('#nextButton').hidden`);
      if (!restartButtonReady) throw new Error('activation finish restart button is not ready');
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'));
      await evalJS(`document.querySelector('#nextButton').click();`);
      cdp.close();
      return;
    }
    await sleep(250);
  }
  const body = await evalJS('document.body.innerText || ""');
  cdp.close();
  throw new Error(`activation page did not finish:\n${body.slice(0, 2000)}`);
}

/**
 * Verifies all local files and server commit order after the renderer finishes.
 */
function verifyLocalActivationMaterial() {
  const configDir = path.join(devDataDir, '.openclaw');
  const license = JSON.parse(fs.readFileSync(path.join(configDir, 'license', 'license.json'), 'utf8'));
  const modelCredential = JSON.parse(fs.readFileSync(path.join(configDir, 'builtin-model-credential.v1.json'), 'utf8'));
  const activationState = JSON.parse(fs.readFileSync(path.join(configDir, 'uclaw-activation.json'), 'utf8'));
  const openclaw = JSON.parse(fs.readFileSync(path.join(configDir, 'openclaw.json'), 'utf8'));

  if (license.payload.activationId !== activationID || license.signature.algorithm !== 'Ed25519') {
    throw new Error('license artifact was not written correctly');
  }
  const tokenFingerprint = crypto.createHash('sha256').update(newapiToken).digest('hex').slice(0, 16);
  if (modelCredential.tokenFingerprint !== tokenFingerprint || modelCredential.baseUrl !== newapiBaseUrl) {
    throw new Error('builtin model credential was not written correctly');
  }
  for (const providerName of ['custom', 'litellm']) {
    const provider = openclaw.models?.providers?.[providerName];
    if (provider?.baseUrl !== newapiBaseUrl || provider?.apiKey !== newapiToken) {
      throw new Error(`OpenClaw provider ${providerName} was not configured`);
    }
  }
  if (activationState.status !== 'activated' || activationState.commitStatus !== 'committed') {
    throw new Error('activation state did not reach committed status');
  }
  if (requests.length !== 2 || requests[0].url !== '/v1/activations' || requests[1].url !== `/v1/activations/${activationID}/commit`) {
    throw new Error(`unexpected activation request order: ${JSON.stringify(requests.map((request) => request.url))}`);
  }
  if (requests[0].body.username !== username || !requests[0].body.idempotencyKey?.startsWith('electron-')) {
    throw new Error('first-start request payload was not normalized');
  }
  if (requests[1].body.writeStatus !== 'verified') {
    throw new Error('commit payload did not report verified write');
  }
}

/**
 * Stops Electron and removes transient test data.
 */
function cleanup(server) {
  for (const child of children.reverse()) {
    try { child.kill('SIGTERM'); } catch {}
  }
  try { server?.close(); } catch {}
  try { fs.rmSync(devDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}
}

(async () => {
  let server;
  try {
    server = await startActivationStub();
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const child = spawn(path.join(appRoot, 'node_modules/.bin/electron'), ['.', '--dev', `--remote-debugging-port=${debugPort}`], {
      cwd: appRoot,
      env: {
        ...process.env,
        UCLAW_ACTIVATION_ONLY: '1',
        UCLAW_ACTIVATION_ENDPOINT: endpoint,
        UCLAW_DEV_DATA_DIR: devDataDir,
        UCLAW_USB_FINGERPRINT_SUMMARY: 'TEST-USB-SUMMARY',
        UCLAW_USB_LABEL: 'Verifier USB',
      },
      stdio: 'ignore',
    });
    children.push(child);
    await driveActivationPage();
    const exitCode = await waitForChildExit(child);
    if (exitCode !== activationRestartExitCode) {
      throw new Error(`activation handoff exited with ${exitCode}, expected ${activationRestartExitCode}`);
    }
    verifyLocalActivationMaterial();
    console.log(JSON.stringify({ ok: true, step: 'activation_real_write', screenshot: screenshotPath }));
  } finally {
    cleanup(server);
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
