#!/usr/bin/env node

/**
 * Verifies that chat runs schedule a short session-status poll, so stale
 * active-run indicators clear without requiring navigation to another module.
 * Terminal cleanup must also force a final refresh after local run state is
 * cleared, because the sidebar consumes the shared sessions list.
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
  [chatSource, "function uClawScheduleChatStatusPoll(", "runtime status poll scheduler"],
  [chatSource, "function uClawRefreshChatStatusNow(", "runtime terminal status refresh"],
  [chatSource, "uClawChatStatusPollTimer", "runtime poll timer state"],
  [chatSource, "n===e.sessionKey?ph(e):mh(e,s)", "runtime sessions refresh call"],
  [chatSource, "yc(e,{publishRunStatus:!0})", "runtime terminal reconcile after refresh"],
  [
    chatSource,
    "globalThis.setTimeout(()=>uClawRefreshChatStatusNow(e,{sessionKey:i,runId:r,status:t.sessionStatus,outcome:t.outcome}),900)",
    "runtime delayed terminal refresh",
  ],
  [chatSource, "function uClawStopChatStatusPoll(e,t)", "runtime poll cleanup"],
  [chatSource, "uClawScheduleChatStatusPoll(e)", "runtime poll scheduled after send"],
  [swSource, "chat-status-poll-1", "service worker cache marker"],
  [swSource, "chat-terminal-final-refresh-1", "terminal refresh service worker cache marker"],
  [patchSource, "sessionRefreshWithStatusPolling", "patch source of truth"],
];

for (const [source, needle, label] of checks) {
  if (!source.includes(needle)) {
    throw new Error(`Missing ${label}: ${needle}`);
  }
}

console.log("chat status polling verified");
