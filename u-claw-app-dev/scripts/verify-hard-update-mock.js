#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { sha256File, readJson, unzipTo } = require('./lib/hard-update-utils');
const { generateKeyPair, signPayload, verifyPayload } = require('./lib/release-signing');

const appDir = path.resolve(__dirname, '..');
const releaseDir = path.join(appDir, 'release');
const packageJson = readJson(path.join(appDir, 'package.json'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || appDir,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    stdio: options.stdio || 'pipe'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout || ''}${result.stderr || ''}`);
  }
  return result;
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n');
}

function writeFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function createMockStage(stageRoot, edition) {
  fs.rmSync(stageRoot, { recursive: true, force: true });
  writeFile(path.join(stageRoot, 'Mac-Start-App.command'), '#!/bin/bash\necho U-Claw\n');
  writeFile(path.join(stageRoot, 'Windows-Start-App.bat'), '@echo off\r\necho U-Claw\r\n');
  writeFile(path.join(stageRoot, 'UCLAW-PACKAGE-NOTES.txt'), `${edition} mock\n`);
  writeFile(path.join(stageRoot, 'U-Claw Launcher.exe'), 'mock windows launcher\n');
  writeFile(path.join(stageRoot, 'U-Claw Launcher.app', 'Contents', 'MacOS', 'U-Claw Launcher'), 'mock mac launcher\n');
  writeFile(path.join(stageRoot, 'bootstrap', 'README.txt'), 'mock bootstrap placeholder\n');
  for (const name of ['u-claw-app-mac-arm64.tar.gz', 'u-claw-app-mac-x64.tar.gz', 'u-claw-app-win-x64.zip']) {
    const archive = path.join(stageRoot, 'app', 'desktop-archive', name);
    writeFile(archive, `${edition} ${name}\n`);
    writeFile(`${archive}.sha256`, `${sha256File(archive)}\n`);
  }
  writeJson(path.join(stageRoot, 'app', 'version.json'), {
    schemaVersion: 1,
    version: packageJson.version,
    releaseId: `v${packageJson.version}`
  });
  writeJson(path.join(stageRoot, 'data', '.openclaw', 'openclaw.json'), {
    models: {
      providers: {
        custom: { baseUrl: 'https://api.gmnlee.com/v1', apiKey: edition === 'streamer' ? 'mock-streamer-key' : '' },
        litellm: { baseUrl: 'https://api.gmnlee.com/v1', apiKey: edition === 'streamer' ? 'mock-streamer-key' : '' },
        xai: { baseUrl: 'https://video-adapter.gmnlee.com/xai/v1', apiKey: 'uclaw-video-adapter' }
      }
    }
  });
  if (edition === 'streamer') {
    writeFile(path.join(stageRoot, 'data', '.openclaw', 'agents', 'main', 'agent', 'openclaw-agent.sqlite'), 'mock auth_profile_store\n');
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertNoForbiddenReleaseFiles(releaseRoot) {
  const bad = [];
  function walk(root) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const absolute = path.join(root, entry.name);
      const relative = path.relative(releaseRoot, absolute).split(path.sep).join('/');
      if (
        relative.includes('/data/')
        || relative.startsWith('data/')
        || relative.includes('/.openclaw/')
        || /openclaw\.json$/i.test(relative)
        || /\.env(?:\.|$)/i.test(relative)
        || /\.key$/i.test(relative)
      ) {
        bad.push(relative);
      }
      if (entry.isDirectory()) walk(absolute);
    }
  }
  walk(releaseRoot);
  assert(bad.length === 0, `forbidden release files: ${bad.join(', ')}`);
}

function verifyPackagePolicy(tmp) {
  const customerStage = path.join(tmp, 'stage-customer', 'U-Claw');
  const streamerStage = path.join(tmp, 'stage-streamer', 'U-Claw');
  createMockStage(customerStage, 'customer');
  createMockStage(streamerStage, 'streamer');
  const customerConfig = readJson(path.join(customerStage, 'data', '.openclaw', 'openclaw.json'));
  const streamerConfig = readJson(path.join(streamerStage, 'data', '.openclaw', 'openclaw.json'));
  assert(!customerConfig.models.providers.custom.apiKey, 'customer custom.apiKey must be empty');
  assert(!customerConfig.models.providers.litellm.apiKey, 'customer litellm.apiKey must be empty');
  assert(streamerConfig.models.providers.custom.apiKey === 'mock-streamer-key', 'streamer stage key missing');
  assert(fs.existsSync(path.join(streamerStage, 'data', '.openclaw', 'agents', 'main', 'agent', 'openclaw-agent.sqlite')), 'streamer auth store missing');

  const oldDisk = path.join(tmp, 'old-disk', 'U-Claw');
  writeJson(path.join(oldDisk, 'data', '.openclaw', 'openclaw.json'), {
    preserved: true,
    models: { providers: { custom: { apiKey: '' }, litellm: { apiKey: '' } } }
  });
  const before = sha256File(path.join(oldDisk, 'data', '.openclaw', 'openclaw.json'));
  fs.cpSync(path.join(streamerStage, 'app'), path.join(oldDisk, 'app'), { recursive: true, force: true });
  fs.copyFileSync(path.join(streamerStage, 'UCLAW-PACKAGE-NOTES.txt'), path.join(oldDisk, 'UCLAW-PACKAGE-NOTES.txt'));
  const after = sha256File(path.join(oldDisk, 'data', '.openclaw', 'openclaw.json'));
  assert(before === after, 'old disk openclaw.json hash changed');
}

function verifyHardUpdateFlow(tmp) {
  const stage = path.join(tmp, 'stage-customer', 'U-Claw');
  const releaseRoot = path.join(releaseDir, 'mock-hard-update');
  run(process.execPath, ['scripts/hard-update-package.js', 'create', '--stage', stage, '--out', releaseRoot, '--version', '9.9.9']);
  run(process.execPath, ['scripts/hard-update-package.js', 'verify', '--release', releaseRoot]);
  assertNoForbiddenReleaseFiles(releaseRoot);

  const usbRoot = path.join(tmp, 'usb', 'U-Claw');
  writeJson(path.join(usbRoot, 'app', 'version.json'), { schemaVersion: 1, version: '0.0.1', releaseId: 'v0.0.1' });
  writeJson(path.join(usbRoot, 'data', '.openclaw', 'openclaw.json'), { key: 'preserve-me' });
  const stamp = path.join(usbRoot, '.mock-cache', 'app', '.u-claw-archive.sha256');
  writeFile(stamp, 'old-stamp\n');
  const before = sha256File(path.join(usbRoot, 'data', '.openclaw', 'openclaw.json'));
  run(process.execPath, ['scripts/hard-update-client.js', 'mock-update', '--usb', usbRoot, '--release', releaseRoot, '--platform', 'win32-x64']);
  const after = sha256File(path.join(usbRoot, 'data', '.openclaw', 'openclaw.json'));
  assert(before === after, 'mock update changed openclaw.json');
  assert(!fs.existsSync(stamp), 'cache stamp was not invalidated');
  assert(readJson(path.join(usbRoot, 'app', 'version.json')).version === '9.9.9', 'version.json not updated');
  assert(readJson(path.join(usbRoot, 'app', 'update-transaction.json')).state === 'complete', 'transaction not complete');
}

function verifyBadDataPackageFails(tmp) {
  const stage = path.join(tmp, 'bad-stage', 'U-Claw');
  const releaseRoot = path.join(tmp, 'bad-release');
  createMockStage(stage, 'customer');
  run(process.execPath, ['scripts/hard-update-package.js', 'create', '--stage', stage, '--out', releaseRoot, '--version', '9.9.10']);
  const tamperDir = path.join(tmp, 'tamper');
  writeFile(path.join(tamperDir, 'data', 'bad.txt'), 'must fail\n');
  run('zip', ['-qry', path.join(releaseRoot, 'packages', 'v9.9.10', 'win32-x64', 'runtime.pkg'), 'data'], { cwd: tamperDir });
  let failed = false;
  try {
    unzipTo(path.join(releaseRoot, 'packages', 'v9.9.10', 'win32-x64', 'runtime.pkg'), path.join(tmp, 'bad-extract'));
  } catch (error) {
    failed = /Forbidden package path|Forbidden package file|data/.test(error.message);
  }
  assert(failed, 'update package containing data/ must fail');
}

function verifySignatureAndPathFixtures(tmp) {
  const keyPair = generateKeyPair();
  const key = { keyId: 'fixture-key', alg: 'Ed25519', ...keyPair };
  const payload = signPayload({ schemaVersion: 1, releaseId: 'v-fixture' }, key);
  verifyPayload(payload, [{ keyId: key.keyId, alg: 'Ed25519', publicKey: key.publicKey, status: 'active' }]);

  const tampered = { ...payload, releaseId: 'v-tampered' };
  let signatureFailed = false;
  try {
    verifyPayload(tampered, [{ keyId: key.keyId, alg: 'Ed25519', publicKey: key.publicKey, status: 'active' }]);
  } catch (error) {
    signatureFailed = /Invalid signature/.test(error.message);
  }
  assert(signatureFailed, 'tampered signed payload must fail');

  const paths = path.join(tmp, 'path-fixtures');
  writeFile(path.join(paths, 'safe.txt'), 'safe\n');
  const packagePath = path.join(tmp, 'path-fixture.zip');
  run('zip', ['-qry', packagePath, 'safe.txt'], { cwd: paths });
  const absolutePath = path.join(tmp, 'absolute-path.zip');
  run('zip', ['-qry', absolutePath, 'safe.txt'], { cwd: paths });
  let absoluteFailed = false;
  try {
    require('./lib/hard-update-utils').assertSafeRelativePath('/absolute/file');
  } catch (error) {
    absoluteFailed = /Absolute package path rejected/.test(error.message);
  }
  assert(absoluteFailed, 'absolute package path must fail');
  let traversalFailed = false;
  try {
    require('./lib/hard-update-utils').assertSafeRelativePath('../escape');
  } catch (error) {
    traversalFailed = /Path traversal rejected/.test(error.message);
  }
  assert(traversalFailed, 'path traversal must fail');

  const symlinkDir = path.join(tmp, 'symlink-stage');
  writeFile(path.join(symlinkDir, 'target.txt'), 'target\n');
  fs.symlinkSync('target.txt', path.join(symlinkDir, 'link.txt'));
  const symlinkPackage = path.join(tmp, 'symlink-fixture.zip');
  run('zip', ['-qry', '-y', symlinkPackage, 'target.txt', 'link.txt'], { cwd: symlinkDir });
  let symlinkFailed = false;
  try {
    unzipTo(symlinkPackage, path.join(tmp, 'symlink-extract'));
  } catch (error) {
    symlinkFailed = /Symlink rejected/.test(error.message);
  }
  assert(symlinkFailed, 'symlink package entry must fail');

  const failedUsb = path.join(tmp, 'failed-usb', 'U-Claw');
  const failedRelease = path.join(tmp, 'failed-release');
  createMockStage(path.join(tmp, 'failed-stage'), 'customer');
  run(process.execPath, ['scripts/hard-update-package.js', 'create', '--stage', path.join(tmp, 'failed-stage'), '--out', failedRelease, '--version', '9.9.11']);
  const failedPackage = path.join(failedRelease, 'packages', 'v9.9.11', 'win32-x64', 'runtime.pkg');
  fs.appendFileSync(failedPackage, 'tampered');
  let updateFailed = false;
  try {
    require('./hard-update-client').mockUpdate({ usb: failedUsb, release: failedRelease, platform: 'win32-x64' });
  } catch (error) {
    updateFailed = /sha256|treeDigest/.test(error.message);
  }
  assert(updateFailed, 'tampered manifest must fail update');
  assert(readJson(path.join(failedUsb, 'app', 'update-transaction.json')).state === 'failed', 'failed update must persist failed transaction');
  assert(packagePath && absolutePath, 'path fixtures were not created');
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uclaw-hard-update-'));
  try {
    verifyPackagePolicy(tmp);
    verifyHardUpdateFlow(tmp);
    verifyBadDataPackageFails(tmp);
    verifySignatureAndPathFixtures(tmp);
    console.log('[verify-hard-update-mock] all mock checks passed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`[verify-hard-update-mock] ${error.message}`);
  process.exit(1);
}
