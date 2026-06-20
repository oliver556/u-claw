import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function readRepoFile(...parts) {
  return readFileSync(join(repoRoot, ...parts), 'utf8');
}

function lineOf(content, needle) {
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(needle));
  assert.notEqual(index, -1, `missing line containing: ${needle}`);
  return lines[index];
}

test('Windows-Start dependency fallback text escapes parentheses inside IF block', () => {
  const script = readRepoFile('portable', 'Windows-Start.bat');

  assert.match(
    lineOf(script, 'Falling back to npm install'),
    /\^\(USB drives may take 20\+ minutes\^\)\./,
  );
  assert.match(
    lineOf(script, 'pre-installed deps'),
    /\^\(~200 MB\^\)\./,
  );
});

test('portable Windows launchers disable OpenClaw bonjour discovery', () => {
  for (const scriptName of [
    'Windows-Start.bat',
    'Windows-Menu.bat',
    'Windows-Install.bat',
  ]) {
    const script = readRepoFile('portable', scriptName);
    assert.match(
      script,
      /OPENCLAW_DISABLE_BONJOUR=1/,
      `${scriptName} should disable bonjour discovery`,
    );
  }
});

test('Windows startup keeps Config Center available even after model setup', () => {
  const script = readRepoFile('portable', 'Windows-Start.bat');

  assert.match(
    script,
    /Opening Config Center[\s\S]*start "" http:\/\/127\.0\.0\.1:18788\//,
    'Windows-Start.bat should always open Config Center for model/channel changes',
  );
  assert.doesNotMatch(
    script,
    /if not defined MODEL_CONFIGURED/,
    'Config Center should not be gated on first-time setup only',
  );
});

test('Windows gateway fallback does not force-open Dashboard', () => {
  const script = readRepoFile('portable', 'lib', 'wait-gateway.bat');

  assert.match(
    script,
    /:timeout[\s\S]*start "" http:\/\/127\.0\.0\.1:18788\//,
    'wait-gateway.bat should return users to Config Center on timeout',
  );
  assert.doesNotMatch(
    script,
    /#token=uclaw/,
    'fallback should not push configured users straight into Dashboard',
  );
  assert.doesNotMatch(
    lineOf(script, ':ready') + '\n' + lineOf(script, 'exit /b 0'),
    /start ""/,
    'ready fallback should not open duplicate browser tabs',
  );
});

test('PowerShell installer generated start.bat disables OpenClaw bonjour discovery', () => {
  const script = readRepoFile('install', 'install.ps1');

  assert.match(script, /\$startBat = @'/);
  assert.match(
    script,
    /set "OPENCLAW_DISABLE_BONJOUR=1"/,
    'generated start.bat should disable bonjour discovery',
  );
});

test('Electron desktop launcher disables OpenClaw bonjour discovery on Windows only', () => {
  const source = readRepoFile('u-claw-app', 'src', 'main.js');

  assert.match(
    source,
    /if\s*\(\s*process\.platform\s*===\s*['"]win32['"]\s*\)\s*{[\s\S]*?env\.OPENCLAW_DISABLE_BONJOUR\s*=\s*['"]1['"]/,
  );
  assert.doesNotMatch(
    source,
    /OPENCLAW_DISABLE_BONJOUR:\s*['"]1['"]/,
    'bonjour disable flag should not be in the unconditional env object',
  );
});
