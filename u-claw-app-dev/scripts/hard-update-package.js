#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const {
  assertSafeRelativePath,
  copyDirFiltered,
  copyFile,
  isPortableMetadataPath,
  platformParts,
  readJson,
  sha256File,
  treeDigest,
  unzipTo,
  walkFiles,
  writeJson,
  zipDirectory
} = require('./lib/hard-update-utils');
const { loadOrCreateMockKey, signPayload, verifyPayload } = require('./lib/release-signing');
const { firstEnv, parseEnvFile } = require('./lib/local-env');

const appDir = path.resolve(__dirname, '..');
const releaseDir = path.join(appDir, 'release');
const packageJson = readJson(path.join(appDir, 'package.json'));
const defaultProductionUrl = 'https://yiyong.me/uclaw/releases/production.json';
const defaultBaseUrl = 'https://yiyong.me/uclaw/releases';
const platforms = ['win32-x64', 'darwin-arm64', 'darwin-x64'];

function usage() {
  console.log(`Usage:
  node scripts/hard-update-package.js create --stage release/portable-customer/Bavi-box --out release/mock-hard-update --version 2.1.18
  node scripts/hard-update-package.js verify --release release/mock-hard-update

Options:
  --stage <dir>        Portable stage root containing Bavi-box files.
  --out <dir>          Output release directory.
  --release <dir>      Existing release directory for verify mode.
  --version <version>  Product version. Defaults to package.json version.
  --base-url <url>     Public releases base URL. Defaults to ${defaultBaseUrl}
  --platform <key>     Build one platform package only.
  --env <file>         Local env file. Defaults to .env.
  --key-file <path>    Private key path. Defaults to UCLAW_RELEASE_PRIVATE_KEY_PATH, then mock key.
`);
}

function parseArgs(argv) {
  const command = argv.shift();
  const options = { command, version: packageJson.version, baseUrl: defaultBaseUrl, env: path.join(appDir, '.env') };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--stage') options.stage = readValue();
    else if (arg === '--out') options.out = readValue();
    else if (arg === '--release') options.release = readValue();
    else if (arg === '--version') options.version = readValue();
    else if (arg === '--base-url') options.baseUrl = readValue().replace(/\/+$/, '');
    else if (arg === '--platform') options.platform = readValue();
    else if (arg === '--env') options.env = readValue();
    else if (arg === '--key-file') options.keyFile = readValue();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function shouldCopyProgramLayer(relative) {
  const normalized = relative.replace(/\\/g, '/');
  if (isPortableMetadataPath(normalized)) return false;
  if (normalized === 'data' || normalized.startsWith('data/')) return false;
  if (normalized === '.openclaw' || normalized.startsWith('.openclaw/')) return false;
  if (normalized.includes('/.openclaw/') || normalized.endsWith('/.openclaw')) return false;
  assertSafeRelativePath(normalized);
  const allowedRoots = [
    'app',
    'bootstrap',
    'Bavi-box.exe',
    'Bavi-box.app',
    'U-Claw Launcher.exe',
    'U-Claw Launcher.app',
    'UCLAW-PACKAGE-NOTES.txt'
  ];
  return allowedRoots.some(root => normalized === root || normalized.startsWith(`${root}/`));
}

function copyProgramLayer(stageRoot, stagingRoot) {
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.mkdirSync(stagingRoot, { recursive: true });
  copyDirFiltered(stageRoot, stagingRoot, (source, entry) => {
    const relative = path.relative(stageRoot, source).split(path.sep).join('/');
    return shouldCopyProgramLayer(relative);
  });
}

function stageForPlatform(commonStageRoot, platformKey, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  copyDirFiltered(commonStageRoot, destination, (source, entry) => {
    const relative = path.relative(commonStageRoot, source).split(path.sep).join('/');
    if (!relative) return true;
    assertSafeRelativePath(relative);
    return true;
  });
}

function sbomFor(root, version, platformKey) {
  const files = [];
  walkFiles(root, (absolute, relative, stat) => {
    files.push({ path: relative, sha256: sha256File(absolute), size: stat.size });
  });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    schemaVersion: 1,
    product: 'Bavi-box',
    version,
    platform: platformKey,
    generatedAt: new Date().toISOString(),
    files
  };
}

function publicKeysFromKey(key) {
  return [{
    keyId: key.keyId,
    alg: 'Ed25519',
    publicKey: key.publicKey,
    status: 'active'
  }];
}

function loadSigningKey(options) {
  const env = parseEnvFile(path.resolve(options.env));
  const configuredKeyFile = options.keyFile || firstEnv(env, ['UCLAW_RELEASE_PRIVATE_KEY_PATH']);
  if (configuredKeyFile) {
    const key = readJson(path.resolve(configuredKeyFile));
    const expectedKeyId = firstEnv(env, ['UCLAW_RELEASE_KEY_ID']);
    if (expectedKeyId && key.keyId !== expectedKeyId) {
      throw new Error(`Release key id mismatch: expected ${expectedKeyId}, got ${key.keyId}`);
    }
    return { key, keyFile: path.resolve(configuredKeyFile), mock: false };
  }
  const keyFile = path.resolve(path.join(releaseDir, '.mock-release-keys', 'release-key.json'));
  return { key: loadOrCreateMockKey(keyFile), keyFile, mock: true };
}

function create(options) {
  if (!options.stage) throw new Error('--stage is required');
  const stageRoot = path.resolve(options.stage);
  if (!fs.existsSync(stageRoot) || !fs.statSync(stageRoot).isDirectory()) {
    throw new Error(`Stage not found: ${stageRoot}`);
  }
  const outRoot = path.resolve(options.out || path.join(releaseDir, 'mock-hard-update'));
  const signingKey = loadSigningKey(options);
  const key = signingKey.key;
  const releaseId = `v${options.version}`;
  const packageRoot = path.join(outRoot, 'packages', releaseId);
  const commonStageRoot = path.join(outRoot, '.work', 'program-layer');
  const publicKeys = publicKeysFromKey(key);

  fs.rmSync(outRoot, { recursive: true, force: true });
  copyProgramLayer(stageRoot, commonStageRoot);
  fs.mkdirSync(path.join(outRoot, 'bootstrap'), { recursive: true });
  writeJson(path.join(outRoot, 'bootstrap', 'release-public-keys.json'), { keys: publicKeys });

  const production = {
    schemaVersion: 1,
    requiredVersion: options.version,
    releaseId,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    platforms: {}
  };

  const targetPlatforms = options.platform ? [options.platform] : platforms;
  for (const platformKey of targetPlatforms) {
    if (!platforms.includes(platformKey)) throw new Error(`Unsupported platform key: ${platformKey}`);
    const { platform, arch } = platformParts(platformKey);
    const platformDir = path.join(packageRoot, platformKey);
    const platformStage = path.join(outRoot, '.work', platformKey);
    const runtimePkg = path.join(platformDir, 'runtime.pkg');
    stageForPlatform(commonStageRoot, platformKey, platformStage);
    const digest = treeDigest(platformStage);
    zipDirectory(platformStage, runtimePkg);
    const packageSha = sha256File(runtimePkg);
    const packageSize = fs.statSync(runtimePkg).size;
    const manifestUnsigned = {
      schemaVersion: 1,
      version: options.version,
      releaseId,
      platform,
      arch,
      package: {
        url: `${options.baseUrl}/packages/${releaseId}/${platformKey}/runtime.pkg`,
        format: 'zip',
        size: packageSize,
        sha256: packageSha,
        treeDigest: digest
      },
      install: {
        replace: [
          'app/',
          'Bavi-box.exe',
          'Bavi-box.app',
          'U-Claw Launcher.exe',
          'U-Claw Launcher.app',
          'UCLAW-PACKAGE-NOTES.txt',
          'bootstrap/'
        ],
        preserve: ['data/'],
        entrypoint: platform === 'win32' ? 'Bavi-box.exe' : 'Bavi-box.app'
      },
      runtime: {
        productVersion: options.version,
        openclawVersion: packageJson.dependencies?.openclaw || 'unknown',
        nodeVersion: process.versions.node,
        electronVersion: packageJson.devDependencies?.electron || 'unknown'
      },
      publishedAt: new Date().toISOString()
    };
    const manifest = signPayload(manifestUnsigned, key);
    writeJson(path.join(platformDir, 'manifest.json'), manifest);
    writeJson(path.join(platformDir, 'sbom.json'), sbomFor(platformStage, options.version, platformKey));
    fs.writeFileSync(path.join(platformDir, 'runtime.pkg.sha256'), `${packageSha}\n`);
    production.platforms[platformKey] = {
      manifestUrl: `${options.baseUrl}/packages/${releaseId}/${platformKey}/manifest.json`,
      manifestSha256: sha256File(path.join(platformDir, 'manifest.json'))
    };
  }

  writeJson(path.join(outRoot, 'production.json'), signPayload(production, key));
  writeJson(path.join(outRoot, 'deploy-config.template.json'), {
    schemaVersion: 1,
    productionUrl: defaultProductionUrl,
    r2: {
      accountId: '${R2_ACCOUNT_ID}',
      endpoint: '${R2_ENDPOINT}',
      accessKeyId: '${R2_ACCESS_KEY_ID}',
      secretAccessKey: '${R2_SECRET_ACCESS_KEY}',
      stagingBucket: '${R2_STAGING_BUCKET}',
      stagingPublicUrl: '${R2_STAGING_PUBLIC_URL}',
      prodBucket: '${R2_PROD_BUCKET}',
      prodPublicUrl: '${R2_PROD_PUBLIC_URL}'
    },
    routes: {
      productionJson: '/uclaw/releases/production.json',
      packagesPrefix: '/uclaw/releases/packages/'
    },
    notes: [
      'No real R2 secret, server password, DNS token, or signing private key belongs in this file.',
      'Client production URL remains https://yiyong.me/uclaw/releases/production.json.'
    ]
  });
  fs.rmSync(path.join(outRoot, '.work'), { recursive: true, force: true });
  console.log(`[hard-update-package] production ${path.join(outRoot, 'production.json')}`);
  console.log(`[hard-update-package] signing key ${signingKey.keyFile}`);
  if (signingKey.mock) console.log('[hard-update-package] using mock signing key');
}

function verify(options) {
  const releaseRoot = path.resolve(options.release || options.out || path.join(releaseDir, 'mock-hard-update'));
  const keys = readJson(path.join(releaseRoot, 'bootstrap', 'release-public-keys.json')).keys;
  const production = readJson(path.join(releaseRoot, 'production.json'));
  verifyPayload(production, keys);
  for (const platformKey of Object.keys(production.platforms)) {
    const platformDir = path.join(releaseRoot, 'packages', production.releaseId, platformKey);
    const manifestPath = path.join(platformDir, 'manifest.json');
    const manifest = readJson(manifestPath);
    verifyPayload(manifest, keys);
    if (sha256File(manifestPath) !== production.platforms[platformKey].manifestSha256) {
      throw new Error(`manifestSha256 mismatch: ${platformKey}`);
    }
    const runtimePkg = path.join(platformDir, 'runtime.pkg');
    if (sha256File(runtimePkg) !== manifest.package.sha256) throw new Error(`runtime.pkg sha256 mismatch: ${platformKey}`);
    if (fs.statSync(runtimePkg).size !== manifest.package.size) throw new Error(`runtime.pkg size mismatch: ${platformKey}`);
    const extractDir = path.join(releaseRoot, '.verify', platformKey);
    unzipTo(runtimePkg, extractDir);
    const digest = treeDigest(extractDir);
    if (digest !== manifest.package.treeDigest) throw new Error(`treeDigest mismatch: ${platformKey}`);
  }
  fs.rmSync(path.join(releaseRoot, '.verify'), { recursive: true, force: true });
  console.log(`[hard-update-package] verified ${releaseRoot}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.command) {
    usage();
    return;
  }
  if (options.command === 'create') create(options);
  else if (options.command === 'verify') verify(options);
  else throw new Error(`Unknown command: ${options.command}`);
}

try {
  main();
} catch (error) {
  console.error(`[hard-update-package] ${error.message}`);
  process.exit(1);
}
