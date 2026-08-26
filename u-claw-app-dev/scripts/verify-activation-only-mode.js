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
requireText(main, 'ACTIVATION_STATIC_PREVIEW_COMPLETE', 'activation static preview code');
requireText(main, "const activationStatePath = path.join(configDir, 'uclaw-activation.json');", 'activation state path');
requireText(main, 'function hasCompletedActivation()', 'activation completion checker');
requireText(main, 'function shouldShowActivationOnStartup()', 'startup activation gate');
requireText(main, 'function writeActivationState', 'activation state writer');
requireText(main, 'async function postActivationJSON', 'activation cloud HTTP client');
requireText(main, 'async function getActivationJSON', 'activation cloud GET client');
requireText(main, 'async function getCloudModelUsageSummary', 'cloud model usage summary client');
requireText(main, 'function writeOpenClawActivationConfig', 'OpenClaw activation config writer');
requireText(main, "postActivationJSON('/v1/auth/sms/send'", 'cloud SMS send');
requireText(main, "postActivationJSON('/v1/auth/sms/login'", 'cloud SMS login');
requireText(main, "postActivationJSON('/v1/activation/redeem'", 'cloud activation redeem');
requireText(main, 'ACTIVATION_CLOUD_COMPLETE', 'cloud activation completion code');
requireText(main, 'uclaw:get-model-usage-summary', 'normal usage summary IPC channel');
requireText(main, 'function setupActivationIPC()', 'activation IPC setup');
requireText(main, 'function loadActivationPage()', 'activation page loader');
requireText(main, "mainWindow.loadFile(path.join(__dirname, 'activation.html'));", 'activation local loadFile');
requireText(main, 'Activation-only mode starting', 'activation lifecycle branch');
requireText(main, 'Activation gate starting', 'activation startup gate branch');
requireText(main, 'function createActivationMenu()', 'activation menu');
requireText(main, 'additionalArguments: activationWindowMode ? [ACTIVATION_ONLY_ARG] : [],', 'activation renderer argv');

const lifecycleBranch = sliceBetween(main, 'Activation-only mode starting', '  // Setup');
for (const required of ['createMenu();', 'setupActivationIPC();', 'createWindow();', 'return;']) {
  requireText(lifecycleBranch, required, `activation early-return ${required}`);
}

const startupGateBranch = sliceBetween(main, 'Activation gate starting', '  // Setup');
for (const required of ['activationWindowMode = true;', 'createMenu();', 'setupActivationIPC();', 'createWindow();', 'return;']) {
  requireText(startupGateBranch, required, `startup activation gate ${required}`);
}
for (const forbidden of ['startConfigServer', 'startGateway', 'startVideoAdapter', 'setupIPC();', 'ensureConfig();']) {
  if (startupGateBranch.includes(forbidden)) {
    throw new Error(`Startup activation gate must not call ${forbidden}`);
  }
}
for (const forbidden of ['startConfigServer', 'startGateway', 'startVideoAdapter', 'setupIPC();', 'ensureConfig();']) {
  if (lifecycleBranch.includes(forbidden)) {
    throw new Error(`Activation-only branch must not call ${forbidden}`);
  }
}

const activationIpc = sliceBetween(main, 'function setupActivationIPC()', 'function loadActivationPage()');
for (const channel of ['activation:get-preflight', 'activation:send-sms', 'activation:submit', 'activation:window-action']) {
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

const preloadNormalBranch = sliceBetween(preload, '} else {', '\n}');
requireText(preloadNormalBranch, 'getModelUsageSummary', 'normal preload model usage bridge');

for (const required of [
  '首次启动激活',
  '受限模式不启动 OpenClaw Gateway',
  '登录并绑定当前 U-Claw 产品盘',
  'placeholder="请输入手机号"',
  'placeholder="6 位验证码"',
  'placeholder="XXXX-XXXX-XXXX-XXXX"',
  'sendSMS',
  'finishPhone',
  'formatActivationCode',
  'escapeHtml',
  'U-Claw 首次登录完成',
  'preview',
  '等待云端激活兑换接入',
]) {
  requireText(activationHtml, required, `activation page marker ${required}`);
}

for (const forbidden of ['UCLAW-8F2K9M', '7K4P-9Q2M-X8RT-6W3N-A5LC', 'Gateway 在线', 'custom/gpt-5.5', '本地启动授权有效']) {
  if (activationHtml.includes(forbidden)) {
    throw new Error(`Activation page must not keep demo value: ${forbidden}`);
  }
}

console.log('verify-activation-only-mode passed');
