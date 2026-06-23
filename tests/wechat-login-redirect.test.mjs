import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const server = readFileSync(join(repoRoot, 'portable', 'config-server', 'server.js'), 'utf8');
const configUi = readFileSync(join(repoRoot, 'portable', 'config-server', 'public', 'index.html'), 'utf8');

// The ilink QR API (StatusResponse in openclaw-weixin/src/auth/login-qr.ts) can return
// status "scaned_but_redirect" with a redirect_host: after the user scans, polling must
// move to a new IDC host or "confirmed" never arrives and the QR screen hangs forever.
// The config-server must mirror the plugin's redirect handling.

test('config-server follows the WeChat scaned_but_redirect IDC redirect', () => {
  // Status polling uses a redirect-aware host, not the fixed apiBaseUrl directly.
  assert.match(
    server,
    /pollWeChatQrStatus\(\s*login\.pollBaseUrl\s*\|\|\s*login\.apiBaseUrl/,
    'status polling must use login.pollBaseUrl (falls back to apiBaseUrl)',
  );

  // On scaned_but_redirect, switch the poll host to redirect_host.
  assert.match(
    server,
    /scaned_but_redirect[\s\S]{0,200}login\.pollBaseUrl\s*=\s*['"]https:\/\/['"]\s*\+\s*result\.redirect_host/,
    'must set login.pollBaseUrl to https://<redirect_host> on scaned_but_redirect',
  );

  // The redirect case is reported to the client as "scaned" so it keeps polling.
  assert.match(
    server,
    /scaned_but_redirect[\s\S]{0,260}return\s*\{\s*status:\s*['"]scaned['"]\s*\}/,
    'scaned_but_redirect should surface as status "scaned" to the client',
  );
});

test('config-server writes the Telegram bot token under the field OpenClaw reads (botToken)', () => {
  // OpenClaw's top-level telegram channel schema only reads `botToken` (the legacy
  // `token` alias is honored only inside accounts.<id>). Writing flat `token` silently
  // disables Telegram, so the Config Center must write `botToken`.
  assert.match(
    configUi,
    /channels\.telegram\s*=\s*\{[^}]*botToken:\s*tgToken/,
    'telegram channel must be saved with botToken',
  );
  assert.doesNotMatch(
    configUi,
    /channels\.telegram\s*=\s*\{[^}]*\btoken:\s*tgToken/,
    'telegram channel must not use the flat `token` field (ignored by OpenClaw)',
  );
});

test('config-server resets the poll host when the QR is refreshed', () => {
  // A refreshed QR comes from the original host, so the redirected poll host must reset,
  // otherwise the new QR would be polled against a stale redirect host.
  assert.match(
    server,
    /status:\s*'refreshed'[\s\S]{0,400}/,
    'refresh branch should exist',
  );
  assert.match(
    server,
    /login\.pollBaseUrl\s*=\s*null;[\s\S]{0,200}status:\s*'refreshed'/,
    'QR refresh must reset login.pollBaseUrl before returning refreshed',
  );
});
