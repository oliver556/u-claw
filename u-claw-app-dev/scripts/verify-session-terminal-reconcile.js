#!/usr/bin/env node

/**
 * Verifies that terminal session reconciliation clears stale active-run rows
 * even when the session list did not include activeRunIds for the finished run.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const assetsDir = path.join(root, "node_modules/openclaw/dist/control-ui/assets");
const indexFile = fs
  .readdirSync(assetsDir)
  .find((name) => /^index-.*\.js$/.test(name));
const swPath = path.join(root, "node_modules/openclaw/dist/control-ui/sw.js");
const patchPath = path.join(root, "scripts/patch-openclaw.js");

if (!indexFile) {
  throw new Error("Missing OpenClaw Control UI index asset");
}

const indexSource = fs.readFileSync(path.join(assetsDir, indexFile), "utf8");
const swSource = fs.readFileSync(swPath, "utf8");
const patchSource = fs.readFileSync(patchPath, "utf8");

const staleGuard =
  "||(e.hasActiveRun===!0||xn(e))&&(!r||!e.activeRunIds?.includes(r)))return e;";
const tolerantGuard =
  "||(e.hasActiveRun===!0||xn(e))&&e.activeRunIds?.length&&(!r||!e.activeRunIds.includes(r)))return e;";

if (indexSource.includes(staleGuard)) {
  throw new Error("Runtime still refuses to clear terminal rows without activeRunIds");
}
if (!indexSource.includes(tolerantGuard)) {
  throw new Error("Runtime is missing tolerant terminal reconcile guard");
}
if (!swSource.includes("session-reconcile-missing-runids-1")) {
  throw new Error("Service Worker cache marker is missing session reconcile patch");
}
if (!patchSource.includes("sessionTerminalReconcileWithMissingRunIds")) {
  throw new Error("Patch source does not own the terminal reconcile change");
}

console.log("session terminal reconcile verified");
