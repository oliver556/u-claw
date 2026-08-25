#!/usr/bin/env node

/**
 * Verifies that the sidebar New Session action is visually pinned near the top.
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

const cssFile = findAsset(/^index-.*\.css$/, "index css bundle");
const cssSource = read(cssFile);
const patchSource = read(patchFile);
const swSource = read(swFile);

const cacheMarker = "new-session-top-1";
const requiredCssTokens = [
  ".sidebar-shell{position:relative}",
  ".sidebar-shell__body{padding-top:36px}",
  ".sidebar-sessions>.sidebar-new-session",
  ".sidebar-sessions>openclaw-tooltip>.sidebar-new-session",
  ".sidebar-sessions>.sidebar-new-session-group",
  "top:62px",
  "z-index:12",
];

const checks = [
  {
    label: "runtime CSS pins New Session action in the sidebar top slot",
    ok: requiredCssTokens.every((token) => cssSource.includes(token)),
  },
  {
    label: "source patch owns New Session top CSS",
    ok: requiredCssTokens.every((token) => patchSource.includes(token)),
  },
  {
    label: "source patch bumps the Service Worker cache marker",
    ok: patchSource.includes(cacheMarker),
  },
  {
    label: "runtime Service Worker cache marker includes New Session top patch",
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
