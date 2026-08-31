const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const DEFAULT_CONFIG_PATH = '/opt/uclaw-video-adapter/config.json';
const DEFAULT_TASK_STORE_PATH = '/opt/uclaw-video-adapter/tasks.json';
const DEFAULT_FLASH_BASE_URL = 'https://flash.duoyuanx.net';
const DEFAULT_NEW_API_UPSTREAM_BASE_URL = 'http://158.51.110.49:3000';
const JSON_LIMIT_BYTES = 8 * 1024 * 1024;
const TASK_MODEL_TTL_MS = 24 * 60 * 60 * 1000;
const RECENT_UPSTREAM_CREATE_TTL_MS = 5 * 60 * 1000;
const RECENT_UPSTREAM_CREATES = [];

const DEFAULT_MODELS = {
  'seedance-1.5-pro-1080p-5s': {
    provider: 'flash',
    upstreamModel: 'doubao-seedance-1-5-pro_1080p',
    seconds: '5',
    size: '4:3',
    enabled: true,
  },
  'seedance-1.5-pro-1080p-4s-test': {
    provider: 'flash',
    upstreamModel: 'doubao-seedance-1-5-pro_1080p',
    seconds: '4',
    size: '4:3',
    enabled: true,
  },
  'seedance-1.5-pro-1080p-10s': {
    provider: 'flash',
    upstreamModel: 'doubao-seedance-1-5-pro_1080p',
    seconds: '10',
    size: '4:3',
    enabled: true,
  },
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_FLASH_BASE_URL).trim().replace(/\/+$/, '');
}

function bearerToken(value) {
  const match = String(value || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function authorizationHeader(value) {
  const token = String(value || '').trim();
  if (!token) return '';
  return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

function splitTokens(value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function readConfigFile(configPath) {
  if (!fs.existsSync(configPath)) return {};
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed;
}

function createProviders(fileConfig, options = {}) {
  const configured = fileConfig.providers || {};
  const flash = configured.flash || {};
  const providers = {
    flash: {
      type: 'flash-multipart',
      baseUrl: DEFAULT_FLASH_BASE_URL,
      apiKey: '',
      enabled: true,
    },
    ...configured,
  };

  providers.flash = {
    type: flash.type || 'flash-multipart',
    baseUrl: options.flashBaseUrl || process.env.UCLAW_FLASH_BASE_URL || flash.baseUrl || DEFAULT_FLASH_BASE_URL,
    apiKey: options.flashApiKey || process.env.UCLAW_FLASH_API_KEY || flash.apiKey || '',
    enabled: flash.enabled !== false,
  };

  for (const [name, provider] of Object.entries(providers)) {
    providers[name] = {
      type: provider.type || 'openai-json',
      baseUrl: normalizeBaseUrl(provider.baseUrl),
      apiKey: provider.apiKey || '',
      enabled: provider.enabled !== false,
    };
  }

  return providers;
}

function createConfig(options = {}) {
  const configPath = options.configPath || process.env.UCLAW_VIDEO_ADAPTER_CONFIG || DEFAULT_CONFIG_PATH;
  const fileConfig = readConfigFile(configPath);
  const security = fileConfig.security || {};
  const providers = createProviders(fileConfig, options);
  return {
    configPath,
    taskStorePath: options.taskStorePath || process.env.UCLAW_VIDEO_TASK_STORE || fileConfig.taskStorePath || DEFAULT_TASK_STORE_PATH,
    fileConfig,
    providers,
    flashBaseUrl: providers.flash.baseUrl,
    flashApiKey: providers.flash.apiKey,
    newApiUpstreamBaseUrl: normalizeBaseUrl(
      options.newApiUpstreamBaseUrl
      || process.env.UCLAW_NEW_API_UPSTREAM_BASE_URL
      || fileConfig.newApiUpstreamBaseUrl
      || DEFAULT_NEW_API_UPSTREAM_BASE_URL,
    ),
    adapterTokens: [
      ...splitTokens(options.adapterTokens || process.env.UCLAW_ADAPTER_API_KEYS || process.env.UCLAW_ADAPTER_API_KEY),
      ...splitTokens(security.adapterTokens),
    ],
    adminToken: options.adminToken || process.env.UCLAW_ADAPTER_ADMIN_TOKEN || security.adminToken || '',
    models: {
      ...DEFAULT_MODELS,
      ...(fileConfig.models || {}),
    },
  };
}

function writeConfig(configPath, nextConfig) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (fs.existsSync(configPath)) {
    const backupDir = path.join(path.dirname(configPath), 'backups');
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(configPath, path.join(backupDir, `config-${stamp}.json`));
  }
  const tmpPath = `${configPath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  fs.renameSync(tmpPath, configPath);
}

function readRequestBody(req, limit = JSON_LIMIT_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipartFields(raw, contentType) {
  const boundaryMatch = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new Error('Missing multipart boundary');
  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const text = raw.toString('utf8');
  const fields = {};
  for (const part of text.split(`--${boundary}`)) {
    const separator = part.indexOf('\r\n\r\n');
    if (separator === -1) continue;
    const headers = part.slice(0, separator);
    const nameMatch = headers.match(/content-disposition:[^\r\n]*\bname="([^"]+)"/i);
    const filenameMatch = headers.match(/content-disposition:[^\r\n]*\bfilename="/i);
    if (!nameMatch || filenameMatch) continue;
    let value = part.slice(separator + 4).replace(/\r\n--$/, '').replace(/\r\n$/, '');
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    fields[nameMatch[1]] = value;
  }
  return fields;
}

async function readFlexibleBody(req) {
  const raw = await readRequestBody(req);
  if (!raw.length || !raw.toString('utf8').trim()) return {};
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (contentType.includes('multipart/form-data')) return parseMultipartFields(raw, contentType);
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw.toString('utf8')).entries());
  }
  return JSON.parse(raw.toString('utf8'));
}

function validateAdapterToken(req, config) {
  if (!config.adapterTokens.length) return true;
  const token = bearerToken(req.headers.authorization) || String(req.headers.authorization || '').trim();
  return config.adapterTokens.includes(token);
}

function validateAdminToken(req, url, config) {
  if (!config.adminToken) return true;
  const token = req.headers['x-admin-token'] || url.searchParams.get('token') || '';
  return String(token).trim() === config.adminToken;
}

function getModelConfig(config, model) {
  const requested = String(model || '').trim();
  const modelConfig = config.models[requested];
  if (!modelConfig || modelConfig.enabled === false) {
    const error = new Error(`Unsupported video model: ${requested || '(empty)'}`);
    error.statusCode = 400;
    throw error;
  }
  return { requested, modelConfig };
}

function getProviderConfig(config, providerName) {
  const name = String(providerName || 'flash').trim();
  const provider = config.providers[name];
  if (!provider || provider.enabled === false) {
    const error = new Error(`Unsupported video provider: ${name || '(empty)'}`);
    error.statusCode = 400;
    throw error;
  }
  return { name, provider };
}

function addFormField(form, key, value) {
  if (value === undefined || value === null || value === '') return;
  if (Array.isArray(value)) {
    for (const item of value) addFormField(form, key, item);
    return;
  }
  if (typeof value === 'object') {
    form.append(key, JSON.stringify(value));
    return;
  }
  form.append(key, String(value));
}

function buildFlashCreateForm(body, config) {
  const { requested, modelConfig } = getModelConfig(config, body.model);
  const form = new FormData();
  const fixedParams = modelConfig.fixedParams || {};
  const size = fixedParams.size || modelConfig.size || body.size || body.aspect_ratio || '4:3';
  const seconds = fixedParams.seconds || modelConfig.seconds;
  addFormField(form, 'model', modelConfig.upstreamModel);
  addFormField(form, 'prompt', body.prompt);
  addFormField(form, 'size', size);
  addFormField(form, 'seconds', seconds);
  return { form, requested, modelConfig };
}

async function upstreamJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: { message: text || 'Malformed upstream response' } };
  }
  return { response, payload };
}

function getVideoUrl(payload) {
  return payload?.output?.url
    || payload?.data?.url
    || payload?.data?.video_url
    || payload?.video_url
    || payload?.url
    || payload?.metadata?.url
    || payload?.video?.url
    || '';
}

function normalizeStatus(status) {
  const value = String(status || '').toLowerCase();
  if (['completed', 'succeeded', 'success', 'done'].includes(value)) return 'completed';
  if (['failed', 'error', 'expired'].includes(value)) return 'failed';
  if (['cancelled', 'canceled'].includes(value)) return 'cancelled';
  if (value === 'queued') return 'queued';
  return 'processing';
}

function mapCreateResponse(payload, requestedModel) {
  const id = payload.task_id || payload.request_id || payload.id || payload?.data?.task_id || payload?.data?.id;
  return {
    ...payload,
    id,
    task_id: id,
    object: payload.object || 'video',
    model: requestedModel,
    status: normalizeStatus(payload.status || payload?.data?.status || 'queued'),
    created_at: payload.created_at || Math.floor(Date.now() / 1000),
  };
}

function readTaskStore(config) {
  try {
    if (!fs.existsSync(config.taskStorePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(config.taskStorePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeTaskStore(config, store) {
  fs.mkdirSync(path.dirname(config.taskStorePath), { recursive: true });
  fs.writeFileSync(config.taskStorePath, `${JSON.stringify(store, null, 2)}\n`);
}

function rememberTaskRecord(config, taskId, record) {
  if (!taskId) return;
  const now = Date.now();
  const store = readTaskStore(config);
  for (const [id, item] of Object.entries(store)) {
    if (!item || item.expiresAt < now) delete store[id];
  }
  store[taskId] = {
    ...(store[taskId] || {}),
    ...record,
    expiresAt: now + TASK_MODEL_TTL_MS,
  };
  writeTaskStore(config, store);
}

function rememberTaskModel(config, taskId, model, protocol = 'openai') {
  if (!taskId || !model) return;
  rememberTaskRecord(config, taskId, { model, protocol });
}

function rememberNewApiTaskAlias(config, newApiTaskId, upstreamTaskId, model, protocol = 'xai-newapi') {
  if (!newApiTaskId || !upstreamTaskId || !model) return;
  rememberTaskRecord(config, newApiTaskId, {
    model,
    protocol,
    upstreamTaskId,
  });
}

function rememberRecentUpstreamCreate(taskId, body, requestedModel) {
  if (!taskId) return;
  const now = Date.now();
  while (RECENT_UPSTREAM_CREATES.length && now - RECENT_UPSTREAM_CREATES[0].createdAt > RECENT_UPSTREAM_CREATE_TTL_MS) {
    RECENT_UPSTREAM_CREATES.shift();
  }
  RECENT_UPSTREAM_CREATES.push({
    taskId,
    model: requestedModel,
    prompt: String(body.prompt || ''),
    createdAt: now,
    claimed: false,
  });
}

function takeRecentUpstreamCreate(model, prompt) {
  const now = Date.now();
  const requestedModel = String(model || '');
  const requestedPrompt = String(prompt || '');
  for (let index = RECENT_UPSTREAM_CREATES.length - 1; index >= 0; index -= 1) {
    const record = RECENT_UPSTREAM_CREATES[index];
    if (!record || now - record.createdAt > RECENT_UPSTREAM_CREATE_TTL_MS) {
      RECENT_UPSTREAM_CREATES.splice(index, 1);
      continue;
    }
    if (!record.claimed && record.model === requestedModel && record.prompt === requestedPrompt) {
      record.claimed = true;
      return record;
    }
  }
  return null;
}

function findTaskRecord(config, taskId) {
  const record = readTaskStore(config)[taskId];
  if (!record || record.expiresAt < Date.now()) return {};
  return record;
}

function findTaskModel(config, taskId) {
  return findTaskRecord(config, taskId).model || '';
}

function findTaskProtocol(config, taskId) {
  return findTaskRecord(config, taskId).protocol || 'openai';
}

function findUpstreamTaskId(config, taskId) {
  return findTaskRecord(config, taskId).upstreamTaskId || taskId;
}

function mapStatusResponse(payload, taskId, config) {
  const id = payload.task_id || payload.request_id || payload.id || payload?.data?.task_id || payload?.data?.id;
  const status = normalizeStatus(payload.status || payload?.data?.status);
  const videoUrl = getVideoUrl(payload);
  return {
    ...payload,
    id,
    task_id: id,
    object: payload.object || 'video',
    model: findTaskModel(config, taskId) || payload.model,
    status,
    video_url: videoUrl,
    metadata: {
      ...(payload.metadata || {}),
      ...(videoUrl ? { url: videoUrl } : {}),
    },
  };
}

function toXaiStatus(status, creating = false) {
  const normalized = normalizeStatus(status);
  if (normalized === 'completed') return 'done';
  if (normalized === 'queued') return creating ? 'pending' : 'processing';
  return normalized;
}

function mapXaiCreateResponse(payload, requestedModel) {
  const mapped = mapCreateResponse(payload, requestedModel);
  return {
    ...mapped,
    request_id: mapped.task_id || mapped.id,
    status: toXaiStatus(mapped.status, true),
  };
}

function mapXaiStatusResponse(payload, taskId, config) {
  const mapped = mapStatusResponse(payload, taskId, config);
  const requestId = mapped.task_id || mapped.id || taskId;
  const videoUrl = mapped.video_url || getVideoUrl(mapped);
  return {
    ...mapped,
    request_id: requestId,
    status: toXaiStatus(mapped.status),
    ...(videoUrl ? { video: { url: videoUrl } } : {}),
    ...(mapped.status === 'failed' && !mapped.error ? { error: { message: 'Video generation failed' } } : {}),
  };
}

function mapNewApiVideoCreateToXai(payload, requestedModel) {
  const mapped = mapCreateResponse(payload, requestedModel);
  return {
    request_id: mapped.task_id || mapped.id,
    status: toXaiStatus(mapped.status, true),
    error: mapped.error || null,
  };
}

function mapNewApiVideoStatusToXai(payload, taskId, config, fallbackPayload) {
  const mapped = mapStatusResponse(payload, taskId, config);
  const fallback = fallbackPayload ? mapStatusResponse(fallbackPayload, taskId, config) : null;
  const requestId = mapped.task_id || mapped.id || fallback?.task_id || fallback?.id || taskId;
  const videoUrl = mapped.video_url || getVideoUrl(mapped) || fallback?.video_url || getVideoUrl(fallback);
  return {
    request_id: requestId,
    status: toXaiStatus(mapped.status),
    ...(videoUrl ? { video: { url: videoUrl } } : {}),
    ...(mapped.error ? { error: mapped.error } : {}),
  };
}

function newApiVideoCreateBody(body, config) {
  const model = String(body.model || '').trim();
  const modelConfig = config.models[model] || {};
  const seconds = modelConfig.fixedParams?.seconds || modelConfig.seconds || body.seconds || body.duration;
  const size = String(body.size || body.resolution || '').trim();
  const allowedNewApiSizes = new Set(['720x1280', '1280x720', '1792x1024', '1024x1792']);
  const nextBody = {
    model,
    prompt: body.prompt,
    ...(seconds ? { seconds: String(seconds), duration: String(seconds) } : {}),
  };
  if (allowedNewApiSizes.has(size)) nextBody.size = size;
  return nextBody;
}

async function forwardNewApiJson(config, req, pathName, body) {
  const authorization = String(req.headers.authorization || '').trim();
  if (!authorization) {
    const error = new Error('Missing New API authorization');
    error.statusCode = 401;
    throw error;
  }
  const result = await upstreamJson(`${config.newApiUpstreamBaseUrl}${pathName}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: authorization,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return result;
}

async function handleNewApiXaiCompat(req, res, videoPath, config) {
  if (req.method === 'POST' && videoPath === '/v1/videos/generations') {
    const body = await readFlexibleBody(req);
    const requestedModel = String(body.model || '').trim();
    const result = await forwardNewApiJson(config, req, '/v1/videos', newApiVideoCreateBody(body, config));
    const payload = result.response.ok ? mapNewApiVideoCreateToXai(result.payload, requestedModel) : result.payload;
    if (result.response.ok && payload.request_id) {
      const upstreamCreate = takeRecentUpstreamCreate(requestedModel, body.prompt);
      if (upstreamCreate?.taskId) {
        rememberNewApiTaskAlias(config, payload.request_id, upstreamCreate.taskId, requestedModel, 'xai-newapi');
      } else {
        rememberTaskModel(config, payload.request_id, requestedModel, 'xai-newapi');
      }
    }
    sendJson(res, result.response.status, payload);
    return true;
  }

  const statusMatch = videoPath.match(/^\/v1\/videos\/([^/]+)$/);
  if (req.method === 'GET' && statusMatch) {
    const taskId = decodeURIComponent(statusMatch[1]);
    const result = await forwardNewApiJson(config, req, `/v1/videos/${encodeURIComponent(taskId)}`);
    let fallbackPayload = null;
    if (result.response.ok && !getVideoUrl(result.payload)) {
      try {
        const upstreamTaskId = findUpstreamTaskId(config, taskId);
        const fallback = await queryVideo(upstreamTaskId, config);
        if (fallback.response.ok) fallbackPayload = fallback.payload;
      } catch {}
    }
    const payload = result.response.ok ? mapNewApiVideoStatusToXai(result.payload, taskId, config, fallbackPayload) : result.payload;
    sendJson(res, result.response.status, payload);
    return true;
  }

  return false;
}

async function createVideo(body, config, options = {}) {
  const { modelConfig } = getModelConfig(config, body.model);
  const { provider } = getProviderConfig(config, modelConfig.provider);

  if (provider.type !== 'flash-multipart') {
    const error = new Error(`Video provider type not implemented: ${provider.type}`);
    error.statusCode = 501;
    throw error;
  }
  if (!provider.apiKey) {
    const error = new Error(`Video adapter missing API key for provider: ${modelConfig.provider || 'flash'}`);
    error.statusCode = 401;
    throw error;
  }
  const { form, requested } = buildFlashCreateForm(body, config);
  const result = await upstreamJson(`${provider.baseUrl}/v1/videos`, {
    method: 'POST',
    headers: { Authorization: authorizationHeader(provider.apiKey) },
    body: form,
  });
  const payload = result.response.ok
    ? options.protocol === 'xai' ? mapXaiCreateResponse(result.payload, requested) : mapCreateResponse(result.payload, requested)
    : result.payload;
  if (result.response.ok && payload.task_id) rememberTaskModel(config, payload.task_id, requested, options.protocol || 'openai');
  if (result.response.ok && payload.task_id) rememberRecentUpstreamCreate(payload.task_id, body, requested);
  return {
    response: result.response,
    payload,
  };
}

async function queryVideo(taskId, config) {
  const model = findTaskModel(config, taskId);
  const providerName = config.models[model]?.provider || 'flash';
  const { provider } = getProviderConfig(config, providerName);
  if (provider.type !== 'flash-multipart') {
    const error = new Error(`Video provider type not implemented: ${provider.type}`);
    error.statusCode = 501;
    throw error;
  }
  if (!provider.apiKey) {
    const error = new Error(`Video adapter missing API key for provider: ${providerName}`);
    error.statusCode = 401;
    throw error;
  }
  const result = await upstreamJson(`${provider.baseUrl}/v1/videos/${encodeURIComponent(taskId)}`, {
    method: 'GET',
    headers: { Authorization: authorizationHeader(provider.apiKey), Accept: 'application/json' },
  });
  return {
    response: result.response,
    payload: result.response.ok ? mapStatusResponse(result.payload, taskId, config) : result.payload,
  };
}

function publicConfig(config) {
  const providers = {};
  for (const [name, provider] of Object.entries(config.providers)) {
    providers[name] = {
      type: provider.type,
      baseUrl: provider.baseUrl,
      enabled: provider.enabled !== false,
      hasApiKey: Boolean(provider.apiKey),
    };
  }

  return {
    flashBaseUrl: config.flashBaseUrl,
    hasFlashApiKey: Boolean(config.flashApiKey),
    hasAdminToken: Boolean(config.adminToken),
    adapterTokenCount: config.adapterTokens.length,
    providers,
    models: config.models,
  };
}

function html() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>视频 Adapter 控制台</title>
<style>
*{box-sizing:border-box}html{background:#07110f}body{margin:0;background:#12211e;color:#edf7f2;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}button,input,textarea,select{font:inherit}button{cursor:pointer}code,pre,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.hidden{display:none!important}.auth-screen{min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 64% -12%,rgba(42,209,164,.2),transparent 35%),#12211e}.auth-card{width:min(460px,100%);border:1px solid #344f49;border-radius:10px;background:#1b2d2a;padding:24px;box-shadow:0 24px 70px rgba(0,0,0,.28)}.auth-card h1{margin:0 0 10px;font-size:24px}.auth-card p{margin:0 0 18px;color:#9eb4ae;line-height:1.55}.shell{min-height:100vh;display:grid;grid-template-columns:264px minmax(0,1fr);background:radial-gradient(circle at 70% -10%,rgba(42,209,164,.16),transparent 34%),#12211e}.sidebar{border-right:1px solid #344f49;background:#0b1715;padding:20px 16px}.brand{display:flex;gap:12px;align-items:center;margin:0 8px 24px}.logo{display:grid;place-items:center;width:40px;height:40px;border-radius:8px;background:#9aead0;color:#0a1713;box-shadow:0 0 28px rgba(42,209,164,.24);font-weight:800}.brand b{display:block;font-size:14px}.brand span{display:block;margin-top:3px;color:#8da7a0;font-size:12px}.nav{display:grid;gap:6px}.nav button{height:40px;border:0;border-radius:8px;background:transparent;color:#91aaa4;text-align:left;padding:0 12px}.nav button.active,.nav button:hover{background:#1d332f;color:#edf7f2}.target{margin-top:28px;border:1px solid #344f49;border-radius:8px;background:rgba(18,33,30,.6);padding:14px}.target-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;color:#abc0bb;font-size:12px}.target p{margin:7px 0;color:#abc0bb;font-size:12px}.main{min-width:0}.top{position:sticky;top:0;z-index:2;border-bottom:1px solid #344f49;background:rgba(18,33,30,.88);backdrop-filter:blur(18px);padding:18px 32px}.crumb{display:flex;gap:8px;align-items:center;color:#8fa9a3;font-size:12px;margin-bottom:8px}.top-row{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}.top h1{margin:0;font-size:24px;font-weight:700}.top p{margin:6px 0 0;color:#9eb4ae;font-size:14px}.actions{display:flex;gap:8px;flex-wrap:wrap}.btn{height:34px;border:1px solid #3b5952;border-radius:8px;background:#9aead0;color:#091713;padding:0 12px;font-size:14px;font-weight:650}.btn.secondary{background:transparent;color:#edf7f2}.btn[disabled]{opacity:.45;cursor:not-allowed}.mini{height:28px;padding:0 10px;font-size:12px}.content{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:20px;padding:28px 32px}.page{display:grid;gap:20px}.panel{border:1px solid #344f49;border-radius:8px;background:#1b2d2a;padding:20px;box-shadow:0 14px 40px rgba(0,0,0,.18)}.panel h2,.panel h3{margin:0;color:#f5fffb}.panel p{color:#9eb4ae;line-height:1.55}.pill{display:inline-flex;align-items:center;justify-content:center;min-height:22px;border:1px solid #3b5952;border-radius:999px;padding:2px 8px;color:#9aead0;background:rgba(154,234,208,.1);font-size:12px;white-space:nowrap}.pill.warn{color:#f6d17a;background:rgba(246,209,122,.1);border-color:#6d5930}.pill.gray{color:#a7bbb5;background:rgba(167,187,181,.09);border-color:#415c55}.flow{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.card{border:1px solid #344f49;border-radius:8px;background:#12211e;padding:14px}.card small{display:block;color:#8fa9a3}.card b{display:block;margin-top:8px;word-break:break-word;font-size:14px}.card span{display:block;margin-top:5px;color:#8fa9a3;font-size:12px}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.metric{border:1px solid #344f49;border-radius:8px;background:#12211e;padding:14px}.metric small{color:#8fa9a3}.metric b{display:block;margin-top:8px;font-size:22px}.table{overflow:hidden;border:1px solid #344f49;border-radius:8px}.tr{display:grid;grid-template-columns:minmax(220px,1.5fr) minmax(120px,.8fr) minmax(180px,1fr) 82px 90px 100px;align-items:center}.tr.provider{grid-template-columns:minmax(160px,1fr) minmax(220px,1.3fr) 120px 120px 100px}.tr.security{grid-template-columns:minmax(160px,1fr) minmax(260px,1.3fr) 120px}.tr.backup{grid-template-columns:minmax(220px,1fr) minmax(280px,1.3fr) 120px}.tr.head{background:#243936;color:#91aaa4;font-size:12px;font-weight:650}.tr:not(.head){border-top:1px solid #344f49;font-size:14px}.td{min-width:0;padding:12px 14px}.td code{word-break:break-word;color:#edf7f2}.muted{color:#91aaa4}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:20px}.check{display:flex;align-items:center;gap:12px;margin:11px 0}.check i{display:grid;place-items:center;width:24px;height:24px;border-radius:6px;background:rgba(154,234,208,.12);color:#9aead0;font-style:normal}.field{display:grid;gap:6px;margin:0 0 12px}.field span{color:#91aaa4;font-size:12px;font-weight:650}input,textarea,select{width:100%;border:1px solid #3b5952;border-radius:8px;background:#12211e;color:#edf7f2;padding:9px 10px;outline:none}input:focus,textarea:focus,select:focus{border-color:#9aead0;box-shadow:0 0 0 3px rgba(154,234,208,.15)}textarea{min-height:112px;resize:vertical}.input-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.guard{border:1px solid #344f49;border-radius:8px;background:#243936;padding:12px;color:#91aaa4;font-size:12px;line-height:1.55}.guard b{display:block;margin-bottom:5px;color:#9aead0}pre{max-height:430px;overflow:auto;margin:0;border:1px solid #344f49;border-radius:8px;background:#07110f;color:#b8ffe8;padding:14px;font-size:12px;line-height:1.55}.side{display:grid;gap:20px;align-content:start}.login-row{display:grid;grid-template-columns:1fr auto;gap:8px}.empty{border:1px dashed #44645d;border-radius:8px;background:#12211e;padding:18px;color:#9eb4ae}.toast{position:fixed;right:18px;bottom:18px;max-width:420px;border:1px solid #3b5952;border-radius:8px;background:#07110f;color:#d6eee6;padding:12px 14px;box-shadow:0 18px 60px rgba(0,0,0,.32);white-space:pre-wrap;z-index:10}@media (max-width:1100px){.shell{grid-template-columns:1fr}.sidebar{display:none}.content{grid-template-columns:1fr}.flow,.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}@media (max-width:720px){.top,.content{padding:18px}.flow,.metrics,.grid2,.input-row{grid-template-columns:1fr}.tr,.tr.provider,.tr.security,.tr.backup{grid-template-columns:1fr}.tr.head{display:none}.td{padding:8px 12px}}
</style>
</head><body>
<div id="authScreen" class="auth-screen">
  <section class="auth-card">
    <div class="brand" style="margin:0 0 18px"><div class="logo">V</div><div><b>视频 Adapter 控制台</b><span>需要 admin token 才能进入</span></div></div>
    <h1>后台登录</h1>
    <p>此页面连接线上 adapter 配置。未登录时不展示配置项，不提供保存、生成密钥、测试任务入口。</p>
    <label class="field"><span>admin token</span><input id="authToken" type="password" placeholder="输入 admin token"></label>
    <div class="actions"><button class="btn" onclick="login()">进入控制台</button></div>
    <pre id="authMessage" style="margin-top:14px">等待登录</pre>
  </section>
</div>

<div id="appShell" class="shell hidden">
  <aside class="sidebar">
    <div class="brand"><div class="logo">V</div><div><b>易用视频 Adapter</b><span>单服务控制平面</span></div></div>
    <nav class="nav">
      <button class="active" data-page="overview">总览</button>
      <button data-page="providers">上游配置</button>
      <button data-page="models">模型映射</button>
      <button data-page="security">安全密钥</button>
      <button data-page="tests">测试验证</button>
      <button data-page="backups">配置备份</button>
    </nav>
    <div class="target">
      <div class="target-head"><span>部署目标</span><span class="pill">在线</span></div>
      <p>64.90.19.251</p><p>/opt/uclaw-video-adapter</p><p>127.0.0.1:18808</p>
    </div>
  </aside>
  <main class="main">
    <header class="top">
      <div class="crumb"><span>video-adapter.yiyong.me</span><span>→</span><span>flash.duoyuanx.net</span></div>
      <div class="top-row">
        <div><h1 id="pageTitle">总览</h1><p id="pageSubtitle">当前视频链路和关键状态。</p></div>
        <div class="actions"><button class="btn secondary" onclick="loadConfig()">重载配置</button><button class="btn secondary" onclick="logout()">退出</button></div>
      </div>
    </header>
    <div class="content">
      <section id="pageContent" class="page"></section>
      <aside id="sidePanel" class="side"></aside>
    </div>
  </main>
</div>
<div id="toast" class="toast hidden">等待操作</div>

<script>
let currentConfig={models:{},flashBaseUrl:'https://flash.duoyuanx.net',adapterTokenCount:0,hasAdminToken:false,hasFlashApiKey:false,adapterTokens:[]};
let currentPage='overview';
const savedToken=localStorage.getItem('uclawAdminToken')||'';
const authTokenInput=document.getElementById('authToken');
authTokenInput.value=savedToken;
function adminToken(){return localStorage.getItem('uclawAdminToken')||authTokenInput.value.trim()}
function headers(json=true){const h={'x-admin-token':adminToken()};if(json)h['Content-Type']='application/json';return h}
function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,function(s){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]})}
function toast(v){const el=document.getElementById('toast');el.textContent=typeof v==='string'?v:JSON.stringify(v,null,2);el.classList.remove('hidden')}
function money(seconds){const n=Number(seconds||0);return n?String((n*0.637).toFixed(3)).replace(/0$/,'').replace(/\\.0$/,''):''}
function pageMeta(page){return {overview:['总览','当前视频链路和关键状态。'],providers:['上游配置','配置 Flash 或未来其它视频上游。'],models:['模型映射','New API 展示 SKU，Adapter 固定真实上游参数。'],security:['安全密钥','管理 admin token 和 New API 渠道使用的 Adapter 内部密钥。'],tests:['测试验证','用真实 /v1/videos 请求验证链路。'],backups:['配置备份','查看备份和回滚策略。']}[page]}
function setPage(page){currentPage=page;document.querySelectorAll('[data-page]').forEach(function(b){b.classList.toggle('active',b.dataset.page===page)});const meta=pageMeta(page);document.getElementById('pageTitle').textContent=meta[0];document.getElementById('pageSubtitle').textContent=meta[1];renderPage()}
function showApp(){document.getElementById('authScreen').classList.add('hidden');document.getElementById('appShell').classList.remove('hidden')}
function showAuth(){document.getElementById('appShell').classList.add('hidden');document.getElementById('authScreen').classList.remove('hidden')}
function logout(){localStorage.removeItem('uclawAdminToken');showAuth();toast('已退出')}
async function login(){const token=authTokenInput.value.trim();if(!token){document.getElementById('authMessage').textContent='请输入 admin token';return}localStorage.setItem('uclawAdminToken',token);const ok=await loadConfig(true);if(ok){showApp();setPage('overview');toast('已登录，配置已读取')}else{localStorage.removeItem('uclawAdminToken')}}
async function loadConfig(fromLogin=false){try{const r=await fetch('/admin/config',{headers:headers(false)});const j=await r.json();if(!r.ok){if(fromLogin)document.getElementById('authMessage').textContent='登录失败：admin token 不正确';else toast(j);showAuth();return false}currentConfig=j;renderPage();return true}catch(error){if(fromLogin)document.getElementById('authMessage').textContent='登录失败：'+error.message;else toast({error:{message:error.message}});return false}}
async function saveConfig(){const body={flashBaseUrl:value('flashBaseUrl'),flashApiKey:value('flashApiKey'),adapterToken:value('adapterToken')};const r=await fetch('/admin/config',{method:'POST',headers:headers(),body:JSON.stringify(body)});const j=await r.json();toast(j);if(r.ok)await loadConfig()}
async function generateToken(){const r=await fetch('/admin/generate-token',{method:'POST',headers:headers(),body:'{}'});const j=await r.json();if(j.token){const input=document.getElementById('adapterToken');if(input)input.value=j.token}toast(j);if(r.ok)await loadConfig()}
async function testModel(){const body={model:value('testModel'),prompt:value('testPrompt')};const r=await fetch('/admin/test',{method:'POST',headers:headers(),body:JSON.stringify(body)});const j=await r.json();const message=document.getElementById('message');if(message)message.textContent=JSON.stringify(j,null,2);toast(j)}
async function saveProvider(){const body={name:value('providerName'),type:value('providerType'),baseUrl:value('providerBaseUrl'),apiKey:value('providerApiKey'),enabled:document.getElementById('providerEnabled')?.checked!==false};const r=await fetch('/admin/provider',{method:'POST',headers:headers(),body:JSON.stringify(body)});const j=await r.json();toast(j);if(r.ok)await loadConfig()}
async function saveModel(){const body={sku:value('modelSku'),provider:value('modelProvider'),upstreamModel:value('modelUpstream'),seconds:value('modelSeconds'),size:value('modelSize'),enabled:document.getElementById('modelEnabled')?.checked!==false};const r=await fetch('/admin/model',{method:'POST',headers:headers(),body:JSON.stringify(body)});const j=await r.json();toast(j);if(r.ok)await loadConfig()}
function value(id){const el=document.getElementById(id);return el?el.value:''}
function todo(name){toast(name+'：暂未做。当前已开放新增/编辑上游、新增/编辑模型、生成 Adapter 内部密钥、真实视频测试。')}
function configPreview(){return '<section class="panel"><h2>config.json 摘要</h2><pre>'+escapeHtml(JSON.stringify({providers:currentConfig.providers,models:currentConfig.models,security:{hasAdminToken:currentConfig.hasAdminToken,adapterTokenCount:currentConfig.adapterTokenCount}},null,2))+'</pre></section>'}
function providerOptions(selected){return Object.keys(currentConfig.providers||{}).map(function(name){return '<option value="'+escapeHtml(name)+'" '+(name===selected?'selected':'')+'>'+escapeHtml(name)+'</option>'}).join('')}
function setInput(id,value){const el=document.getElementById(id);if(el)el.value=value??''}
function setChecked(id,checked){const el=document.getElementById(id);if(el)el.checked=checked}
function fillProviderForm(name){const p=(currentConfig.providers||{})[name];if(!p)return;setInput('providerName',name);setInput('providerType',p.type);setInput('providerBaseUrl',p.baseUrl);setInput('providerApiKey','');setChecked('providerEnabled',p.enabled!==false);toast('已载入上游：'+name)}
function newProviderForm(){setInput('providerName','');setInput('providerType','flash-multipart');setInput('providerBaseUrl','https://');setInput('providerApiKey','');setChecked('providerEnabled',true)}
function fillModelForm(id){const m=(currentConfig.models||{})[id];if(!m)return;const seconds=m.seconds||(m.fixedParams&&m.fixedParams.seconds)||'';setInput('modelSku',id);setInput('modelProvider',m.provider||'flash');setInput('modelUpstream',m.upstreamModel||'');setInput('modelSeconds',seconds);setInput('modelSize',m.size||(m.fixedParams&&m.fixedParams.size)||'4:3');setChecked('modelEnabled',m.enabled!==false);toast('已载入模型：'+id)}
function newModelForm(){setInput('modelSku','');setInput('modelProvider',Object.keys(currentConfig.providers||{})[0]||'flash');setInput('modelUpstream','');setInput('modelSeconds','5');setInput('modelSize','4:3');setChecked('modelEnabled',true)}
function renderProviderRows(){const rows=Object.entries(currentConfig.providers||{}).map(function(item){const name=item[0],p=item[1];return '<div class="tr provider"><div class="td"><code>'+escapeHtml(name)+'</code><br><span class="muted">'+escapeHtml(p.type)+'</span></div><div class="td"><code>'+escapeHtml(p.baseUrl)+'</code></div><div class="td">'+(p.hasApiKey?'已配置':'未配置')+'</div><div class="td"><span class="pill '+(p.enabled===false?'gray':'')+'">'+(p.enabled===false?'停用':'启用')+'</span></div><div class="td"><button class="btn secondary mini" onclick="fillProviderForm(\\''+escapeHtml(name)+'\\')">编辑</button></div></div>'}).join('');return rows||'<div class="empty">还没有上游。点下面“新增空白上游”。</div>'}
function renderModelRows(){const rows=Object.entries(currentConfig.models||{}).map(function(item){const id=item[0],m=item[1];const seconds=m.seconds||(m.fixedParams&&m.fixedParams.seconds)||'';return '<div class="tr"><div class="td"><code>'+escapeHtml(id)+'</code></div><div class="td"><code>'+escapeHtml(m.provider||'flash')+'</code></div><div class="td"><code>'+escapeHtml(m.upstreamModel||'')+'</code></div><div class="td"><span class="pill">'+escapeHtml(seconds)+'s</span></div><div class="td">'+money(seconds)+'</div><div class="td"><span class="pill '+(m.enabled===false?'gray':'')+'">'+(m.enabled===false?'停用':'可用')+'</span><button class="btn secondary mini" onclick="fillModelForm(\\''+escapeHtml(id)+'\\')" style="margin-left:8px">编辑</button></div></div>'}).join('');return '<div class="table"><div class="tr head"><div class="td">New API 模型 SKU</div><div class="td">上游</div><div class="td">上游真实模型</div><div class="td">秒数</div><div class="td">按次价</div><div class="td">操作</div></div>'+rows+'</div>'}
function renderPage(){const main=document.getElementById('pageContent');const side=document.getElementById('sidePanel');if(!main||!side)return;if(currentPage==='overview'){main.innerHTML='<section class="panel"><p><span class="pill">P0 已上线</span> <span class="pill">P1 后台原型</span></p><h2>稳定链路</h2><p>客户和龙虾客户端只访问 api.yiyong.me。New API 管模型广场、密钥、额度、日志和计费。Adapter 只做视频协议适配、上游分发、固定参数覆盖。</p><div class="flow"><div class="card"><small>客户端</small><b>api.yiyong.me</b><span>New API 用户密钥</span></div><div class="card"><small>New API</small><b>OpenAI 渠道</b><span>模型映射留空</span></div><div class="card"><small>Adapter</small><b>香港优化前置机</b><span>单服务部署</span></div><div class="card"><small>上游</small><b>Flash Seedance</b><span>视频 multipart 协议</span></div></div></section><section class="metrics"><div class="metric"><small>模型 SKU</small><b>'+Object.keys(currentConfig.models||{}).length+'</b></div><div class="metric"><small>Adapter 内部密钥</small><b>'+currentConfig.adapterTokenCount+'</b></div><div class="metric"><small>上游 key</small><b>'+(currentConfig.hasFlashApiKey?'已配':'未配')+'</b></div><div class="metric"><small>admin token</small><b>'+(currentConfig.hasAdminToken?'已配':'未配')+'</b></div></section><section class="grid2"><div class="panel"><h2>热更新保存流程</h2><div class="check"><i>✓</i><span>校验上游、模型、安全配置</span></div><div class="check"><i>✓</i><span>备份旧 config 到 backups 目录</span></div><div class="check"><i>✓</i><span>原子写 config.json.tmp 并 rename</span></div><div class="check"><i>✓</i><span>重载内存配置并返回版本号</span></div></div><div class="panel"><h2>当前限制</h2><p>P0 已能配置 Flash 和测试视频。完整 provider/model CRUD、hash 存储、备份恢复还是 P1。</p></div></section>';side.innerHTML=configPreview();return}
if(currentPage==='providers'){main.innerHTML='<section class="panel"><h2>上游配置</h2><p>这里是真配置。每一行来自 config.json 的 providers；点编辑会把这一行载入下面表单。</p><div class="actions" style="margin-bottom:12px"><button class="btn secondary" onclick="newProviderForm()">新增空白上游</button><button class="btn secondary" onclick="loadConfig()">重新读取 config.json</button></div><div class="table"><div class="tr provider head"><div class="td">上游标识 / 类型</div><div class="td">Base URL</div><div class="td">API Key</div><div class="td">状态</div><div class="td">操作</div></div>'+renderProviderRows()+'</div></section><section class="panel"><h2>新增 / 编辑上游</h2><p>上游标识同名保存就是覆盖。API Key 留空会保留旧 key，不会清空。</p><div class="input-row"><label class="field"><span>上游标识，例如 flash、kling、jimeng</span><input id="providerName" value="flash" autocomplete="off"></label><label class="field"><span>协议类型</span><select id="providerType"><option value="flash-multipart">flash-multipart（当前已实现）</option><option value="openai-json">openai-json（先存配置）</option><option value="openai-multipart">openai-multipart（先存配置）</option><option value="custom-json">custom-json（先存配置）</option></select></label></div><label class="field"><span>Base URL，例如 https://flash.duoyuanx.net</span><input id="providerBaseUrl" value="'+escapeHtml(currentConfig.flashBaseUrl)+'" autocomplete="off"></label><label class="field"><span>上游 API Key</span><input id="providerApiKey" type="password" placeholder="新增时填写；编辑旧上游时留空=不改旧 key"></label><label class="field"><span><input id="providerEnabled" type="checkbox" checked style="width:auto;margin-right:8px">启用这个上游</span></label><div class="actions"><button class="btn" onclick="saveProvider()">保存到 config.json 并热加载</button><button class="btn secondary" onclick="newProviderForm()">清空表单</button></div></section>';side.innerHTML='<section class="panel"><h2>手动增加上游</h2><p>1. 点“新增空白上游”。<br>2. 填上游标识。<br>3. 选协议类型。<br>4. 填 Base URL 和 API Key。<br>5. 点保存。<br>6. 去“模型映射”把某个 SKU 绑定到这个上游。</p></section><section class="panel"><h2>当前事实</h2><p>现在只有 flash-multipart 真能发视频请求。其它协议类型先允许保存，后续接每家上游时，再补对应请求函数。</p></section>'+configPreview();return}
if(currentPage==='models'){main.innerHTML='<section class="panel"><h2>模型映射</h2><p>这里是真映射。New API 给用户看的模型 SKU，在这里绑定到上游真实模型，并固定 seconds。</p><div class="actions" style="margin-bottom:12px"><button class="btn secondary" onclick="newModelForm()">新增空白模型</button><button class="btn secondary" onclick="loadConfig()">重新读取 config.json</button></div>'+renderModelRows()+'</section><section class="panel"><h2>新增 / 编辑模型映射</h2><p>模型 SKU 同名保存就是覆盖。保存后立即生效，用户传 seconds 也会被这里固定值覆盖。</p><label class="field"><span>New API 模型 SKU，必须和模型广场展示名一致</span><input id="modelSku" value="seedance-1.5-pro-1080p-5s" autocomplete="off"></label><div class="input-row"><label class="field"><span>绑定上游</span><select id="modelProvider">'+providerOptions('flash')+'</select></label><label class="field"><span>上游真实模型名</span><input id="modelUpstream" value="doubao-seedance-1-5-pro_1080p" autocomplete="off"></label></div><div class="input-row"><label class="field"><span>固定 seconds，用于按次计费</span><input id="modelSeconds" value="5" inputmode="decimal"></label><label class="field"><span>固定 size</span><input id="modelSize" value="4:3"></label></div><label class="field"><span><input id="modelEnabled" type="checkbox" checked style="width:auto;margin-right:8px">启用这个模型</span></label><div class="actions"><button class="btn" onclick="saveModel()">保存到 config.json 并热加载</button><button class="btn secondary" onclick="newModelForm()">清空表单</button></div></section>';side.innerHTML='<section class="panel"><h2>手动增加模型</h2><p>1. New API 里先决定展示 SKU，例如 xxx-5s。<br>2. 这里填同名 SKU。<br>3. 选择上游 provider。<br>4. 填上游真实模型名。<br>5. 写死 seconds。<br>6. 点保存。<br>7. New API 渠道模型映射保持空。</p></section><section class="panel"><h2>计费逻辑</h2><div class="guard"><b>按次价格</b>如果上游 0.637 / 秒，5s SKU 在 New API 按次填 3.185，10s SKU 填 6.37。Adapter 只负责固定 seconds。</div></section>'+configPreview();return}
if(currentPage==='security'){main.innerHTML='<section class="panel"><h2>安全密钥</h2><div class="table"><div class="tr security head"><div class="td">项目</div><div class="td">当前状态</div><div class="td">操作</div></div><div class="tr security"><div class="td">admin token</div><div class="td">'+(currentConfig.hasAdminToken?'已配置。用于登录这个后台。':'未配置')+'</div><div class="td"><span class="pill gray">只读</span></div></div><div class="tr security"><div class="td">Adapter 内部密钥</div><div class="td">'+currentConfig.adapterTokenCount+' 个。填到 New API 渠道 API 密钥。</div><div class="td"><button class="btn secondary" onclick="generateToken()">生成</button></div></div><div class="tr security"><div class="td">密钥存储</div><div class="td">当前 P0 明文；P1 改 hash，只生成时显示一次。</div><div class="td"><span class="pill warn">待开发</span></div></div></div></section><section class="panel"><h2>Adapter 内部密钥</h2><label class="field"><span>当前 token</span><input id="adapterToken" type="password" value="'+escapeHtml((currentConfig.adapterTokens||[])[0]||'')+'" placeholder="生成后填入 New API 渠道"></label><div class="actions"><button class="btn secondary" onclick="generateToken()">生成新密钥</button><button class="btn" onclick="saveConfig()">保存密钥</button></div></section>';side.innerHTML='<section class="panel"><h2>安全边界</h2><p>客户只访问 api.yiyong.me。Flash 上游 key 只在 adapter config。Adapter 内部密钥只给 New API 渠道。</p></section>';return}
if(currentPage==='tests'){main.innerHTML='<section class="panel"><h2>真实 /v1/videos 测试</h2><p>New API 自带渠道测试没有视频端点。这里直接调用 adapter 的 /admin/test，创建真实视频任务。</p><label class="field"><span>模型 SKU</span><input id="testModel" value="seedance-1.5-pro-1080p-5s"></label><label class="field"><span>提示词</span><textarea id="testPrompt">测试视频，一只猫在雨天窗边轻轻点头</textarea></label><div class="actions"><button class="btn" onclick="testModel()">创建任务</button><button class="btn secondary" onclick="todo(\\'查询任务状态\\')">查询状态</button></div></section><section class="panel"><h2>10s 验证状态</h2><p>10s 请求已打到上游。之前失败原因是上游余额不足：insufficient_user_quota。</p><span class="pill warn">充值后复测</span></section>';side.innerHTML='<section class="panel"><h2>测试结果</h2><pre id="message">等待操作</pre></section>';return}
main.innerHTML='<section class="panel"><h2>配置备份</h2><div class="table"><div class="tr backup head"><div class="td">文件</div><div class="td">说明</div><div class="td">操作</div></div><div class="tr backup"><div class="td"><code>config-YYYYMMDD-HHMMSS.json</code></div><div class="td">P1 保存前自动备份旧 config。</div><div class="td"><span class="pill warn">待开发</span></div></div><div class="tr backup"><div class="td"><code>server.js.bak.*</code></div><div class="td">每次部署代码前手动备份。</div><div class="td"><span class="pill gray">可手动回滚</span></div></div></div></section><section class="panel"><h2>回滚说明</h2><p>P0 代码回滚需要替换 server.js 后重启 Docker。P1 配置回滚会走后台恢复并自动重载。</p></section>';side.innerHTML='<section class="panel"><h2>当前备份路径</h2><pre>/opt/uclaw-video-adapter/server.js.bak.*\\n/opt/uclaw-video-adapter/backups/config-*.json</pre></section>'}
document.querySelectorAll('[data-page]').forEach(function(button){button.addEventListener('click',function(){setPage(button.dataset.page)})});
showAuth();
</script></body></html>`;
}

function generateToken() {
  return `uclaw_va_${crypto.randomBytes(24).toString('base64url')}`;
}

function normalizeProviderInput(body) {
  const name = String(body.name || '').trim();
  const baseUrl = normalizeBaseUrl(body.baseUrl);
  const type = String(body.type || 'flash-multipart').trim();
  if (!name) throw Object.assign(new Error('Provider name is required'), { statusCode: 400 });
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw Object.assign(new Error('Provider name only allows letters, numbers, underscore and dash'), { statusCode: 400 });
  if (!/^https?:\/\//i.test(baseUrl)) throw Object.assign(new Error('Provider baseUrl must start with http:// or https://'), { statusCode: 400 });
  if (!['flash-multipart', 'openai-json', 'openai-multipart', 'custom-json'].includes(type)) {
    throw Object.assign(new Error(`Unsupported provider type: ${type}`), { statusCode: 400 });
  }
  return {
    name,
    provider: {
      type,
      baseUrl,
      ...(body.apiKey ? { apiKey: String(body.apiKey).trim() } : {}),
      enabled: body.enabled !== false,
    },
  };
}

function normalizeModelInput(body, config) {
  const sku = String(body.sku || '').trim();
  const provider = String(body.provider || '').trim();
  const upstreamModel = String(body.upstreamModel || '').trim();
  const seconds = String(body.seconds || body.fixedParams?.seconds || '').trim();
  const size = String(body.size || body.fixedParams?.size || '4:3').trim();
  if (!sku) throw Object.assign(new Error('Model SKU is required'), { statusCode: 400 });
  if (!provider || !config.providers[provider]) throw Object.assign(new Error(`Provider not found: ${provider || '(empty)'}`), { statusCode: 400 });
  if (!upstreamModel) throw Object.assign(new Error('Upstream model is required'), { statusCode: 400 });
  if (!/^\d+(\.\d+)?$/.test(seconds) || Number(seconds) <= 0) {
    throw Object.assign(new Error('seconds must be a positive number'), { statusCode: 400 });
  }
  return {
    sku,
    model: {
      provider,
      upstreamModel,
      seconds,
      size,
      enabled: body.enabled !== false,
    },
  };
}

async function handleAdmin(req, res, url, getConfig, reloadConfig) {
  const config = getConfig();
  if (req.method === 'GET' && url.pathname === '/admin') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html());
    return;
  }
  if (!validateAdminToken(req, url, config)) {
    sendJson(res, 401, { error: { message: 'Invalid admin token' } });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/admin/config') {
    sendJson(res, 200, { ...publicConfig(config), adapterTokens: config.adapterTokens });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/admin/generate-token') {
    const token = generateToken();
    const nextConfig = {
      ...config.fileConfig,
      security: {
        ...(config.fileConfig.security || {}),
        adapterTokens: [token],
      },
    };
    writeConfig(config.configPath, nextConfig);
    reloadConfig();
    sendJson(res, 200, { ok: true, token });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/admin/provider') {
    const body = await readFlexibleBody(req);
    const { name, provider } = normalizeProviderInput(body);
    const oldProvider = config.fileConfig.providers?.[name] || {};
    const nextConfig = {
      ...config.fileConfig,
      providers: {
        ...(config.fileConfig.providers || {}),
        [name]: {
          ...oldProvider,
          ...provider,
          apiKey: provider.apiKey || oldProvider.apiKey || '',
        },
      },
      models: {
        ...DEFAULT_MODELS,
        ...(config.fileConfig.models || {}),
      },
    };
    writeConfig(config.configPath, nextConfig);
    reloadConfig();
    sendJson(res, 200, { ok: true, config: publicConfig(getConfig()) });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/admin/model') {
    const body = await readFlexibleBody(req);
    const { sku, model } = normalizeModelInput(body, config);
    const nextConfig = {
      ...config.fileConfig,
      providers: config.fileConfig.providers || {},
      models: {
        ...DEFAULT_MODELS,
        ...(config.fileConfig.models || {}),
        [sku]: model,
      },
    };
    writeConfig(config.configPath, nextConfig);
    reloadConfig();
    sendJson(res, 200, { ok: true, config: publicConfig(getConfig()) });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/admin/config') {
    const body = await readFlexibleBody(req);
    const nextConfig = {
      ...config.fileConfig,
      providers: {
        ...(config.fileConfig.providers || {}),
        flash: {
          ...(config.providers.flash || {}),
          ...(body.flashBaseUrl ? { baseUrl: body.flashBaseUrl } : {}),
          ...(body.flashApiKey ? { apiKey: body.flashApiKey } : {}),
        },
      },
      security: {
        ...(config.fileConfig.security || {}),
        ...(body.adapterToken ? { adapterTokens: [body.adapterToken] } : {}),
      },
      models: {
        ...DEFAULT_MODELS,
        ...(config.fileConfig.models || {}),
      },
    };
    writeConfig(config.configPath, nextConfig);
    reloadConfig();
    sendJson(res, 200, { ok: true, config: publicConfig(getConfig()) });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/admin/test') {
    const body = await readFlexibleBody(req);
    const { response, payload } = await createVideo(body, config);
    sendJson(res, response.status, payload);
    return;
  }
  sendJson(res, 404, { error: { message: `Admin route not found: ${req.method} ${url.pathname}` } });
}

function normalizeAdapterPath(pathname) {
  return pathname
    .replace(/^\/openai\/v1(?=\/|$)/, '/v1')
    .replace(/^\/videos(?=\/|$)/, '/v1/videos');
}

function isNewApiXaiCompatRequest(req) {
  return String(req.headers['x-uclaw-newapi-compat'] || '').trim() === '1';
}

function createServer(options = {}) {
  let config = createConfig(options);
  const getConfig = () => config;
  const reloadConfig = () => {
    config = createConfig(options);
    return config;
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      const videoPath = normalizeAdapterPath(url.pathname);
      const statusMatch = videoPath.match(/^\/v1\/videos\/([^/]+)$/);

      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
        await handleAdmin(req, res, url, getConfig, reloadConfig);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, {
          ok: true,
          ...publicConfig(getConfig()),
          routes: ['/v1/videos', '/v1/videos/generations', '/openai/v1/videos', '/openai/v1/videos/generations', '/videos/generations', '/admin'],
        });
        return;
      }

      if (isNewApiXaiCompatRequest(req) && await handleNewApiXaiCompat(req, res, videoPath, getConfig())) {
        return;
      }

      if (req.method === 'POST' && videoPath === '/v1/videos') {
        if (!validateAdapterToken(req, getConfig())) {
          sendJson(res, 401, { error: { message: 'Invalid video adapter token' } });
          return;
        }
        const body = await readFlexibleBody(req);
        const { response, payload } = await createVideo(body, getConfig());
        sendJson(res, response.status, payload);
        return;
      }

      if (req.method === 'POST' && videoPath === '/v1/videos/generations') {
        if (!validateAdapterToken(req, getConfig())) {
          sendJson(res, 401, { error: { message: 'Invalid video adapter token' } });
          return;
        }
        const body = await readFlexibleBody(req);
        const { response, payload } = await createVideo(body, getConfig(), { protocol: 'xai' });
        sendJson(res, response.status, payload);
        return;
      }

      if (req.method === 'GET' && statusMatch) {
        if (!validateAdapterToken(req, getConfig())) {
          sendJson(res, 401, { error: { message: 'Invalid video adapter token' } });
          return;
        }
        const taskId = decodeURIComponent(statusMatch[1]);
        const { response, payload } = await queryVideo(taskId, getConfig());
        sendJson(res, response.status, findTaskProtocol(getConfig(), taskId) === 'xai' && response.ok ? mapXaiStatusResponse(payload, taskId, getConfig()) : payload);
        return;
      }

      sendJson(res, 404, { error: { message: `Route not found: ${req.method} ${url.pathname}` } });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: { message: error.message || String(error) } });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 18808);
  const host = process.env.HOST || '127.0.0.1';
  createServer().listen(port, host, () => {
    console.log(`U-Claw server video adapter listening on http://${host}:${port}`);
  });
}

module.exports = {
  createServer,
  createConfig,
  DEFAULT_MODELS,
};
