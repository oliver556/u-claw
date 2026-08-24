#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const appDir = path.resolve(__dirname, '..');
const releaseDir = path.join(appDir, 'release');
const packageJson = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
const version = packageJson.version;
const macAppDir = path.join(releaseDir, 'mac-arm64', 'U-Claw.app');
const winAppDir = path.join(releaseDir, 'win-unpacked');
const macArchive = path.join(releaseDir, 'u-claw-app-mac-arm64.tar.gz');
const winArchive = path.join(releaseDir, 'u-claw-app-win-x64.zip');

function usage() {
  console.log(`Usage:
  npm run package:portable:customer -- --usb /Volumes/UCLAW-01
  npm run package:portable:streamer -- --usb /Volumes/UCLAW-01
  npm run package:portable:customer
  npm run package:portable:streamer

Options:
  --edition <customer|streamer>  Package edition. Added by the npm scripts.
  --usb <mount>                  Deploy to <mount>/U-Claw after staging.
  --skip-build                   Reuse current release/mac-arm64 and release/win-unpacked.
`);
}

function parseArgs(argv) {
  const options = { edition: '', usb: '', skipBuild: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };

    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--edition') options.edition = readValue();
    else if (arg === '--usb') options.usb = readValue();
    else if (arg === '--skip-build') options.skipBuild = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.help && !['customer', 'streamer'].includes(options.edition)) {
    throw new Error('--edition must be customer or streamer');
  }
  return options;
}

function run(command, args, options = {}) {
  console.log(`[package:portable] ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd || appDir,
    env: { ...process.env, ...(options.env || {}) },
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function ensureFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

function ensureDir(dirPath, label) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    throw new Error(`Missing ${label}: ${dirPath}`);
  }
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function copyAtomic(source, destination) {
  const temporary = `${destination}.new`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, temporary);
  if (sha256(source) !== sha256(temporary)) {
    throw new Error(`Copy verification failed: ${destination}`);
  }
  fs.renameSync(temporary, destination);
}

function buildApps() {
  ensureDir(path.join(appDir, 'node_modules', 'electron-builder'), 'electron-builder dependency');
  run('npm', ['run', 'patch-openclaw']);
  run('npm', ['run', 'sync-lib']);
  run('npx', ['electron-builder', '--mac', '--arm64', '--dir']);
  run('npx', ['electron-builder', '--win', '--x64', '--dir', '-c.npmRebuild=false']);
}

function keepPackagedRuntime(runtimeRoot, expectedName, label) {
  const expectedPath = path.join(runtimeRoot, expectedName);
  ensureDir(expectedPath, `${label} ${expectedName} runtime`);
  for (const entry of fs.readdirSync(runtimeRoot, { withFileTypes: true })) {
    if (entry.name === expectedName) continue;
    fs.rmSync(path.join(runtimeRoot, entry.name), { recursive: true, force: true });
  }
}

function buildArchives() {
  ensureDir(macAppDir, 'Mac arm64 app');
  ensureFile(path.join(macAppDir, 'Contents', 'MacOS', 'U-Claw'), 'Mac executable');
  ensureDir(winAppDir, 'Windows x64 app');
  ensureFile(path.join(winAppDir, 'U-Claw.exe'), 'Windows executable');

  keepPackagedRuntime(
    path.join(macAppDir, 'Contents', 'Resources', 'resources', 'runtime'),
    'node-darwin-arm64',
    'Mac'
  );
  keepPackagedRuntime(
    path.join(winAppDir, 'resources', 'resources', 'runtime'),
    'node-win32-x64',
    'Windows'
  );

  const macTemporary = `${macArchive}.new`;
  const winTemporary = path.join(releaseDir, 'u-claw-app-win-x64.new.zip');
  fs.rmSync(macTemporary, { force: true });
  fs.rmSync(winTemporary, { force: true });

  run('tar', ['-czf', macTemporary, '-C', path.dirname(macAppDir), path.basename(macAppDir)], {
    env: { COPYFILE_DISABLE: '1' }
  });
  run('zip', ['-qry', winTemporary, '.'], {
    cwd: winAppDir,
    env: { COPYFILE_DISABLE: '1' }
  });

  fs.renameSync(macTemporary, macArchive);
  fs.renameSync(winTemporary, winArchive);
}

function generateConfig(edition, destination) {
  const editionArg = edition === 'customer' ? '--customer' : '--streamer';
  run(process.execPath, [
    path.join(appDir, 'scripts', 'sync-openclaw-config.js'),
    editionArg,
    '--dest',
    destination
  ]);

  const config = JSON.parse(fs.readFileSync(destination, 'utf8'));
  const providers = config.models?.providers || {};
  const hasNewApiKey = Boolean(providers.custom?.apiKey && providers.litellm?.apiKey);
  if (edition === 'customer' && hasNewApiKey) {
    throw new Error('Customer package contains a New API key');
  }
  if (edition === 'streamer' && !hasNewApiKey) {
    throw new Error('Streamer package is missing the New API key');
  }
  if (providers.xai?.baseUrl !== 'http://127.0.0.1:18808/xai/v1') {
    throw new Error(`Wrong xai base URL: ${providers.xai?.baseUrl || '(empty)'}`);
  }
  if (providers.xai?.apiKey !== 'uclaw-video-adapter') {
    throw new Error('Wrong xai adapter token');
  }
}

function packageNotes(edition, macHash, winHash) {
  const keyRule = edition === 'customer'
    ? 'New API key: empty; customer enters credentials after delivery.'
    : 'New API key: inherited automatically from current desktop config.';
  return `U-Claw portable package - ${edition} edition
Version: ${version}
Built: ${localDisplayTime()}

Mac:
  Double-click Mac-Start-App.command
  App cache: ~/Library/Caches/U-Claw/u-claw-app-mac-arm64
  Data cache: ~/Library/Caches/U-Claw/usb-portable/data

Windows:
  Double-click Windows-Start-App.bat
  App cache: %LOCALAPPDATA%\\U-Claw\\usb-portable\\app-win-x64
  Data cache: %LOCALAPPDATA%\\U-Claw\\usb-portable\\data
  First launch: verify SHA-256, then extract with Windows tar.exe.
  Later launches: reuse the computer app cache without extracting again.

Edition:
  ${keyRule}

Video chain:
  U-Claw -> local adapter -> New API -> server adapter -> Jimeng
  xai.baseUrl = http://127.0.0.1:18808/xai/v1
  xai.apiKey = uclaw-video-adapter

Artifacts:
  u-claw-app-mac-arm64.tar.gz  sha256=${macHash}
  u-claw-app-win-x64.zip       sha256=${winHash}
`;
}

function assembleStage(edition) {
  ensureFile(macArchive, 'Mac archive');
  ensureFile(winArchive, 'Windows archive');
  const macHash = sha256(macArchive);
  const winHash = sha256(winArchive);
  const stageRoot = path.join(releaseDir, `portable-${edition}`, 'U-Claw');
  const archiveDir = path.join(stageRoot, 'app', 'desktop-archive');
  const configPath = path.join(stageRoot, 'data', '.openclaw', 'openclaw.json');

  fs.rmSync(path.dirname(stageRoot), { recursive: true, force: true });
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });

  fs.copyFileSync(macArchive, path.join(archiveDir, path.basename(macArchive)));
  fs.copyFileSync(winArchive, path.join(archiveDir, path.basename(winArchive)));
  writeText(path.join(archiveDir, `${path.basename(macArchive)}.sha256`), `${macHash}\n`);
  writeText(path.join(archiveDir, `${path.basename(winArchive)}.sha256`), `${winHash}\n`);
  fs.copyFileSync(path.join(appDir, 'scripts', 'Mac-Start-App.command'), path.join(stageRoot, 'Mac-Start-App.command'));
  fs.copyFileSync(path.join(appDir, 'scripts', 'Windows-Start-App.bat'), path.join(stageRoot, 'Windows-Start-App.bat'));
  fs.chmodSync(path.join(stageRoot, 'Mac-Start-App.command'), 0o755);
  generateConfig(edition, configPath);
  writeText(path.join(stageRoot, 'UCLAW-PACKAGE-NOTES.txt'), packageNotes(edition, macHash, winHash));

  return { stageRoot, macHash, winHash };
}

function localTimestamp(separator = '-') {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${date}${separator}${time}`;
}

function localDisplayTime() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + ` ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function backupIfExists(source, destination) {
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function deploy(stage, usbRoot) {
  const resolvedUsbRoot = path.resolve(usbRoot);
  if (!fs.existsSync(resolvedUsbRoot) || !fs.statSync(resolvedUsbRoot).isDirectory()) {
    throw new Error(`USB mount does not exist: ${resolvedUsbRoot}`);
  }
  const targetRoot = path.basename(resolvedUsbRoot).toLowerCase() === 'u-claw'
    ? resolvedUsbRoot
    : path.join(resolvedUsbRoot, 'U-Claw');
  if (!fs.existsSync(targetRoot) || !fs.statSync(targetRoot).isDirectory()) {
    throw new Error(`U-Claw package root does not exist: ${targetRoot}`);
  }

  const backupRoot = path.join(targetRoot, `_backup-before-portable-deploy-${localTimestamp()}`);
  const relativeFiles = [
    'Mac-Start-App.command',
    'Windows-Start-App.bat',
    'UCLAW-PACKAGE-NOTES.txt',
    'app/desktop-archive/u-claw-app-mac-arm64.tar.gz',
    'app/desktop-archive/u-claw-app-mac-arm64.tar.gz.sha256',
    'app/desktop-archive/u-claw-app-win-x64.zip',
    'app/desktop-archive/u-claw-app-win-x64.zip.sha256',
    'data/.openclaw/openclaw.json'
  ];
  const legacyFiles = [
    `app/desktop-archive/U-Claw ${version}.exe`
  ];

  for (const relativeFile of relativeFiles) {
    backupIfExists(path.join(targetRoot, relativeFile), path.join(backupRoot, relativeFile));
  }
  for (const relativeFile of legacyFiles) {
    backupIfExists(path.join(targetRoot, relativeFile), path.join(backupRoot, relativeFile));
  }
  for (const relativeFile of relativeFiles) {
    copyAtomic(path.join(stage.stageRoot, relativeFile), path.join(targetRoot, relativeFile));
  }
  for (const relativeFile of legacyFiles) {
    const legacyPath = path.join(targetRoot, relativeFile);
    if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
  }
  fs.chmodSync(path.join(targetRoot, 'Mac-Start-App.command'), 0o755);

  const deployedMacHash = sha256(path.join(targetRoot, 'app', 'desktop-archive', path.basename(macArchive)));
  const deployedWinHash = sha256(path.join(targetRoot, 'app', 'desktop-archive', path.basename(winArchive)));
  if (deployedMacHash !== stage.macHash || deployedWinHash !== stage.winHash) {
    throw new Error('Deployed archive hash verification failed');
  }

  console.log(`[package:portable] deployed ${targetRoot}`);
  console.log(`[package:portable] rollback ${backupRoot}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  if (!options.skipBuild) buildApps();
  buildArchives();
  const stage = assembleStage(options.edition);
  console.log(`[package:portable] staged ${stage.stageRoot}`);
  console.log(`[package:portable] Mac sha256 ${stage.macHash}`);
  console.log(`[package:portable] Windows sha256 ${stage.winHash}`);
  if (options.usb) deploy(stage, options.usb);
}

try {
  main();
} catch (error) {
  console.error(`[package:portable] ${error.message}`);
  process.exit(1);
}
