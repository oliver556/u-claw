#!/usr/bin/env node

/**
 * Verifies that the chat thinking toggle is exposed in the composer bar.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const assetsDir = path.join(root, "node_modules", "openclaw", "dist", "control-ui", "assets");
const swFile = path.join(root, "node_modules", "openclaw", "dist", "control-ui", "sw.js");
const patchFile = path.join(root, "scripts", "patch-openclaw.js");

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function findAsset(pattern, label) {
  const matches = fs.readdirSync(assetsDir).filter((name) => pattern.test(name));
  if (matches.length !== 1) {
    throw new Error(`Expected one ${label}, found ${matches.length}: ${matches.join(", ")}`);
  }
  return path.join(assetsDir, matches[0]);
}

const chatFile = findAsset(/^chat-page-.*\.js$/, "chat-page bundle");
const cssFile = findAsset(/^index-.*\.css$/, "index css bundle");
const chatSource = read(chatFile);
const cssSource = read(cssFile);
const swSource = read(swFile);
const patchSource = read(patchFile);
const compactCssSource = cssSource.replace(/\s+/g, "");
const compactPatchSource = patchSource.replace(/\s+/g, "");

const cacheMarker = "deep-thinking-control-1";
const helperToken = "function UcDeepThinkingControl(e){";
const renderToken = "${UcDeepThinkingControl(e)}";
const toggleToken = "chatShowThinking:!e.settings.chatShowThinking";
const labelToken = "深度思考";
const hideSettingsToken = ".chat-settings-popover-wrapper{display:none}";
const controlClass = ".chat-controls__deep-thinking";
const compactTokens = ["min-width:78px", "height:28px", "background:transparent"];
const hoverTokens = [
  ".chat-controls__deep-thinking:hover:not(:disabled)",
  "background:color-mix(insrgb,var(--accent-subtle)64%,white36%)",
];
const activeTokens = [
  ".chat-controls__deep-thinking--active",
  "background:color-mix(insrgb,var(--accent-subtle)82%,white18%)",
];

const checks = [
  {
    label: "runtime bundle contains deep thinking helper",
    ok: chatSource.includes(helperToken),
  },
  {
    label: "runtime composer renders deep thinking control",
    ok: chatSource.includes(renderToken),
  },
  {
    label: "runtime deep thinking control reuses chatShowThinking toggle",
    ok: chatSource.includes(toggleToken),
  },
  {
    label: "runtime control label is 深度思考",
    ok: chatSource.includes(labelToken),
  },
  {
    label: "runtime CSS hides the chat settings popover wrapper",
    ok: cssSource.includes(hideSettingsToken),
  },
  {
    label: "runtime CSS styles the deep thinking control",
    ok: cssSource.includes(controlClass),
  },
  {
    label: "runtime CSS keeps the deep thinking control compact and lightweight",
    ok: compactTokens.every((token) => compactCssSource.includes(token)),
  },
  {
    label: "runtime CSS defines deep thinking hover state",
    ok: hoverTokens.every((token) => compactCssSource.includes(token)),
  },
  {
    label: "runtime CSS defines deep thinking selected state",
    ok: activeTokens.every((token) => compactCssSource.includes(token)),
  },
  {
    label: "source patch owns deep thinking helper and render call",
    ok: patchSource.includes(helperToken) && patchSource.includes(renderToken),
  },
  {
    label: "source patch owns settings wrapper hide CSS",
    ok: patchSource.includes(hideSettingsToken) && patchSource.includes(controlClass),
  },
  {
    label: "source patch owns compact, hover, and selected styles",
    ok: compactTokens.concat(hoverTokens, activeTokens).every((token) => compactPatchSource.includes(token)),
  },
  {
    label: "source patch bumps the Service Worker cache marker",
    ok: patchSource.includes(cacheMarker),
  },
  {
    label: "runtime Service Worker cache marker includes deep thinking patch",
    ok: swSource.includes(cacheMarker),
  },
];

const failed = checks.filter((check) => !check.ok);
if (failed.length > 0) {
  for (const check of failed) {
    console.error(`FAIL ${check.label}`);
  }
  process.exit(1);
}

for (const check of checks) {
  console.log(`PASS ${check.label}`);
}
