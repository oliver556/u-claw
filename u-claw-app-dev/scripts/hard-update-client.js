#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const {
  assertSafeRelativePath,
  copyDirFiltered,
  platformParts,
  readJson,
  sha256File,
  treeDigest,
  unzipTo,
  writeJson
} = require('./lib/hard-update-utils');
const { verifyPayload } = require('./lib/release-signing');

const productionUrl = 'https://yiyong.me/uclaw/releases/production.json';
const transactionStates = [
  'checking',
  'downloading',
  'downloaded',
  'verifying',
  'extracting',
  'staged',
  'waiting-for-app-exit',
  'switching',
  'switched',
  'cache-invalidated',
  'restarting',
  'complete',
  'failed'
];

function usage() {
  console.log(`Usage:
  node scripts/hard-update-client.js mock-update --usb <U-Claw root> --release <release root> --platform win32-x64
  node scripts/hard-update-client.js check --usb <U-Claw root> --release <release root> --platform darwin-arm64
`);
}

function parseArgs(argv) {
  const command = argv.shift();
  const options = { command, platform: `${process.platform}-${process.arch}` };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--usb') options.usb = readValue();
    else if (arg === '--release') options.release = readValue();
    else if (arg === '--platform') options.platform = readValue();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function transactionPath(usbRoot) {
  return path.join(usbRoot, 'app', 'update-transaction.json');
}

function runtimeDir(usbRoot) {
  return path.join(usbRoot, 'app', '.runtime');
}

function writeTransaction(usbRoot, next) {
  if (!transactionStates.includes(next.state)) throw new Error(`Invalid transaction state: ${next.state}`);
  const payload = { schemaVersion: 1, ...next, updatedAt: new Date().toISOString() };
  const filePath = transactionPath(usbRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
  return payload;
}

function requestUpdateShutdown(usbRoot, transactionId) {
  writeJson(path.join(runtimeDir(usbRoot), 'update-shutdown-request.json'), {
    schemaVersion: 1,
    reason: 'update',
    transactionId,
    requestedAt: new Date().toISOString()
  });
}

function writeShutdownCompleteMock(usbRoot, transactionId) {
  writeJson(path.join(runtimeDir(usbRoot), 'shutdown-complete.json'), {
    schemaVersion: 1,
    reason: 'update',
    transactionId,
    completedAt: new Date().toISOString()
  });
}

function writeRunStateMock(usbRoot, extra = {}) {
  writeJson(path.join(runtimeDir(usbRoot), 'run-state.json'), {
    schemaVersion: 1,
    launcherPid: process.pid,
    appPid: null,
    gatewayPid: null,
    configServerPid: null,
    videoAdapterPid: null,
    startedAt: new Date().toISOString(),
    cacheRoot: path.join(usbRoot, '.mock-cache'),
    appCacheDir: path.join(usbRoot, '.mock-cache', 'app'),
    archiveCache: path.join(usbRoot, '.mock-cache', 'archive'),
    stampFile: path.join(usbRoot, '.mock-cache', 'app', '.u-claw-archive.sha256'),
    ...extra
  });
}

function loadPublicKeys(releaseRoot) {
  return readJson(path.join(releaseRoot, 'bootstrap', 'release-public-keys.json')).keys;
}

function loadProduction(releaseRoot, keys) {
  const production = readJson(path.join(releaseRoot, 'production.json'));
  verifyPayload(production, keys);
  return production;
}

function readLocalVersion(usbRoot) {
  const filePath = path.join(usbRoot, 'app', 'version.json');
  if (!fs.existsSync(filePath)) return null;
  return readJson(filePath);
}

function manifestPathFromMockRelease(releaseRoot, production, platformKey) {
  const platformInfo = production.platforms?.[platformKey];
  if (!platformInfo) throw new Error(`Unsupported update platform: ${platformKey}`);
  return path.join(releaseRoot, 'packages', production.releaseId, platformKey, 'manifest.json');
}

function loadManifest(releaseRoot, production, platformKey, keys) {
  const manifestPath = manifestPathFromMockRelease(releaseRoot, production, platformKey);
  if (sha256File(manifestPath) !== production.platforms[platformKey].manifestSha256) {
    throw new Error(`manifestSha256 mismatch: ${platformKey}`);
  }
  const manifest = readJson(manifestPath);
  verifyPayload(manifest, keys);
  const expected = platformParts(platformKey);
  if (manifest.version !== production.requiredVersion) throw new Error('Manifest version does not match production.requiredVersion');
  if (manifest.releaseId !== production.releaseId) throw new Error('Manifest releaseId does not match production.releaseId');
  if (manifest.platform !== expected.platform || manifest.arch !== expected.arch) throw new Error(`Manifest platform mismatch: ${platformKey}`);
  return manifest;
}

function verifyRuntimePackage(releaseRoot, production, platformKey, manifest, stagingDir) {
  const runtimePkg = path.join(releaseRoot, 'packages', production.releaseId, platformKey, 'runtime.pkg');
  if (sha256File(runtimePkg) !== manifest.package.sha256) throw new Error('runtime.pkg sha256 mismatch');
  if (fs.statSync(runtimePkg).size !== manifest.package.size) throw new Error('runtime.pkg size mismatch');
  unzipTo(runtimePkg, stagingDir);
  const digest = treeDigest(stagingDir);
  if (digest !== manifest.package.treeDigest) throw new Error('runtime.pkg treeDigest mismatch');
  return runtimePkg;
}

function assertInstallTreeSafe(stagingDir) {
  walkInstallTree(stagingDir, relative => assertSafeRelativePath(relative));
}

function walkInstallTree(root, visitor, prefix = '') {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    visitor(relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Symlink rejected: ${relative}`);
    if (entry.isDirectory()) walkInstallTree(absolute, visitor, relative);
    else if (!entry.isFile()) throw new Error(`Non-regular file rejected: ${relative}`);
  }
}

function installFromStaging(usbRoot, stagingDir) {
  const allowed = new Set([
    'app',
    'bootstrap',
    'U-Claw Launcher.exe',
    'U-Claw Launcher.app',
    'Mac-Start-App.command',
    'Windows-Start-App.bat',
    'UCLAW-PACKAGE-NOTES.txt'
  ]);
  for (const entry of fs.readdirSync(stagingDir, { withFileTypes: true })) {
    if (!allowed.has(entry.name)) throw new Error(`Installer refused unexpected root: ${entry.name}`);
    const source = path.join(stagingDir, entry.name);
    const destination = path.join(usbRoot, entry.name);
    if (entry.name === 'data') throw new Error('Installer refused data/');
    if (entry.name === 'app') {
      installAppSubtree(source, destination);
      continue;
    }
    if (entry.isDirectory()) {
      fs.rmSync(destination, { recursive: true, force: true });
      copyDirFiltered(source, destination, () => true);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
  }
}

function installAppSubtree(sourceAppDir, destinationAppDir) {
  fs.mkdirSync(destinationAppDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceAppDir, { withFileTypes: true })) {
    if (entry.name === '.runtime' || entry.name === '.update-staging' || entry.name === '.update-backup') {
      throw new Error(`Installer refused runtime app subtree: app/${entry.name}`);
    }
    assertSafeRelativePath(`app/${entry.name}`);
    const source = path.join(sourceAppDir, entry.name);
    const destination = path.join(destinationAppDir, entry.name);
    fs.rmSync(destination, { recursive: true, force: true });
    if (entry.isDirectory()) copyDirFiltered(source, destination, () => true);
    else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    } else {
      throw new Error(`Installer refused non-regular app subtree: app/${entry.name}`);
    }
  }
}

function invalidateCacheStamp(usbRoot) {
  const runStatePath = path.join(runtimeDir(usbRoot), 'run-state.json');
  if (!fs.existsSync(runStatePath)) return null;
  const runState = readJson(runStatePath);
  if (runState.stampFile) {
    fs.rmSync(runState.stampFile, { force: true });
    return runState.stampFile;
  }
  return null;
}

function writeVersion(usbRoot, production, platformKey, manifest) {
  writeJson(path.join(usbRoot, 'app', 'version.json'), {
    schemaVersion: 1,
    version: production.requiredVersion,
    releaseId: production.releaseId,
    installedAt: new Date().toISOString(),
    platforms: {
      [platformKey]: {
        archiveSha256: manifest.package.sha256,
        launcherSha256: null,
        treeDigest: manifest.package.treeDigest
      }
    }
  });
}

function failTransaction(usbRoot, baseTx, error) {
  if (!baseTx) return;
  writeTransaction(usbRoot, {
    ...baseTx,
    state: 'failed',
    error: error instanceof Error ? error.message : String(error)
  });
}

function check(options) {
  if (!options.usb || !options.release) throw new Error('--usb and --release are required');
  const usbRoot = path.resolve(options.usb);
  const releaseRoot = path.resolve(options.release);
  const keys = loadPublicKeys(releaseRoot);
  const production = loadProduction(releaseRoot, keys);
  const local = readLocalVersion(usbRoot);
  if (local?.version === production.requiredVersion) {
    return { updateRequired: false, productionUrl, requiredVersion: production.requiredVersion };
  }
  const manifest = loadManifest(releaseRoot, production, options.platform, keys);
  return { updateRequired: true, productionUrl, requiredVersion: production.requiredVersion, manifest };
}

function mockUpdate(options) {
  const result = check(options);
  if (!result.updateRequired) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const usbRoot = path.resolve(options.usb);
  const releaseRoot = path.resolve(options.release);
  const keys = loadPublicKeys(releaseRoot);
  const production = loadProduction(releaseRoot, keys);
  const manifest = loadManifest(releaseRoot, production, options.platform, keys);
  const transactionId = `update-${Date.now()}-${production.releaseId}`;
  const stagingDir = path.join(usbRoot, 'app', '.update-staging', transactionId);
  const baseTx = {
    id: transactionId,
    targetVersion: production.requiredVersion,
    releaseId: production.releaseId,
    platform: manifest.platform,
    arch: manifest.arch,
    productionSha256: sha256File(path.join(releaseRoot, 'production.json')),
    manifestSha256: sha256File(manifestPathFromMockRelease(releaseRoot, production, options.platform)),
    packageSha256: manifest.package.sha256,
    packageSize: manifest.package.size,
    stagingDir: path.relative(usbRoot, stagingDir).split(path.sep).join('/'),
    backupDir: `app/.update-backup/${transactionId}`,
    startedAt: new Date().toISOString(),
    error: null
  };

  try {
    writeTransaction(usbRoot, { ...baseTx, state: 'checking' });
    writeTransaction(usbRoot, { ...baseTx, state: 'downloading' });
    writeTransaction(usbRoot, { ...baseTx, state: 'downloaded' });
    writeTransaction(usbRoot, { ...baseTx, state: 'verifying' });
    verifyRuntimePackage(releaseRoot, production, options.platform, manifest, stagingDir);
    assertInstallTreeSafe(stagingDir);
    writeTransaction(usbRoot, { ...baseTx, state: 'extracting' });
    writeTransaction(usbRoot, { ...baseTx, state: 'staged' });
    writeRunStateMock(usbRoot);
    requestUpdateShutdown(usbRoot, transactionId);
    writeShutdownCompleteMock(usbRoot, transactionId);
    writeTransaction(usbRoot, { ...baseTx, state: 'waiting-for-app-exit' });
    installFromStaging(usbRoot, stagingDir);
    writeTransaction(usbRoot, { ...baseTx, state: 'switching' });
    writeTransaction(usbRoot, { ...baseTx, state: 'switched' });
    invalidateCacheStamp(usbRoot);
    writeTransaction(usbRoot, { ...baseTx, state: 'cache-invalidated' });
    writeVersion(usbRoot, production, options.platform, manifest);
    writeTransaction(usbRoot, { ...baseTx, state: 'restarting' });
    writeTransaction(usbRoot, { ...baseTx, state: 'complete' });
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } catch (error) {
    failTransaction(usbRoot, baseTx, error);
    throw error;
  }
  const finalResult = { updateRequired: true, updated: true, version: production.requiredVersion };
  console.log(JSON.stringify(finalResult, null, 2));
  return finalResult;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.command) {
    usage();
    return;
  }
  if (options.command === 'check') console.log(JSON.stringify(check(options), null, 2));
  else if (options.command === 'mock-update') mockUpdate(options);
  else throw new Error(`Unknown command: ${options.command}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[hard-update-client] ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  check,
  invalidateCacheStamp,
  mockUpdate,
  requestUpdateShutdown,
  writeRunStateMock,
  writeShutdownCompleteMock,
  writeTransaction,
  failTransaction,
  writeVersion
};
