#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const assetsDir = path.join(root, "node_modules", "openclaw", "dist", "control-ui", "assets");

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function firstAsset(pattern, label) {
  const file = fs.readdirSync(assetsDir).find((name) => pattern.test(name));
  if (!file) {
    throw new Error(`Missing ${label} asset in ${assetsDir}`);
  }
  return path.join(assetsDir, file);
}

function assertIncludes(source, needle, label) {
  if (!source.includes(needle)) {
    throw new Error(`Missing ${label}: ${needle}`);
  }
}

function assertNotIncludes(source, needle, label) {
  if (source.includes(needle)) {
    throw new Error(`Unexpected ${label}: ${needle}`);
  }
}

const chatJsPath = firstAsset(/^chat-page-.*\.js$/, "chat page");
const cssPath = firstAsset(/^index-.*\.css$/, "control stylesheet");
const patchPath = path.join(root, "scripts", "patch-openclaw.js");

const chatJs = read(chatJsPath);
const css = read(cssPath);
const patcher = read(patchPath);

const composerStart = chatJs.indexOf("function wy(e)");
if (composerStart === -1) {
  throw new Error("Missing composer action renderer function wy(e)");
}
const composerEnd = chatJs.indexOf("function uClawInputDebugEnabled", composerStart);
const fallbackEnd = chatJs.indexOf("function Ty(e)", composerStart);
const end = composerEnd === -1 ? fallbackEnd : composerEnd;
if (end === -1) {
  throw new Error("Could not find end of composer action renderer");
}
const composer = chatJs.slice(composerStart, end);

assertIncludes(composer, "uclaw-chat-action-btn--send", "send action class");
assertIncludes(composer, "uclaw-chat-action-btn--stop", "stop action class");
assertIncludes(composer, "?disabled=${!e.connected||e.sending||!t}", "empty-state disabled send button");
assertIncludes(composer, "e.canAbort||e.isBusy?A(`chat.runControls.queue`)", "busy queue affordance");
assertIncludes(composer, "@click=${n}", "send click handler");
assertIncludes(composer, "@click=${e.onAbort}", "abort click handler");
assertNotIncludes(composer, "chat-send-btn--voice", "voice send button");
assertNotIncludes(composer, "z.mic", "voice icon");
assertNotIncludes(composer, "${z.send}", "legacy paper-plane icon");
assertNotIncludes(composer, "${z.stop}", "legacy stop icon");

assertIncludes(css, ".uclaw-chat-action-btn", "composer action button CSS");
assertIncludes(css, ".uclaw-chat-action-btn--send:disabled", "disabled send CSS");
assertIncludes(css, ".uclaw-chat-action-btn--stop", "stop button CSS");
assertIncludes(css, ".uclaw-chat-stop-dot", "stop glyph CSS");
assertIncludes(css, ".agent-chat__composer-shell .agent-chat__input>.chat-attachments-preview", "attachment preview inside composer CSS");
assertIncludes(css, "position:static!important", "attachment preview no longer floats above composer");
assertIncludes(css, ".agent-chat__composer-shell .agent-chat__input{max-height:none!important;overflow:visible!important}", "composer grows to fit attachment preview");
assertIncludes(css, "uclaw-composer-attachments-inside-2", "attachment preview inside composer override marker");
assertIncludes(css, "uclaw-composer-neutral-focus-1", "neutral composer focus marker");
assertIncludes(css, ".agent-chat__composer-shell .agent-chat__input:focus-within{border-color:#d0d7e2!important;outline:none!important;box-shadow:0 10px 28px rgba(16,22,43,.08)!important}", "neutral composer focus style");

assertIncludes(patcher, "const composerActionsFunction", "patcher composer action replacement");
assertIncludes(patcher, "const composerActionCss", "patcher composer action CSS");
assertIncludes(patcher, "const composerAttachmentInsideCss", "patcher composer attachment inside override");
assertIncludes(patcher, "const composerNeutralFocusCss", "patcher composer neutral focus override");

console.log("chat composer action UI patch verified");
