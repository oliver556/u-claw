#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');
const { parseEnvFile } = require('./lib/local-env');

const appDir = path.resolve(__dirname, '..');
const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error('[with-local-env] missing command');
  process.exit(1);
}

const env = {
  ...process.env,
  ...parseEnvFile(path.join(appDir, '.env'))
};

const child = spawn(command, args, {
  cwd: appDir,
  env,
  stdio: 'inherit',
  shell: false
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', error => {
  console.error(`[with-local-env] ${error.message}`);
  process.exit(1);
});
