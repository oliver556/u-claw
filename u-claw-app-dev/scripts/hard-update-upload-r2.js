#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { readJson, sha256File } = require('./lib/hard-update-utils');
const { firstEnv, parseEnvFile } = require('./lib/local-env');
const { signPayload, verifyPayload } = require('./lib/release-signing');

const appDir = path.resolve(__dirname, '..');
const defaultReleaseRoot = path.join(appDir, 'release', 'mock-hard-update');
const defaultEnvPath = path.join(appDir, '.env');

function usage() {
  console.log(`Usage:
  node scripts/hard-update-upload-r2.js --release release/mock-hard-update --env .env --channel staging

Options:
  --release <dir>   Release root from hard-update-package.js. Defaults to release/mock-hard-update.
  --env <file>      Local env file. Defaults to .env.
  --channel <name>  staging or prod. Defaults to staging.
  --platform <key>  Upload one platform only, preserving other production.json platform entries.
  --dry-run         Print planned object keys only.
  --skip-production Upload immutable release objects only; do not replace releases/production.json.
  --only-production Upload releases/production.json only. Use after control plane is on the same release.

Required env, preferred:
  R2_ENDPOINT
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY
  R2_STAGING_BUCKET
  R2_STAGING_PUBLIC_URL

Legacy env also accepted:
  UCLAW_R2_ENDPOINT
  UCLAW_R2_ACCESS_KEY_ID
  UCLAW_R2_SECRET_ACCESS_KEY
  UCLAW_R2_BUCKET
`);
}

function parseArgs(argv) {
  const options = {
    release: defaultReleaseRoot,
    env: defaultEnvPath,
    channel: 'staging',
    dryRun: false,
    skipProduction: false,
    onlyProduction: false
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
    else if (arg === '--channel') options.channel = readValue();
    else if (arg === '--platform') options.platform = readValue();
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--skip-production') options.skipProduction = true;
    else if (arg === '--only-production') options.onlyProduction = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.skipProduction && options.onlyProduction) {
    throw new Error('--skip-production and --only-production cannot be used together');
  }
  return options;
}

function loadR2Config(options) {
  const env = parseEnvFile(path.resolve(options.env));
  const channel = options.channel.toLowerCase();
  if (channel !== 'staging' && channel !== 'prod') throw new Error('--channel must be staging or prod');
  const channelPrefix = channel === 'staging' ? 'STAGING' : 'PROD';
  const config = {
    endpoint: firstEnv(env, ['R2_ENDPOINT', 'UCLAW_R2_ENDPOINT']),
    accessKeyId: firstEnv(env, ['R2_ACCESS_KEY_ID', 'UCLAW_R2_ACCESS_KEY_ID']),
    secretAccessKey: firstEnv(env, ['R2_SECRET_ACCESS_KEY', 'UCLAW_R2_SECRET_ACCESS_KEY']),
    bucket: firstEnv(env, [`R2_${channelPrefix}_BUCKET`, 'R2_BUCKET', 'UCLAW_R2_BUCKET']),
    publicUrl: firstEnv(env, [`R2_${channelPrefix}_PUBLIC_URL`, 'R2_PUBLIC_URL', 'UCLAW_R2_PUBLIC_URL'])
  };
  for (const [key, value] of Object.entries(config)) {
    if (!value && key !== 'publicUrl') throw new Error(`Missing R2 config: ${key}`);
  }
  return config;
}

function loadSigningKey(envPath) {
  const env = parseEnvFile(path.resolve(envPath));
  const keyFile = firstEnv(env, ['UCLAW_RELEASE_PRIVATE_KEY_PATH']);
  if (!keyFile) return null;
  return readJson(path.resolve(keyFile));
}

function contentTypeFor(filePath) {
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.sha256')) return 'text/plain; charset=utf-8';
  if (filePath.endsWith('.pkg')) return 'application/zip';
  return 'application/octet-stream';
}

function cacheControlFor(objectKey) {
  if (objectKey.endsWith('/production.json')) return 'no-cache, max-age=60';
  if (objectKey.endsWith('/manifest.json')) return 'public, max-age=300';
  return 'public, max-age=31536000, immutable';
}

function filterPlatformEntries(production, platformKey) {
  if (!platformKey) return Object.keys(production.platforms || {}).sort();
  if (!production.platforms?.[platformKey]) throw new Error(`Release missing platform: ${platformKey}`);
  return [platformKey];
}

function releaseObjects(releaseRoot, options = {}) {
  const production = readJson(path.join(releaseRoot, 'production.json'));
  if (options.onlyProduction) {
    return [{
      filePath: path.join(releaseRoot, 'production.json'),
      objectKey: 'releases/production.json'
    }];
  }
  const objects = [{
    filePath: path.join(releaseRoot, 'bootstrap', 'release-public-keys.json'),
    objectKey: 'releases/bootstrap/release-public-keys.json'
  }];
  for (const platformKey of filterPlatformEntries(production, options.platform)) {
    const dir = path.join(releaseRoot, 'packages', production.releaseId, platformKey);
    objects.push(
      { filePath: path.join(dir, 'runtime.pkg'), objectKey: `releases/packages/${production.releaseId}/${platformKey}/runtime.pkg` },
      { filePath: path.join(dir, 'runtime.pkg.sha256'), objectKey: `releases/packages/${production.releaseId}/${platformKey}/runtime.pkg.sha256` },
      { filePath: path.join(dir, 'sbom.json'), objectKey: `releases/packages/${production.releaseId}/${platformKey}/sbom.json` },
      { filePath: path.join(dir, 'manifest.json'), objectKey: `releases/packages/${production.releaseId}/${platformKey}/manifest.json` }
    );
  }
  if (!options.skipProduction) {
    objects.push({ filePath: path.join(releaseRoot, 'production.json'), objectKey: 'releases/production.json' });
  }
  for (const object of objects) {
    if (!fs.existsSync(object.filePath)) throw new Error(`Missing release file: ${object.filePath}`);
  }
  return objects;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'u-claw-hard-update-upload-r2/1' } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        fetchJson(new URL(response.headers.location, url).toString()).then(resolve, reject);
        return;
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} for ${url}`));
          return;
        }
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      });
    }).on('error', reject);
  });
}

async function prepareSinglePlatformProduction(releaseRoot, config, options) {
  if (!options.platform || options.skipProduction || options.onlyProduction) return null;
  if (!config.publicUrl) throw new Error('--platform requires R2 publicUrl for production.json merge');
  const releaseProductionPath = path.join(releaseRoot, 'production.json');
  const nextProduction = readJson(releaseProductionPath);
  const signingKey = loadSigningKey(options.env);
  if (!signingKey) throw new Error('--platform requires UCLAW_RELEASE_PRIVATE_KEY_PATH for merged production signing');
  const keys = readJson(path.join(releaseRoot, 'bootstrap', 'release-public-keys.json')).keys;
  const currentProductionUrl = `${config.publicUrl.replace(/\/+$/, '')}/releases/production.json`;
  const currentProduction = await fetchJson(currentProductionUrl);
  verifyPayload(currentProduction, keys);
  verifyPayload(nextProduction, keys);
  const merged = {
    ...nextProduction,
    platforms: {
      ...(currentProduction.platforms || {}),
      [options.platform]: nextProduction.platforms[options.platform]
    }
  };
  const original = fs.readFileSync(releaseProductionPath);
  fs.writeFileSync(releaseProductionPath, JSON.stringify(signPayload(merged, signingKey), null, 2) + '\n');
  return () => fs.writeFileSync(releaseProductionPath, original);
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function signingKey(secret, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function encodePathPart(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalPath(bucket, objectKey) {
  return `/${[bucket, ...objectKey.split('/')].map(encodePathPart).join('/')}`;
}

function amzDates(now = new Date()) {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function authorizationHeader(config, request) {
  const region = 'auto';
  const service = 's3';
  const { amzDate, dateStamp } = amzDates();
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders = [
    `host:${request.host}`,
    `x-amz-content-sha256:${request.payloadHash}`,
    `x-amz-date:${amzDate}`
  ].join('\n') + '\n';
  const canonicalRequest = [
    'PUT',
    request.path,
    '',
    canonicalHeaders,
    signedHeaders,
    request.payloadHash
  ].join('\n');
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join('\n');
  const signature = hmac(signingKey(config.secretAccessKey, dateStamp, region, service), stringToSign, 'hex');
  return {
    amzDate,
    value: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
}

function putObject(config, object) {
  const endpoint = new URL(config.endpoint.replace(/\/+$/, ''));
  const requestPath = canonicalPath(config.bucket, object.objectKey);
  const payloadHash = sha256File(object.filePath);
  const body = fs.createReadStream(object.filePath);
  const auth = authorizationHeader(config, { host: endpoint.host, path: requestPath, payloadHash });
  const options = {
    method: 'PUT',
    hostname: endpoint.hostname,
    port: endpoint.port || 443,
    path: requestPath,
    headers: {
      authorization: auth.value,
      'content-length': fs.statSync(object.filePath).size,
      'content-type': contentTypeFor(object.filePath),
      'cache-control': cacheControlFor(object.objectKey),
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': auth.amzDate
    }
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve();
          return;
        }
        const bodyText = Buffer.concat(chunks).toString('utf8').trim();
        reject(new Error(`R2 PUT failed ${response.statusCode} for ${object.objectKey}${bodyText ? `: ${bodyText.slice(0, 300)}` : ''}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error(`R2 PUT timeout for ${object.objectKey}`)));
    body.pipe(req);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const releaseRoot = path.resolve(options.release);
  const config = loadR2Config(options);
  const restoreProduction = await prepareSinglePlatformProduction(releaseRoot, config, options);
  try {
    const objects = releaseObjects(releaseRoot, options);
    for (const object of objects) {
      if (options.dryRun) {
        console.log(`[hard-update-upload-r2] dry-run ${config.bucket}/${object.objectKey}`);
        continue;
      }
      await putObject(config, object);
      console.log(`[hard-update-upload-r2] uploaded ${config.bucket}/${object.objectKey}`);
    }
    if (config.publicUrl) {
      const productionUrl = `${config.publicUrl.replace(/\/+$/, '')}/releases/production.json`;
      if (options.skipProduction) {
        console.log(`[hard-update-upload-r2] production unchanged ${productionUrl}`);
      } else if (options.onlyProduction) {
        console.log(`[hard-update-upload-r2] production published ${productionUrl}`);
      } else {
        console.log(`[hard-update-upload-r2] production ${productionUrl}`);
      }
    }
  } finally {
    if (restoreProduction) restoreProduction();
  }
}

main().catch(error => {
  console.error(`[hard-update-upload-r2] ${error.message}`);
  process.exit(1);
});
