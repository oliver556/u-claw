#!/usr/bin/env node
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { sha256File, readJson, unzipTo } = require('./lib/hard-update-utils');
const { generateKeyPair, signPayload, verifyPayload } = require('./lib/release-signing');
const { createServer: createControlPlaneServer } = require('./hard-update-control-plane-server');

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
  writeFile(path.join(stageRoot, 'Windows-Sync-Data.ps1'), "Write-Host 'U-Claw sync'\n");
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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

function serveStatic(root) {
  return http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const relative = url.pathname.replace(/^\/+/, '');
    let safeRelative;
    try {
      safeRelative = require('./lib/hard-update-utils').assertSafeRelativePath(relative);
    } catch (error) {
      response.writeHead(400);
      response.end(error.message);
      return;
    }
    const filePath = path.join(root, safeRelative);
    if (!filePath.startsWith(root) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    response.writeHead(200);
    fs.createReadStream(filePath).pipe(response);
  });
}

async function verifyHardUpdateFlow(tmp) {
  const stage = path.join(tmp, 'stage-customer', 'U-Claw');
  const releaseRoot = path.join(tmp, 'local-hard-update-release');
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

  const httpRoot = path.join(tmp, 'http-release');
  const server = serveStatic(httpRoot);
  const port = await listen(server);
  try {
    run(process.execPath, [
      'scripts/hard-update-package.js',
      'create',
      '--stage',
      stage,
      '--out',
      path.join(httpRoot, 'releases'),
      '--version',
      '9.9.9',
      '--base-url',
      `http://127.0.0.1:${port}/releases`
    ]);
    const httpUsbRoot = path.join(tmp, 'http-usb', 'U-Claw');
    writeJson(path.join(httpUsbRoot, 'app', 'version.json'), { schemaVersion: 1, version: '0.0.1', releaseId: 'v0.0.1' });
    writeJson(path.join(httpUsbRoot, 'data', '.openclaw', 'openclaw.json'), { key: 'preserve-me-http' });
    const httpBefore = sha256File(path.join(httpUsbRoot, 'data', '.openclaw', 'openclaw.json'));
    await require('./hard-update-client').mockUpdate({
      usb: httpUsbRoot,
      productionUrl: `http://127.0.0.1:${port}/releases/production.json`,
      platform: 'win32-x64'
    });
    const httpAfter = sha256File(path.join(httpUsbRoot, 'data', '.openclaw', 'openclaw.json'));
    assert(httpBefore === httpAfter, 'HTTP mock update changed openclaw.json');
    assert(readJson(path.join(httpUsbRoot, 'app', 'version.json')).version === '9.9.9', 'HTTP version.json not updated');
  assert(readJson(path.join(httpUsbRoot, 'app', 'update-transaction.json')).state === 'complete', 'HTTP transaction not complete');

    const startupUsbRoot = path.join(tmp, 'startup-usb', 'U-Claw');
    writeJson(path.join(startupUsbRoot, 'app', 'version.json'), { schemaVersion: 1, version: '0.0.1', releaseId: 'v0.0.1' });
    writeJson(path.join(startupUsbRoot, 'data', '.openclaw', 'openclaw.json'), { key: 'preserve-me-startup' });
    writeFile(path.join(startupUsbRoot, 'data', '.uclaw', 'activation-builtin-credential.v1.json'), '{bad activation json');
    const startupBefore = sha256File(path.join(startupUsbRoot, 'data', '.openclaw', 'openclaw.json'));
    const startupResult = await require('./hard-update-client').startupUpdate({
      usb: startupUsbRoot,
      productionUrl: `http://127.0.0.1:${port}/releases/production.json`,
      platform: 'win32-x64'
    });
    assert(startupResult.staged, 'startup update should stage a transaction');
    assert(readJson(path.join(startupUsbRoot, 'app', 'update-transaction.json')).state === 'staged', 'startup update transaction not staged');
    await require('./hard-update-client').applyStartupUpdate({
      usb: startupUsbRoot,
      transaction: path.join(startupUsbRoot, 'app', 'update-transaction.json')
    });
    const startupAfter = sha256File(path.join(startupUsbRoot, 'data', '.openclaw', 'openclaw.json'));
    assert(startupBefore === startupAfter, 'startup update changed openclaw.json');
    assert(readJson(path.join(startupUsbRoot, 'app', 'version.json')).version === '9.9.9', 'startup version.json not updated');
    assert(readJson(path.join(startupUsbRoot, 'app', 'update-transaction.json')).state === 'complete', 'startup transaction not complete');

    const controlPlaneServer = createControlPlaneServer({
      port: 0,
      releaseRoot: path.join(httpRoot, 'releases'),
      publicBaseUrl: `http://127.0.0.1:${port}/releases`,
      authMode: 'permissive',
      databaseUrl: '',
      shortTokenSecret: 'mock-short-token-secret',
      shortTokenTtlSeconds: 21600,
      videoAdapterBaseUrl: 'https://video-adapter.gmnlee.com/xai/v1'
    });
    const controlPort = await listen(controlPlaneServer);
    try {
      const checkResult = await require('./hard-update-client').check({
        usb: path.join(tmp, 'control-plane-usb', 'U-Claw'),
        updateCheckUrl: `http://127.0.0.1:${controlPort}/uclaw/update/check`,
        platform: 'win32-x64',
        device: '22222222-2222-4222-8222-222222222222',
        deviceToken: 'mock-device-token'
      });
      assert(checkResult.updateRequired, 'control-plane update check should require update');
      let denied = false;
      try {
        await require('./hard-update-client').check({
          usb: path.join(tmp, 'control-plane-denied-usb', 'U-Claw'),
          updateCheckUrl: `http://127.0.0.1:${controlPort}/uclaw/update/check`,
          platform: 'win32-x64',
          device: ''
        });
      } catch (error) {
        denied = /Update check denied/.test(error.message);
      }
      assert(denied, 'control-plane update check without device must be denied');
    } finally {
      await closeServer(controlPlaneServer);
    }
  } finally {
    await closeServer(server);
  }
}

function verifyControlPlaneProdBaseUrl(tmp) {
  const envPath = path.join(tmp, 'control-plane-prod.env');
  writeFile(envPath, 'UCLAW_UPDATE_PUBLIC_BASE_URL=https://pub-4f24fbbe718b4c75955440700c70bdeb.r2.dev/releases\n');
  const { loadConfig } = require('./hard-update-control-plane-server');
  const config = loadConfig({ env: envPath, release: path.join(tmp, 'prod-release') });
  assert(
    config.publicBaseUrl === 'https://pub-4f24fbbe718b4c75955440700c70bdeb.r2.dev/releases',
    'control-plane prod public base URL env was not honored'
  );
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

function verifyPortableMetadataHandling(tmp) {
  const { isPortableMetadataPath, prunePortableMetadata, treeDigest } = require('./lib/hard-update-utils');
  assert(isPortableMetadataPath('._UCLAW-PACKAGE-NOTES.txt'), 'AppleDouble metadata path must be recognized');
  assert(isPortableMetadataPath('U-Claw Launcher.app/Contents/._Info.plist'), 'nested AppleDouble metadata path must be recognized');
  assert(isPortableMetadataPath('__MACOSX/anything'), '__MACOSX metadata path must be recognized');
  assert(!isPortableMetadataPath('Mac-Start-App.command'), 'normal package path must not be treated as metadata');

  const clean = path.join(tmp, 'metadata-clean');
  const dirty = path.join(tmp, 'metadata-dirty');
  writeFile(path.join(clean, 'Mac-Start-App.command'), '#!/bin/bash\necho ok\n');
  writeFile(path.join(clean, 'U-Claw Launcher.app', 'Contents', 'Info.plist'), '<plist />\n');
  fs.cpSync(clean, dirty, { recursive: true });
  writeFile(path.join(dirty, '._Mac-Start-App.command'), 'appledouble\n');
  writeFile(path.join(dirty, 'U-Claw Launcher.app', 'Contents', '._Info.plist'), 'appledouble\n');
  writeFile(path.join(dirty, '__MACOSX', 'ignored'), 'metadata\n');
  prunePortableMetadata(dirty);
  assert(treeDigest(clean) === treeDigest(dirty), 'portable metadata pruning must preserve real tree digest');

  const metadataZipRoot = path.join(tmp, 'metadata-zip-root');
  writeFile(path.join(metadataZipRoot, '._bad'), 'appledouble\n');
  const metadataZip = path.join(tmp, 'metadata.zip');
  run('zip', ['-qry', metadataZip, '._bad'], { cwd: metadataZipRoot });
  let failed = false;
  try {
    require('./lib/hard-update-utils').unzipTo(metadataZip, path.join(tmp, 'metadata-extract'));
  } catch (error) {
    failed = /Forbidden package metadata path/.test(error.message);
  }
  assert(failed, 'runtime package containing AppleDouble metadata must fail before extract');
}

async function verifySignatureAndPathFixtures(tmp) {
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
    await require('./hard-update-client').mockUpdate({ usb: failedUsb, release: failedRelease, platform: 'win32-x64' });
  } catch (error) {
    updateFailed = /sha256|treeDigest/.test(error.message);
  }
  assert(updateFailed, 'tampered manifest must fail update');
  assert(readJson(path.join(failedUsb, 'app', 'update-transaction.json')).state === 'failed', 'failed update must persist failed transaction');
  assert(packagePath && absolutePath, 'path fixtures were not created');
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uclaw-hard-update-'));
  try {
    verifyPackagePolicy(tmp);
    verifyControlPlaneProdBaseUrl(tmp);
    await verifyHardUpdateFlow(tmp);
    verifyBadDataPackageFails(tmp);
    verifyPortableMetadataHandling(tmp);
    await verifySignatureAndPathFixtures(tmp);
    console.log('[verify-hard-update-mock] all mock checks passed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  main().catch(error => {
  console.error(`[verify-hard-update-mock] ${error.message}`);
  process.exit(1);
  });
} catch (error) {
  console.error(`[verify-hard-update-mock] ${error.message}`);
  process.exit(1);
}
