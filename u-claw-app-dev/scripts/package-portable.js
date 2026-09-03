#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const appDir = path.resolve(__dirname, '..');
const releaseDir = path.join(appDir, 'release');
const packageJson = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
const version = packageJson.version;
const macArm64AppDir = path.join(releaseDir, 'mac-arm64', 'Bavi-box.app');
const macX64AppDir = path.join(releaseDir, 'mac', 'Bavi-box.app');
const winAppDir = path.join(releaseDir, 'win-unpacked');
const macArm64Archive = path.join(releaseDir, 'u-claw-app-mac-arm64.tar.gz');
const macX64Archive = path.join(releaseDir, 'u-claw-app-mac-x64.tar.gz');
const winArchive = path.join(releaseDir, 'u-claw-app-win-x64.zip');
const macLauncherSource = path.join(appDir, 'scripts', 'launcher', 'macos', 'main.c');
const macStartScript = path.join(appDir, 'scripts', 'Mac-Start-App.command');
const macLauncherScriptInclude = path.join(appDir, 'scripts', 'launcher', 'macos', 'generated-start-script.inc');
const macLauncherBinary = path.join(releaseDir, 'launcher', 'macos', 'Bavi-box');
const appIconIcns = path.join(appDir, 'assets', 'icon.icns');
const winLauncherSourceDir = path.join(appDir, 'scripts', 'launcher', 'windows');
const winLauncherBinary = path.join(releaseDir, 'launcher', 'Bavi-box.exe');
const winLauncherResource = path.join(winLauncherSourceDir, 'rsrc_windows_amd64.syso');
const winUpdaterSourceDir = path.join(appDir, 'scripts', 'updater', 'windows-entry');
const winUpdaterBinary = path.join(releaseDir, 'launcher', 'Bavi-box Win Update.exe');
const winSyncScript = path.join(appDir, 'scripts', 'Windows-Sync-Data.ps1');
const macIndependentUpdateScript = path.join(appDir, 'scripts', 'Bavi-box Mac Update.command');
const desktopAgentDir = path.join(process.env.HOME || '', 'Library', 'Application Support', 'Bavi-box', '.openclaw', 'agents', 'main', 'agent');

function usage() {
  console.log(`Usage:
  npm run package:portable:customer -- --usb /Volumes/UCLAW-01
  npm run package:portable:streamer -- --usb /Volumes/UCLAW-01
  npm run package:portable:customer
  npm run package:portable:streamer

Options:
  --edition <customer|streamer>  Package edition. Added by the npm scripts.
  --usb <mount>                  Deploy to <mount>/Bavi-box after staging.
  --platform <key>               Rebuild only one platform app archive. Supports win32-x64.
  --skip-build                   Reuse current release archives and rebuild only launcher/stage files.
`);
}

function parseArgs(argv) {
  const options = { edition: '', usb: '', platform: '', skipBuild: false };
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
    else if (arg === '--platform') options.platform = readValue();
    else if (arg === '--skip-build') options.skipBuild = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.help && !['customer', 'streamer'].includes(options.edition)) {
    throw new Error('--edition must be customer or streamer');
  }
  if (options.platform && options.platform !== 'win32-x64') {
    throw new Error('--platform currently supports win32-x64 only');
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

function buildWindowsAppOnly() {
  ensureDir(path.join(appDir, 'node_modules', 'electron-builder'), 'electron-builder dependency');
  ensureSourceRuntime('node-win32-x64');
  run('npm', ['run', 'patch-openclaw']);
  run('npm', ['run', 'sync-lib']);
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
  ensureFile(path.join(macArm64AppDir, 'Contents', 'MacOS', 'Bavi-box'), 'Mac arm64 executable');
  ensureDir(macX64AppDir, 'Mac x64 app');
  ensureFile(path.join(macX64AppDir, 'Contents', 'MacOS', 'Bavi-box'), 'Mac x64 executable');
  ensureDir(winAppDir, 'Windows x64 app');
  ensureFile(path.join(winAppDir, 'Bavi-box.exe'), 'Windows executable');

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

function buildWindowsArchiveOnly() {
  ensureDir(winAppDir, 'Windows x64 app');
  ensureFile(path.join(winAppDir, 'Bavi-box.exe'), 'Windows executable');
  keepPackagedRuntime(
    path.join(winAppDir, 'resources', 'resources', 'runtime'),
    'node-win32-x64',
    'Windows'
  );

  const winTemporary = path.join(releaseDir, 'u-claw-app-win-x64.new.zip');
  fs.rmSync(winTemporary, { force: true });
  run('zip', ['-qry', winTemporary, '.'], {
    cwd: winAppDir,
    env: { COPYFILE_DISABLE: '1' }
  });
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
  if (providers.xai?.baseUrl !== 'https://api.yiyong.me/v1') {
    throw new Error(`Wrong xai base URL: ${providers.xai?.baseUrl || '(empty)'}`);
  }
  if (edition === 'streamer' && providers.xai?.apiKey !== providers.custom?.apiKey) {
    throw new Error('Wrong xai API key');
  }
  if (edition === 'customer' && providers.xai?.apiKey) {
    throw new Error('Customer package contains an xai API key');
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
  return `Bavi-box portable package - ${edition} edition
Version: ${version}
Built: ${localDisplayTime()}

  Mac:
  Formal entry: double-click Bavi-box.app
  Independent updater: double-click Bavi-box Mac Update.command
  Diagnostic entry: app/scripts/Mac-Start-App.command
  App cache: ~/Library/Caches/Bavi-box/u-claw-app-mac-arm64
  App cache: ~/Library/Caches/Bavi-box/u-claw-app-mac-x64
  USB data: <USB>/Bavi-box/data
  Runtime data cache: ~/Library/Caches/Bavi-box/usb-portable-<usb-id>/data
  Logs to return:
    <USB>/Bavi-box/data/logs/Bavi-box-Launcher.log
    <USB>/Bavi-box/data/logs/Mac-Start-App.log
    <USB>/Bavi-box/data/logs/main.log
    <USB>/Bavi-box/data/logs/gateway.log
    ~/Library/Caches/Bavi-box/launcher-logs/Bavi-box-Launcher.log
    ~/Library/Caches/Bavi-box/launcher-logs/Mac-Start-App.log

  Windows:
  Formal entry: double-click Bavi-box.exe
  Independent updater: double-click Bavi-box Win Update.exe
  Diagnostic entry: app/scripts/Windows-Start-App.bat
  Sync helper: app/scripts/Windows-Sync-Data.ps1
  App cache: %LOCALAPPDATA%\\Bavi-box\\usb-portable\\app-win-x64
  USB data: <USB>\\Bavi-box\\data
  Runtime data cache: %LOCALAPPDATA%\\Bavi-box\\usb-portable\\data-<usb-id>
  First launch: verify SHA-256, then extract with Windows tar.exe.
  Later launches: reuse the computer app cache without extracting again.
  Logs to return:
    <USB>\\Bavi-box\\data\\logs\\Bavi-box-Launcher.log
    <USB>\\Bavi-box\\data\\logs\\Windows-Start-App.log
    <USB>\\Bavi-box\\data\\logs\\main.log
    <USB>\\Bavi-box\\data\\logs\\gateway.log
    %LOCALAPPDATA%\\Bavi-box\\launcher-logs\\Bavi-box-Launcher.log
    %LOCALAPPDATA%\\Bavi-box\\launcher-logs\\Windows-Start-App.log

Edition:
  ${keyRule}

Video chain:
  Bavi-box -> New API -> server adapter -> Flash/Seedance
  xai.baseUrl = https://api.yiyong.me/v1
  xai.apiKey = ${edition === 'streamer' ? 'same as custom/litellm New API key' : 'empty'}

Artifacts:
  u-claw-app-mac-arm64.tar.gz  sha256=${macArm64Hash}
  u-claw-app-mac-x64.tar.gz    sha256=${macX64Hash}
  u-claw-app-win-x64.zip       sha256=${winHash}

Deploy rule:
  app/, launchers, and package notes are replaced on update.
  data/ is initialized only for a new disk and is never overwritten on update.
  Existing chats, skills, memory, license, logs, and data/.openclaw/openclaw.json stay untouched.

Launcher behavior:
  Launchers show native progress only while copying, extracting, syncing, or closing.
  Electron window stays hidden until Gateway ready/App ready, then opens directly to the main UI.
  Runtime data uses a per-USB computer cache for speed, then syncs back to <USB>/Bavi-box/data.
  Electron Control UI profile uses local per-USB/per-platform storage and is never synced with data/.
  Runtime sync never overwrites USB data/.openclaw/openclaw.json.
  Activation writes approved license and model credential files back to USB before launcher restart.
  USB-to-runtime startup sync copies data/.openclaw/openclaw.json so new computers get the disk config.
  OpenClaw device pairing state stays in each computer runtime cache and is not synced between Mac/Windows.
  Two USB disks use different cache IDs, so their data does not merge.
  Clean same-machine restart reuses current app and data cache, skipping USB-to-runtime sync when markers match.
  Close asks for confirmation first, then shows shutdown progress in app while launcher stays hidden.
  Immediate reopen during shutdown queues one relaunch instead of starting a second app/process.
  Independent updater downloads, verifies, stages, replaces program layer, and launches Bavi-box.app/Bavi-box.exe after completion.
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
  ensureFile(appIconIcns, 'macOS launcher icon');
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

  const appBundle = path.join(stageRoot, 'Bavi-box.app');
  const contentsDir = path.join(appBundle, 'Contents');
  const macOsDir = path.join(contentsDir, 'MacOS');
  const resourcesDir = path.join(contentsDir, 'Resources');
  const executablePath = path.join(macOsDir, 'Bavi-box');

  fs.rmSync(appBundle, { recursive: true, force: true });
  fs.mkdirSync(macOsDir, { recursive: true });
  writeText(path.join(contentsDir, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>Bavi-box</string>
  <key>CFBundleIdentifier</key>
  <string>org.u-claw.portable.launcher</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Bavi-box</string>
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
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.copyFileSync(appIconIcns, path.join(resourcesDir, 'icon.icns'));
  fs.chmodSync(executablePath, 0o755);
  run('codesign', ['--force', '--deep', '--sign', '-', appBundle]);
}

function buildWindowsLauncher(stageRoot) {
  ensureFile(path.join(winLauncherSourceDir, 'main.go'), 'Windows launcher source');
  ensureFile(winLauncherResource, 'Windows launcher icon resource');
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
  fs.copyFileSync(winLauncherBinary, path.join(stageRoot, 'Bavi-box.exe'));
}

function buildWindowsUpdater(stageRoot) {
  ensureFile(path.join(winUpdaterSourceDir, 'main.go'), 'Windows updater source');
  fs.mkdirSync(path.dirname(winUpdaterBinary), { recursive: true });
  run('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', winUpdaterBinary, '.'], {
    cwd: winUpdaterSourceDir,
    env: {
      GOOS: 'windows',
      GOARCH: 'amd64',
      CGO_ENABLED: '0',
      GO111MODULE: 'off'
    }
  });
  ensureFile(winUpdaterBinary, 'Windows updater executable');
  fs.copyFileSync(winUpdaterBinary, path.join(stageRoot, 'Bavi-box Win Update.exe'));
}

function copyUpdateRuntime(stageRoot) {
  const destination = path.join(stageRoot, 'app', 'update-runtime');
  fs.rmSync(destination, { recursive: true, force: true });
  const runtimes = [
    ['node-darwin-arm64', path.join('bin', 'node'), 'tar.gz'],
    ['node-darwin-x64', path.join('bin', 'node'), 'tar.gz'],
    ['node-win32-x64', 'node.exe', 'zip']
  ];
  const temporaryRoot = fs.mkdtempSync(path.join(releaseDir, 'updater-runtime-'));
  try {
    for (const [runtimeName, executableRelativePath, archiveType] of runtimes) {
      const source = path.join(appDir, 'resources', 'runtime', runtimeName, executableRelativePath);
      ensureFile(source, `updater runtime ${runtimeName}`);
      const sourceRoot = path.join(temporaryRoot, runtimeName);
      const stagedExecutable = path.join(sourceRoot, executableRelativePath);
      fs.mkdirSync(path.dirname(stagedExecutable), { recursive: true });
      fs.copyFileSync(source, stagedExecutable);
      if (archiveType === 'tar.gz') {
        fs.mkdirSync(destination, { recursive: true });
        run('tar', ['-czf', path.join(destination, `${runtimeName}.tar.gz`), '-C', sourceRoot, '.'], {
          env: { COPYFILE_DISABLE: '1' }
        });
      } else {
        fs.mkdirSync(destination, { recursive: true });
        run('zip', ['-qry', path.join(destination, `${runtimeName}.zip`), '.'], {
          cwd: sourceRoot,
          env: { COPYFILE_DISABLE: '1' }
        });
      }
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function assembleStage(edition) {
  ensureFile(macArm64Archive, 'Mac arm64 archive');
  ensureFile(macX64Archive, 'Mac x64 archive');
  ensureFile(winArchive, 'Windows archive');
  const macArm64Hash = sha256(macArm64Archive);
  const macX64Hash = sha256(macX64Archive);
  const winHash = sha256(winArchive);
  const stageRoot = path.join(releaseDir, `portable-${edition}`, 'Bavi-box');
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
  const portableScriptsDir = path.join(stageRoot, 'app', 'scripts');
  fs.mkdirSync(portableScriptsDir, { recursive: true });
  fs.copyFileSync(path.join(appDir, 'scripts', 'Mac-Start-App.command'), path.join(portableScriptsDir, 'Mac-Start-App.command'));
  fs.copyFileSync(path.join(appDir, 'scripts', 'Windows-Start-App.bat'), path.join(portableScriptsDir, 'Windows-Start-App.bat'));
  fs.copyFileSync(winSyncScript, path.join(portableScriptsDir, 'Windows-Sync-Data.ps1'));
  fs.copyFileSync(path.join(appDir, 'scripts', 'hard-update-client.js'), path.join(portableScriptsDir, 'hard-update-client.js'));
  fs.cpSync(path.join(appDir, 'scripts', 'lib'), path.join(portableScriptsDir, 'lib'), { recursive: true });
  fs.copyFileSync(macIndependentUpdateScript, path.join(stageRoot, 'Bavi-box Mac Update.command'));
  fs.chmodSync(path.join(portableScriptsDir, 'Mac-Start-App.command'), 0o755);
  fs.chmodSync(path.join(stageRoot, 'Bavi-box Mac Update.command'), 0o755);
  copyUpdateRuntime(stageRoot);
  buildMacLauncher(stageRoot);
  buildWindowsLauncher(stageRoot);
  buildWindowsUpdater(stageRoot);
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
  const rootName = path.basename(resolvedUsbRoot).toLowerCase();
  const targetRoot = rootName === 'bavi-box' || rootName === 'u-claw'
    ? resolvedUsbRoot
    : path.join(resolvedUsbRoot, 'Bavi-box');
  fs.mkdirSync(targetRoot, { recursive: true });

  const backupRoot = path.join(targetRoot, `_backup-before-portable-deploy-${localTimestamp()}`);
  const relativeFiles = [
    'Bavi-box.exe',
    'Bavi-box Win Update.exe',
    'Bavi-box Mac Update.command',
    'UCLAW-PACKAGE-NOTES.txt',
    'app/version.json',
    'app/scripts/Mac-Start-App.command',
    'app/scripts/Windows-Start-App.bat',
    'app/scripts/Windows-Sync-Data.ps1',
    'app/scripts/hard-update-client.js',
    'app/desktop-archive/u-claw-app-mac-arm64.tar.gz',
    'app/desktop-archive/u-claw-app-mac-arm64.tar.gz.sha256',
    'app/desktop-archive/u-claw-app-mac-x64.tar.gz',
    'app/desktop-archive/u-claw-app-mac-x64.tar.gz.sha256',
    'app/desktop-archive/u-claw-app-win-x64.zip',
    'app/desktop-archive/u-claw-app-win-x64.zip.sha256'
  ];
  const relativeDirs = [
    'Bavi-box.app',
    'app/scripts/lib',
    'app/update-runtime'
  ];
  const legacyFiles = [
    'U-Claw.exe',
    'U-Claw Launcher.exe',
    'Bavi-box Launcher.exe',
    'Mac-Start-App.command',
    'Windows-Start-App.bat',
    'Windows-Sync-Data.ps1',
    'Bavi-box Win 更新.exe',
    'Bavi-box Mac 更新.command',
    `app/desktop-archive/U-Claw ${version}.exe`,
    `app/desktop-archive/Bavi-box ${version}.exe`
  ];
  const legacyDirs = [
    'U-Claw.app',
    'U-Claw Launcher.app',
    'U-Claw Launcher',
    'Bavi-box Launcher.app',
    'Bavi-box Launcher'
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
  fs.chmodSync(path.join(targetRoot, 'app', 'scripts', 'Mac-Start-App.command'), 0o755);
  fs.chmodSync(path.join(targetRoot, 'Bavi-box Mac Update.command'), 0o755);
  fs.chmodSync(path.join(targetRoot, 'Bavi-box.app', 'Contents', 'MacOS', 'Bavi-box'), 0o755);
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
    if (options.platform === 'win32-x64') {
      buildWindowsAppOnly();
      buildWindowsArchiveOnly();
    } else {
      buildApps();
      buildArchives();
    }
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
