#!/usr/bin/env node

/**
 * Verifies that Windows does not render the native Electron menu bar.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const mainFile = path.join(root, "src", "main.js");
const source = fs.readFileSync(mainFile, "utf8");

const checks = [
  {
    label: "BrowserWindow removes the native menu on Windows",
    ok:
      source.includes("if (process.platform === 'win32') {")
      && source.includes("mainWindow.setMenu(null);"),
  },
  {
    label: "createMenu removes the application menu on Windows",
    ok: source.includes("if (process.platform === 'win32')") && source.includes("Menu.setApplicationMenu(null);"),
  },
  {
    label: "Windows menu removal does not rely on auto-hide",
    ok: !source.includes("autoHideMenuBar: process.platform === 'win32'"),
  },
  {
    label: "macOS and other platforms still build the application menu",
    ok: source.includes("Menu.setApplicationMenu(Menu.buildFromTemplate(template));"),
  },
  {
    label: "Windows branch runs before the menu template is built",
    ok:
      source.indexOf("Menu.setApplicationMenu(null);") > source.indexOf("function createMenu()")
      && source.indexOf("Menu.setApplicationMenu(null);") < source.indexOf("const template = ["),
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
