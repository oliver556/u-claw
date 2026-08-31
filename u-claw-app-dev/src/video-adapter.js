const crypto = require('crypto');
const http = require('http');

const DEFAULT_FLASH_BASE_URL = 'https://flash.duoyuanx.net/v1';
const DEFAULT_VOLCENGINE_BASE_URL = 'https://visual.volcengineapi.com';
const DEFAULT_VIDEO_MODEL = 'jimeng-video-3-720p';
const DEFAULT_SECONDS = 15;
const DEFAULT_ASPECT_RATIO = '16:9';
const DEFAULT_SIZE = '720P';
const JSON_LIMIT_BYTES = 8 * 1024 * 1024;
const VOLCENGINE_REGION = 'cn-north-1';
const VOLCENGINE_SERVICE = 'cv';
const VOLCENGINE_API_VERSION = '2024-06-06';
const VOLCENGINE_TASK_PROFILES = new Map();

const DEFAULT_MODEL_PROFILES = {
  'jimeng-video-3-720p': {
    provider: 'volcengine',
    reqKey: 'jimeng_t2v_v30',
    submitAction: 'JimengT2VV30SubmitTask',
    getAction: 'JimengT2VV30GetResult',
    version: VOLCENGINE_API_VERSION,
    defaults: { frames: 241, aspect_ratio: DEFAULT_ASPECT_RATIO, seed: -1 },
    aliases: { duration: 'seconds', durationSeconds: 'seconds', aspectRatio: 'aspect_ratio' },
  },
  'jimeng-video-3-1080p': {
    provider: 'volcengine',
    reqKey: 'jimeng_t2v_v30_1080p',
    submitAction: 'JimengT2VV301080PSubmitTask',
    getAction: 'JimengT2VV301080PGetResult',
    version: VOLCENGINE_API_VERSION,
    defaults: { frames: 241, aspect_ratio: DEFAULT_ASPECT_RATIO, seed: -1 },
    aliases: { duration: 'seconds', durationSeconds: 'seconds', aspectRatio: 'aspect_ratio' },
  },
  'jimeng-video-3-pro': {
    provider: 'volcengine',
    reqKey: 'jimeng_ti2v_v30_pro',
    submitAction: 'JimengTI2VV30PROSubmitTask',
    getAction: 'JimengTI2VV30PROGetResult',
    version: VOLCENGINE_API_VERSION,
    defaults: { frames: 241, aspect_ratio: DEFAULT_ASPECT_RATIO, seed: -1 },
    aliases: { duration: 'seconds', durationSeconds: 'seconds', aspectRatio: 'aspect_ratio' },
  },
  'grok-video-3': {
    upstreamModel: 'grok-video-3',
    bodyType: 'multipart',
    defaults: { seconds: 6, size: DEFAULT_SIZE, aspect_ratio: DEFAULT_ASPECT_RATIO },
    aliases: { duration: 'seconds', durationSeconds: 'seconds', aspectRatio: 'aspect_ratio', resolution: 'size' },
    fileFields: ['input_reference'],
  },
  'grok-video-3-10s': {
    upstreamModel: 'grok-video-3-10s',
    bodyType: 'multipart',
    defaults: { seconds: 10, size: DEFAULT_SIZE, aspect_ratio: DEFAULT_ASPECT_RATIO },
    aliases: { duration: 'seconds', durationSeconds: 'seconds', aspectRatio: 'aspect_ratio', resolution: 'size' },
    fileFields: ['input_reference'],
  },
  'grok-video-3-15s': {
    upstreamModel: 'grok-video-3-15s',
    bodyType: 'multipart',
    defaults: { seconds: DEFAULT_SECONDS, size: DEFAULT_SIZE, aspect_ratio: DEFAULT_ASPECT_RATIO },
    aliases: { duration: 'seconds', durationSeconds: 'seconds', aspectRatio: 'aspect_ratio', resolution: 'size' },
    fileFields: ['input_reference'],
  },
  'grok-video-3-pro': {
    upstreamModel: 'grok-video-3-pro',
    bodyType: 'multipart',
    defaults: { seconds: 10, size: DEFAULT_SIZE, aspect_ratio: DEFAULT_ASPECT_RATIO },
    aliases: { duration: 'seconds', durationSeconds: 'seconds', aspectRatio: 'aspect_ratio', resolution: 'size' },
    fileFields: ['input_reference'],
  },
  'grok-video-3-max': {
    upstreamModel: 'grok-video-3-max',
    bodyType: 'multipart',
    defaults: { seconds: DEFAULT_SECONDS, size: DEFAULT_SIZE, aspect_ratio: DEFAULT_ASPECT_RATIO },
    aliases: { duration: 'seconds', durationSeconds: 'seconds', aspectRatio: 'aspect_ratio', resolution: 'size' },
    fileFields: ['input_reference'],
  },
  'grok-imagine-video': {
    upstreamModel: 'grok-imagine-video',
    bodyType: 'json',
    defaults: { seconds: '6', resolution: '720P', aspect_ratio: DEFAULT_ASPECT_RATIO },
    aliases: { duration: 'seconds', durationSeconds: 'seconds', aspectRatio: 'aspect_ratio', size: 'resolution' },
  },
  'grok-imagine-video-1.5-preview': {
    upstreamModel: 'grok-imagine-video-1.5-preview',
    bodyType: 'json',
    defaults: { seconds: '6', resolution: '720P', aspect_ratio: DEFAULT_ASPECT_RATIO },
    aliases: { duration: 'seconds', durationSeconds: 'seconds', aspectRatio: 'aspect_ratio', size: 'resolution' },
  },
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function normalizeBaseUrl(value, fallback = DEFAULT_FLASH_BASE_URL) {
  const trimmed = String(value || fallback).trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function bearerToken(headerValue) {
  const match = String(headerValue || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function normalizeSize(value, fallback = DEFAULT_SIZE) {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = String(value).trim();
  const match = raw.match(/^(\d+)\s*p$/i);
  return match ? `${match[1]}P` : raw;
}

function asPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function parseJsonConfig(value, fallback) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function mergeModelProfiles(customProfiles) {
  return {
    ...DEFAULT_MODEL_PROFILES,
    ...(customProfiles || {}),
  };
}

function createAdapterConfig(options = {}) {
  const modelProfiles = mergeModelProfiles(parseJsonConfig(
    options.modelProfilesJson || process.env.UCLAW_VIDEO_MODEL_PROFILES,
    options.modelProfiles,
  ));

  return {
    flashBaseUrl: normalizeBaseUrl(options.flashBaseUrl || process.env.UCLAW_FLASH_BASE_URL || process.env.UCLAW_VIDEO_UPSTREAM_BASE_URL),
    flashApiKey: options.flashApiKey || process.env.UCLAW_FLASH_API_KEY || '',
    newApiBaseUrl: options.newApiBaseUrl || process.env.UCLAW_NEW_API_BASE_URL || '',
    newApiKey: options.newApiKey || process.env.UCLAW_NEW_API_KEY || '',
    videoProvider: options.videoProvider || process.env.UCLAW_VIDEO_PROVIDER || '',
    volcengineBaseUrl: normalizeBaseUrl(
      options.volcengineBaseUrl || process.env.UCLAW_VOLCENGINE_BASE_URL || DEFAULT_VOLCENGINE_BASE_URL,
      DEFAULT_VOLCENGINE_BASE_URL,
    ).replace(/\/v1$/, ''),
    volcengineAccessKeyId: options.volcengineAccessKeyId || process.env.VOLC_ACCESS_KEY_ID || process.env.UCLAW_VOLCENGINE_ACCESS_KEY_ID || '',
    volcengineSecretAccessKey: options.volcengineSecretAccessKey || process.env.VOLC_SECRET_ACCESS_KEY || process.env.UCLAW_VOLCENGINE_SECRET_ACCESS_KEY || '',
    volcengineRegion: options.volcengineRegion || process.env.UCLAW_VOLCENGINE_REGION || VOLCENGINE_REGION,
    volcengineService: options.volcengineService || process.env.UCLAW_VOLCENGINE_SERVICE || VOLCENGINE_SERVICE,
    defaultModel: options.defaultModel || process.env.UCLAW_VIDEO_MODEL || process.env.UCLAW_VIDEO_UPSTREAM_MODEL || DEFAULT_VIDEO_MODEL,
    defaultSeconds: asPositiveNumber(options.seconds || process.env.UCLAW_VIDEO_SECONDS, DEFAULT_SECONDS),
    defaultAspectRatio: options.aspectRatio || process.env.UCLAW_VIDEO_ASPECT_RATIO || DEFAULT_ASPECT_RATIO,
    defaultSize: normalizeSize(options.size || process.env.UCLAW_VIDEO_SIZE, DEFAULT_SIZE),
    modelProfiles,
  };
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

async function readJsonBody(req) {
  const raw = await readRequestBody(req);
  if (!raw.length || !raw.toString('utf8').trim()) return {};
  return JSON.parse(raw.toString('utf8'));
}

function parseMultipartFields(raw, contentType) {
  const boundaryMatch = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new Error('Missing multipart boundary');
  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const text = raw.toString('utf8');
  const fields = {};
  for (const part of text.split(`--${boundary}`)) {
    if (!part || part === '--\r\n' || part === '--') continue;
    const separator = part.indexOf('\r\n\r\n');
    if (separator === -1) continue;
    const headerText = part.slice(0, separator);
    let value = part.slice(separator + 4);
    value = value.replace(/\r\n--$/, '').replace(/\r\n$/, '');
    const nameMatch = headerText.match(/content-disposition:[^\r\n]*\bname="([^"]+)"/i);
    const filenameMatch = headerText.match(/content-disposition:[^\r\n]*\bfilename="/i);
    if (!nameMatch || filenameMatch) continue;
    const name = nameMatch[1];
    if (fields[name] === undefined) {
      fields[name] = value;
    } else if (Array.isArray(fields[name])) {
      fields[name].push(value);
    } else {
      fields[name] = [fields[name], value];
    }
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

function chooseProfile(config, model) {
  const requestedModel = model || config.defaultModel;
  return {
    ...(config.modelProfiles[requestedModel] || config.modelProfiles[config.defaultModel] || {}),
    requestedModel,
  };
}

function applyAliases(body, aliases = {}) {
  const mapped = { ...body };
  for (const [from, to] of Object.entries(aliases)) {
    if (mapped[from] !== undefined && mapped[to] === undefined) {
      mapped[to] = mapped[from];
    }
    if (mapped[from] !== undefined && from !== to) {
      delete mapped[from];
    }
  }
  return mapped;
}

function applyDefaults(body, defaults = {}) {
  const mapped = { ...body };
  for (const [key, value] of Object.entries(defaults)) {
    if (mapped[key] === undefined || mapped[key] === null || mapped[key] === '') {
      mapped[key] = value;
    }
  }
  return mapped;
}

function mapXaiCreateRequest(body, config) {
  const profile = chooseProfile(config, body.model);
  const genericDefaults = profile.bodyType === 'json'
    ? { seconds: String(config.defaultSeconds), aspect_ratio: config.defaultAspectRatio }
    : { seconds: config.defaultSeconds, size: config.defaultSize, aspect_ratio: config.defaultAspectRatio };
  const mapped = applyDefaults(applyAliases(body, profile.aliases), {
    ...genericDefaults,
    seconds: config.defaultSeconds,
    ...(profile.defaults || {}),
  });

  mapped.model = profile.upstreamModel || body.model || config.defaultModel;
  if (mapped.size !== undefined) mapped.size = normalizeSize(mapped.size, config.defaultSize);
  if (mapped.resolution !== undefined) mapped.resolution = normalizeSize(mapped.resolution, '720P');

  return { body: mapped, profile };
}

function addFormField(form, key, value) {
  if (value === undefined || value === null || value === '') return;
  if (Array.isArray(value)) {
    for (const item of value) addFormField(form, key, item);
    return;
  }
  if (typeof value === 'object' && !(value instanceof Blob)) {
    form.append(key, JSON.stringify(value));
    return;
  }
  form.append(key, String(value));
}

function dataUrlToBlob(value) {
  const match = String(value || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) return null;
  const mimeType = match[1] || 'application/octet-stream';
  const buffer = match[2] ? Buffer.from(match[3] || '', 'base64') : Buffer.from(decodeURIComponent(match[3] || ''), 'utf8');
  return new Blob([buffer], { type: mimeType });
}

async function appendFileLike(form, field, value, index) {
  if (!value) return;
  const source = typeof value === 'string' ? value : value.url || value.data || value.base64;
  if (!source) return;

  const dataBlob = dataUrlToBlob(source);
  if (dataBlob) {
    form.append(field, dataBlob, `${field}-${index + 1}.png`);
    return;
  }

  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Fetch ${field} failed: ${response.status}`);
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const blob = new Blob([await response.arrayBuffer()], { type: contentType });
    form.append(field, blob, `${field}-${index + 1}`);
    return;
  }

  addFormField(form, field, source);
}

async function buildUpstreamBody(mappedBody, profile) {
  if (profile.bodyType === 'json') {
    return {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mappedBody),
    };
  }

  const form = new FormData();
  const fileFields = new Set(profile.fileFields || ['input_reference']);
  const aliasesToFiles = {
    image: 'input_reference',
    images: 'input_reference',
    reference_image: 'input_reference',
    reference_images: 'input_reference',
  };

  for (const [key, value] of Object.entries(mappedBody)) {
    const fileField = fileFields.has(key) ? key : aliasesToFiles[key];
    if (fileField) {
      const values = Array.isArray(value) ? value : [value];
      for (let index = 0; index < values.length; index += 1) {
        await appendFileLike(form, fileField, values[index], index);
      }
      continue;
    }
    addFormField(form, key, value);
  }

  return { headers: {}, body: form };
}

async function upstreamJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: { message: text || 'Malformed upstream response' } };
  }
  return { response, payload };
}

function resolveFlashKey(config, req) {
  return bearerToken(req.headers.authorization) || config.flashApiKey;
}

function resolveNewApiKey(config, req) {
  const requestKey = bearerToken(req.headers.authorization);
  if (requestKey && requestKey !== 'uclaw-video-adapter') return requestKey;
  return config.newApiKey;
}

function getVideoUrl(payload) {
  return payload?.output?.url
    || payload.video_url
    || payload.url
    || payload?.detail?.url
    || payload?.metadata?.url
    || payload?.video?.url
    || '';
}

function normalizeOpenAiStatus(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'completed' || normalized === 'succeeded' || normalized === 'success' || normalized === 'done') return 'completed';
  if (normalized === 'failed' || normalized === 'error' || normalized === 'expired') return 'failed';
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
  if (normalized === 'queued') return 'queued';
  return 'processing';
}

function normalizeXaiStatus(status) {
  const normalized = normalizeOpenAiStatus(status);
  if (normalized === 'completed') return 'done';
  if (normalized === 'processing') return 'in_progress';
  return normalized;
}

function normalizeProgress(payload, status) {
  if (Number.isFinite(Number(payload.progress))) return Number(payload.progress);
  if (status === 'completed' || status === 'done') return 100;
  if (status === 'processing' || status === 'in_progress' || status === 'generating') return 50;
  return 0;
}

function normalizeVolcengineStatus(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'done') return 'completed';
  if (normalized === 'in_queue') return 'queued';
  if (normalized === 'generating') return 'processing';
  if (normalized === 'not_found' || normalized === 'expired') return 'failed';
  return normalizeOpenAiStatus(status);
}

function mapOpenAiStatusResponse(payload) {
  const status = normalizeOpenAiStatus(payload.status);
  const videoUrl = getVideoUrl(payload);
  return {
    ...payload,
    id: payload.task_id || payload.request_id || payload.id,
    object: payload.object || 'video',
    status,
    progress: normalizeProgress(payload, status),
    video_url: videoUrl,
    metadata: {
      ...(payload.metadata || {}),
      ...(videoUrl ? { url: videoUrl } : {}),
    },
  };
}

function mapVolcengineOpenAiCreateResponse(payload) {
  return {
    id: payload.id || payload.task_id || payload.request_id,
    task_id: payload.task_id || payload.id || payload.request_id,
    object: 'video',
    model: payload.model || DEFAULT_VIDEO_MODEL,
    status: normalizeOpenAiStatus(payload.status),
    progress: normalizeProgress(payload, payload.status),
    created_at: payload.created_at || Math.floor(Date.now() / 1000),
    metadata: payload.metadata || {},
  };
}

function mapVolcengineOpenAiStatusResponse(payload) {
  const status = normalizeOpenAiStatus(payload.status);
  const videoUrl = getVideoUrl(payload) || payload.video_url || payload?.metadata?.url || '';
  return {
    id: payload.id || payload.task_id || payload.request_id,
    task_id: payload.task_id || payload.id || payload.request_id,
    object: 'video',
    model: payload.model || DEFAULT_VIDEO_MODEL,
    status,
    progress: normalizeProgress(payload, status),
    video_url: videoUrl,
    metadata: {
      ...(payload.metadata || {}),
      ...(videoUrl ? { url: videoUrl } : {}),
    },
    error: payload.error || null,
  };
}

function mapXaiCreateResponse(payload) {
  const requestId = payload.task_id || payload.request_id || payload.id;
  return {
    request_id: requestId,
    id: requestId,
    status: normalizeXaiStatus(payload.status),
    progress: normalizeProgress(payload, payload.status),
    created_at: payload.created_at,
    model: payload.model || DEFAULT_VIDEO_MODEL,
  };
}

function mapXaiStatusResponse(payload) {
  const status = normalizeXaiStatus(payload.status);
  const requestId = payload.task_id || payload.request_id || payload.id;
  const videoUrl = getVideoUrl(payload);
  return {
    request_id: requestId,
    id: requestId,
    status,
    progress: normalizeProgress(payload, status),
    created_at: payload.created_at,
    completed_at: payload.completed_at,
    expires_at: payload.expires_at,
    model: payload.model || DEFAULT_VIDEO_MODEL,
    video: videoUrl ? { url: videoUrl } : null,
    error: payload.error || null,
  };
}

function mapVolcengineCreateResponse(payload, profile) {
  const taskId = payload?.data?.task_id || payload.task_id || payload.request_id || payload.id;
  if (taskId) VOLCENGINE_TASK_PROFILES.set(taskId, profile);
  return {
    task_id: taskId,
    id: taskId,
    status: 'queued',
    progress: 0,
    created_at: Math.floor(Date.now() / 1000),
    model: profile.requestedModel || DEFAULT_VIDEO_MODEL,
    request_id: payload.request_id,
    upstream: payload,
  };
}

function mapVolcengineStatusResponse(payload, profile, taskId) {
  const status = normalizeVolcengineStatus(payload?.data?.status || payload.status);
  const videoUrl = payload?.data?.video_url || payload.video_url || '';
  return {
    task_id: taskId,
    id: taskId,
    status,
    progress: normalizeProgress(payload?.data || {}, status),
    model: profile?.requestedModel || DEFAULT_VIDEO_MODEL,
    video_url: videoUrl,
    metadata: videoUrl ? { url: videoUrl } : {},
    upstream: payload,
  };
}

function secondsToJimengFrames(value) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds <= 5) return 121;
  return 241;
}

function mapVolcengineCreateBody(body, config) {
  const profile = chooseProfile(config, body.model);
  const mapped = applyDefaults(applyAliases(body, profile.aliases), {
    aspect_ratio: config.defaultAspectRatio,
    seconds: config.defaultSeconds,
    ...(profile.defaults || {}),
  });

  if (mapped.frames === undefined) mapped.frames = secondsToJimengFrames(mapped.seconds);
  delete mapped.seconds;
  delete mapped.model;
  delete mapped.size;
  delete mapped.resolution;

  return {
    body: {
      req_key: profile.reqKey,
      prompt: mapped.prompt,
      seed: Number.isFinite(Number(mapped.seed)) ? Number(mapped.seed) : -1,
      frames: Number(mapped.frames),
      aspect_ratio: mapped.aspect_ratio || config.defaultAspectRatio,
    },
    profile,
  };
}

function isVolcengineProfile(config, model) {
  const profile = chooseProfile(config, model);
  return config.videoProvider === 'volcengine' || profile.provider === 'volcengine';
}

function requireVolcengineCredentials(config) {
  if (!config.volcengineAccessKeyId || !config.volcengineSecretAccessKey) {
    throw new Error('Video adapter missing Volcengine AK/SK: set VOLC_ACCESS_KEY_ID and VOLC_SECRET_ACCESS_KEY');
  }
}

function hashHex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function encodeQueryPart(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildCanonicalQuery(params) {
  return Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeQueryPart(key)}=${encodeQueryPart(String(value))}`)
    .join('&');
}

function signVolcengineRequest(config, action, version, payloadText) {
  const now = new Date();
  const xDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const shortDate = xDate.slice(0, 8);
  const url = new URL(config.volcengineBaseUrl);
  const method = 'POST';
  const canonicalUri = url.pathname && url.pathname !== '/' ? url.pathname : '/';
  const canonicalQuery = buildCanonicalQuery({ Action: action, Version: version });
  const payloadHash = hashHex(payloadText);
  const headers = {
    'content-type': 'application/json',
    host: url.host,
    'x-content-sha256': payloadHash,
    'x-date': xDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map(key => `${key}:${headers[key]}\n`)
    .join('');
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${shortDate}/${config.volcengineRegion}/${config.volcengineService}/request`;
  const stringToSign = [
    'HMAC-SHA256',
    xDate,
    credentialScope,
    hashHex(canonicalRequest),
  ].join('\n');
  const signingKey = hmac(
    hmac(
      hmac(
        hmac(config.volcengineSecretAccessKey, shortDate),
        config.volcengineRegion,
      ),
      config.volcengineService,
    ),
    'request',
  );
  const signature = hmac(signingKey, stringToSign, 'hex');
  return {
    url: `${url.origin}${canonicalUri}?${canonicalQuery}`,
    headers: {
      'Content-Type': 'application/json',
      Host: url.host,
      'X-Content-Sha256': payloadHash,
      'X-Date': xDate,
      Authorization: `HMAC-SHA256 Credential=${config.volcengineAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

async function postVolcengineAction(config, action, version, body) {
  requireVolcengineCredentials(config);
  const payloadText = JSON.stringify(body);
  const signed = signVolcengineRequest(config, action, version, payloadText);
  return upstreamJson(signed.url, {
    method: 'POST',
    headers: {
      ...signed.headers,
      Accept: 'application/json',
    },
    body: payloadText,
  });
}

function volcengineErrorResult(result) {
  const upstreamError = result.payload?.ResponseMetadata?.Error;
  const upstreamResult = result.payload?.Result || result.payload;
  const message = upstreamError?.Message || upstreamResult?.message || 'Volcengine video task failed';
  return {
    response: { ok: false, status: result.response.status >= 400 ? result.response.status : 502 },
    payload: {
      error: {
        message,
        code: upstreamError?.Code || upstreamResult?.code || '',
        type: 'volcengine_api_error',
      },
      upstream: result.payload,
    },
  };
}

function copyProxyHeaders(req, extra = {}) {
  const headers = { ...req.headers, ...extra };
  delete headers.host;
  delete headers.authorization;
  delete headers['content-length'];
  return headers;
}

async function handleOpenAiProxy(req, res, url, config) {
  const path = url.pathname.replace(/^\/openai\/v1/, '/v1');
  const videoCreatePath = path === '/v1/videos';
  const videoStatusMatch = path.match(/^\/v1\/videos\/([^/]+)$/);

  if (req.method === 'POST' && videoCreatePath && config.videoProvider === 'volcengine') {
    const body = await readFlexibleBody(req);
    const { response, payload } = await createViaVolcengine(body, config);
    sendJson(res, response.status, response.ok ? mapVolcengineOpenAiCreateResponse(payload) : payload);
    return;
  }

  if (req.method === 'GET' && videoStatusMatch && config.videoProvider === 'volcengine') {
    const taskId = decodeURIComponent(videoStatusMatch[1]);
    const { response, payload } = await queryViaVolcengine(taskId, config);
    sendJson(res, response.status, response.ok ? mapVolcengineOpenAiStatusResponse(payload) : payload);
    return;
  }

  const upstreamUrl = `${config.flashBaseUrl}${path.replace(/^\/v1/, '')}${url.search}`;
  const apiKey = resolveFlashKey(config, req);
  if (!apiKey) {
    sendJson(res, 401, { error: { message: 'Video adapter missing Flash API key' } });
    return;
  }

  if (req.method === 'POST') {
    const raw = await readRequestBody(req);
    const { response, payload } = await upstreamJson(upstreamUrl, {
      method: req.method,
      headers: copyProxyHeaders(req, { Authorization: `Bearer ${apiKey}` }),
      body: raw,
    });
    sendJson(res, response.status, response.ok ? mapOpenAiStatusResponse(payload) : payload);
    return;
  }

  if (req.method === 'GET') {
    const { response, payload } = await upstreamJson(upstreamUrl, {
      method: req.method,
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    sendJson(res, response.status, response.ok ? mapOpenAiStatusResponse(payload) : payload);
    return;
  }

  sendJson(res, 405, { error: { message: `Unsupported method: ${req.method}` } });
}

async function createViaNewApi(body, config, apiKey) {
  const { body: mappedBody, profile } = mapXaiCreateRequest(body, config);
  const upstreamBody = await buildUpstreamBody(mappedBody, profile);
  return upstreamJson(`${normalizeBaseUrl(config.newApiBaseUrl)}/videos`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...upstreamBody.headers,
    },
    body: upstreamBody.body,
  });
}

async function createViaFlash(body, config, apiKey) {
  const { body: mappedBody, profile } = mapXaiCreateRequest(body, config);
  const upstreamBody = await buildUpstreamBody(mappedBody, profile);
  return upstreamJson(`${config.flashBaseUrl}/videos`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...upstreamBody.headers,
    },
    body: upstreamBody.body,
  });
}

async function createViaVolcengine(body, config) {
  const { body: mappedBody, profile } = mapVolcengineCreateBody(body, config);
  const result = await postVolcengineAction(config, profile.submitAction, profile.version || VOLCENGINE_API_VERSION, mappedBody);
  const upstreamResult = result.payload?.Result || result.payload;
  if (!result.response.ok || result.payload?.ResponseMetadata?.Error || upstreamResult?.code !== 10000) {
    return volcengineErrorResult(result);
  }
  result.payload = mapVolcengineCreateResponse(upstreamResult, profile);
  return result;
}

async function queryViaNewApi(taskId, config, apiKey) {
  return upstreamJson(`${normalizeBaseUrl(config.newApiBaseUrl)}/videos/${encodeURIComponent(taskId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
}

async function queryViaFlash(taskId, config, apiKey) {
  return upstreamJson(`${config.flashBaseUrl}/videos/${encodeURIComponent(taskId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
}

async function queryViaVolcengine(taskId, config) {
  const profile = VOLCENGINE_TASK_PROFILES.get(taskId)
    || chooseProfile(config, config.defaultModel);
  const body = {
    req_key: profile.reqKey,
    task_id: taskId,
  };
  const result = await postVolcengineAction(config, profile.getAction, profile.version || VOLCENGINE_API_VERSION, body);
  const upstreamResult = result.payload?.Result || result.payload;
  if (!result.response.ok || result.payload?.ResponseMetadata?.Error || upstreamResult?.code !== 10000) {
    return volcengineErrorResult(result);
  }
  result.payload = mapVolcengineStatusResponse(upstreamResult, profile, taskId);
  return result;
}

function mapXaiActionBody(body, config) {
  const profile = chooseProfile(config, body.model);
  const mapped = applyAliases(body, {
    aspectRatio: 'aspect_ratio',
    resolution: 'size',
  });
  if (!mapped.model) mapped.model = profile.upstreamModel || config.defaultModel;
  if (mapped.size !== undefined) mapped.size = normalizeSize(mapped.size, config.defaultSize);
  return mapped;
}

async function postJsonViaNewApi(path, body, config, apiKey) {
  return upstreamJson(`${normalizeBaseUrl(config.newApiBaseUrl)}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function postJsonViaFlash(path, body, config, apiKey) {
  return upstreamJson(`${config.flashBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function handleXai(req, res, url, config) {
  const createPath = url.pathname === '/v1/videos/generations'
    || url.pathname === '/xai/v1/videos/generations'
    || url.pathname === '/xai/v1/videos';

  if (req.method === 'POST' && createPath) {
    const body = await readJsonBody(req);
    const newApiKey = resolveNewApiKey(config, req);
    const flashKey = resolveFlashKey(config, req);
    const useVolcengine = config.videoProvider === 'volcengine'
      && isVolcengineProfile(config, body.model);
    const useNewApi = !useVolcengine && Boolean(config.newApiBaseUrl && newApiKey);

    if (!useVolcengine && !useNewApi && !flashKey) {
      sendJson(res, 401, { error: { message: 'Video adapter missing New API key or Flash API key' } });
      return;
    }

    const { response, payload } = useVolcengine
      ? await createViaVolcengine(body, config)
      : useNewApi
        ? await createViaNewApi(body, config, newApiKey)
        : await createViaFlash(body, config, flashKey);
    sendJson(res, response.status, response.ok ? mapXaiCreateResponse(payload) : payload);
    return;
  }

  const actionMatch = url.pathname.match(/^(?:\/xai)?\/v1(\/videos\/(?:[^/]+\/(?:remix|extend)|extensions))$/);
  if (req.method === 'POST' && actionMatch) {
    const body = mapXaiActionBody(await readJsonBody(req), config);
    const path = actionMatch[1];
    const newApiKey = resolveNewApiKey(config, req);
    const flashKey = resolveFlashKey(config, req);
    const useNewApi = Boolean(config.newApiBaseUrl && newApiKey);

    if (!useNewApi && !flashKey) {
      sendJson(res, 401, { error: { message: 'Video adapter missing New API key or Flash API key' } });
      return;
    }

    const { response, payload } = useNewApi
      ? await postJsonViaNewApi(path, body, config, newApiKey)
      : await postJsonViaFlash(path, body, config, flashKey);
    sendJson(res, response.status, response.ok ? mapXaiCreateResponse(payload) : payload);
    return;
  }

  const statusMatch = url.pathname.match(/^(?:\/xai)?\/v1\/videos\/([^/]+)$/);
  if (req.method === 'GET' && statusMatch) {
    const taskId = decodeURIComponent(statusMatch[1]);
    const newApiKey = resolveNewApiKey(config, req);
    const flashKey = resolveFlashKey(config, req);
    const useVolcengine = config.videoProvider === 'volcengine';
    const useNewApi = !useVolcengine && Boolean(config.newApiBaseUrl && newApiKey);

    if (!useVolcengine && !useNewApi && !flashKey) {
      sendJson(res, 401, { error: { message: 'Video adapter missing New API key or Flash API key' } });
      return;
    }

    const { response, payload } = useVolcengine
      ? await queryViaVolcengine(taskId, config)
      : useNewApi
        ? await queryViaNewApi(taskId, config, newApiKey)
        : await queryViaFlash(taskId, config, flashKey);
    sendJson(res, response.status, response.ok ? mapXaiStatusResponse(payload) : payload);
    return;
  }

  sendJson(res, 404, { error: { message: `Bavi-box video adapter route not found: ${req.method} ${url.pathname}` } });
}

function createVideoAdapterServer(options = {}) {
  const config = createAdapterConfig(options);

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, {
          ok: true,
          flashBaseUrl: config.flashBaseUrl,
          newApiBaseUrl: config.newApiBaseUrl || null,
          volcengineBaseUrl: config.volcengineBaseUrl,
          videoProvider: config.videoProvider || null,
          defaultModel: config.defaultModel,
          routes: ['/xai/v1', '/openai/v1', '/v1'],
        });
        return;
      }

      if (url.pathname.startsWith('/openai/v1/')) {
        await handleOpenAiProxy(req, res, url, config);
        return;
      }

      await handleXai(req, res, url, config);
    } catch (error) {
      sendJson(res, 500, { error: { message: error.message || String(error) } });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 18808);
  const host = process.env.HOST || '127.0.0.1';
  createVideoAdapterServer().listen(port, host, () => {
    console.log(`Bavi-box video adapter listening on http://${host}:${port}`);
  });
}

module.exports = {
  createVideoAdapterServer,
  createAdapterConfig,
  mapXaiCreateRequest,
  mapXaiCreateResponse,
  mapXaiStatusResponse,
  mapOpenAiStatusResponse,
  buildUpstreamBody,
  DEFAULT_MODEL_PROFILES,
};
