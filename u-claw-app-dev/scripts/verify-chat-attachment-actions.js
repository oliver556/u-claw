#!/usr/bin/env node

/**
 * Verifies that patched chat image attachments expose open/save/save-as actions
 * in both available previews and blocked attachment cards.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const assetsDir = path.join(root, "node_modules/openclaw/dist/control-ui/assets");
const chatFile = fs
  .readdirSync(assetsDir)
  .find((name) => /^chat-page-.*\.js$/.test(name));
const cssFile = fs
  .readdirSync(assetsDir)
  .find((name) => /^index-.*\.css$/.test(name));
const swPath = path.join(root, "node_modules/openclaw/dist/control-ui/sw.js");
const patchPath = path.join(root, "scripts/patch-openclaw.js");

if (!chatFile || !cssFile) {
  throw new Error("Missing OpenClaw Control UI chat or CSS asset");
}

const chatSource = fs.readFileSync(path.join(assetsDir, chatFile), "utf8");
const cssSource = fs.readFileSync(path.join(assetsDir, cssFile), "utf8");
const swSource = fs.readFileSync(swPath, "utf8");
const patchSource = fs.readFileSync(patchPath, "utf8");

const checks = [
  [chatSource, "function uClawAttachmentActions(", "runtime attachment action helper"],
  [chatSource, "function uClawDownloadAttachment(", "runtime save helper"],
  [chatSource, "function uClawSaveAttachmentAs(", "runtime save-as helper"],
  [chatSource, "uclaw-chat-image-attachment", "available image action wrapper"],
  [chatSource, "uClawAttachmentActions({url:l,kind:`image`,label:e.label})", "available image action buttons"],
  [chatSource, "url:o.status===`unavailable`?e.url:void 0", "blocked image fallback URL"],
  [chatSource, "打开", "open button label"],
  [chatSource, "保存", "save button label"],
  [chatSource, "另存为", "save-as button label"],
  [cssSource, ".uclaw-attachment-actions", "attachment action CSS"],
  [swSource, "chat-attachment-actions-1", "service worker cache marker"],
  [patchSource, "attachmentActionsFunction", "patch script source of truth"],
];

for (const [source, needle, label] of checks) {
  if (!source.includes(needle)) {
    throw new Error(`Missing ${label}: ${needle}`);
  }
}

console.log("chat attachment actions verified");
