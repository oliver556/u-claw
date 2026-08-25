#!/usr/bin/env node

/**
 * Verifies chat terminal states clear live tool Activity as soon as a run ends.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const assetsDir = path.join(root, "node_modules", "openclaw", "dist", "control-ui", "assets");
const swFile = path.join(root, "node_modules", "openclaw", "dist", "control-ui", "sw.js");
const patchFile = path.join(root, "scripts", "patch-openclaw.js");

/**
 * Reads a UTF-8 text file.
 */
function read(file) {
  return fs.readFileSync(file, "utf8");
}

/**
 * Finds the single generated Control UI asset matching the current build hash.
 */
function findAsset(pattern, label) {
  const matches = fs.readdirSync(assetsDir).filter((name) => pattern.test(name));
  if (matches.length !== 1) {
    throw new Error(`Expected one ${label}, found ${matches.length}: ${matches.join(", ")}`);
  }
  return path.join(assetsDir, matches[0]);
}

const chatFile = findAsset(/^chat-page-.*\.js$/, "chat-page bundle");
const chatSource = read(chatFile);
const swSource = read(swFile);
const patchSource = read(patchFile);

const cacheMarker = "chat-terminal-toolstream-clear-1";
const sessionStatusToken =
  "runId:e.chatRunId,sessionKey:e.sessionKey,sessionKeys:[t.key],clearLocalRun:!0,clearChatStream:!0,clearToolStream:!0,publishRunStatus:n.publishRunStatus";
const chatEventToken =
  "runId:a,sessionKey:e.sessionKey,sessionKeys:r?[e.sessionKey,t.sessionKey]:[],clearLocalRun:!0,clearChatStream:!0,clearToolStream:!0,armLocalTerminalReconcile:n&&i";

const checks = [
  {
    label: "runtime session status terminal path clears live tool stream",
    ok: chatSource.includes(sessionStatusToken),
  },
  {
    label: "runtime chat event terminal path clears live tool stream",
    ok: chatSource.includes(chatEventToken),
  },
  {
    label: "source patch owns session status terminal cleanup",
    ok: patchSource.includes(sessionStatusToken),
  },
  {
    label: "source patch owns chat event terminal cleanup",
    ok: patchSource.includes(chatEventToken),
  },
  {
    label: "source patch bumps the Service Worker cache marker",
    ok: patchSource.includes(cacheMarker),
  },
  {
    label: "runtime Service Worker cache marker includes terminal cleanup patch",
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
