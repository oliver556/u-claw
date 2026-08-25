#!/usr/bin/env node

/**
 * Verifies that the U-Claw session rename menu uses the in-app dialog.
 * Native `window.prompt` is unreliable inside packaged Electron windows.
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

const indexFile = findAsset(/^index-.*\.js$/, "index bundle");
const indexSource = read(indexFile);
const swSource = read(swFile);
const patchSource = read(patchFile);

const renameReplacement =
  "async renameSession(e){let t=await UcPromptSessionName(D(`sessionsView.renameSessionPrompt`),e.label);t!==null&&await this.patchSession(e,{label:w(t)??null})}";
const cacheMarker = "session-rename-1";

const checks = [
  {
    label: "runtime bundle contains in-app rename dialog helper",
    ok: indexSource.includes("function UcPromptSessionName(e,t)"),
  },
  {
    label: "runtime renameSession awaits the in-app dialog",
    ok: indexSource.includes(renameReplacement),
  },
  {
    label: "runtime renameSession no longer uses native window.prompt",
    ok: !indexSource.includes("window.prompt(D(`sessionsView.renameSessionPrompt`),e.label)"),
  },
  {
    label: "source patch owns the in-app rename dialog helper",
    ok: patchSource.includes("function UcPromptSessionName(e,t)"),
  },
  {
    label: "source patch owns the renameSession replacement",
    ok: patchSource.includes(renameReplacement),
  },
  {
    label: "source patch bumps the Service Worker cache marker",
    ok: patchSource.includes(cacheMarker),
  },
  {
    label: "runtime Service Worker cache marker includes session rename patch",
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
