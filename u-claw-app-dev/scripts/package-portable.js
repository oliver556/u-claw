#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const appDir = path.resolve(__dirname, '..');
const releaseDir = path.join(appDir, 'release');
const packageJson = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
const version = packageJson.version;
const macArm64AppDir = path.join(releaseDir, 'mac-arm64', 'U-Claw.app');
const macX64AppDir = path.join(releaseDir, 'mac', 'U-Claw.app');
const winAppDir = path.join(releaseDir, 'win-unpacked');
const macArm64Archive = path.join(releaseDir, 'u-claw-app-mac-arm64.tar.gz');
const macX64Archive = path.join(releaseDir, 'u-claw-app-mac-x64.tar.gz');
const winArchive = path.join(releaseDir, 'u-claw-app-win-x64.zip');
const macLauncherSource = path.join(appDir, 'scripts', 'launcher', 'macos', 'main.c');
const macStartScript = path.join(appDir, 'scripts', 'Mac-Start-App.command');
const macLauncherScriptInclude = path.join(appDir, 'scripts', 'launcher', 'macos', 'generated-start-script.inc');
const macLauncherBinary = path.join(releaseDir, 'launcher', 'macos', 'U-Claw Launcher');
const winLauncherSourceDir = path.join(appDir, 'scripts', 'launcher', 'windows');
const winLauncherBinary = path.join(releaseDir, 'launcher', 'U-Claw Launcher.exe');
const winSyncScript = path.join(appDir, 'scripts', 'Windows-Sync-Data.ps1');
const desktopAgentDir = path.join(process.env.HOME || '', 'Library', 'Application Support', 'U-Claw', '.openclaw', 'agents', 'main', 'agent');

function usage() {
  console.log(`Usage:
  npm run package:portable:customer -- --usb /Volumes/UCLAW-01
  npm run package:portable:streamer -- --usb /Volumes/UCLAW-01
  npm run package:portable:customer
  npm run package:portable:streamer

Options:
  --edition <customer|streamer>  Package edition. Added by the npm scripts.
  --usb <mount>                  Deploy to <mount>/U-Claw after staging.
  --skip-build                   Reuse current release archives and rebuild only launcher/stage files.
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
  const commandText = options.logArgs === false ? `${command} [args redacted]` : `${command} ${args.join(' ')}`;
  console.log(`[package:portable] ${commandText}`);
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

function copyDirReplacing(source, destination) {
  const temporary = `${destination}.new`;
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, temporary, { recursive: true });
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(temporary, destination);
}

function copyDirIfMissing(source, destination) {
  if (fs.existsSync(destination)) return false;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
  return true;
}

function removeAppleDoubleFiles(root) {
  if (!fs.existsSync(root)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.name.startsWith('._')) {
      fs.rmSync(fullPath, { recursive: true, force: true });
      removed += 1;
      continue;
    }
    if (entry.isDirectory()) removed += removeAppleDoubleFiles(fullPath);
  }
  return removed;
}

function ensureSourceRuntime(name) {
  const runtimeDir = path.join(appDir, 'resources', 'runtime', name);
  const nodeBin = name.startsWith('node-win32-')
    ? path.join(runtimeDir, 'node.exe')
    : path.join(runtimeDir, 'bin', 'node');
  ensureFile(nodeBin, `${name} runtime. Run ./setup.sh or ./setup.bat first`);
}

function buildApps() {
  ensureDir(path.join(appDir, 'node_modules', 'electron-builder'), 'electron-builder dependency');
  ensureSourceRuntime('node-darwin-arm64');
  ensureSourceRuntime('node-darwin-x64');
  ensureSourceRuntime('node-win32-x64');
  run('npm', ['run', 'patch-openclaw']);
  run('npm', ['run', 'sync-lib']);
  run('npx', ['electron-builder', '--mac', '--arm64', '--dir']);
  run('npx', ['electron-builder', '--mac', '--x64', '--dir']);
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
  ensureDir(macArm64AppDir, 'Mac arm64 app');
  ensureFile(path.join(macArm64AppDir, 'Contents', 'MacOS', 'U-Claw'), 'Mac arm64 executable');
  ensureDir(macX64AppDir, 'Mac x64 app');
  ensureFile(path.join(macX64AppDir, 'Contents', 'MacOS', 'U-Claw'), 'Mac x64 executable');
  ensureDir(winAppDir, 'Windows x64 app');
  ensureFile(path.join(winAppDir, 'U-Claw.exe'), 'Windows executable');

  keepPackagedRuntime(
    path.join(macArm64AppDir, 'Contents', 'Resources', 'resources', 'runtime'),
    'node-darwin-arm64',
    'Mac arm64'
  );
  keepPackagedRuntime(
    path.join(macX64AppDir, 'Contents', 'Resources', 'resources', 'runtime'),
    'node-darwin-x64',
    'Mac x64'
  );
  keepPackagedRuntime(
    path.join(winAppDir, 'resources', 'resources', 'runtime'),
    'node-win32-x64',
    'Windows'
  );

  const macArm64Temporary = `${macArm64Archive}.new`;
  const macX64Temporary = `${macX64Archive}.new`;
  const winTemporary = path.join(releaseDir, 'u-claw-app-win-x64.new.zip');
  fs.rmSync(macArm64Temporary, { force: true });
  fs.rmSync(macX64Temporary, { force: true });
  fs.rmSync(winTemporary, { force: true });

  run('tar', ['-czf', macArm64Temporary, '-C', path.dirname(macArm64AppDir), path.basename(macArm64AppDir)], {
    env: { COPYFILE_DISABLE: '1' }
  });
  run('tar', ['-czf', macX64Temporary, '-C', path.dirname(macX64AppDir), path.basename(macX64AppDir)], {
    env: { COPYFILE_DISABLE: '1' }
  });
  run('zip', ['-qry', winTemporary, '.'], {
    cwd: winAppDir,
    env: { COPYFILE_DISABLE: '1' }
  });

  fs.renameSync(macArm64Temporary, macArm64Archive);
  fs.renameSync(macX64Temporary, macX64Archive);
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
  if (providers.xai?.baseUrl !== 'https://video-adapter.gmnlee.com/xai/v1') {
    throw new Error(`Wrong xai base URL: ${providers.xai?.baseUrl || '(empty)'}`);
  }
  if (providers.xai?.apiKey !== 'uclaw-video-adapter') {
    throw new Error('Wrong xai adapter token');
  }
}

function seedStreamerAuthStore(edition, stageRoot) {
  if (edition !== 'streamer') return;
  const configPath = path.join(stageRoot, 'data', '.openclaw', 'openclaw.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const providers = config.models?.providers || {};
  const customKey = providers.custom?.apiKey;
  const litellmKey = providers.litellm?.apiKey || customKey;
  if (!customKey || !litellmKey) throw new Error('Streamer auth store requires custom/litellm API keys');

  const now = Date.now();
  const store = {
    profiles: {
      'custom:manual': { type: 'api_key', provider: 'custom', key: customKey },
      'litellm:manual': { type: 'api_key', provider: 'litellm', key: litellmKey }
    },
    order: {
      custom: ['custom:manual'],
      litellm: ['litellm:manual']
    },
    lastGood: {
      custom: 'custom:manual',
      litellm: 'litellm:manual'
    }
  };
  const state = {
    providers: {
      custom: { lastGoodProfileId: 'custom:manual' },
      litellm: { lastGoodProfileId: 'litellm:manual' }
    }
  };
  const destinationDir = path.join(stageRoot, 'data', '.openclaw', 'agents', 'main', 'agent');
  fs.mkdirSync(destinationDir, { recursive: true });
  const sourceModels = path.join(desktopAgentDir, 'models.json');
  if (fs.existsSync(sourceModels)) fs.copyFileSync(sourceModels, path.join(destinationDir, 'models.json'));
  const dbPath = path.join(destinationDir, 'openclaw-agent.sqlite');
  fs.rmSync(dbPath, { force: true });
  run('sqlite3', [dbPath, [
    'CREATE TABLE IF NOT EXISTS auth_profile_store (store_key TEXT PRIMARY KEY NOT NULL, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL);',
    'CREATE TABLE IF NOT EXISTS auth_profile_state (state_key TEXT PRIMARY KEY NOT NULL, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL);',
    `INSERT INTO auth_profile_store(store_key, store_json, updated_at) VALUES('primary', json('${JSON.stringify(store).replace(/'/g, "''")}'), ${now});`,
    `INSERT INTO auth_profile_state(state_key, state_json, updated_at) VALUES('primary', json('${JSON.stringify(state).replace(/'/g, "''")}'), ${now});`
  ].join(' ')], { logArgs: false });
}

function packageNotes(edition, macArm64Hash, macX64Hash, winHash) {
  const keyRule = edition === 'customer'
    ? 'New API key: empty; customer enters credentials after delivery.'
    : 'New API key: inherited automatically from current desktop config.';
  return `U-Claw portable package - ${edition} edition
Version: ${version}
Built: ${localDisplayTime()}

  Mac:
  Formal entry: double-click U-Claw Launcher.app
  Diagnostic entry: Mac-Start-App.command
  App cache: ~/Library/Caches/U-Claw/u-claw-app-mac-arm64
  App cache: ~/Library/Caches/U-Claw/u-claw-app-mac-x64
  USB data: <USB>/U-Claw/data
  Runtime data cache: ~/Library/Caches/U-Claw/usb-portable-<usb-id>/data
  Logs to return:
    <USB>/U-Claw/data/logs/U-Claw-Launcher.log
    <USB>/U-Claw/data/logs/Mac-Start-App.log
    <USB>/U-Claw/data/logs/main.log
    <USB>/U-Claw/data/logs/gateway.log
    ~/Library/Caches/U-Claw/launcher-logs/U-Claw-Launcher.log
    ~/Library/Caches/U-Claw/launcher-logs/Mac-Start-App.log

  Windows:
  Formal entry: double-click U-Claw Launcher.exe
  Diagnostic entry: Windows-Start-App.bat
  Sync helper: Windows-Sync-Data.ps1
  App cache: %LOCALAPPDATA%\\U-Claw\\usb-portable\\app-win-x64
  USB data: <USB>\\U-Claw\\data
  Runtime data cache: %LOCALAPPDATA%\\U-Claw\\usb-portable\\data-<usb-id>
  First launch: verify SHA-256, then extract with Windows tar.exe.
  Later launches: reuse the computer app cache without extracting again.
  Logs to return:
    <USB>\\U-Claw\\data\\logs\\U-Claw-Launcher.log
    <USB>\\U-Claw\\data\\logs\\Windows-Start-App.log
    <USB>\\U-Claw\\data\\logs\\main.log
    <USB>\\U-Claw\\data\\logs\\gateway.log
    %LOCALAPPDATA%\\U-Claw\\launcher-logs\\U-Claw-Launcher.log
    %LOCALAPPDATA%\\U-Claw\\launcher-logs\\Windows-Start-App.log

Edition:
  ${keyRule}

Video chain:
  U-Claw -> server adapter -> New API -> Jimeng
  xai.baseUrl = https://video-adapter.gmnlee.com/xai/v1
  xai.apiKey = uclaw-video-adapter

Artifacts:
  u-claw-app-mac-arm64.tar.gz  sha256=${macArm64Hash}
  u-claw-app-mac-x64.tar.gz    sha256=${macX64Hash}
  u-claw-app-win-x64.zip       sha256=${winHash}

Deploy rule:
  app/, launchers, scripts, and package notes are replaced on update.
  data/ is initialized only for a new disk and is never overwritten on update.
  Existing chats, skills, memory, license, logs, and data/.openclaw/openclaw.json stay untouched.

Launcher behavior:
  Launchers show native progress only while copying, extracting, syncing, or closing.
  Electron window stays hidden until Gateway ready/App ready, then opens directly to the main UI.
  Runtime data uses a per-USB computer cache for speed, then syncs back to <USB>/U-Claw/data.
  Electron Control UI profile uses local per-USB/per-platform storage and is never synced with data/.
  Runtime sync never overwrites USB data/.openclaw/openclaw.json.
  USB-to-runtime startup sync copies data/.openclaw/openclaw.json so new computers get the disk config.
  OpenClaw device pairing state stays in each computer runtime cache and is not synced between Mac/Windows.
  Two USB disks use different cache IDs, so their data does not merge.
  Clean same-machine restart reuses current app and data cache, skipping USB-to-runtime sync when markers match.
  Close asks for confirmation first, then shows shutdown progress in app while launcher stays hidden.
  Immediate reopen during shutdown queues one relaunch instead of starting a second app/process.
	`;
}

function packageVersionJson(macArm64Hash, macX64Hash, winHash) {
  return `${JSON.stringify({
    schemaVersion: 1,
    version,
    releaseId: `v${version}`,
    installedAt: new Date().toISOString(),
    platforms: {
      'darwin-arm64': {
        archiveSha256: macArm64Hash,
        launcherSha256: null,
        treeDigest: null
      },
      'darwin-x64': {
        archiveSha256: macX64Hash,
        launcherSha256: null,
        treeDigest: null
      },
      'win32-x64': {
        archiveSha256: winHash,
        launcherSha256: null,
        treeDigest: null
      }
    }
  }, null, 2)}\n`;
}

function buildMacLauncher(stageRoot) {
  ensureFile(macLauncherSource, 'macOS launcher source');
  ensureFile(macStartScript, 'macOS start script');
  writeText(
    macLauncherScriptInclude,
    [
      `static const char *kMacStartScript = ${JSON.stringify(fs.readFileSync(macStartScript, 'utf8'))};`,
      `static const char *kMacArm64ArchiveHash = "${sha256(macArm64Archive)}";`,
      `static const char *kMacX64ArchiveHash = "${sha256(macX64Archive)}";`,
      ''
    ].join('\n')
  );
  fs.mkdirSync(path.dirname(macLauncherBinary), { recursive: true });
  run('clang', [
    '-x',
    'objective-c',
    '-fobjc-arc',
    '-fblocks',
    '-arch',
    'arm64',
    '-arch',
    'x86_64',
    '-mmacosx-version-min=10.15',
    '-framework',
    'Cocoa',
    '-o',
    macLauncherBinary,
    macLauncherSource
  ]);
  ensureFile(macLauncherBinary, 'macOS launcher executable');

  const appBundle = path.join(stageRoot, 'U-Claw Launcher.app');
  const contentsDir = path.join(appBundle, 'Contents');
  const macOsDir = path.join(contentsDir, 'MacOS');
  const executablePath = path.join(macOsDir, 'U-Claw Launcher');

  fs.rmSync(appBundle, { recursive: true, force: true });
  fs.mkdirSync(macOsDir, { recursive: true });
  writeText(path.join(contentsDir, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>U-Claw Launcher</string>
  <key>CFBundleIdentifier</key>
  <string>org.u-claw.portable.launcher</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>U-Claw Launcher</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>LSMinimumSystemVersion</key>
  <string>10.15</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`);
  fs.copyFileSync(macLauncherBinary, executablePath);
  fs.chmodSync(executablePath, 0o755);
  run('codesign', ['--force', '--deep', '--sign', '-', appBundle]);
}

function buildWindowsLauncher(stageRoot) {
  ensureFile(path.join(winLauncherSourceDir, 'main.go'), 'Windows launcher source');
  fs.mkdirSync(path.dirname(winLauncherBinary), { recursive: true });
  run('go', ['build', '-trimpath', '-ldflags=-H windowsgui -s -w', '-o', winLauncherBinary, '.'], {
    cwd: winLauncherSourceDir,
    env: {
      GOOS: 'windows',
      GOARCH: 'amd64',
      CGO_ENABLED: '0',
      GO111MODULE: 'off'
    }
  });
  ensureFile(winLauncherBinary, 'Windows GUI launcher');
  fs.copyFileSync(winLauncherBinary, path.join(stageRoot, 'U-Claw Launcher.exe'));
}

function assembleStage(edition) {
  ensureFile(macArm64Archive, 'Mac arm64 archive');
  ensureFile(macX64Archive, 'Mac x64 archive');
  ensureFile(winArchive, 'Windows archive');
  const macArm64Hash = sha256(macArm64Archive);
  const macX64Hash = sha256(macX64Archive);
  const winHash = sha256(winArchive);
  const stageRoot = path.join(releaseDir, `portable-${edition}`, 'U-Claw');
  const archiveDir = path.join(stageRoot, 'app', 'desktop-archive');
  const configPath = path.join(stageRoot, 'data', '.openclaw', 'openclaw.json');

  fs.rmSync(path.dirname(stageRoot), { recursive: true, force: true });
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });

  fs.copyFileSync(macArm64Archive, path.join(archiveDir, path.basename(macArm64Archive)));
  fs.copyFileSync(macX64Archive, path.join(archiveDir, path.basename(macX64Archive)));
  fs.copyFileSync(winArchive, path.join(archiveDir, path.basename(winArchive)));
  writeText(path.join(archiveDir, `${path.basename(macArm64Archive)}.sha256`), `${macArm64Hash}\n`);
  writeText(path.join(archiveDir, `${path.basename(macX64Archive)}.sha256`), `${macX64Hash}\n`);
  writeText(path.join(archiveDir, `${path.basename(winArchive)}.sha256`), `${winHash}\n`);
  writeText(path.join(stageRoot, 'app', 'version.json'), packageVersionJson(macArm64Hash, macX64Hash, winHash));
  fs.copyFileSync(path.join(appDir, 'scripts', 'Mac-Start-App.command'), path.join(stageRoot, 'Mac-Start-App.command'));
  fs.copyFileSync(path.join(appDir, 'scripts', 'Windows-Start-App.bat'), path.join(stageRoot, 'Windows-Start-App.bat'));
  fs.copyFileSync(winSyncScript, path.join(stageRoot, 'Windows-Sync-Data.ps1'));
  fs.chmodSync(path.join(stageRoot, 'Mac-Start-App.command'), 0o755);
  buildMacLauncher(stageRoot);
  buildWindowsLauncher(stageRoot);
  generateConfig(edition, configPath);
  seedStreamerAuthStore(edition, stageRoot);
  writeText(path.join(stageRoot, 'UCLAW-PACKAGE-NOTES.txt'), packageNotes(edition, macArm64Hash, macX64Hash, winHash));
  removeAppleDoubleFiles(stageRoot);

  return { stageRoot, macArm64Hash, macX64Hash, winHash };
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

function backupDirIfExists(source, destination) {
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) return;
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

function deploy(stage, usbRoot) {
  const resolvedUsbRoot = path.resolve(usbRoot);
  if (!fs.existsSync(resolvedUsbRoot) || !fs.statSync(resolvedUsbRoot).isDirectory()) {
    throw new Error(`USB mount does not exist: ${resolvedUsbRoot}`);
  }
  const targetRoot = path.basename(resolvedUsbRoot).toLowerCase() === 'u-claw'
    ? resolvedUsbRoot
    : path.join(resolvedUsbRoot, 'U-Claw');
  fs.mkdirSync(targetRoot, { recursive: true });

  const backupRoot = path.join(targetRoot, `_backup-before-portable-deploy-${localTimestamp()}`);
  const relativeFiles = [
    'U-Claw Launcher.exe',
    'Mac-Start-App.command',
    'Windows-Start-App.bat',
    'Windows-Sync-Data.ps1',
    'UCLAW-PACKAGE-NOTES.txt',
    'app/version.json',
    'app/desktop-archive/u-claw-app-mac-arm64.tar.gz',
    'app/desktop-archive/u-claw-app-mac-arm64.tar.gz.sha256',
    'app/desktop-archive/u-claw-app-mac-x64.tar.gz',
    'app/desktop-archive/u-claw-app-mac-x64.tar.gz.sha256',
    'app/desktop-archive/u-claw-app-win-x64.zip',
    'app/desktop-archive/u-claw-app-win-x64.zip.sha256'
  ];
  const relativeDirs = [
    'U-Claw Launcher.app'
  ];
  const legacyFiles = [
    `app/desktop-archive/U-Claw ${version}.exe`
  ];
  const legacyDirs = [
    'U-Claw Launcher'
  ];

  for (const relativeFile of relativeFiles) {
    backupIfExists(path.join(targetRoot, relativeFile), path.join(backupRoot, relativeFile));
  }
  for (const relativeDir of relativeDirs) {
    backupDirIfExists(path.join(targetRoot, relativeDir), path.join(backupRoot, relativeDir));
  }
  for (const relativeFile of legacyFiles) {
    backupIfExists(path.join(targetRoot, relativeFile), path.join(backupRoot, relativeFile));
  }
  for (const relativeDir of legacyDirs) {
    backupDirIfExists(path.join(targetRoot, relativeDir), path.join(backupRoot, relativeDir));
  }
  for (const relativeFile of relativeFiles) {
    copyAtomic(path.join(stage.stageRoot, relativeFile), path.join(targetRoot, relativeFile));
  }
  for (const relativeDir of relativeDirs) {
    copyDirReplacing(path.join(stage.stageRoot, relativeDir), path.join(targetRoot, relativeDir));
  }
  const dataInitialized = copyDirIfMissing(path.join(stage.stageRoot, 'data'), path.join(targetRoot, 'data'));
  for (const relativeFile of legacyFiles) {
    const legacyPath = path.join(targetRoot, relativeFile);
    if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
  }
  for (const relativeDir of legacyDirs) {
    fs.rmSync(path.join(targetRoot, relativeDir), { recursive: true, force: true });
  }
  fs.chmodSync(path.join(targetRoot, 'Mac-Start-App.command'), 0o755);
  fs.chmodSync(path.join(targetRoot, 'U-Claw Launcher.app', 'Contents', 'MacOS', 'U-Claw Launcher'), 0o755);
  const appleDoubleRemoved = removeAppleDoubleFiles(targetRoot);

  const deployedMacArm64Hash = sha256(path.join(targetRoot, 'app', 'desktop-archive', path.basename(macArm64Archive)));
  const deployedMacX64Hash = sha256(path.join(targetRoot, 'app', 'desktop-archive', path.basename(macX64Archive)));
  const deployedWinHash = sha256(path.join(targetRoot, 'app', 'desktop-archive', path.basename(winArchive)));
  if (
    deployedMacArm64Hash !== stage.macArm64Hash
    || deployedMacX64Hash !== stage.macX64Hash
    || deployedWinHash !== stage.winHash
  ) {
    throw new Error('Deployed archive hash verification failed');
  }

  console.log(`[package:portable] deployed ${targetRoot}`);
  console.log(`[package:portable] data ${dataInitialized ? 'initialized' : 'preserved'} ${path.join(targetRoot, 'data')}`);
  console.log(`[package:portable] removed AppleDouble metadata files ${appleDoubleRemoved}`);
  console.log(`[package:portable] rollback ${backupRoot}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  if (!options.skipBuild) {
    buildApps();
    buildArchives();
  }
  const stage = assembleStage(options.edition);
  console.log(`[package:portable] staged ${stage.stageRoot}`);
  console.log(`[package:portable] Mac arm64 sha256 ${stage.macArm64Hash}`);
  console.log(`[package:portable] Mac x64 sha256 ${stage.macX64Hash}`);
  console.log(`[package:portable] Windows sha256 ${stage.winHash}`);
  if (options.usb) deploy(stage, options.usb);
}

try {
  main();
} catch (error) {
  console.error(`[package:portable] ${error.message}`);
  process.exit(1);
}
