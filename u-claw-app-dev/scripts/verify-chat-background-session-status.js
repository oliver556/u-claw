#!/usr/bin/env node

/**
 * Verifies that a run started in one chat session keeps clearing that session's
 * running indicator even if the user switches to another session before finish.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const assetsDir = path.join(root, "node_modules/openclaw/dist/control-ui/assets");
const chatFile = fs
  .readdirSync(assetsDir)
  .find((name) => /^chat-page-.*\.js$/.test(name));
const swPath = path.join(root, "node_modules/openclaw/dist/control-ui/sw.js");
const patchPath = path.join(root, "scripts/patch-openclaw.js");

if (!chatFile) {
  throw new Error("Missing OpenClaw Control UI chat asset");
}

const chatSource = fs.readFileSync(path.join(assetsDir, chatFile), "utf8");
const swSource = fs.readFileSync(swPath, "utf8");
const patchSource = fs.readFileSync(patchPath, "utf8");

const checks = [
  [chatSource, "uClawChatStatusPollTimers", "per-session poll timer map"],
  [chatSource, "function uClawRefreshChatStatusNow(e,t={})", "targeted terminal refresh"],
  [chatSource, "Promise.resolve(mh(e,{sessionKey:n", "targeted session refresh"],
  [chatSource, "function uClawHandleBackgroundSessionTerminal(", "background terminal handler"],
  [chatSource, "uClawHandleBackgroundSessionTerminal(e,t)", "background terminal event hook"],
  [chatSource, "t.outcome&&uClawStopChatStatusPoll(e,i)", "terminal-only poll cleanup"],
  [chatSource, "uClawScheduleChatStatusPoll(e,{sessionKey:l,runId:r.runId", "send path schedules original session"],
  [chatSource, "uClawScheduleChatStatusPoll(e,{sessionKey:t.sessionKey,runId:t.runId", "stream path schedules event session"],
  [swSource, "chat-background-session-status-1", "service worker cache marker"],
  [patchSource, "chatBackgroundSessionStatus", "patch source of truth"],
];

const forbidden = [
  [chatSource, "if(!e.connected||e.sessionKey!==i||!e.chatRunId&&e.chatStream==null)", "poll stops when user switches session"],
  [chatSource, "t.clearLocalRun&&(e.chatRunId=null,uClawStopChatStatusPoll(e))", "session switch clears background poll"],
];

for (const [source, needle, label] of checks) {
  if (!source.includes(needle)) {
    throw new Error(`Missing ${label}: ${needle}`);
  }
}

for (const [source, needle, label] of forbidden) {
  if (source.includes(needle)) {
    throw new Error(`Forbidden ${label}: ${needle}`);
  }
}

console.log("chat background session status verified");
