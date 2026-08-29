const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const mainPath = path.join(root, 'src', 'main.js');
const preloadPath = path.join(root, 'src', 'preload.js');
const activationHtmlPath = path.join(root, 'src', 'activation.html');
const macStartPath = path.join(root, 'scripts', 'Mac-Start-App.command');
const windowsStartPath = path.join(root, 'scripts', 'Windows-Start-App.bat');
const macLauncherPath = path.join(root, 'scripts', 'launcher', 'macos', 'main.c');
const windowsLauncherPath = path.join(root, 'scripts', 'launcher', 'windows', 'main.go');
const generatedMacScriptPath = path.join(root, 'scripts', 'launcher', 'macos', 'generated-start-script.inc');
const packagePortablePath = path.join(root, 'scripts', 'package-portable.js');

const main = fs.readFileSync(mainPath, 'utf8');
const preload = fs.readFileSync(preloadPath, 'utf8');
const activationHtml = fs.readFileSync(activationHtmlPath, 'utf8');
const macStart = fs.readFileSync(macStartPath, 'utf8');
const windowsStart = fs.readFileSync(windowsStartPath, 'utf8');
const macLauncher = fs.readFileSync(macLauncherPath, 'utf8');
const windowsLauncher = fs.readFileSync(windowsLauncherPath, 'utf8');
const generatedMacScript = fs.readFileSync(generatedMacScriptPath, 'utf8');
const packagePortable = fs.readFileSync(packagePortablePath, 'utf8');

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
requireText(main, "const activationLicensePath = path.join(configDir, 'license', 'license.json');", 'activation license path');
requireText(main, "const builtinModelCredentialPath = path.join(configDir, 'builtin-model-credential.v1.json');", 'builtin model credential path');
requireText(main, "const updateCredentialPath = path.join(configDir, 'update-credential.v1.json');", 'hard update credential path');
requireText(main, 'function writeActivationLicenseArtifact', 'activation license writer');
requireText(main, 'function writeBuiltinModelCredential', 'builtin model credential writer');
requireText(main, 'function writeUpdateCredential', 'hard update credential writer');
requireText(main, 'function canUseActivationStaticFallback()', 'activation static fallback guard');
requireText(main, 'function createStaticActivationResult', 'activation static fallback result');
requireText(main, 'async function postActivationJSON', 'activation cloud HTTP client');
requireText(main, 'async function getActivationJSON', 'activation cloud GET client');
requireText(main, 'async function getCloudModelUsageSummary', 'cloud model usage summary client');
requireText(main, 'function writeOpenClawActivationConfig', 'OpenClaw activation config writer');
requireText(main, "postActivationJSON('/v1/auth/sms/send'", 'cloud SMS send');
requireText(main, "postActivationJSON('/v1/activations'", 'first-start cloud activation');
requireText(main, "postActivationJSON(`/v1/activations/${activationID}/commit`", 'first-start activation commit');
requireText(main, 'ACTIVATION_CLOUD_COMPLETE', 'cloud activation completion code');
requireText(main, 'async function launchMainAfterActivation()', 'activation launch handoff');
requireText(main, 'async function startNormalApplication', 'normal startup launcher');
requireText(main, 'UCLAW_ACTIVATION_REQUIRE_CLOUD', 'activation cloud required opt-out');
requireText(main, 'activation cloud submit fallback', 'activation cloud submit fallback');
requireText(main, 'uclaw:get-model-usage-summary', 'normal usage summary IPC channel');
requireText(main, 'function setupActivationIPC()', 'activation IPC setup');
requireText(main, 'function loadActivationPage()', 'activation page loader');
requireText(main, "mainWindow.loadFile(path.join(__dirname, 'activation.html'));", 'activation local loadFile');
requireText(main, 'Failed to load activation page', 'activation page load error log');
requireText(main, 'activationWindowMode || !holdMainWindowUntilReady || gatewayReady || appIsQuitting', 'activation window bypasses portable hold');
requireText(main, 'Activation-only mode starting', 'activation lifecycle branch');
requireText(main, 'Activation gate starting', 'activation startup gate branch');
requireText(main, 'function createActivationMenu()', 'activation menu');
requireText(main, 'if (activationWindowMode) {', 'activation menu gate uses runtime window mode');
requireText(main, 'additionalArguments: activationWindowMode ? [ACTIVATION_ONLY_ARG] : [],', 'activation renderer argv');

const lifecycleBranch = sliceBetween(main, 'Activation-only mode starting', '  if (shouldShowActivationOnStartup())');
for (const required of ['createMenu();', 'setupActivationIPC();', 'createWindow();', 'return;']) {
  requireText(lifecycleBranch, required, `activation early-return ${required}`);
}

const startupGateBranch = sliceBetween(main, 'Activation gate starting', '  await startNormalApplication();');
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
for (const channel of ['activation:get-preflight', 'activation:send-sms', 'activation:submit', 'activation:launch-main', 'activation:complete', 'activation:window-action']) {
  requireText(activationIpc, channel, `activation IPC channel ${channel}`);
}
for (const forbidden of ['get-gateway-status', 'open-dashboard', 'open-config']) {
  if (activationIpc.includes(forbidden)) {
    throw new Error(`Activation IPC must not expose ${forbidden}`);
  }
}

const submitActivationSource = sliceBetween(main, 'async function submitActivation', '/**\n * Registers only the activation IPC surface.');
for (const forbidden of ["postActivationJSON('/v1/auth/sms/login'", "postActivationJSON('/v1/activation/redeem'"]) {
  if (submitActivationSource.includes(forbidden)) {
    throw new Error(`Activation submit must use first-start API, not ${forbidden}`);
  }
}

const preloadActivationBranch = sliceBetween(preload, 'if (isActivationOnlyMode)', '} else {');
requireText(preloadActivationBranch, 'uclawActivation', 'activation preload namespace');
requireText(preloadActivationBranch, 'launchMain', 'activation launch-main preload bridge');
requireText(preloadActivationBranch, 'completeActivation', 'activation complete preload bridge');
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
  '激活并绑定当前 U-Claw 产品盘',
  'placeholder="请输入手机号"',
  'placeholder="6 位验证码"',
  'placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX"',
  'normalizePhone',
  'sendSmsButton',
  'finishPhone',
  'formatActivationCode',
  'escapeHtml',
  '固定验证码为 123456',
  'launchReady',
  '进入 U-Claw',
  '.step.done .step-number::after { content: ""; position: absolute;',
  'transform: translate(-50%, -58%) rotate(45deg);',
  '.button.primary:hover:not(:disabled) { border-color: var(--blue-hover); color: #fff;',
  '.button.text:hover:not(:disabled) { border-color: transparent; color: var(--text);',
  '.button.inline:hover:not(:disabled) { border-color: var(--blue); color: var(--blue);',
  'U-Claw 首次激活完成',
  '授权材料已写入',
  '已完成云端绑定和本地授权写盘',
]) {
  requireText(activationHtml, required, `activation page marker ${required}`);
}

for (const forbidden of ['UCLAW-8F2K9M', '7K4P-9Q2M-X8RT-6W3N-A5LC', 'Gateway 在线', 'custom/gpt-5.5', '本地启动授权有效', 'placeholder="UCLAW-XXXXXXXX"']) {
  if (activationHtml.includes(forbidden)) {
    throw new Error(`Activation page must not keep demo value: ${forbidden}`);
  }
}

for (const source of [
  ['macOS start script', macStart],
  ['Windows start script', windowsStart],
  ['generated macOS launcher script', generatedMacScript],
]) {
  requireText(source[1], 'UCLAW_ACTIVATION_ENDPOINT', `${source[0]} activation endpoint env`);
  requireText(source[1], 'UCLAW_ACTIVATION_REQUIRE_CLOUD', `${source[0]} activation strict env`);
  requireText(source[1], 'https://license.yiyong.me', `${source[0]} production activation endpoint`);
  if (source[1].includes('openclaw.json.last-good') || source[1].includes("'.openclaw/openclaw.json'") || source[1].includes("'openclaw.json'")) {
    throw new Error(`${source[0]} must sync activation OpenClaw config back to USB`);
  }
}
requireText(macStart, 'decompressing directly from USB archive', 'macOS start script direct archive fallback');
requireText(generatedMacScript, 'decompressing directly from USB archive', 'generated macOS launcher direct archive fallback');
requireText(macLauncher, 'kActivationRestartExitCode = 20', 'macOS legacy activation restart exit code');
requireText(windowsLauncher, 'activationRestartExitCode = 20', 'Windows legacy activation restart exit code');
requireText(windowsStart, 'if "%APP_EXIT%"=="20"', 'Windows legacy direct script activation restart loop');
requireText(packagePortable, 'writes activated data/.openclaw/openclaw.json back to USB', 'package notes activation config sync');

console.log(JSON.stringify({ ok: true, step: 'activation_only_contracts' }));
