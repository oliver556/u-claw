#!/usr/bin/env node

/**
 * Verifies that the sidebar New Session action uses the same row rhythm as
 * the primary navigation and does not rely on absolute positioning.
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
const jsFile = findAsset(/^index-.*\.js$/, "index js bundle");
const cssSource = read(cssFile);
const jsSource = read(jsFile);
const patchSource = read(patchFile);
const swSource = read(swFile);

const cacheMarker = "new-session-row-2";
const activeRunCacheMarker = "sidebar-new-session-active-run-2";
const requiredCssTokens = [
  ".sidebar-shell{position:relative}",
  ".sidebar-shell__body{padding-top:0}",
  ".sidebar-new-session-slot{flex:none;padding:0 6px 8px}",
  ".sidebar-brand__actions>openclaw-tooltip{display:contents}",
  ".sidebar-nav {\n  padding: 0 0 6px;",
  ".sidebar-new-session-slot>.sidebar-new-session",
  ".sidebar-new-session-slot>.sidebar-new-session-group",
  "grid-template-columns: minmax(0, 1fr) 44px",
  "width:30px",
  "min-height: 44px",
  "border: 1px solid transparent",
  "background: transparent",
  "background: rgba(255, 255, 255, 0.58)",
  ".sidebar--collapsed .sidebar-new-session-slot {\n  display: none;",
  ".sidebar--collapsed .sidebar-brand__actions {\n  gap: 8px;",
  ".sidebar--collapsed .sidebar-brand__actions .sidebar-new-session-group {\n  display: contents;",
];

const checks = [
  {
    label: "runtime CSS renders New Session as a sidebar row and collapsed rail icon",
    ok: requiredCssTokens.every((token) => cssSource.includes(token)),
  },
  {
    label: "runtime JS allows New Session while current chat is still running",
    ok:
      jsSource.includes("a=!this.connected||this.sessionsLoading;return{routeSessionKey:n.currentSessionKey") &&
      jsSource.includes("selectedSession:n.selectedSession") &&
      jsSource.includes("selectedSession:o}=this.getSessionNavigationState()") &&
      jsSource.includes("...s?{}:{currentSessionKey:n}") &&
      jsSource.includes("renderNewSessionAction(){") &&
      jsSource.includes("${this.collapsed?this.renderNewSessionAction():l}") &&
      jsSource.includes("${this.collapsed?l:this.renderNewSessionAction()}") &&
      !jsSource.includes("newSessionDisabled:a,newSessionTitle:this.connected?n.selectedSession?.hasActiveRun") &&
      !jsSource.includes("sessions.create({currentSessionKey:n,agentId:r"),
  },
  {
    label: "source patch owns New Session row CSS",
    ok: requiredCssTokens.every((token) => patchSource.includes(token)),
  },
  {
    label: "source patch owns active-run New Session behavior",
    ok:
      patchSource.includes("a=!this.connected||this.sessionsLoading;return{routeSessionKey:n.currentSessionKey") &&
      patchSource.includes("...s?{}:{currentSessionKey:n}") &&
      patchSource.includes("renderNewSessionAction(){") &&
      patchSource.includes("${this.collapsed?this.renderNewSessionAction():l}") &&
      patchSource.includes("${this.collapsed?l:this.renderNewSessionAction()}") &&
      patchSource.includes(activeRunCacheMarker),
  },
  {
    label: "source patch bumps the Service Worker cache marker",
    ok: patchSource.includes(cacheMarker) && patchSource.includes(activeRunCacheMarker),
  },
  {
    label: "runtime Service Worker cache marker includes New Session top patch",
    ok: swSource.includes(cacheMarker) && swSource.includes(activeRunCacheMarker),
  },
];

const failed = checks.filter((check) => !check.ok);
const forbiddenCssTokens = [
  "top:62px",
  "top:85px",
  ".sidebar--collapsed .sidebar-brand__actions .sidebar-brand__icon + .sidebar-brand__icon{margin-top:34px}",
  ".sidebar-sessions>.sidebar-new-session,\n.sidebar-sessions>openclaw-tooltip>.sidebar-new-session,\n.sidebar-sessions>.sidebar-new-session-group{position:absolute",
];
for (const token of forbiddenCssTokens) {
  if (cssSource.includes(token) || patchSource.includes(token)) {
    failed.push({ label: `New Session should not use absolute offset token: ${token}` });
  }
}
if (failed.length > 0) {
  for (const check of failed) {
    console.error(`FAIL ${check.label}`);
  }
  process.exit(1);
}

for (const check of checks) {
  console.log(`PASS ${check.label}`);
}
