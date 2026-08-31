#!/usr/bin/env node
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');
const { readJson, sha256File } = require('./lib/hard-update-utils');
const { firstEnv, parseEnvFile } = require('./lib/local-env');

const appDir = path.resolve(__dirname, '..');
const defaultReleaseRoot = path.join(appDir, 'release', 'mock-hard-update');
const defaultEnvPath = path.join(appDir, '.env');
const defaultBucket = 'uclaw-updates-prod';
const defaultEndpoint = 'oss-cn-shanghai.aliyuncs.com';
const defaultPrefix = 'bavi-box/releases';
const defaultBaseUrl = 'https://oss-download.yiyong.me/bavi-box/releases';
const requiredPlatforms = ['darwin-arm64', 'darwin-x64', 'win32-x64'];

function usage() {
  console.log(`Usage:
  node scripts/hard-update-upload-oss.js --release release/mock-hard-update --env .env
  node scripts/hard-update-upload-oss.js --release release/bavi-box-v1.0.1 --dry-run

Options:
  --release <dir>     Release root from hard-update-package.js. Defaults to release/mock-hard-update.
  --env <file>        Local env file. Defaults to .env.
  --bucket <name>     OSS bucket. Defaults to UCLAW_OSS_BUCKET, then ${defaultBucket}.
  --endpoint <host>   OSS endpoint. Defaults to UCLAW_OSS_ENDPOINT, then ${defaultEndpoint}.
  --prefix <prefix>   OSS release prefix. Defaults to UCLAW_OSS_RELEASE_PREFIX, then ${defaultPrefix}.
  --base-url <url>    Public releases base URL. Defaults to ${defaultBaseUrl}.
  --keep <count>      Keep newest N package versions under packages/. Defaults to 3.
  --dry-run           Print plan only; no upload/delete.

Auth:
  Set ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET locally.
  STS token is supported with ALIBABA_CLOUD_SECURITY_TOKEN.
  If no key is provided, an already configured ossutil / ossutil64 is used as fallback.
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
    else if (arg === '--bucket') options.bucket = readValue();
    else if (arg === '--endpoint') options.endpoint = readValue();
    else if (arg === '--prefix') options.prefix = readValue();
    else if (arg === '--base-url') options.baseUrl = readValue();
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

function loadConfig(options) {
  const env = parseEnvFile(path.resolve(options.env));
  return {
    bucket: options.bucket || firstEnv(env, ['UCLAW_OSS_BUCKET']) || defaultBucket,
    endpoint: options.endpoint || firstEnv(env, ['UCLAW_OSS_ENDPOINT']) || defaultEndpoint,
    prefix: (options.prefix || firstEnv(env, ['UCLAW_OSS_RELEASE_PREFIX']) || defaultPrefix).replace(/^\/+|\/+$/g, ''),
    baseUrl: (options.baseUrl || firstEnv(env, ['UCLAW_OSS_RELEASES_BASE_URL', 'UCLAW_RELEASES_BASE_URL']) || defaultBaseUrl).replace(/\/+$/, ''),
    keep: positiveInteger(options.keep || firstEnv(env, ['UCLAW_OSS_KEEP_RELEASES', 'UCLAW_KEEP_RELEASES']), 3),
    accessKeyId: firstEnv(env, [
      'ALIBABA_CLOUD_ACCESS_KEY_ID',
      'ALIYUN_ACCESS_KEY_ID',
      'OSS_ACCESS_KEY_ID',
      'UCLAW_OSS_ACCESS_KEY_ID'
    ]),
    accessKeySecret: firstEnv(env, [
      'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
      'ALIYUN_ACCESS_KEY_SECRET',
      'OSS_ACCESS_KEY_SECRET',
      'UCLAW_OSS_ACCESS_KEY_SECRET'
    ]),
    securityToken: firstEnv(env, [
      'ALIBABA_CLOUD_SECURITY_TOKEN',
      'ALIYUN_SECURITY_TOKEN',
      'OSS_SECURITY_TOKEN',
      'UCLAW_OSS_SECURITY_TOKEN'
    ])
  };
}

function assertSafeReleaseId(releaseId) {
  if (!/^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(releaseId)) {
    throw new Error(`Refusing unsafe releaseId: ${releaseId}`);
  }
}

function assertSafePrefix(prefix) {
  if (!prefix || prefix === '.' || prefix === '/') throw new Error(`Refusing unsafe OSS prefix: ${prefix}`);
  if (prefix.includes('..')) throw new Error(`Refusing unsafe OSS prefix: ${prefix}`);
}

function findOssutil() {
  for (const command of ['ossutil', 'ossutil64']) {
    const result = spawnSync('/bin/sh', ['-lc', `command -v ${command}`], {
      cwd: appDir,
      encoding: 'utf8'
    });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  throw new Error('ossutil not found. Install/configure Alibaba Cloud ossutil first.');
}

function hasDirectOssAuth(config) {
  return Boolean(config.accessKeyId && config.accessKeySecret);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: appDir,
    env: process.env,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: options.capture ? 'utf8' : undefined
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = options.capture ? `${result.stderr || result.stdout || ''}`.trim() : '';
    throw new Error(`${path.basename(command)} ${args.join(' ')} failed${details ? `: ${details}` : ''}`);
  }
  return result;
}

function ossArgs(config, args) {
  return ['--endpoint', config.endpoint, ...args];
}

function ossUri(config, relativePath = '') {
  const key = [config.prefix, relativePath].filter(Boolean).join('/').replace(/\/+/g, '/');
  return `oss://${config.bucket}/${key}`;
}

function objectKey(config, remotePath = '') {
  return [config.prefix, remotePath].filter(Boolean).join('/').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

function releaseObjects(releaseRoot) {
  const production = readJson(path.join(releaseRoot, 'production.json'));
  const releaseId = production.releaseId;
  if (!releaseId) throw new Error('production.json missing releaseId');
  assertSafeReleaseId(releaseId);
  const platformKeys = Object.keys(production.platforms || {}).sort();
  for (const platformKey of requiredPlatforms) {
    if (!platformKeys.includes(platformKey)) {
      throw new Error(`OSS publish requires full platform release; missing ${platformKey}`);
    }
  }
  for (const platformKey of platformKeys) {
    if (!requiredPlatforms.includes(platformKey)) {
      throw new Error(`OSS publish refuses unknown platform: ${platformKey}`);
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

function assertPackageUrls(config, releaseRoot, release) {
  for (const [platformKey, platform] of Object.entries(release.production.platforms || {})) {
    const expectedManifestUrl = `${config.baseUrl}/packages/${release.production.releaseId}/${platformKey}/manifest.json`;
    if (platform.manifestUrl !== expectedManifestUrl) {
      throw new Error(`manifestUrl mismatch for ${platformKey}: expected ${expectedManifestUrl}, got ${platform.manifestUrl}`);
    }
    const manifestPath = path.join(releaseRoot, 'packages', release.production.releaseId, platformKey, 'manifest.json');
    const manifest = readJson(manifestPath);
    const expectedPackageUrl = `${config.baseUrl}/packages/${release.production.releaseId}/${platformKey}/runtime.pkg`;
    if (manifest.package.url !== expectedPackageUrl) {
      throw new Error(`runtime.pkg URL mismatch for ${platformKey}: expected ${expectedPackageUrl}, got ${manifest.package.url}`);
    }
  }
}

function printPlan(config, release) {
  console.log(JSON.stringify({
    bucket: config.bucket,
    endpoint: config.endpoint,
    prefix: config.prefix,
    baseUrl: config.baseUrl,
    keep: config.keep,
    releaseId: release.production.releaseId,
    requiredVersion: release.production.requiredVersion,
    immutableObjects: release.immutable.map(object => object.remotePath),
    productionObject: release.productionObject.remotePath,
    productionUrl: `${config.baseUrl}/production.json`
  }, null, 2));
}

function uploadObject(ossutil, config, object, remotePath) {
  console.log(`[hard-update-upload-oss] upload ${remotePath} (${object.size} bytes)`);
  run(ossutil, ossArgs(config, [
    'cp',
    '-f',
    object.filePath,
    ossUri(config, remotePath)
  ]));
}

function signOssV1(config, method, key, headers = {}, subresources = '') {
  const ossHeaders = Object.entries(headers)
    .filter(([name]) => name.toLowerCase().startsWith('x-oss-'))
    .map(([name, value]) => [name.toLowerCase(), String(value).trim()])
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value}`)
    .join('\n');
  const canonicalizedOssHeaders = ossHeaders ? `${ossHeaders}\n` : '';
  const contentMd5 = headers['Content-MD5'] || '';
  const contentType = headers['Content-Type'] || '';
  const date = headers.Date || '';
  const canonicalizedResource = `/${config.bucket}/${key}${subresources}`;
  const stringToSign = [
    method,
    contentMd5,
    contentType,
    date,
    `${canonicalizedOssHeaders}${canonicalizedResource}`
  ].join('\n');
  const signature = crypto
    .createHmac('sha1', config.accessKeySecret)
    .update(stringToSign)
    .digest('base64');
  return `OSS ${config.accessKeyId}:${signature}`;
}

function contentTypeFor(remotePath) {
  if (remotePath.endsWith('.json')) return 'application/json';
  if (remotePath.endsWith('.sha256')) return 'text/plain';
  if (remotePath.endsWith('.pkg')) return 'application/zip';
  return 'application/octet-stream';
}

function requestOssDirect(config, method, key, headers, subresources, responseHandler) {
  return new Promise((resolve, reject) => {
    const host = `${config.bucket}.${config.endpoint}`;
    if (config.securityToken) headers['x-oss-security-token'] = config.securityToken;
    headers.Authorization = signOssV1(config, method, key, headers, subresources);
    const requestPath = `/${key.split('/').map(encodeURIComponent).join('/')}${subresources}`;
    const request = https.request({
      method,
      host,
      path: requestPath,
      headers
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve(responseHandler(response, Buffer.concat(chunks)));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(30 * 60 * 1000, () => request.destroy(new Error(`OSS ${method} timeout: ${key}`)));
    request.on('error', reject);
    request.end();
  });
}

function putObjectDirect(config, object, remotePath) {
  const key = objectKey(config, remotePath);
  const date = new Date().toUTCString();
  const contentType = contentTypeFor(remotePath);
  const headers = {
    Date: date,
    'Content-Type': contentType,
    'Content-Length': object.size
  };
  console.log(`[hard-update-upload-oss] upload ${remotePath} (${object.size} bytes)`);
  return new Promise((resolve, reject) => {
    const host = `${config.bucket}.${config.endpoint}`;
    if (config.securityToken) headers['x-oss-security-token'] = config.securityToken;
    headers.Authorization = signOssV1(config, 'PUT', key, headers);
    const request = https.request({
      method: 'PUT',
      host,
      path: `/${key.split('/').map(encodeURIComponent).join('/')}`,
      headers
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        if ((response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300) {
          resolve();
          return;
        }
        reject(new Error(`OSS PUT failed ${response.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 500)}`));
      });
    });
    request.setTimeout(30 * 60 * 1000, () => request.destroy(new Error(`OSS PUT timeout: ${remotePath}`)));
    request.on('error', reject);
    fs.createReadStream(object.filePath).on('error', reject).pipe(request);
  });
}

function deleteObjectDirect(config, remotePath) {
  const key = objectKey(config, remotePath);
  const date = new Date().toUTCString();
  const headers = { Date: date };
  return requestOssDirect(config, 'DELETE', key, headers, '', (response, body) => {
    if ([200, 202, 204, 404].includes(response.statusCode || 0)) return;
    throw new Error(`OSS DELETE failed ${response.statusCode}: ${body.toString('utf8').slice(0, 500)}`);
  }).then(result => result);
}

function publicUrl(config, remotePath) {
  return `${config.baseUrl}/${remotePath.replace(/^\/+/, '')}`;
}

function head(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error(`Too many redirects: ${url}`));
      return;
    }
    const client = url.startsWith('https:') ? https : http;
    const request = client.request(url, { method: 'HEAD' }, response => {
      const statusCode = response.statusCode || 0;
      const location = response.headers.location;
      response.resume();
      if (statusCode >= 300 && statusCode < 400 && location) {
        resolve(head(new URL(location, url).toString(), redirectCount + 1));
        return;
      }
      resolve({
        statusCode,
        contentLength: Number(response.headers['content-length'] || 0)
      });
    });
    request.setTimeout(30000, () => request.destroy(new Error(`HEAD timeout: ${url}`)));
    request.on('error', reject);
    request.end();
  });
}

async function verifyPublicObject(config, object, remotePath) {
  const url = publicUrl(config, remotePath);
  const result = await head(url);
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(`Public URL not readable (${result.statusCode}): ${url}`);
  }
  if (result.contentLength && result.contentLength !== object.size) {
    throw new Error(`Public URL size mismatch: ${url}`);
  }
}

function listPackageReleasesWithOssutil(ossutil, config) {
  const result = spawnSync(ossutil, ossArgs(config, [
    'ls',
    ossUri(config, 'packages/')
  ]), {
    cwd: appDir,
    env: process.env,
    stdio: 'pipe',
    encoding: 'utf8'
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !/NoSuchKey|Not Found|not exist/i.test(`${result.stderr}\n${result.stdout}`)) {
    throw new Error(`ossutil ls packages failed: ${`${result.stderr || result.stdout || ''}`.trim()}`);
  }
  const releases = new Set();
  for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) {
    const match = line.match(/packages\/(v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\//);
    if (match) releases.add(match[1]);
  }
  return [...releases].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function decodeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function listPackageReleasesDirect(config) {
  const releases = new Set();
  let continuationToken = '';
  for (;;) {
    const prefix = `${config.prefix}/packages/`;
    const params = [
      ['list-type', '2'],
      ['prefix', prefix],
      ['delimiter', '/']
    ];
    if (continuationToken) params.push(['continuation-token', continuationToken]);
    params.sort(([left], [right]) => left.localeCompare(right));
    const query = `?${params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')}`;
    const date = new Date().toUTCString();
    const headers = { Date: date };
    if (config.securityToken) headers['x-oss-security-token'] = config.securityToken;
    headers.Authorization = signOssV1(config, 'GET', '', headers);
    const body = await new Promise((resolve, reject) => {
      const request = https.request({
        method: 'GET',
        host: `${config.bucket}.${config.endpoint}`,
        path: `/${query}`,
        headers
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          if ((response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300) {
            resolve(rawBody);
            return;
          }
          reject(new Error(`OSS LIST failed ${response.statusCode}: ${rawBody.slice(0, 500)}`));
        });
      });
      request.setTimeout(60000, () => request.destroy(new Error('OSS LIST timeout')));
      request.on('error', reject);
      request.end();
    });
    for (const match of body.matchAll(/<Prefix>([^<]+)<\/Prefix>/g)) {
      const releaseMatch = decodeXml(match[1]).match(/\/packages\/(v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\/$/);
      if (releaseMatch) releases.add(releaseMatch[1]);
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/i.test(body);
    const tokenMatch = body.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    if (!truncated || !tokenMatch) break;
    continuationToken = decodeXml(tokenMatch[1]);
  }
  return [...releases].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

async function retention(config, currentReleaseId, releases, ossutil) {
  releases = releases.filter(releaseId => releaseId !== currentReleaseId);
  const deleteCount = Math.max(0, releases.length + 1 - config.keep);
  for (const releaseId of releases.slice(0, deleteCount)) {
    assertSafeReleaseId(releaseId);
    console.log(`[hard-update-upload-oss] remove old release ${releaseId}`);
    if (ossutil) {
      run(ossutil, ossArgs(config, [
        'rm',
        '-r',
        '-f',
        ossUri(config, `packages/${releaseId}/`)
      ]));
      continue;
    }
    for (const platformKey of requiredPlatforms) {
      await deleteObjectDirect(config, `packages/${releaseId}/${platformKey}/runtime.pkg`);
      await deleteObjectDirect(config, `packages/${releaseId}/${platformKey}/runtime.pkg.sha256`);
      await deleteObjectDirect(config, `packages/${releaseId}/${platformKey}/sbom.json`);
      await deleteObjectDirect(config, `packages/${releaseId}/${platformKey}/manifest.json`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const releaseRoot = path.resolve(options.release);
  const config = loadConfig(options);
  assertSafePrefix(config.prefix);
  const release = releaseObjects(releaseRoot);
  assertPackageUrls(config, releaseRoot, release);
  if (options.dryRun) {
    printPlan(config, release);
    return;
  }
  const directAuth = hasDirectOssAuth(config);
  const ossutil = directAuth ? '' : findOssutil();
  console.log(`[hard-update-upload-oss] release ${release.production.releaseId}`);
  console.log(`[hard-update-upload-oss] target oss://${config.bucket}/${config.prefix}`);
  for (const object of release.immutable) {
    if (directAuth) await putObjectDirect(config, object, object.remotePath);
    else uploadObject(ossutil, config, object, object.remotePath);
  }
  for (const object of release.immutable) await verifyPublicObject(config, object, object.remotePath);
  if (directAuth) {
    await putObjectDirect(config, release.productionObject, '.production.json.tmp');
    await putObjectDirect(config, release.productionObject, release.productionObject.remotePath);
    await deleteObjectDirect(config, '.production.json.tmp');
  } else {
    uploadObject(ossutil, config, release.productionObject, '.production.json.tmp');
    uploadObject(ossutil, config, release.productionObject, release.productionObject.remotePath);
    run(ossutil, ossArgs(config, ['rm', '-f', ossUri(config, '.production.json.tmp')]));
  }
  await verifyPublicObject(config, release.productionObject, release.productionObject.remotePath);
  const releases = ossutil ? listPackageReleasesWithOssutil(ossutil, config) : await listPackageReleasesDirect(config);
  await retention(config, release.production.releaseId, releases, ossutil);
  console.log(`[hard-update-upload-oss] production ${config.baseUrl}/production.json`);
  console.log(`[hard-update-upload-oss] kept newest ${config.keep} package versions`);
}

try {
  main();
} catch (error) {
  console.error(`[hard-update-upload-oss] ${error.message}`);
  process.exit(1);
}
