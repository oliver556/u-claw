const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const assetsDir = path.join(root, 'node_modules', 'openclaw', 'dist', 'control-ui', 'assets');

function readAsset(pattern, label) {
  const name = fs.readdirSync(assetsDir).find((entry) => pattern.test(entry));
  if (!name) throw new Error(`Missing ${label}`);
  return fs.readFileSync(path.join(assetsDir, name), 'utf8');
}

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function check(ok, label) {
  if (!ok) throw new Error(`Missing ${label}`);
  console.log(`PASS ${label}`);
}

const chat = readAsset(/^chat-page-.*\.js$/, 'chat page asset');
const index = readAsset(/^index-.*\.js$/, 'index asset');
const css = readAsset(/^index-.*\.css$/, 'index stylesheet');
const debug = readAsset(/^debug-page-.*\.js$/, 'debug page asset');
const main = readProjectFile('src/main.js');
const preload = readProjectFile('src/preload.js');
const patch = readProjectFile('scripts/patch-openclaw.js');

check(chat.includes('function uClawInputDebugEnabled()'), 'chat input debug helper');
check(chat.includes('function Ty(e){let t=ov(e.paneId),n=e.canSend,'), 'chat input ignores transport connection for focus');
check(chat.includes('canSend:!r,disabledReason:i'), 'chat page send capability keeps archived guard');
check(chat.includes('ae={canAbort:l,connected:n,'), 'composer controls receive send capability instead of transport connection');
check(chat.includes('?disabled=${!1}'), 'chat textarea remains enabled');
check(chat.includes('@click=${t=>{uClawInputDebug(`shell-click`'), 'composer shell click logs and focuses');
check(chat.includes('@keydown=${t=>{uClawInputDebug(`keydown`'), 'chat keydown diagnostics');
check(chat.includes('@input=${t=>{uClawInputDebug(`input`'), 'chat input diagnostics');
check(chat.includes('?disabled=${!e.connected||e.sending||!t}'), 'send button disables when session cannot send or composer is empty');
check(!chat.includes('function Ty(e){let t=ov(e.paneId),n=e.connected&&e.canSend,'), 'transport connection no longer disables composer');
check(!chat.includes('?disabled=${!n}\n              aria-autocomplete="list"'), 'textarea no longer uses canSend disabled binding');

check(index.includes('e.isComposing||e.keyCode===229'), 'rename dialog ignores IME composition enter');
check(index.includes('e.key===`Tab`'), 'rename dialog traps tab focus');
check(index.includes('setTimeout(f,80)'), 'rename dialog retries focus');

check(css.includes('.sw-handoff-veil--landing,.sw-handoff-veil[hidden],.sw-handoff-veil.is-hidden{pointer-events:none!important}'), 'handoff veil landing state does not capture clicks');

check(debug.includes('function uClawDebugInputEnabled()'), 'debug page input diagnostics getter');
check(debug.includes('function uClawSetDebugInputEnabled(e)'), 'debug page input diagnostics setter');
check(debug.includes('开启输入诊断日志'), 'debug page input diagnostics toggle');

check(preload.includes("writeDebuggerLog: (payload) => ipcRenderer.invoke('uclaw:write-debugger-log', payload)"), 'preload exposes debugger log IPC');
check(main.includes("ipcMain.handle('uclaw:write-debugger-log'"), 'main handles debugger log IPC');
check(main.includes("appendLogFile('input-debug.log'"), 'main writes input-debug.log');

check(patch.includes('function patchDebugPageInputDiagnostics()'), 'source patch owns debug page toggle');
check(patch.includes('patchDebugPageInputDiagnostics();'), 'source patch runs debug page toggle patch');
