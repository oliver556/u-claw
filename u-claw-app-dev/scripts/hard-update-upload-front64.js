#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { readJson, sha256File } = require('./lib/hard-update-utils');
const { firstEnv, parseEnvFile } = require('./lib/local-env');

const appDir = path.resolve(__dirname, '..');
const defaultReleaseRoot = path.join(appDir, 'release', 'mock-hard-update');
const defaultEnvPath = path.join(appDir, '.env');
const defaultPublicBaseUrl = 'https://download.yiyong.me/uclaw/releases';
const defaultRemoteRoot = '/srv/uclaw-updates/releases';
const requiredPlatforms = ['darwin-arm64', 'darwin-x64', 'win32-x64'];

function usage() {
  console.log(`Usage:
  node scripts/hard-update-upload-front64.js --release release/mock-hard-update --env .env
  node scripts/hard-update-upload-front64.js --release release/bavi-box-v1.0.1-front64 --dry-run

Options:
  --release <dir>       Release root from hard-update-package.js. Defaults to release/mock-hard-update.
  --env <file>          Local env file. Defaults to .env.
  --host <host>         Front64 SSH host. Defaults to UCLAW_FRONT64_HOST, then 64.90.19.251.
  --port <port>         Front64 SSH port. Defaults to UCLAW_FRONT64_PORT, then 24851.
  --user <user>         Front64 SSH user. Defaults to UCLAW_FRONT64_USER, then root.
  --remote-root <dir>   Remote releases root. Defaults to UCLAW_FRONT64_RELEASE_ROOT, then ${defaultRemoteRoot}.
  --public-base-url <url>
                       Public releases base URL. Defaults to ${defaultPublicBaseUrl}.
  --ssh-key <path>      SSH private key path. Defaults to UCLAW_FRONT64_SSH_KEY.
  --keep <count>        Keep newest N package versions on server. Defaults to UCLAW_FRONT64_KEEP_RELEASES, then 3.
  --dry-run             Print plan only; no SSH/SCP.

Password auth:
  Prefer --ssh-key / UCLAW_FRONT64_SSH_KEY. If key auth is unavailable, set UCLAW_FRONT64_PASSWORD
  or UCLAW_FRONT64_PASSWORD_FILE locally. Do not commit passwords to .env.
`);
}

function parseArgs(argv) {
  const options = {
    release: defaultReleaseRoot,
    env: defaultEnvPath,
    dryRun: false
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
    else if (arg === '--env') options.env = readValue();
    else if (arg === '--host') options.host = readValue();
    else if (arg === '--port') options.port = readValue();
    else if (arg === '--user') options.user = readValue();
    else if (arg === '--remote-root') options.remoteRoot = readValue();
    else if (arg === '--public-base-url') options.publicBaseUrl = readValue();
    else if (arg === '--ssh-key') options.sshKey = readValue();
    else if (arg === '--keep') options.keep = readValue();
    else if (arg === '--dry-run') options.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return fallback;
}

function readPasswordFile(filePath) {
  if (!filePath) return '';
  return fs.readFileSync(path.resolve(filePath), 'utf8').trim();
}

function loadConfig(options) {
  const env = parseEnvFile(path.resolve(options.env));
  return {
    host: options.host || firstEnv(env, ['UCLAW_FRONT64_HOST']) || '64.90.19.251',
    port: String(options.port || firstEnv(env, ['UCLAW_FRONT64_PORT']) || '24851'),
    user: options.user || firstEnv(env, ['UCLAW_FRONT64_USER']) || 'root',
    remoteRoot: (options.remoteRoot || firstEnv(env, ['UCLAW_FRONT64_RELEASE_ROOT']) || defaultRemoteRoot).replace(/\/+$/, ''),
    publicBaseUrl: (options.publicBaseUrl || firstEnv(env, ['UCLAW_FRONT64_PUBLIC_BASE_URL', 'UCLAW_RELEASES_BASE_URL']) || defaultPublicBaseUrl).replace(/\/+$/, ''),
    sshKey: options.sshKey || firstEnv(env, ['UCLAW_FRONT64_SSH_KEY']),
    password: firstEnv(env, ['UCLAW_FRONT64_PASSWORD']) || readPasswordFile(firstEnv(env, ['UCLAW_FRONT64_PASSWORD_FILE'])),
    keep: positiveInteger(options.keep || firstEnv(env, ['UCLAW_FRONT64_KEEP_RELEASES']), 3)
  };
}

function assertSafeRemoteRoot(remoteRoot) {
  if (!remoteRoot.startsWith('/srv/')) {
    throw new Error(`Refusing unsafe remote root outside /srv: ${remoteRoot}`);
  }
  if (remoteRoot === '/srv' || remoteRoot === '/srv/') {
    throw new Error('Refusing broad remote root: /srv');
  }
}

function assertSafeReleaseId(releaseId) {
  if (!/^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(releaseId)) {
    throw new Error(`Refusing unsafe releaseId: ${releaseId}`);
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sshArgs(config) {
  const args = ['-o', 'StrictHostKeyChecking=no', '-p', config.port];
  if (config.sshKey) args.push('-i', path.resolve(config.sshKey));
  args.push(`${config.user}@${config.host}`);
  return args;
}

function scpArgs(config, source, remoteDestination) {
  const args = ['-P', config.port, '-o', 'StrictHostKeyChecking=no'];
  if (config.sshKey) args.push('-i', path.resolve(config.sshKey));
  args.push(source, `${config.user}@${config.host}:${remoteDestination}`);
  return args;
}

function runExpect(command, args, password) {
  const shellCommand = [command, ...args].map(shellQuote).join(' ');
  const expectScript = `
set timeout -1
spawn /bin/sh -lc $env(FRONT64_COMMAND)
expect {
  -re {Are you sure you want to continue connecting} { send "yes\\r"; exp_continue }
  -re {[Pp]assword:} { send -- "$env(FRONT64_PASSWORD)\\r"; exp_continue }
  eof
}
catch wait result
exit [lindex $result 3]
`;
  const result = spawnSync('/usr/bin/expect', ['-c', expectScript], {
    cwd: appDir,
    env: { ...process.env, FRONT64_COMMAND: shellCommand, FRONT64_PASSWORD: password },
    encoding: 'utf8',
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}

function runSync(command, args, config) {
  if (!config.sshKey && config.password) {
    runExpect(command, args, config.password);
    return;
  }
  const result = spawnSync(command, args, {
    cwd: appDir,
    env: process.env,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}

function runAsync(command, args, config) {
  if (!config.sshKey && config.password) {
    return new Promise((resolve, reject) => {
      const shellCommand = [command, ...args].map(shellQuote).join(' ');
      const expectScript = `
set timeout -1
spawn /bin/sh -lc $env(FRONT64_COMMAND)
expect {
  -re {Are you sure you want to continue connecting} { send "yes\\r"; exp_continue }
  -re {[Pp]assword:} { send -- "$env(FRONT64_PASSWORD)\\r"; exp_continue }
  eof
}
catch wait result
exit [lindex $result 3]
`;
      const child = spawn('/usr/bin/expect', ['-c', expectScript], {
        cwd: appDir,
        env: { ...process.env, FRONT64_COMMAND: shellCommand, FRONT64_PASSWORD: config.password },
        stdio: 'inherit'
      });
      child.on('error', reject);
      child.on('exit', status => {
        if (status === 0) resolve();
        else reject(new Error(`${command} failed with status ${status}`));
      });
    });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: appDir,
      env: process.env,
      stdio: 'inherit'
    });
    child.on('error', reject);
    child.on('exit', status => {
      if (status === 0) resolve();
      else reject(new Error(`${command} failed with status ${status}`));
    });
  });
}

function remoteShell(config, script) {
  runSync('ssh', [...sshArgs(config), script], config);
}

function releaseObjects(releaseRoot) {
  const production = readJson(path.join(releaseRoot, 'production.json'));
  const releaseId = production.releaseId;
  if (!releaseId) throw new Error('production.json missing releaseId');
  assertSafeReleaseId(releaseId);
  const platformKeys = Object.keys(production.platforms || {}).sort();
  for (const platformKey of requiredPlatforms) {
    if (!platformKeys.includes(platformKey)) {
      throw new Error(`Front64 publish requires full platform release; missing ${platformKey}`);
    }
  }
  for (const platformKey of platformKeys) {
    if (!requiredPlatforms.includes(platformKey)) {
      throw new Error(`Front64 publish refuses unknown platform: ${platformKey}`);
    }
  }
  const immutable = [{
    filePath: path.join(releaseRoot, 'bootstrap', 'release-public-keys.json'),
    remotePath: 'bootstrap/release-public-keys.json'
  }];
  for (const platformKey of platformKeys) {
    const dir = path.join(releaseRoot, 'packages', releaseId, platformKey);
    immutable.push(
      { filePath: path.join(dir, 'runtime.pkg'), remotePath: `packages/${releaseId}/${platformKey}/runtime.pkg` },
      { filePath: path.join(dir, 'runtime.pkg.sha256'), remotePath: `packages/${releaseId}/${platformKey}/runtime.pkg.sha256` },
      { filePath: path.join(dir, 'sbom.json'), remotePath: `packages/${releaseId}/${platformKey}/sbom.json` },
      { filePath: path.join(dir, 'manifest.json'), remotePath: `packages/${releaseId}/${platformKey}/manifest.json` }
    );
  }
  const productionObject = {
    filePath: path.join(releaseRoot, 'production.json'),
    remotePath: 'production.json'
  };
  for (const object of [...immutable, productionObject]) {
    if (!fs.existsSync(object.filePath)) throw new Error(`Missing release file: ${object.filePath}`);
    if (path.basename(object.filePath).startsWith('._')) throw new Error(`Refusing AppleDouble file: ${object.filePath}`);
    object.sha256 = sha256File(object.filePath);
    object.size = fs.statSync(object.filePath).size;
  }
  return { production, immutable, productionObject };
}

function prepareRemoteScript(config, releaseId, directories) {
  const mkdirs = directories.map(dir => `mkdir -p ${shellQuote(path.posix.join(config.remoteRoot, dir))}`).join('\n');
  return `set -eu
remote_root=${shellQuote(config.remoteRoot)}
mkdir -p "$remote_root/bootstrap" "$remote_root/packages"
rm -rf "$remote_root/packages/${releaseId}"
${mkdirs}
rm -f "$remote_root/.production.json.tmp"
find "$remote_root" -type f -name '._*' -delete
find "$(dirname "$remote_root")" -maxdepth 1 -type d -name 'releases.tmp-*' -prune -exec rm -rf -- {} +
rm -rf "$(dirname "$remote_root")/releases-test"
`;
}

function verifyRemoteScript(config, objects) {
  const lines = ['set -eu', `remote_root=${shellQuote(config.remoteRoot)}`];
  for (const object of objects) {
    lines.push(`test "$(sha256sum "$remote_root/${object.remotePath}" | awk '{print $1}')" = ${shellQuote(object.sha256)}`);
  }
  lines.push(`find "$remote_root" -type f -name '._*' -delete`);
  lines.push(`find "$remote_root" -type d -exec chmod 0755 {} +`);
  lines.push(`find "$remote_root" -type f -exec chmod 0644 {} +`);
  return lines.join('\n');
}

function publishProductionScript(config) {
  return `set -eu
remote_root=${shellQuote(config.remoteRoot)}
install -m 0644 "$remote_root/.production.json.tmp" "$remote_root/production.json"
rm -f "$remote_root/.production.json.tmp"
`;
}

function retentionScript(config) {
  return `set -eu
remote_root=${shellQuote(config.remoteRoot)}
keep=${config.keep}
packages="$remote_root/packages"
if [ -d "$packages" ]; then
  count="$(find "$packages" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
  if [ "$count" -gt "$keep" ]; then
    delete_count="$((count - keep))"
    find "$packages" -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' | sort -V | head -n "$delete_count" | while IFS= read -r release_id; do
      case "$release_id" in
        v[0-9]*)
          rm -rf "$packages/$release_id"
          echo "[hard-update-upload-front64] removed old release $release_id"
          ;;
        *)
          echo "[hard-update-upload-front64] skipped non-version release dir $release_id"
          ;;
      esac
    done
  fi
fi
find "$remote_root" -type f -name '._*' -delete
`;
}

async function uploadObjects(config, objects, concurrency) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, objects.length) }, async () => {
    while (cursor < objects.length) {
      const object = objects[cursor];
      cursor += 1;
      const destination = `${config.remoteRoot}/${object.remotePath}`;
      console.log(`[hard-update-upload-front64] upload ${object.remotePath} (${object.size} bytes)`);
      await runAsync('scp', scpArgs(config, object.filePath, destination), config);
    }
  });
  await Promise.all(workers);
}

function uploadPriority(object) {
  if (object.remotePath.endsWith('/runtime.pkg')) return 0;
  return 1;
}

function printPlan(config, release) {
  console.log(JSON.stringify({
    host: config.host,
    port: config.port,
    user: config.user,
    remoteRoot: config.remoteRoot,
    publicBaseUrl: config.publicBaseUrl,
    keep: config.keep,
    releaseId: release.production.releaseId,
    requiredVersion: release.production.requiredVersion,
    immutableObjects: release.immutable.map(object => object.remotePath),
    productionObject: release.productionObject.remotePath
  }, null, 2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const releaseRoot = path.resolve(options.release);
  const config = loadConfig(options);
  assertSafeRemoteRoot(config.remoteRoot);
  const release = releaseObjects(releaseRoot);
  const directories = Array.from(new Set(release.immutable.map(object => path.posix.dirname(object.remotePath)))).sort();
  if (options.dryRun) {
    printPlan(config, release);
    return;
  }
  console.log(`[hard-update-upload-front64] release ${release.production.releaseId}`);
  console.log(`[hard-update-upload-front64] remote ${config.user}@${config.host}:${config.port}:${config.remoteRoot}`);
  remoteShell(config, prepareRemoteScript(config, release.production.releaseId, directories));
  const orderedImmutable = [...release.immutable].sort((left, right) => {
    const priorityDelta = uploadPriority(left) - uploadPriority(right);
    if (priorityDelta) return priorityDelta;
    return left.remotePath.localeCompare(right.remotePath);
  });
  await uploadObjects(config, orderedImmutable, 1);
  remoteShell(config, verifyRemoteScript(config, release.immutable));
  await uploadObjects(config, [{
    ...release.productionObject,
    remotePath: '.production.json.tmp'
  }], 1);
  remoteShell(config, publishProductionScript(config));
  remoteShell(config, verifyRemoteScript(config, [release.productionObject]));
  remoteShell(config, retentionScript(config));
  console.log(`[hard-update-upload-front64] production ${config.publicBaseUrl}/production.json`);
  console.log(`[hard-update-upload-front64] kept newest ${config.keep} package versions`);
}

main().catch(error => {
  console.error(`[hard-update-upload-front64] ${error.message}`);
  process.exit(1);
});
