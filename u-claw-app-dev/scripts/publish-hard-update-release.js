#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { firstEnv, parseEnvFile } = require('./lib/local-env');

const appDir = path.resolve(__dirname, '..');
const defaultEnvPath = path.join(appDir, '.env');
const defaultReleaseRoot = path.join(appDir, 'release', 'mock-hard-update');

function usage() {
  console.log(`Usage:
  node scripts/publish-hard-update-release.js --stage release/portable-customer/U-Claw --version 1.0.0 --channel staging
  node scripts/publish-hard-update-release.js --stage release/portable-customer/U-Claw --version 1.0.0 --channel prod --confirm-prod

Options:
  --stage <dir>       Portable stage root containing U-Claw files.
  --version <version> Release version.
  --channel <name>    staging or prod. Defaults to staging.
  --env <file>        Local env file. Defaults to .env.
  --out <dir>         Release output dir. Defaults to release/mock-hard-update.
  --confirm-prod      Required for prod upload.
  --deploy-control    Deploy update check service after upload.
`);
}

function parseArgs(argv) {
  const options = { channel: 'staging', env: defaultEnvPath, out: defaultReleaseRoot, deployControl: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--stage') options.stage = readValue();
    else if (arg === '--version') options.version = readValue();
    else if (arg === '--channel') options.channel = readValue();
    else if (arg === '--env') options.env = readValue();
    else if (arg === '--out') options.out = readValue();
    else if (arg === '--confirm-prod') options.confirmProd = true;
    else if (arg === '--deploy-control') options.deployControl = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function run(args, extraEnv = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: appDir,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed`);
}

function runShell(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: appDir,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}

function baseUrlFor(options) {
  const env = parseEnvFile(path.resolve(options.env));
  if (options.channel === 'staging') {
    return `${firstEnv(env, ['R2_STAGING_PUBLIC_URL']).replace(/\/+$/, '')}/releases`;
  }
  if (options.channel === 'prod') {
    return `${firstEnv(env, ['R2_PROD_PUBLIC_URL']).replace(/\/+$/, '')}/releases`;
  }
  throw new Error('--channel must be staging or prod');
}

function assertOptions(options) {
  if (options.help) return;
  if (!options.stage) throw new Error('--stage is required');
  if (!options.version) throw new Error('--version is required');
  if (options.channel === 'prod' && !options.confirmProd) throw new Error('--confirm-prod is required for prod');
  if (!fs.existsSync(path.resolve(options.stage))) throw new Error(`Stage not found: ${path.resolve(options.stage)}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  assertOptions(options);
  const baseUrl = baseUrlFor(options);
  run([
    'scripts/hard-update-package.js',
    'create',
    '--stage',
    options.stage,
    '--out',
    options.out,
    '--version',
    options.version,
    '--base-url',
    baseUrl,
    '--env',
    options.env
  ]);
  run(['scripts/hard-update-package.js', 'verify', '--release', options.out]);
  if (options.deployControl) {
    run([
      'scripts/hard-update-upload-r2.js',
      '--release',
      options.out,
      '--env',
      options.env,
      '--channel',
      options.channel,
      '--skip-production'
    ]);
    runShell('bash', ['scripts/deploy-hard-update-control-plane.sh'], {
      UCLAW_UPDATE_RELEASE_SOURCE: path.resolve(options.out)
    });
    run([
      'scripts/hard-update-upload-r2.js',
      '--release',
      options.out,
      '--env',
      options.env,
      '--channel',
      options.channel,
      '--only-production'
    ]);
    return;
  }
  run(['scripts/hard-update-upload-r2.js', '--release', options.out, '--env', options.env, '--channel', options.channel]);
}

try {
  main();
} catch (error) {
  console.error(`[publish-hard-update-release] ${error.message}`);
  process.exit(1);
}
