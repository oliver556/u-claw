#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const mac = fs.readFileSync(path.join(root, 'scripts', 'Mac-Start-App.command'), 'utf8');
const win = fs.readFileSync(path.join(root, 'scripts', 'Windows-Start-App.bat'), 'utf8');
const winSync = fs.readFileSync(path.join(root, 'scripts', 'Windows-Sync-Data.ps1'), 'utf8');
const winLauncher = fs.readFileSync(path.join(root, 'scripts', 'launcher', 'windows', 'main.go'), 'utf8');
const macLauncher = fs.readFileSync(path.join(root, 'scripts', 'launcher', 'macos', 'main.c'), 'utf8');
const packagePortable = fs.readFileSync(path.join(root, 'scripts', 'package-portable.js'), 'utf8');
const patchOpenClaw = fs.readFileSync(path.join(root, 'scripts', 'patch-openclaw.js'), 'utf8');
const controlUiGateway = fs.readFileSync(path.join(root, 'node_modules', 'openclaw', 'dist', 'control-ui-CuoxgbYo.js'), 'utf8');

function assertIncludes(label, text, needle) {
  if (!text.includes(needle)) throw new Error(`${label} missing ${needle}`);
}

function assertNotIncludes(label, text, needle) {
  if (text.includes(needle)) throw new Error(`${label} must not contain ${needle}`);
}

for (const [label, text] of [['Mac script', mac], ['Windows script', win]]) {
  assertIncludes(label, text, 'UCLAW_PORTABLE_ROOT');
  assertIncludes(label, text, 'UCLAW_CACHE_ROOT');
  assertIncludes(label, text, 'UCLAW_APP_CACHE_DIR');
  assertIncludes(label, text, 'UCLAW_ARCHIVE_CACHE');
  assertIncludes(label, text, 'UCLAW_APP_CACHE_STAMP');
}

assertIncludes('main.js', main, 'update-shutdown-request.json');
assertIncludes('main.js', main, 'shutdown-complete.json');
assertIncludes('main.js', main, 'run-state.json');
assertIncludes('main.js', main, 'requestAppQuit({ confirm: false, reason: \'update\' })');
assertIncludes('main.js', main, 'writeShutdownComplete()');
assertIncludes('main.js', main, 'writeRunState(\'gateway-ready\')');
assertIncludes('main.js', main, 'writeRunState(\'shutdown-complete\')');
assertIncludes('main.js', main, 'finalPortableDataSync(\'after-stop\')');
assertIncludes('main.js', main, 'UCLAW_ELECTRON_PROFILE_DIR');
assertIncludes('main.js', main, 'electron-profile');
assertIncludes('main.js', main, 'process.platform');
assertIncludes('main.js', main, 'applyPortableLocalDesktopConfig');
assertIncludes('main.js', main, 'dangerouslyDisableDeviceAuth');
assertIncludes('main.js', main, 'requestSingleInstanceLock');
assertIncludes('main.js', main, "app.on('second-instance'");
assertIncludes('Mac script', mac, 'UCLAW_ELECTRON_PROFILE_DIR');
assertIncludes('Windows script', win, 'UCLAW_ELECTRON_PROFILE_DIR');
assertIncludes('Windows script', win, 'Windows-Sync-Data.ps1');
assertIncludes('Windows script', win, 'start "" /wait "%APP_BIN%"');
assertIncludes('Windows script', win, 'Windows desktop app exited with code');
assertIncludes('Windows script', win, 'set "HARD_UPDATE_STATUS=%ERRORLEVEL%"');
assertIncludes('Windows script', win, 'if "%HARD_UPDATE_STATUS%"=="2" goto install_app_cache');
assertIncludes('Mac script', mac, '$USB_DATA_DIR/.openclaw/media');
assertIncludes('Windows script', win, '%USB_DATA_DIR%\\.openclaw\\media');
assertIncludes('main.js', main, "usbDataPath ? path.join(usbDataPath, '.openclaw', 'media') : ''");
assertIncludes('Windows script', win, 'SYNC_PRESERVE_CONFIG=1');
assertIncludes('Windows script', win, 'SYNC_PRESERVE_CONFIG=0');
assertIncludes('Windows script', win, ':stop_existing_app_cache_processes');
assertIncludes('Windows script', win, 'Stopping {0} old U-Claw cache process(es)');
assertIncludes('Windows sync helper', winSync, 'robocopy @robocopyArgs');
assertIncludes('Windows sync helper', winSync, '$preserveConfig');
assertIncludes('Windows sync helper', winSync, '.openclaw\\devices');
assertIncludes('Windows sync helper', winSync, '.openclaw\\identity');
assertIncludes('Windows sync helper', winSync, 'openclaw.json');
for (const [lineNumber, line] of win.split(/\r?\n/).entries()) {
  if (line.length > 1800) throw new Error(`Windows script line ${lineNumber + 1} too long for cmd.exe`);
}
assertIncludes('Mac script', mac, '"copy-config"');
assertIncludes('Mac script', mac, '"preserve-config"');
for (const [label, text] of [['Mac script', mac], ['Windows sync helper', winSync]]) {
  assertIncludes(label, text, '.openclaw');
  assertIncludes(label, text, 'devices');
  assertIncludes(label, text, 'identity');
}
for (const [label, text] of [['patch-openclaw.js', patchOpenClaw], ['Control UI gateway', controlUiGateway]]) {
  assertIncludes(label, text, 'resolveUClawPortableAssistantMediaPath');
  assertIncludes(label, text, '/.openclaw/media/');
}
assertNotIncludes('main.js', main, "app.setPath('userData', userDataPath)");
for (const legacyProfilePath of ['Local Storage', 'Session Storage', 'Preferences', 'Local State']) {
  assertIncludes('main.js', main, legacyProfilePath);
  assertIncludes('Mac script', mac, legacyProfilePath);
  assertIncludes('Windows sync helper', winSync, legacyProfilePath);
}

assertIncludes('Windows launcher', winLauncher, 'CreateMutexW');
assertIncludes('Windows launcher', winLauncher, 'relaunch.request');
assertIncludes('Windows launcher', winLauncher, 'Shutdown complete');
assertIncludes('Windows launcher', winLauncher, 'Launcher process entered');
assertIncludes('Windows launcher', winLauncher, 'Missing Windows start script');
assertIncludes('Windows launcher', winLauncher, 'UCLAW_LAUNCHER_PID=');
assertIncludes('Windows launcher', winLauncher, 'Gateway ready on port');
assertNotIncludes('Windows launcher', winLauncher, 'strings.Contains(rawStatus, "Starting Windows desktop app") && !isShutdownStatus(rawStatus)');
assertIncludes('Mac launcher', macLauncher, 'flock');
assertIncludes('Mac launcher', macLauncher, 'relaunch.request');
assertIncludes('Mac launcher', macLauncher, 'Shutdown complete');
assertIncludes('package-portable.js', packagePortable, 'removeAppleDoubleFiles');
assertIncludes('package-portable.js', packagePortable, 'removed AppleDouble metadata files');

assertNotIncludes('Windows launcher', winLauncher, 'taskkill /IM');
assertNotIncludes('Windows script', win, 'taskkill /IM');

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uclaw-launcher-protocol-'));
try {
  const runtimeDir = path.join(fixtureRoot, 'app', '.runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const transactionId = 'update-fixture-1';
  const request = {
    schemaVersion: 1,
    reason: 'update',
    transactionId,
    requestedAt: new Date().toISOString()
  };
  const complete = {
    schemaVersion: 1,
    reason: 'update',
    transactionId,
    completedAt: new Date().toISOString()
  };
  const runState = {
    schemaVersion: 1,
    state: 'running',
    launcherPid: 100,
    appPid: 101,
    gatewayPid: 102,
    configServerPid: 103,
    videoAdapterPid: 104
  };
  fs.writeFileSync(path.join(runtimeDir, 'update-shutdown-request.json'), `${JSON.stringify(request)}\n`);
  fs.writeFileSync(path.join(runtimeDir, 'shutdown-complete.json'), `${JSON.stringify(complete)}\n`);
  fs.writeFileSync(path.join(runtimeDir, 'run-state.json'), `${JSON.stringify(runState)}\n`);
  const loadedRequest = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'update-shutdown-request.json')));
  const loadedComplete = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'shutdown-complete.json')));
  const loadedRunState = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'run-state.json')));
  if (loadedRequest.transactionId !== loadedComplete.transactionId) {
    throw new Error('shutdown protocol transactionId mismatch');
  }
  if (loadedRunState.state !== 'running' || loadedRunState.gatewayPid !== 102) {
    throw new Error('run-state fixture fields invalid');
  }
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('[verify-launcher-hotfix-protocol] protocol checks passed');
