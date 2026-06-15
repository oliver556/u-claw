// Bug 上报客户端（便携版）
//
// 流程：
//   1. 算设备指纹 -> sk-uc- apiKey（用来在服务器侧关联同一台设备的多条上报）
//   2. 收集 openclaw 版本号、设备类型、系统信息、最近日志（gzip+base64）
//   3. POST 到 https://api.u-claw.org/recharge/bug/submit
//
// 设计原则（对齐 check-update.mjs）：
//   - 静默失败：上报失败只 console.error，绝不影响 OpenClaw 主流程
//   - 异步：调用方应 detach 跑（Windows-Start.bat 用 start /B），不阻塞启动
//   - 无第三方依赖：fetch + node:zlib 都是内置
//
// 两种用法：
//   手动（网页一键，由 config-server 转发）：import { submitBugReport } from './report-bug.mjs'
//   自动（崩溃）：node lib/report-bug.mjs --auto --title "gateway-start-failed" [--log <文件>]

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve, join } from 'node:path';
import { platform, release, arch, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { getFingerprint } from './fingerprint.mjs';
import { buildApiKey } from './xiapan-client.mjs';

const DEFAULT_API_BASE = 'https://api.u-claw.org/v1';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_LOG_BYTES = 256 * 1024; // 只取日志尾部 256KB，避免上报体过大

function log(level, msg) {
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`[report-bug] ${msg}\n`);
}

// API base 默认带 /v1（虾盘云 API 中转），bug 上报走独立的 /bug 路径，所以去掉尾部 /v1。
// 例：https://api.u-claw.org/v1 -> https://api.u-claw.org/bug/submit
function getSubmitUrl() {
  const base = (process.env.UCLAW_CLOUD_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
  const root = base.replace(/\/v1$/, '');
  return `${root}/bug/submit`;
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 读 OPENCLAW_VERSION：优先环境变量，再找盘内文件
function readOpenclawVersion(appRoot) {
  if (process.env.OPENCLAW_VERSION) return process.env.OPENCLAW_VERSION.trim();
  const candidates = [
    process.env.UCLAW_VERSION_FILE,
    appRoot && resolve(appRoot, 'OPENCLAW_VERSION'),
    appRoot && resolve(appRoot, '..', 'OPENCLAW_VERSION'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const v = readFileSync(p, 'utf8').trim();
        if (v) return v;
      }
    } catch { /* 静默 */ }
  }
  return null;
}

function collectSystemInfo() {
  return JSON.stringify({
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    node: process.version,
    time: new Date().toISOString(),
  });
}

// 读最近一份 openclaw 日志的尾部，gzip+base64。失败返回 null。
// 日志默认在 %LOCALAPPDATA%\Temp\openclaw\ 或 $TMPDIR/openclaw/，文件名形如 openclaw-{date}.log
function collectLogsB64(explicitLogPath) {
  try {
    let logFile = null;
    if (explicitLogPath && existsSync(explicitLogPath)) {
      logFile = explicitLogPath;
    } else {
      const logDir = process.env.OPENCLAW_LOG_DIR || join(tmpdir(), 'openclaw');
      if (existsSync(logDir)) {
        const logs = readdirSync(logDir)
          .filter((f) => /\.log$/i.test(f))
          .map((f) => join(logDir, f))
          .map((p) => ({ p, m: safeMtime(p) }))
          .filter((x) => x.m > 0)
          .sort((a, b) => b.m - a.m);
        if (logs.length) logFile = logs[0].p;
      }
    }
    if (!logFile) return null;

    let raw = readFileSync(logFile);
    if (raw.length > MAX_LOG_BYTES) raw = raw.subarray(raw.length - MAX_LOG_BYTES);
    return gzipSync(raw).toString('base64');
  } catch (err) {
    log('error', `collect logs failed: ${err.message}`);
    return null;
  }
}

function safeMtime(p) {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}

/**
 * 上报一个 bug。所有现场信息（指纹/版本/系统/日志）由本函数自动补齐，
 * 调用方只需给 title（必填）和 description（可选）。
 *
 * @param {object} opts
 * @param {string} opts.title         必填，bug 标题
 * @param {string} [opts.description] 描述（用户填写或堆栈）
 * @param {string} [opts.appRoot]     便携版根目录，用于算指纹和找版本文件，默认 cwd
 * @param {string} [opts.logPath]     指定日志文件；不给则自动找最近的 openclaw 日志
 * @param {boolean}[opts.includeLogs] 是否附带日志，默认 true
 * @returns {Promise<{ok:boolean, id?:number, reason?:string}>}
 */
export async function submitBugReport(opts = {}) {
  const { title, description, appRoot, logPath, includeLogs = true } = opts;
  if (!title || typeof title !== 'string' || title.trim().length < 3) {
    return { ok: false, reason: 'title-required' };
  }
  const root = appRoot || process.cwd();

  // 指纹失败不阻止上报，匿名提交即可
  let api_key = null;
  let device_source = null;
  try {
    const fp = await getFingerprint(root);
    device_source = fp.source;
    api_key = buildApiKey(fp.fingerprint);
  } catch (err) {
    log('error', `fingerprint failed (上报为匿名): ${err.message}`);
  }

  const payload = {
    api_key,
    device_source,
    openclaw_version: readOpenclawVersion(root),
    title: title.trim(),
    description: description || null,
    logs_b64: includeLogs ? collectLogsB64(logPath) : null,
    system_info: collectSystemInfo(),
  };

  try {
    const res = await fetchWithTimeout(getSubmitUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      log('error', `submit failed: HTTP ${res.status} ${data.error || ''}`);
      return { ok: false, reason: data.error || `http-${res.status}` };
    }
    log('info', `submitted bug #${data.id}`);
    return { ok: true, id: data.id };
  } catch (err) {
    log('error', `submit failed: ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

// CLI 入口（自动崩溃上报用）：
//   node report-bug.mjs --auto --title "gateway-start-failed" [--desc "..."] [--log <文件>] [--root <便携版根>]
const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  const title = getArg('--title') || 'auto-report';
  const description = getArg('--desc');
  const logPath = getArg('--log');
  const appRoot = getArg('--root') || process.env.UCLAW_APP_ROOT || process.cwd();

  submitBugReport({ title, description, appRoot, logPath })
    .then((res) => {
      process.stdout.write(`${JSON.stringify(res)}\n`);
      process.exit(res.ok ? 0 : 1);
    })
    .catch((err) => {
      // 即便崩了也别让上报本身把启动脚本拖挂
      process.stderr.write(`report-bug fatal: ${err && err.message ? err.message : err}\n`);
      process.exit(1);
    });
}
