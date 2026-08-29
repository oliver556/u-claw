#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const { readJson } = require('./lib/hard-update-utils');
const { firstEnv, parseEnvFile } = require('./lib/local-env');

const appDir = path.resolve(__dirname, '..');
const defaultEnvPath = path.join(appDir, '.env');
const defaultReleaseRoot = path.join(appDir, 'release', 'mock-hard-update');
const defaultPublicBaseUrl = 'https://pub-8289f643846848528b61bfd5dbf17e43.r2.dev/releases';
const defaultPort = 18080;

function parseArgs(argv) {
  const options = { env: defaultEnvPath };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === '--env') options.env = readValue();
    else if (arg === '--port') options.port = Number(readValue());
    else if (arg === '--release') options.release = readValue();
    else if (arg === '--public-base-url') options.publicBaseUrl = readValue().replace(/\/+$/, '');
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function loadConfig(options) {
  const env = parseEnvFile(path.resolve(options.env));
  const databaseUrl = readDatabaseUrl(env)
    || firstEnv(env, ['UCLAW_UPDATE_DATABASE_URL', 'DATABASE_URL']);
  const authMode = firstEnv(env, ['UCLAW_UPDATE_AUTH_MODE']) || (databaseUrl ? 'postgres' : 'permissive');
  return {
    port: options.port || Number(firstEnv(env, ['UCLAW_UPDATE_CHECK_PORT'])) || defaultPort,
    releaseRoot: path.resolve(options.release || firstEnv(env, ['UCLAW_UPDATE_RELEASE_ROOT']) || defaultReleaseRoot),
    publicBaseUrl: options.publicBaseUrl
      || firstEnv(env, ['UCLAW_UPDATE_PUBLIC_BASE_URL', 'R2_RELEASES_BASE_URL', 'R2_STAGING_RELEASES_BASE_URL'])
      || `${firstEnv(env, ['R2_STAGING_PUBLIC_URL']) || defaultPublicBaseUrl.replace(/\/releases$/, '')}/releases`,
    authMode,
    databaseUrl,
    psqlDatabase: firstEnv(env, ['UCLAW_UPDATE_PSQL_DATABASE']),
    psqlSystemUser: firstEnv(env, ['UCLAW_UPDATE_PSQL_SYSTEM_USER']),
    psqlUser: firstEnv(env, ['UCLAW_UPDATE_PSQL_USER']),
    psqlHost: firstEnv(env, ['UCLAW_UPDATE_PSQL_HOST']),
    psqlPort: firstEnv(env, ['UCLAW_UPDATE_PSQL_PORT']),
    shortTokenSecret: firstEnv(env, ['UCLAW_SHORT_TOKEN_SECRET']),
    videoAdapterBaseUrl: firstEnv(env, ['UCLAW_VIDEO_ADAPTER_BASE_URL']) || 'https://video-adapter.gmnlee.com/xai/v1'
  };
}

function readFirstEnvFile(env, names) {
  const filePath = firstEnv(env, names);
  if (!filePath) return '';
  return fs.readFileSync(filePath, 'utf8').trim();
}

function readDatabaseUrl(env) {
  const envFilePath = firstEnv(env, ['UCLAW_UPDATE_DATABASE_ENV_FILE']);
  if (envFilePath) {
    return firstEnv(parseEnvFile(envFilePath), ['UCLAW_UPDATE_DATABASE_URL', 'DATABASE_URL']);
  }
  return readFirstEnvFile(env, ['UCLAW_UPDATE_DATABASE_URL_FILE', 'DATABASE_URL_FILE']);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(payload, null, 2) + '\n');
}

function readBody(request, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        request.destroy(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function platformKeyFromRequest(payload) {
  if (payload.platformKey) return payload.platformKey;
  if (payload.platform && payload.arch) return `${payload.platform}-${payload.arch}`;
  throw new Error('Missing platform/platformKey');
}

function createShortToken(config, payload) {
  if (!config.shortTokenSecret) return null;
  const body = {
    license: payload.license || null,
    deviceId: payload.deviceId || payload.device || null
  };
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', config.shortTokenSecret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function bearerToken(authHeader) {
  const match = String(authHeader || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function postgresEnvFromDatabaseUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  if (!/^postgres(?:ql)?:$/.test(url.protocol)) throw new Error('DATABASE_URL must use postgres:// or postgresql://');
  const env = {
    PGHOST: url.hostname,
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')),
    PGCONNECT_TIMEOUT: '5'
  };
  if (url.port) env.PGPORT = url.port;
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

function runPsqlScalar(config, variables, sql) {
  if (!config.databaseUrl && !config.psqlDatabase) throw new Error('DATABASE_URL or UCLAW_UPDATE_PSQL_DATABASE missing for postgres auth');
  const args = ['-X', '-q', '-A', '-t', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1'];
  for (const [key, value] of Object.entries(variables)) {
    args.push('-v', `${key}=${value}`);
  }
  const env = { ...process.env };
  if (config.databaseUrl) Object.assign(env, postgresEnvFromDatabaseUrl(config.databaseUrl));
  if (config.psqlHost) env.PGHOST = config.psqlHost;
  if (config.psqlPort) env.PGPORT = config.psqlPort;
  if (config.psqlUser) env.PGUSER = config.psqlUser;
  if (config.psqlDatabase) args.push('-d', config.psqlDatabase);
  let command = 'psql';
  let commandArgs = args;
  if (config.psqlSystemUser) {
    command = 'sudo';
    commandArgs = ['-n', '-u', config.psqlSystemUser, 'psql', ...args];
  }
  const result = spawnSync(command, commandArgs, {
    input: sql,
    env,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error('postgres auth query failed');
    error.statusCode = 500;
    error.detail = (result.stderr || result.stdout || '').trim();
    throw error;
  }
  return result.stdout.trim();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function authorizeDeviceTokenPostgres(config, requestPayload, authHeader) {
  const rawToken = bearerToken(authHeader);
  if (!rawToken) return { allowed: false, reason: 'missing-device-token' };
  const deviceId = requestPayload.deviceId;
  if (!isUuid(deviceId)) return { allowed: false, reason: 'invalid-device-id' };
  const tokenDigestHex = crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
  const result = runPsqlScalar(config, {
    token_digest_hex: tokenDigestHex,
    device_id: deviceId
  }, `
SELECT CASE WHEN EXISTS (
  SELECT 1
  FROM device_access_tokens AS access_token
  JOIN licenses AS license_record
    ON license_record.license_id = access_token.license_id
   AND license_record.device_id = access_token.device_id
  JOIN devices AS device_record
    ON device_record.device_id = access_token.device_id
   AND device_record.inventory_id = access_token.inventory_id
  JOIN activation_inventory AS inventory_record
    ON inventory_record.id = access_token.inventory_id
  WHERE access_token.token_digest = decode(:'token_digest_hex', 'hex')
    AND access_token.status = 'active'
    AND license_record.status = 'active'
    AND device_record.status = 'active'
    AND inventory_record.status = 'active'
    AND license_record.not_before <= now()
    AND license_record.expires_at > now()
    AND device_record.device_id = :'device_id'::uuid
) THEN 'allowed' ELSE 'denied' END;
`);
  return result === 'allowed' ? { allowed: true } : { allowed: false, reason: 'license-device-token-denied' };
}

function authorizeRequest(config, requestPayload, authHeader) {
  if (config.authMode === 'postgres') return authorizeDeviceTokenPostgres(config, requestPayload, authHeader);
  if (config.authMode === 'permissive') {
    const token = bearerToken(authHeader);
    return {
      allowed: Boolean(requestPayload.license || requestPayload.licenseId || ((requestPayload.deviceId || requestPayload.device) && token)),
      reason: 'missing-license-or-device'
    };
  }
  const error = new Error(`Unsupported auth mode: ${config.authMode}`);
  error.statusCode = 500;
  throw error;
}

function checkUpdate(config, requestPayload, authHeader = '') {
  const production = readJson(path.join(config.releaseRoot, 'production.json'));
  const platformKey = platformKeyFromRequest(requestPayload);
  const platformInfo = production.platforms?.[platformKey];
  if (!platformInfo) {
    return {
      allowed: false,
      reason: 'unsupported-platform',
      requiredVersion: production.requiredVersion,
      forceUpdate: true
    };
  }
  const auth = authorizeRequest(config, requestPayload, authHeader);
  if (!auth.allowed) {
    return {
      allowed: false,
      reason: auth.reason || 'not-allowed',
      requiredVersion: production.requiredVersion,
      releaseId: production.releaseId,
      forceUpdate: true
    };
  }
  const installedVersion = requestPayload.installedVersion || '0.0.0';
  const forceUpdate = installedVersion !== production.requiredVersion;
  const manifestUrl = `${config.publicBaseUrl}/packages/${production.releaseId}/${platformKey}/manifest.json`;
  const packageUrl = `${config.publicBaseUrl}/packages/${production.releaseId}/${platformKey}/runtime.pkg`;
  return {
    allowed: true,
    requiredVersion: production.requiredVersion,
    releaseId: production.releaseId,
    forceUpdate,
    productionUrl: `${config.publicBaseUrl}/production.json`,
    manifestUrl,
    packageUrl,
    shortConfig: {
      videoAdapterBaseUrl: config.videoAdapterBaseUrl,
      tokenExpiresAt: null,
      shortToken: createShortToken(config, requestPayload),
      aliyunControlPlane: true,
      r2StaticDownloads: true,
      rollout: 'all',
      containsSecret: false
    }
  };
}

function createServer(config) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/healthz') {
      sendJson(response, 200, { ok: true, service: 'uclaw-update-check' });
      return;
    }
    if (request.method !== 'POST' || url.pathname !== '/uclaw/update/check') {
      sendJson(response, 404, { error: 'not-found' });
      return;
    }
    try {
      const body = await readBody(request);
      const payload = body ? JSON.parse(body) : {};
      sendJson(response, 200, checkUpdate(config, payload, request.headers.authorization));
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.statusCode ? 'server-error' : 'bad-request', message: error.message });
    }
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig(options);
  const server = createServer(config);
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`[hard-update-control-plane] listening 127.0.0.1:${config.port}`);
    console.log(`[hard-update-control-plane] release ${config.releaseRoot}`);
    console.log(`[hard-update-control-plane] public ${config.publicBaseUrl}`);
    console.log(`[hard-update-control-plane] auth ${config.authMode}`);
  });
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[hard-update-control-plane] ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  checkUpdate,
  createServer,
  loadConfig,
  authorizeDeviceTokenPostgres,
  authorizeRequest
};
