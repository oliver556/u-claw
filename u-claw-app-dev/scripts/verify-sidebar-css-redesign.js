#!/usr/bin/env node

/**
 * Verifies that the left sidebar redesign is owned by CSS-only patch tokens.
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
const swSource = read(swFile);
const patchSource = read(patchFile);
const compactCssSource = cssSource.replace(/\s+/g, "");
const compactPatchSource = patchSource.replace(/\s+/g, "");

const cacheMarker = "sidebar-command-shelf-3";
const cssMarker = "/* sidebar-command-shelf-3 */";
const requiredTokens = [
  ".sidebar-shell{position:relative}",
  ".sidebar-brand{min-height:38px",
  ".nav-item.active,.nav-item--active",
  ".sidebar-recent-session--active:before",
  ".sidebar-new-session{min-height:46px",
  ".sidebar-recent-session{min-height:36px",
  ".sidebar-footer-bar{min-height:34px",
];
const compactTokens = [
  ".sidebar-shell__body{padding-top:36px}",
  ".sidebar-nav{padding:12px06px;}",
  ".nav-item{min-height:44px;border-radius:8px;padding:011px;gap:10px;font-size:15px;",
  ".nav-item__icon,.nav-item__iconsvg{width:19px;height:19px;}",
  ".nav-item__text{font-weight:650;}",
  ".nav-item.active,.nav-item--active{color:var(--uclaw-navy);background:color-mix(insrgb,var(--accent-subtle)38%,white62%);border-color:transparent!important;box-shadow:none!important;}",
  ".nav-item.active:before,.nav-item--active:before{content:none;}",
  ".sidebar-new-session{min-height:46px;border:1pxsolidcolor-mix(insrgb,var(--border)72%,transparent);border-radius:8px;background:rgba(255,255,255,0.5);box-shadow:none;gap:10px;padding:013px;font-size:15px;font-weight:680;",
  ".sidebar-sessions>.sidebar-new-session,.sidebar-sessions>openclaw-tooltip>.sidebar-new-session{left:20px;right:72px;}",
  ".sidebar-sessions>.sidebar-new-session-group{left:20px;right:20px;display:grid;grid-template-columns:minmax(0,1fr)46px;gap:8px;align-items:center;width:auto;}",
  ".sidebar-new-session--worktree{width:46px;min-height:46px;justify-content:center;padding:0;color:#8792a4;background:transparent;}",
  ".sidebar-new-session__icon,.sidebar-new-session__iconsvg{width:19px;height:19px;}",
  ".sidebar-recent-session--active{color:var(--uclaw-navy);background:rgba(22,119,255,0.075);border-color:transparent;box-shadow:none;}",
  ".sidebar-recent-session--active:before{content:\"\";width:7px;height:7px;border-radius:999px",
  "box-shadow:0003pxcolor-mix(insrgb,var(--accent-subtle)56%,transparent)",
];

const checks = [
  {
    label: "runtime CSS contains sidebar redesign marker",
    ok: cssSource.includes(cssMarker),
  },
  {
    label: "runtime CSS contains redesigned sidebar selectors",
    ok: requiredTokens.every((token) => compactCssSource.includes(token.replace(/\s+/g, ""))),
  },
  {
    label: "runtime CSS contains compact visual state tokens",
    ok: compactTokens.every((token) => compactCssSource.includes(token)),
  },
  {
    label: "source patch owns sidebar redesign CSS",
    ok: patchSource.includes(cssMarker) && requiredTokens.every((token) => compactPatchSource.includes(token.replace(/\s+/g, ""))),
  },
  {
    label: "source patch owns compact visual state tokens",
    ok: compactTokens.every((token) => compactPatchSource.includes(token)),
  },
  {
    label: "source patch bumps the Service Worker cache marker",
    ok: patchSource.includes(cacheMarker),
  },
  {
    label: "runtime Service Worker cache marker includes sidebar redesign patch",
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
