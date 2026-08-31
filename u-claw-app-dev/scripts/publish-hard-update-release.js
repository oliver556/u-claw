#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { firstEnv, parseEnvFile } = require('./lib/local-env');

const appDir = path.resolve(__dirname, '..');
const defaultEnvPath = path.join(appDir, '.env');
const defaultReleaseRoot = path.join(appDir, 'release', 'mock-hard-update');
const defaultReleasesBaseUrl = 'https://oss-download.yiyong.me/bavi-box/releases';

function usage() {
  console.log(`Usage:
  node scripts/publish-hard-update-release.js --stage release/portable-customer/Bavi-box --version 1.0.1 --channel prod --confirm-prod

Options:
  --stage <dir>       Portable stage root containing Bavi-box files.
  --version <version> Release version.
  --channel <name>    staging or prod. Defaults to staging.
  --env <file>        Local env file. Defaults to .env.
  --out <dir>         Release output dir. Defaults to release/mock-hard-update.
  --confirm-prod      Required for prod upload.
  --keep <count>      Keep newest N package versions on OSS. Defaults to 3.
  --base-url <url>    Public OSS releases base URL. Defaults to ${defaultReleasesBaseUrl}.
`);
}

function parseArgs(argv) {
  const options = { channel: 'staging', env: defaultEnvPath, out: defaultReleaseRoot };
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
    else if (arg === '--platform') options.platform = readValue();
    else if (arg === '--env') options.env = readValue();
    else if (arg === '--out') options.out = readValue();
    else if (arg === '--keep') options.keep = readValue();
    else if (arg === '--base-url') options.baseUrl = readValue();
    else if (arg === '--confirm-prod') options.confirmProd = true;
    else if (arg === '--deploy-control') throw new Error('--deploy-control is deprecated for static OSS releases');
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

function baseUrlFor(options) {
  const env = parseEnvFile(path.resolve(options.env));
  const channel = options.channel.toLowerCase();
  const channelPrefix = channel === 'staging' ? 'STAGING' : 'PROD';
  if (channel !== 'staging' && channel !== 'prod') throw new Error('--channel must be staging or prod');
  if (options.baseUrl) return options.baseUrl.replace(/\/+$/, '');
  const baseUrl = firstEnv(env, [
    `DOWNLOAD_${channelPrefix}_OSS_RELEASES_BASE_URL`,
    `DOWNLOAD_${channelPrefix}_RELEASES_BASE_URL`,
    'UCLAW_OSS_RELEASES_BASE_URL',
    'UCLAW_RELEASES_BASE_URL'
  ]);
  if (baseUrl) return baseUrl.replace(/\/+$/, '');
  const publicRoot = firstEnv(env, [`DOWNLOAD_${channelPrefix}_OSS_PUBLIC_URL`, 'DOWNLOAD_OSS_PUBLIC_URL']);
  if (publicRoot) return `${publicRoot.replace(/\/+$/, '')}/bavi-box/releases`;
  return defaultReleasesBaseUrl;
}

function assertOptions(options) {
  if (options.help) return;
  if (!options.stage) throw new Error('--stage is required');
  if (!options.version) throw new Error('--version is required');
  if (!options.confirmProd) throw new Error('--confirm-prod is required for OSS publish');
  if (options.platform) throw new Error('--platform is disabled for OSS publish; publish full Mac/Win release together');
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
  ].concat(options.platform ? ['--platform', options.platform] : []));
  run(['scripts/hard-update-package.js', 'verify', '--release', options.out]);
  run([
    'scripts/hard-update-upload-oss.js',
    '--release',
    options.out,
    '--env',
    options.env,
    '--base-url',
    baseUrl
  ].concat(options.keep ? ['--keep', options.keep] : []));
}

try {
  main();
} catch (error) {
  console.error(`[publish-hard-update-release] ${error.message}`);
  process.exit(1);
}
