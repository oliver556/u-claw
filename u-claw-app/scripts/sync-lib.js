// Sync portable/ -> u-claw-app/ before dev/build.
// Single source of truth lives under portable/ (used by Windows-Start.bat,
// Mac-Start.command, and config-server). The Electron desktop app embeds a
// runtime copy because asar packaging cannot reach across siblings.

const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const PORTABLE_DIR = path.resolve(APP_DIR, '..', 'portable');

const COPIES = [
  { from: path.join(PORTABLE_DIR, 'lib', 'fingerprint.mjs'),       to: path.join(APP_DIR, 'src', 'lib', 'fingerprint.mjs') },
  { from: path.join(PORTABLE_DIR, 'lib', 'xiapan-client.mjs'),     to: path.join(APP_DIR, 'src', 'lib', 'xiapan-client.mjs') },
  { from: path.join(PORTABLE_DIR, 'lib', 'bootstrap-xiapan.mjs'),  to: path.join(APP_DIR, 'src', 'lib', 'bootstrap-xiapan.mjs') },
  { from: path.join(PORTABLE_DIR, 'Config.html'),                  to: path.join(APP_DIR, 'resources', 'Config.html') },
];

for (const { from, to } of COPIES) {
  if (!fs.existsSync(from)) {
    console.error(`[sync-lib] Missing ${from}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`[sync-lib] ${path.relative(APP_DIR, to)}`);
}
