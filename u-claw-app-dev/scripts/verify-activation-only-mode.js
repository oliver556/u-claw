const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const mainPath = path.join(root, 'src', 'main.js');
const preloadPath = path.join(root, 'src', 'preload.js');
const activationHtmlPath = path.join(root, 'src', 'activation.html');

const main = fs.readFileSync(mainPath, 'utf8');
const preload = fs.readFileSync(preloadPath, 'utf8');
const activationHtml = fs.readFileSync(activationHtmlPath, 'utf8');

/**
 * Fails the verifier with a stable message when a contract is missing.
 */
function requireText(source, text, label) {
  if (!source.includes(text)) {
    throw new Error(`Missing ${label}: ${text}`);
  }
}

/**
 * Returns a source slice between two markers for focused contract checks.
 */
function sliceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  if (startIndex === -1) throw new Error(`Missing start marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex);
  if (endIndex === -1) throw new Error(`Missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

requireText(main, "const ACTIVATION_ONLY_ARG = '--activation-only';", 'activation-only arg');
requireText(main, 'ACTIVATION_SERVICE_UNAVAILABLE', 'activation unavailable error code');
requireText(main, 'function setupActivationIPC()', 'activation IPC setup');
requireText(main, 'function loadActivationPage()', 'activation page loader');
requireText(main, "mainWindow.loadFile(path.join(__dirname, 'activation.html'));", 'activation local loadFile');
requireText(main, 'Activation-only mode starting', 'activation lifecycle branch');
requireText(main, 'function createActivationMenu()', 'activation menu');

const lifecycleBranch = sliceBetween(main, 'Activation-only mode starting', '  // Setup');
for (const required of ['createMenu();', 'setupActivationIPC();', 'createWindow();', 'return;']) {
  requireText(lifecycleBranch, required, `activation early-return ${required}`);
}
for (const forbidden of ['startConfigServer', 'startGateway', 'startVideoAdapter', 'setupIPC();', 'ensureConfig();']) {
  if (lifecycleBranch.includes(forbidden)) {
    throw new Error(`Activation-only branch must not call ${forbidden}`);
  }
}

const activationIpc = sliceBetween(main, 'function setupActivationIPC()', 'function loadActivationPage()');
for (const channel of ['activation:get-preflight', 'activation:submit', 'activation:window-action']) {
  requireText(activationIpc, channel, `activation IPC channel ${channel}`);
}
for (const forbidden of ['get-gateway-status', 'open-dashboard', 'open-config']) {
  if (activationIpc.includes(forbidden)) {
    throw new Error(`Activation IPC must not expose ${forbidden}`);
  }
}

const preloadActivationBranch = sliceBetween(preload, 'if (isActivationOnlyMode)', '} else {');
requireText(preloadActivationBranch, 'uclawActivation', 'activation preload namespace');
for (const forbidden of ['getGatewayStatus', 'openDashboard', 'openConfig']) {
  if (preloadActivationBranch.includes(forbidden)) {
    throw new Error(`Activation preload must not expose ${forbidden}`);
  }
}

for (const required of [
  '首次启动激活',
  '受限模式不启动 OpenClaw Gateway',
  'placeholder="UCLAW-XXXXXXXX"',
  'placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX"',
  'formatActivationCode',
  'escapeHtml',
]) {
  requireText(activationHtml, required, `activation page marker ${required}`);
}

for (const forbidden of ['UCLAW-8F2K9M', '7K4P-9Q2M-X8RT-6W3N-A5LC', 'Gateway 在线', 'custom/gpt-5.5']) {
  if (activationHtml.includes(forbidden)) {
    throw new Error(`Activation page must not keep demo value: ${forbidden}`);
  }
}

console.log('verify-activation-only-mode passed');
