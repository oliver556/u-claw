import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER_FILE = '.uclaw-residue-owner.json';
const CLEANABLE_KINDS = new Set(['appdata', 'localappdata', 'temp', 'fixed-drive']);
const BUSINESS_DATA_PATTERN = /(^|[\\/])([^\\/]*(account|credential|token|session|message|chat|contact)[^\\/]*|openclaw\.json|memory|workspace)([\\/]|$)/i;
const EXPECTED_MARKER = Object.freeze({
  schemaVersion: 1,
  owner: 'U-Claw',
  component: 'personal-wechat',
  dataClass: 'rebuildable-cache',
});

function addCandidate(target, seen, kind, absolutePath) {
  if (!absolutePath) return;
  const normalized = win32.normalize(absolutePath);
  const key = normalized.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  target.push({ kind, absolutePath: normalized });
}

export function buildWindowsWechatCandidates({ env = {}, fixedDriveRoots = [] } = {}) {
  const candidates = [];
  const seen = new Set();
  if (env.USERPROFILE) {
    addCandidate(candidates, seen, 'legacy-userprofile', win32.join(
      env.USERPROFILE,
      '.openclaw',
      'extensions',
      'openclaw-weixin',
    ));
  }
  for (const [name, kind] of [
    ['APPDATA', 'appdata'],
    ['LOCALAPPDATA', 'localappdata'],
    ['TEMP', 'temp'],
  ]) {
    if (env[name]) {
      addCandidate(candidates, seen, kind, win32.join(env[name], 'U-Claw', 'openclaw-weixin'));
    }
  }
  for (const root of fixedDriveRoots) {
    addCandidate(candidates, seen, 'fixed-drive', win32.join(root, 'U-Claw', 'openclaw-weixin'));
  }
  return candidates;
}

function validMarker(marker) {
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return false;
  if (Object.keys(marker).length !== Object.keys(EXPECTED_MARKER).length) return false;
  return Object.entries(EXPECTED_MARKER).every(([key, value]) => marker[key] === value);
}

export function classifyWechatResidue({ kind, marker, relativeFiles = [] } = {}) {
  if (kind === 'legacy-userprofile') {
    return { decision: 'refuse', reason: 'LEGACY_PLUGIN_OWNERSHIP_UNKNOWN' };
  }
  if (!CLEANABLE_KINDS.has(kind)) {
    return { decision: 'refuse', reason: 'PATH_KIND_NOT_ALLOWED' };
  }
  if (marker == null) {
    return { decision: 'refuse', reason: 'OWNERSHIP_MARKER_MISSING' };
  }
  if (!validMarker(marker)) {
    return { decision: 'refuse', reason: 'OWNERSHIP_MARKER_INVALID' };
  }
  if (relativeFiles.some((relativePath) => BUSINESS_DATA_PATTERN.test(relativePath))) {
    return { decision: 'refuse', reason: 'BUSINESS_DATA_PRESENT' };
  }
  return { decision: 'clean', reason: 'UCLAW_REBUILDABLE_RESIDUE' };
}

async function exists(absolutePath) {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function listRelativeFiles(root, current = root, result = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolutePath = `${current}/${entry.name}`;
    const relativePath = absolutePath.slice(root.length + 1);
    if (entry.isDirectory()) await listRelativeFiles(root, absolutePath, result);
    else if (entry.name !== MARKER_FILE) result.push(relativePath);
  }
  return result;
}

async function inspectCandidate({ absolutePath, kind }) {
  if (!await exists(absolutePath)) {
    return { decision: 'absent', reason: 'PATH_ABSENT' };
  }
  let marker = null;
  try {
    marker = JSON.parse(await readFile(`${absolutePath}/${MARKER_FILE}`, 'utf8'));
  } catch {
    // Missing, unreadable, or invalid markers never authorize cleanup.
  }
  let relativeFiles = [];
  try {
    relativeFiles = await listRelativeFiles(absolutePath);
  } catch {
    return { decision: 'refuse', reason: 'DIRECTORY_INSPECTION_FAILED' };
  }
  return classifyWechatResidue({ kind, marker, relativeFiles });
}

export async function cleanupWechatResidue(candidate) {
  const classification = await inspectCandidate(candidate);
  if (classification.decision === 'absent' || classification.decision === 'refuse') {
    return classification;
  }
  await rm(candidate.absolutePath, { recursive: true, force: false });
  return { decision: 'cleaned', reason: classification.reason };
}

function hashPath(value) {
  return createHash('sha256').update(String(value).toLowerCase()).digest('hex');
}

export function redactWechatAudit(results) {
  return {
    schemaVersion: 1,
    component: 'personal-wechat',
    entries: results.map(({ absolutePath, kind, decision, reason }) => ({
      pathSha256: hashPath(absolutePath),
      kind,
      decision,
      reason,
    })),
  };
}

function parseCliArgs(argv) {
  const parsed = { fixedDriveRoots: [], mode: 'audit' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--fixed-drive-root') parsed.fixedDriveRoots.push(argv[++index]);
    else if (value === '--evidence') parsed.evidencePath = argv[++index];
    else if (value === '--mode') parsed.mode = argv[++index];
    else throw new Error('INVALID_ARGUMENT');
  }
  if (!parsed.evidencePath || !['audit', 'clean'].includes(parsed.mode)) {
    throw new Error('INVALID_ARGUMENT');
  }
  return parsed;
}

async function writeJsonAtomic(outputPath, value) {
  const temporary = `${outputPath}.${process.pid}.tmp`;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, outputPath);
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const candidates = buildWindowsWechatCandidates({
    env: process.env,
    fixedDriveRoots: options.fixedDriveRoots,
  });
  const results = [];
  for (const candidate of candidates) {
    const result = options.mode === 'clean'
      ? await cleanupWechatResidue(candidate)
      : await inspectCandidate(candidate);
    results.push({ ...candidate, ...result });
  }
  const evidence = redactWechatAudit(results);
  evidence.mode = options.mode;
  evidence.status = results.some(({ decision }) => decision === 'refuse') ? 'needs-input' : 'passed';
  await writeJsonAtomic(options.evidencePath, evidence);
  process.exitCode = evidence.status === 'passed' ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || 'WECHAT_RESIDUE_AUDIT_FAILED'}\n`);
    process.exitCode = 1;
  });
}
