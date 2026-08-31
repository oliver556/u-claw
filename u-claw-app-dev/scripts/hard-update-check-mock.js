#!/usr/bin/env node
const path = require('path');
const { readJson } = require('./lib/hard-update-utils');

const stagingBaseUrl = 'https://oss-download.yiyong.me/bavi-box/releases';

function usage() {
  console.log(`Usage:
  node scripts/hard-update-check-mock.js --release release/mock-hard-update --platform win32-x64 --device 22222222-2222-4222-8222-222222222222

Options:
  --release <dir>          Local release root. Optional.
  --platform <key>         win32-x64, darwin-arm64, darwin-x64. Defaults to current platform.
  --device <id>            devices.device_id.
  --installed-version <v>  Client installed version. Defaults to 0.0.0.
  --base-url <url>         Public releases base URL. Defaults to OSS.
`);
}

function parseArgs(argv) {
  const options = {
    platform: `${process.platform}-${process.arch}`,
    installedVersion: '0.0.0',
    baseUrl: stagingBaseUrl,
    device: '22222222-2222-4222-8222-222222222222'
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--release') options.release = readValue();
    else if (arg === '--platform') options.platform = readValue();
    else if (arg === '--license') options.license = readValue();
    else if (arg === '--device') options.device = readValue();
    else if (arg === '--installed-version') options.installedVersion = readValue();
    else if (arg === '--base-url') options.baseUrl = readValue().replace(/\/+$/, '');
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function loadProduction(options) {
  if (!options.release) {
    return {
      requiredVersion: null,
      releaseId: null,
      platforms: {
        [options.platform]: {
          manifestUrl: `${options.baseUrl}/packages/<releaseId>/${options.platform}/manifest.json`
        }
      }
    };
  }
  return readJson(path.join(path.resolve(options.release), 'production.json'));
}

function buildContract(options) {
  const production = loadProduction(options);
  const platformInfo = production.platforms?.[options.platform] || null;
  const requiredVersion = production.requiredVersion || '<requiredVersion>';
  const releaseId = production.releaseId || '<releaseId>';
  const manifestUrl = platformInfo?.manifestUrl || `${options.baseUrl}/packages/${releaseId}/${options.platform}/manifest.json`;
  return {
    schemaVersion: 1,
    service: 'aliyun-update-check-mock',
    controlPlaneOnly: true,
    downloadPlane: 'oss-static',
    request: {
      authorization: 'Bearer <device_token>',
      deviceId: options.device,
      platform: options.platform,
      installedVersion: options.installedVersion
    },
    authContract: {
      tokenDigest: 'sha256(raw_device_token), stored as 32-byte bytea',
      joins: [
        'device_access_tokens.token -> licenses by license_id + device_id',
        'device_access_tokens.token -> devices by device_id + inventory_id',
        'device_access_tokens.token -> activation_inventory by inventory_id'
      ],
      allowedStatuses: {
        token: ['active'],
        license: ['active'],
        device: ['active'],
        inventory: ['active']
      },
      timeWindow: 'license.not_before <= now() AND license.expires_at > now()'
    },
    response: {
      allowed: true,
      requiredVersion,
      releaseId,
      forceUpdate: options.installedVersion !== requiredVersion,
      productionUrl: `${options.baseUrl}/production.json`,
      manifestUrl,
      packageUrl: `${options.baseUrl}/packages/${releaseId}/${options.platform}/runtime.pkg`,
      shortConfig: {
        videoAdapterBaseUrl: 'https://api.yiyong.me/v1',
        aliyunControlPlane: true,
        ossStaticDownloads: true,
        containsSecret: false
      }
    },
    notes: [
      'Mock only. Does not connect to Aliyun or OSS.',
      'Aliyun control plane decides license/device/version/gray/forceUpdate.',
      'OSS serves runtime.pkg and static release metadata; Aliyun control plane does not proxy large package downloads.',
      'No VPS password, New API key, or client secret belongs in this contract.'
    ]
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  console.log(JSON.stringify(buildContract(options), null, 2));
}

try {
  main();
} catch (error) {
  console.error(`[hard-update-check-mock] ${error.message}`);
  process.exit(1);
}
