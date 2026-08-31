#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const {
  assertSafeRelativePath,
  copyDirFiltered,
  platformParts,
  readJson,
  sha256Bytes,
  sha256File,
  treeDigest,
  unzipTo,
  writeJson,
  rmSyncBestEffort
} = require('./lib/hard-update-utils');
const { verifyPayload } = require('./lib/release-signing');

const productionUrl = 'https://oss-download.yiyong.me/bavi-box/releases/production.json';
const stagingProductionUrl = 'https://oss-download.yiyong.me/bavi-box/releases/production.json';
const defaultUpdateCheckUrl = 'https://updates.yiyong.me/uclaw/update/check';
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
const safeNamePattern = /[^A-Za-z0-9._-]/g;

function bytesToMb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

function dirSizeBytes(root) {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      let stat;
      try {
        stat = fs.lstatSync(absolute);
      } catch (_) {
        continue;
      }
      if (stat.isDirectory()) stack.push(absolute);
      else if (stat.isFile()) total += stat.size;
    }
  }
  return total;
}

function runWithDirectoryProgress(label, directory, totalBytes, operation) {
  const startedAt = Date.now();
  console.log(`[hard-update-client] ${label}...`);
  const interval = setInterval(() => {
    const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const currentBytes = dirSizeBytes(directory);
    if (totalBytes > 0) {
      const pct = Math.min(99.9, (currentBytes / totalBytes) * 100).toFixed(1);
      console.log(`[hard-update-client] ${label}... ${bytesToMb(currentBytes)}/${bytesToMb(totalBytes)} MB (${pct}%), ${elapsed}s elapsed.`);
    } else {
      console.log(`[hard-update-client] ${label}... ${bytesToMb(currentBytes)} MB, ${elapsed}s elapsed.`);
    }
  }, 5000);
  try {
    const result = operation();
    const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    const finalBytes = dirSizeBytes(directory);
    if (totalBytes > 0) {
      console.log(`[hard-update-client] ${label} finished: ${bytesToMb(finalBytes)}/${bytesToMb(totalBytes)} MB, ${elapsed}s elapsed.`);
    } else {
      console.log(`[hard-update-client] ${label} finished: ${bytesToMb(finalBytes)} MB, ${elapsed}s elapsed.`);
    }
    return result;
  } finally {
    clearInterval(interval);
  }
}

function usage() {
  console.log(`Usage:
  node scripts/hard-update-client.js mock-update --usb <Bavi-box root> --release <release root> --platform win32-x64
  node scripts/hard-update-client.js mock-update --usb <Bavi-box root> --update-check-url ${defaultUpdateCheckUrl} --platform win32-x64 --device <device_id> --device-token <token>
  node scripts/hard-update-client.js mock-update --usb <Bavi-box root> --production-url ${stagingProductionUrl} --platform win32-x64
  node scripts/hard-update-client.js independent-update --usb <Bavi-box root> --platform win32-x64 --launch-after <entrypoint>
  node scripts/hard-update-client.js startup-update --usb <Bavi-box root> --platform win32-x64 [--production-url <release.json>]
  node scripts/hard-update-client.js apply-startup-update --usb <Bavi-box root> --transaction <app/update-transaction.json> --wait-pid <pid> --launch-after <entrypoint>
  node scripts/hard-update-client.js check --usb <Bavi-box root> --release <release root> --platform darwin-arm64
  node scripts/hard-update-client.js check --usb <Bavi-box root> --update-check-url ${defaultUpdateCheckUrl} --platform darwin-arm64 --device <device_id> --device-token <token>
  node scripts/hard-update-client.js check --usb <Bavi-box root> --production-url ${stagingProductionUrl} --platform darwin-arm64

Direct production mode is used when --release, --production-url, and --update-check-url are omitted. Default URL:
  ${stagingProductionUrl}

Explicit update check mode:
  ${defaultUpdateCheckUrl}
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
    else if (arg === '--update-check-url') options.updateCheckUrl = readValue();
    else if (arg === '--license') options.license = readValue();
    else if (arg === '--device') options.device = readValue();
    else if (arg === '--device-token') options.deviceToken = readValue();
    else if (arg === '--installed-version') options.installedVersion = readValue();
    else if (arg === '--production-url') options.productionUrl = readValue();
    else if (arg === '--public-keys-url') options.publicKeysUrl = readValue();
    else if (arg === '--transaction') options.transaction = readValue();
    else if (arg === '--wait-pid') options.waitPid = readValue();
    else if (arg === '--wait-shutdown-ms') options.waitShutdownMs = readValue();
    else if (arg === '--launch-after') options.launchAfter = readValue();
    else if (arg === '--stamp-file') options.stampFile = readValue();
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

function shutdownCompletePath(usbRoot) {
  return path.join(runtimeDir(usbRoot), 'shutdown-complete.json');
}

function removeShutdownComplete(usbRoot) {
  fs.rmSync(shutdownCompletePath(usbRoot), { force: true });
}

function waitForShutdownComplete(usbRoot, transactionId, timeoutMs) {
  const filePath = shutdownCompletePath(usbRoot);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (fs.existsSync(filePath)) {
          const payload = readJson(filePath);
          if (payload?.schemaVersion === 1 && payload.reason === 'update' && payload.transactionId === transactionId) {
            resolve();
            return;
          }
        }
      } catch (_) {
        // Keep waiting while the app is still writing shutdown-complete.json.
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(`Timed out waiting for Bavi-box to close for update transaction ${transactionId}`));
        return;
      }
      setTimeout(tick, 1000);
    };
    tick();
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
  return {
    payload: production,
    sha256: sha256File(path.join(releaseRoot, 'production.json'))
  };
}

function readLocalVersion(usbRoot) {
  const filePath = path.join(usbRoot, 'app', 'version.json');
  if (!fs.existsSync(filePath)) return null;
  return readJson(filePath);
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function safeJoin(root, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`Unsafe transaction path: ${relativePath}`);
  }
  const normalized = relativePath.replace(/\\/g, '/');
  assertSafeRelativePath(normalized);
  const joined = path.resolve(root, normalized);
  const resolvedRoot = path.resolve(root);
  if (joined !== resolvedRoot && !joined.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Transaction path escapes root: ${relativePath}`);
  }
  return joined;
}

function validateTransactionPath(usbRoot, transactionFile) {
  const txPath = path.resolve(transactionFile);
  const expected = transactionPath(usbRoot);
  if (txPath !== expected) {
    throw new Error(`Unexpected transaction path: ${transactionFile}`);
  }
  return txPath;
}

function resolveStartupProductionUrl(options) {
  return firstString([
    options.productionUrl,
    stagingProductionUrl
  ]);
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
  return {
    payload: manifest,
    sha256: sha256File(manifestPath)
  };
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

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

function publicKeysUrlForProduction(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/production\.json$/, '/bootstrap/release-public-keys.json');
  return url.toString();
}

function resolveHttpUrl(value, baseUrl) {
  return new URL(value, baseUrl).toString();
}

function safeCacheSegment(value, fallback) {
  const segment = String(value || fallback || 'cache').replace(safeNamePattern, '-');
  return segment || fallback || 'cache';
}

function downloadDirForRuntimePackage(stagingDir, manifest, platformKey) {
  const usbRoot = path.dirname(path.dirname(stagingDir));
  const rootId = sha256Bytes(Buffer.from(usbRoot, 'utf8')).slice(0, 16);
  const packageKey = manifest?.package?.sha256 || 'runtime.pkg';
  return path.join(
    require('os').tmpdir(),
    'bavi-box-update-downloads',
    rootId,
    safeCacheSegment(platformKey, 'platform'),
    safeCacheSegment(packageKey, 'runtime.pkg')
  );
}

function fetchBuffer(url, maxBytes = 20 * 1024 * 1024) {
  const client = url.startsWith('https:') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = client.get(url, { headers: { 'user-agent': 'u-claw-hard-update-mock/1' } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        fetchBuffer(new URL(response.headers.location, url).toString(), maxBytes).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new Error(`HTTP response too large: ${url}`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error(`HTTP timeout: ${url}`)));
  });
}

function postJson(url, payload, options = {}) {
  const maxBytes = options.maxBytes || 1024 * 1024;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const client = url.startsWith('https:') ? require('https') : require('http');
  const endpoint = new URL(url);
  const headers = {
    'content-type': 'application/json',
    'content-length': body.length,
    'user-agent': 'u-claw-hard-update-mock/1',
    ...(options.headers || {})
  };
  return new Promise((resolve, reject) => {
    const req = client.request({
      method: 'POST',
      hostname: endpoint.hostname,
      port: endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80),
      path: `${endpoint.pathname}${endpoint.search}`,
      headers
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        postJson(new URL(response.headers.location, url).toString(), payload, options).then(resolve, reject);
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new Error(`HTTP response too large: ${url}`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} for ${url}${text ? `: ${text.slice(0, 200)}` : ''}`));
          return;
        }
        resolve(JSON.parse(text));
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error(`HTTP timeout: ${url}`)));
    req.end(body);
  });
}

function requestBuffer(url, options = {}, maxBytes = 1024 * 1024) {
  const client = url.startsWith('https:') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = client.request(url, {
      method: options.method || 'GET',
      headers: {
        'user-agent': 'u-claw-hard-update-mock/1',
        ...(options.headers || {})
      }
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        requestBuffer(new URL(response.headers.location, url).toString(), options, maxBytes).then(resolve, reject);
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new Error(`HTTP response too large: ${url}`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error(`HTTP timeout: ${url}`)));
    if (options.body) req.end(options.body);
    else req.end();
  });
}

async function probeRangeSupport(url) {
  const result = await requestBuffer(url, { headers: { range: 'bytes=0-0' } }, 1024);
  const contentRange = String(result.headers['content-range'] || '');
  return result.statusCode === 206 && /^bytes 0-0\/\d+$/.test(contentRange);
}

function logDownloadProgress(downloaded, expectedSize, startedAt, lastLogRef) {
  const now = Date.now();
  if (now - lastLogRef.value < 5000 && downloaded < expectedSize) return;
  const copiedMb = (downloaded / 1024 / 1024).toFixed(1);
  const elapsed = Math.round((now - startedAt) / 1000);
  if (expectedSize) {
    const totalMb = (expectedSize / 1024 / 1024).toFixed(1);
    const pct = ((downloaded * 100) / expectedSize).toFixed(1);
    console.log(`[hard-update-client] Downloading runtime.pkg... ${copiedMb}/${totalMb} MB (${pct}%), ${elapsed}s elapsed.`);
  } else {
    console.log(`[hard-update-client] Downloading runtime.pkg... ${copiedMb} MB, ${elapsed}s elapsed.`);
  }
  lastLogRef.value = now;
}

function downloadRange(url, destination, start, end, state) {
  const client = url.startsWith('https:') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination, { flags: 'w' });
    const req = client.get(url, {
      headers: {
        'user-agent': 'u-claw-hard-update-mock/1',
        range: `bytes=${start}-${end}`
      }
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.destroy();
        response.resume();
        downloadRange(new URL(response.headers.location, url).toString(), destination, start, end, state).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 206) {
        file.destroy();
        response.resume();
        reject(new Error(`HTTP ${response.statusCode} for range ${start}-${end} from ${url}`));
        return;
      }
      response.on('data', chunk => {
        state.downloaded += chunk.length;
        logDownloadProgress(state.downloaded, state.expectedSize, state.startedAt, state.lastLogRef);
      });
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve(destination)));
    });
    file.on('error', error => {
      reject(error);
    });
    req.on('error', error => {
      file.destroy();
      reject(error);
    });
    req.setTimeout(120000, () => req.destroy(new Error(`HTTP timeout: ${url}`)));
  });
}

async function downloadFileMultipart(url, destination, expectedSize) {
  const clientPartsDir = `${destination}.parts`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.mkdirSync(clientPartsDir, { recursive: true });
  rmSyncBestEffort(destination, { force: true });
  const partCount = Math.min(8, Math.max(2, Math.ceil(expectedSize / (64 * 1024 * 1024))));
  const chunkSize = Math.ceil(expectedSize / partCount);
  const segments = [];
  for (let index = 0; index < partCount; index += 1) {
    const start = index * chunkSize;
    const end = Math.min(expectedSize - 1, ((index + 1) * chunkSize) - 1);
    if (start <= end) segments.push({ index, start, end, partPath: path.join(clientPartsDir, `${String(index).padStart(3, '0')}.part`) });
  }
  const state = {
    downloaded: 0,
    expectedSize,
    startedAt: Date.now(),
    lastLogRef: { value: Date.now() }
  };
  console.log(`[hard-update-client] Using multipart downloader: ${Math.min(4, segments.length)} connections, resume cache enabled.`);
  for (const segment of segments) {
    if (fs.existsSync(segment.partPath)) {
      const stat = fs.statSync(segment.partPath);
      const expectedLength = segment.end - segment.start + 1;
      if (stat.size === expectedLength) state.downloaded += stat.size;
      else rmSyncBestEffort(segment.partPath, { force: true });
    }
  }
  logDownloadProgress(state.downloaded, expectedSize, state.startedAt, state.lastLogRef);
  let cursor = 0;
  const concurrency = Math.min(4, segments.length);
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < segments.length) {
      const segment = segments[cursor];
      cursor += 1;
      const expectedLength = segment.end - segment.start + 1;
      if (fs.existsSync(segment.partPath) && fs.statSync(segment.partPath).size === expectedLength) continue;
      rmSyncBestEffort(segment.partPath, { force: true });
      await downloadRange(url, segment.partPath, segment.start, segment.end, state);
    }
  });
  await Promise.all(workers);
  const output = fs.createWriteStream(destination, { flags: 'wx' });
  try {
    for (const segment of segments) {
      await new Promise((resolve, reject) => {
        const input = fs.createReadStream(segment.partPath);
        input.on('error', reject);
        output.on('error', reject);
        input.on('end', resolve);
        input.pipe(output, { end: false });
      });
    }
    output.end();
    await new Promise((resolve, reject) => {
      output.on('finish', resolve);
      output.on('error', reject);
    });
  } catch (error) {
    output.destroy();
    throw error;
  }
  rmSyncBestEffort(clientPartsDir, { recursive: true, force: true });
  return destination;
}

async function downloadFileSequential(url, destination, expectedSize) {
  const client = url.startsWith('https:') ? require('https') : require('http');
  rmSyncBestEffort(destination, { force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination, { flags: 'wx' });
    const req = client.get(url, { headers: { 'user-agent': 'u-claw-hard-update-mock/1' } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.destroy();
        response.resume();
        rmSyncBestEffort(destination, { force: true });
        downloadFile(new URL(response.headers.location, url).toString(), destination, expectedSize).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        file.destroy();
        response.resume();
        rmSyncBestEffort(destination, { force: true });
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }
      let size = 0;
      let lastLog = Date.now();
      const startedAt = Date.now();
      response.on('data', chunk => {
        size += chunk.length;
        if (expectedSize && size > expectedSize) req.destroy(new Error(`runtime.pkg larger than manifest size: ${url}`));
        if (Date.now() - lastLog >= 5000) {
          logDownloadProgress(size, expectedSize, startedAt, { value: lastLog });
          lastLog = Date.now();
        }
      });
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve(destination)));
    });
    file.on('error', error => {
      rmSyncBestEffort(destination, { force: true });
      reject(error);
    });
    req.on('error', error => {
      file.destroy();
      rmSyncBestEffort(destination, { force: true });
      reject(error);
    });
    req.setTimeout(120000, () => req.destroy(new Error(`HTTP timeout: ${url}`)));
  });
}

async function downloadFile(url, destination, expectedSize) {
  if (expectedSize && expectedSize >= 64 * 1024 * 1024) {
    try {
      if (await probeRangeSupport(url)) {
        return downloadFileMultipart(url, destination, expectedSize);
      }
    } catch (_) {
      // fall back to sequential download below
    }
  }
  return downloadFileSequential(url, destination, expectedSize);
}

async function readHttpJson(url) {
  const bytes = await fetchBuffer(url);
  return {
    payload: JSON.parse(bytes.toString('utf8')),
    sha256: sha256Bytes(bytes)
  };
}

async function sourceFromOptions(options, localVersion = null) {
  if (options.release) {
    return { type: 'local', releaseRoot: path.resolve(options.release), productionUrl };
  }
  if (options.updateCheckUrl) {
    const updateCheckUrl = options.updateCheckUrl || defaultUpdateCheckUrl;
    if (!isHttpUrl(updateCheckUrl)) throw new Error(`Invalid update check URL: ${updateCheckUrl}`);
    const { platform, arch } = platformParts(options.platform);
    const headers = {};
    const deviceToken = options.deviceToken || process.env.UCLAW_DEVICE_TOKEN || process.env.UCLAW_UPDATE_DEVICE_TOKEN;
    if (deviceToken) headers.authorization = `Bearer ${deviceToken}`;
    const updateCheck = await postJson(updateCheckUrl, {
      ...(options.license ? { license: options.license } : {}),
      deviceId: options.device || process.env.UCLAW_UPDATE_DEVICE_ID || process.env.UCLAW_DEVICE_ID || '',
      platform,
      arch,
      platformKey: options.platform,
      installedVersion: options.installedVersion || localVersion?.version || '0.0.0'
    }, { headers });
    if (!updateCheck.allowed) throw new Error(`Update check denied: ${updateCheck.reason || 'not-allowed'}`);
    if (!updateCheck.productionUrl) throw new Error('Update check response missing productionUrl');
    return {
      type: 'update-check',
      updateCheckUrl,
      updateCheck,
      productionUrl: updateCheck.productionUrl,
      publicKeysUrl: options.publicKeysUrl || publicKeysUrlForProduction(updateCheck.productionUrl)
    };
  }
  const remoteProductionUrl = options.productionUrl || stagingProductionUrl;
  if (!isHttpUrl(remoteProductionUrl)) throw new Error(`Invalid production URL: ${remoteProductionUrl}`);
  return {
    type: 'http',
    productionUrl: remoteProductionUrl,
    publicKeysUrl: options.publicKeysUrl || publicKeysUrlForProduction(remoteProductionUrl)
  };
}

async function loadPublicKeysFromSource(source) {
  if (source.type === 'local') return loadPublicKeys(source.releaseRoot);
  if (source.type === 'update-check') {
    const keys = await readHttpJson(source.publicKeysUrl);
    return keys.payload.keys;
  }
  const keys = await readHttpJson(source.publicKeysUrl);
  return keys.payload.keys;
}

async function loadProductionFromSource(source, keys) {
  if (source.type === 'local') return loadProduction(source.releaseRoot, keys);
  if (source.type === 'update-check') {
    const production = await readHttpJson(source.productionUrl);
    verifyPayload(production.payload, keys);
    return production;
  }
  const production = await readHttpJson(source.productionUrl);
  verifyPayload(production.payload, keys);
  return production;
}

async function loadManifestFromSource(source, production, platformKey, keys) {
  const platformInfo = production.platforms?.[platformKey];
  if (!platformInfo) throw new Error(`Unsupported update platform: ${platformKey}`);
  if (source.type === 'local') return loadManifest(source.releaseRoot, production, platformKey, keys);
  const manifestUrl = source.updateCheck?.manifestUrl || platformInfo.manifestUrl;
  const manifestResult = await readHttpJson(resolveHttpUrl(manifestUrl, source.productionUrl));
  if (manifestResult.sha256 !== platformInfo.manifestSha256) throw new Error(`manifestSha256 mismatch: ${platformKey}`);
  const manifest = manifestResult.payload;
  verifyPayload(manifest, keys);
  const expected = platformParts(platformKey);
  if (manifest.version !== production.requiredVersion) throw new Error('Manifest version does not match production.requiredVersion');
  if (manifest.releaseId !== production.releaseId) throw new Error('Manifest releaseId does not match production.releaseId');
  if (manifest.platform !== expected.platform || manifest.arch !== expected.arch) throw new Error(`Manifest platform mismatch: ${platformKey}`);
  if (source.updateCheck?.packageUrl && resolveHttpUrl(source.updateCheck.packageUrl, source.productionUrl) !== resolveHttpUrl(manifest.package.url, source.productionUrl)) {
    throw new Error('Update check packageUrl does not match signed manifest package.url');
  }
  return manifestResult;
}

async function verifyRuntimePackageFromSource(source, production, platformKey, manifest, stagingDir) {
  if (source.type === 'local') return verifyRuntimePackage(source.releaseRoot, production, platformKey, manifest, stagingDir);
  const downloadDir = downloadDirForRuntimePackage(stagingDir, manifest, platformKey);
  const runtimePkg = path.join(downloadDir, 'runtime.pkg');
  console.log(`[hard-update-client] Download cache: ${downloadDir}`);
  await downloadFile(resolveHttpUrl(manifest.package.url, source.productionUrl), runtimePkg, manifest.package.size);
  try {
    if (sha256File(runtimePkg) !== manifest.package.sha256) throw new Error('runtime.pkg sha256 mismatch');
    if (fs.statSync(runtimePkg).size !== manifest.package.size) throw new Error('runtime.pkg size mismatch');
    runWithDirectoryProgress('Extracting update to USB staging', stagingDir, manifest.package.size, () => {
      unzipTo(runtimePkg, stagingDir);
    });
    console.log('[hard-update-client] Verifying extracted update tree...');
    const digest = treeDigest(stagingDir);
    if (digest !== manifest.package.treeDigest) throw new Error('runtime.pkg treeDigest mismatch');
  } catch (error) {
    rmSyncBestEffort(downloadDir, { recursive: true, force: true });
    throw error;
  }
  rmSyncBestEffort(downloadDir, { recursive: true, force: true });
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
    'Bavi-box.exe',
    'Bavi-box.app',
    'Bavi-box Win Update.exe',
    'Bavi-box Mac Update.command',
    'U-Claw Launcher.exe',
    'U-Claw Launcher.app',
    'UCLAW-PACKAGE-NOTES.txt'
  ]);
  runWithDirectoryProgress('Copying update to USB app', path.join(usbRoot, 'app'), dirSizeBytes(path.join(stagingDir, 'app')), () => {
    for (const entry of fs.readdirSync(stagingDir, { withFileTypes: true })) {
      if (!allowed.has(entry.name)) throw new Error(`Installer refused unexpected root: ${entry.name}`);
      const source = path.join(stagingDir, entry.name);
      const destination = path.join(usbRoot, entry.name);
      console.log(`[hard-update-client] Replacing ${entry.name}...`);
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
  });
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
  }
  invalidateElectronProfileCache(runState);
  return runState.stampFile || null;
}

function safeRemoveProfileChild(profileDir, childName) {
  if (!profileDir || !childName) return;
  const root = path.resolve(profileDir);
  const target = path.resolve(root, childName);
  if (!target.startsWith(`${root}${path.sep}`)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

function inferElectronProfileDir(runState) {
  if (typeof runState.electronProfileDir === 'string' && runState.electronProfileDir.trim()) {
    return runState.electronProfileDir.trim();
  }
  return '';
}

function invalidateElectronProfileCache(runState) {
  const profileDir = inferElectronProfileDir(runState);
  if (!profileDir || !fs.existsSync(profileDir)) return null;
  for (const child of [
    'Cache',
    'Code Cache',
    'GPUCache',
    'DawnCache',
    'DawnGraphiteCache',
    'DawnWebGPUCache',
    'Service Worker'
  ]) {
    safeRemoveProfileChild(profileDir, child);
  }
  return profileDir;
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

function writeVersionFromTransaction(usbRoot, tx) {
  const platformKey = `${tx.platform}-${tx.arch}`;
  writeJson(path.join(usbRoot, 'app', 'version.json'), {
    schemaVersion: 1,
    version: tx.targetVersion,
    releaseId: tx.releaseId,
    installedAt: new Date().toISOString(),
    platforms: {
      [platformKey]: {
        archiveSha256: tx.packageSha256,
        launcherSha256: null,
        treeDigest: tx.packageTreeDigest || null
      }
    }
  });
}

function waitForPidExit(pid, timeoutMs) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return Promise.resolve();
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        process.kill(numericPid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') {
          resolve();
          return;
        }
        if (error.code !== 'EPERM') {
          resolve();
          return;
        }
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(`Timed out waiting for launcher pid ${numericPid} to exit`));
        return;
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

function isPidRunning(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readRunState(usbRoot) {
  const filePath = path.join(runtimeDir(usbRoot), 'run-state.json');
  if (!fs.existsSync(filePath)) return null;
  try {
    return readJson(filePath);
  } catch (_) {
    return null;
  }
}

function hasRunningPortableApp(usbRoot) {
  const runState = readRunState(usbRoot);
  return isPidRunning(runState?.appPid);
}

function launchAfterUpdate(entrypoint) {
  if (!entrypoint) return;
  const resolved = path.resolve(entrypoint);
  if (!fs.existsSync(resolved)) return;
  if (process.platform === 'darwin' && resolved.endsWith('.app')) {
    const child = require('child_process').spawn('/usr/bin/open', ['-n', resolved], {
      detached: true,
      stdio: 'ignore',
      shell: false
    });
    child.unref();
    return;
  }
  const child = require('child_process').spawn(resolved, [], {
    cwd: path.dirname(resolved),
    detached: true,
    stdio: 'ignore',
    shell: false
  });
  child.unref();
}

function failTransaction(usbRoot, baseTx, error) {
  if (!baseTx) return;
  writeTransaction(usbRoot, {
    ...baseTx,
    state: 'failed',
    error: error instanceof Error ? error.message : String(error)
  });
}

function readPendingStagedTransaction(usbRoot, production, platformKey) {
  const txPath = transactionPath(usbRoot);
  if (!fs.existsSync(txPath)) return null;
  let tx;
  try {
    tx = readJson(txPath);
  } catch (_) {
    return null;
  }
  if (tx.schemaVersion !== 1) return null;
  if (tx.state !== 'staged' && tx.state !== 'waiting-for-app-exit') return null;
  if (tx.targetVersion !== production.requiredVersion) return null;
  if (tx.releaseId !== production.releaseId) return null;
  const expected = platformParts(platformKey);
  if (tx.platform !== expected.platform || tx.arch !== expected.arch) return null;
  const stagingDir = safeJoin(usbRoot, tx.stagingDir || '');
  if (!fs.existsSync(stagingDir)) return null;
  assertInstallTreeSafe(stagingDir);
  return tx;
}

async function check(options) {
  if (!options.usb) throw new Error('--usb is required');
  const usbRoot = path.resolve(options.usb);
  const local = readLocalVersion(usbRoot);
  const source = await sourceFromOptions(options, local);
  const keys = await loadPublicKeysFromSource(source);
  const productionResult = await loadProductionFromSource(source, keys);
  const production = productionResult.payload;
  if (local?.version === production.requiredVersion) {
    return { updateRequired: false, productionUrl: source.productionUrl, requiredVersion: production.requiredVersion };
  }
  const manifestResult = await loadManifestFromSource(source, production, options.platform, keys);
  return {
    updateRequired: true,
    productionUrl: source.productionUrl,
    requiredVersion: production.requiredVersion,
    updateCheck: source.updateCheck || null,
    manifest: manifestResult.payload
  };
}

async function mockUpdate(options) {
  if (!options.usb) throw new Error('--usb is required');
  const usbRoot = path.resolve(options.usb);
  const local = readLocalVersion(usbRoot);
  const source = await sourceFromOptions(options, local);
  const keys = await loadPublicKeysFromSource(source);
  const productionResult = await loadProductionFromSource(source, keys);
  const production = productionResult.payload;
  if (local?.version === production.requiredVersion) {
    const result = { updateRequired: false, productionUrl: source.productionUrl, requiredVersion: production.requiredVersion };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const manifestResult = await loadManifestFromSource(source, production, options.platform, keys);
  const manifest = manifestResult.payload;
  const transactionId = `update-${Date.now()}-${production.releaseId}`;
  const stagingDir = path.join(usbRoot, 'app', '.update-staging', transactionId);
  const baseTx = {
    id: transactionId,
    targetVersion: production.requiredVersion,
    releaseId: production.releaseId,
    platform: manifest.platform,
    arch: manifest.arch,
    updateCheckUrl: source.updateCheckUrl || null,
    productionUrl: source.productionUrl,
    productionSha256: productionResult.sha256,
    manifestSha256: manifestResult.sha256,
    packageSha256: manifest.package.sha256,
    packageSize: manifest.package.size,
    packageTreeDigest: manifest.package.treeDigest,
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
    await verifyRuntimePackageFromSource(source, production, options.platform, manifest, stagingDir);
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

async function startupUpdate(options) {
  if (!options.usb) throw new Error('--usb is required');
  const usbRoot = path.resolve(options.usb);
  options = {
    ...options,
    productionUrl: resolveStartupProductionUrl(options)
  };
  const local = readLocalVersion(usbRoot);
  const source = await sourceFromOptions(options, local);
  const keys = await loadPublicKeysFromSource(source);
  const productionResult = await loadProductionFromSource(source, keys);
  const production = productionResult.payload;
  if (local?.version === production.requiredVersion) {
    console.log(JSON.stringify({ updateRequired: false, requiredVersion: production.requiredVersion }, null, 2));
    return { updateRequired: false, requiredVersion: production.requiredVersion };
  }
  const pendingTx = readPendingStagedTransaction(usbRoot, production, options.platform);
  if (pendingTx) {
    const result = {
      updateRequired: true,
      staged: true,
      transaction: transactionPath(usbRoot),
      version: production.requiredVersion,
      reusedStaging: true
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const manifestResult = await loadManifestFromSource(source, production, options.platform, keys);
  const manifest = manifestResult.payload;
  const transactionId = `update-${Date.now()}-${production.releaseId}`;
  const stagingDir = path.join(usbRoot, 'app', '.update-staging', transactionId);
  const baseTx = {
    id: transactionId,
    targetVersion: production.requiredVersion,
    releaseId: production.releaseId,
    platform: manifest.platform,
    arch: manifest.arch,
    updateCheckUrl: source.updateCheckUrl || null,
    productionUrl: source.productionUrl,
    productionSha256: productionResult.sha256,
    manifestSha256: manifestResult.sha256,
    packageSha256: manifest.package.sha256,
    packageSize: manifest.package.size,
    packageTreeDigest: manifest.package.treeDigest,
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
    await verifyRuntimePackageFromSource(source, production, options.platform, manifest, stagingDir);
    assertInstallTreeSafe(stagingDir);
    writeTransaction(usbRoot, { ...baseTx, state: 'staged' });
  } catch (error) {
    failTransaction(usbRoot, baseTx, error);
    throw error;
  }

  const result = {
    updateRequired: true,
    staged: true,
    transaction: transactionPath(usbRoot),
    version: production.requiredVersion
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function applyStartupUpdate(options) {
  if (!options.usb) throw new Error('--usb is required');
  if (!options.transaction) throw new Error('--transaction is required');
  const usbRoot = path.resolve(options.usb);
  const txPath = validateTransactionPath(usbRoot, options.transaction);
  const tx = readJson(txPath);
  if (tx.schemaVersion !== 1) throw new Error(`Unsupported transaction schemaVersion: ${tx.schemaVersion}`);
  if (tx.state !== 'staged' && tx.state !== 'waiting-for-app-exit') {
    throw new Error(`Cannot apply transaction in state: ${tx.state}`);
  }
  const stagingDir = safeJoin(usbRoot, tx.stagingDir);
  assertInstallTreeSafe(stagingDir);
  writeTransaction(usbRoot, { ...tx, state: 'waiting-for-app-exit' });
  console.log('[hard-update-client] Waiting for Bavi-box to exit before switching files...');
  await waitForPidExit(options.waitPid, 60000);
  writeTransaction(usbRoot, { ...tx, state: 'switching' });
  console.log('[hard-update-client] Switching USB files to new version...');
  installFromStaging(usbRoot, stagingDir);
  writeTransaction(usbRoot, { ...tx, state: 'switched' });
  invalidateCacheStamp(usbRoot);
  if (options.stampFile) fs.rmSync(path.resolve(options.stampFile), { force: true });
  writeTransaction(usbRoot, { ...tx, state: 'cache-invalidated' });
  writeVersionFromTransaction(usbRoot, tx);
  writeTransaction(usbRoot, { ...tx, state: 'complete' });
  fs.rmSync(stagingDir, { recursive: true, force: true });
  launchAfterUpdate(options.launchAfter);
  console.log(JSON.stringify({ applied: true, version: tx.targetVersion }, null, 2));
}

async function independentUpdate(options) {
  if (!options.usb) throw new Error('--usb is required');
  const usbRoot = path.resolve(options.usb);
  const stageResult = await startupUpdate({
    ...options,
    productionUrl: options.productionUrl || process.env.UCLAW_UPDATE_PRODUCTION_URL || productionUrl
  });
  if (!stageResult.updateRequired) {
    if (options.launchAfter) launchAfterUpdate(options.launchAfter);
    return stageResult;
  }
  if (!stageResult.staged) throw new Error('Independent update did not stage a transaction');
  const txPath = transactionPath(usbRoot);
  const tx = readJson(txPath);
  if (hasRunningPortableApp(usbRoot)) {
    removeShutdownComplete(usbRoot);
    requestUpdateShutdown(usbRoot, tx.id);
    const timeoutMs = Number(options.waitShutdownMs || 120000);
    await waitForShutdownComplete(usbRoot, tx.id, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000);
  }
  await applyStartupUpdate({
    ...options,
    usb: usbRoot,
    transaction: txPath
  });
  return { updateRequired: true, updated: true, version: tx.targetVersion };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.command) {
    usage();
    return;
  }
  if (options.command === 'check') console.log(JSON.stringify(await check(options), null, 2));
  else if (options.command === 'mock-update') await mockUpdate(options);
  else if (options.command === 'independent-update') await independentUpdate(options);
  else if (options.command === 'startup-update') {
    const result = await startupUpdate(options);
    if (result.updateRequired && result.staged) process.exitCode = 20;
  }
  else if (options.command === 'apply-startup-update') await applyStartupUpdate(options);
  else throw new Error(`Unknown command: ${options.command}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[hard-update-client] ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  check,
  invalidateCacheStamp,
  mockUpdate,
  independentUpdate,
  startupUpdate,
  applyStartupUpdate,
  requestUpdateShutdown,
  writeRunStateMock,
  writeShutdownCompleteMock,
  writeTransaction,
  failTransaction,
  writeVersion
};
