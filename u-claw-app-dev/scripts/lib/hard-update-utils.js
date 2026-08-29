const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const forbiddenSegments = new Set([
  'data',
  '.openclaw',
  'memory',
  'logs',
  'license',
  'auth_profile_store'
]);

const forbiddenFilePatterns = [
  /\.env(?:\.|$)/i,
  /\.key$/i,
  /openclaw\.json$/i,
  /auth[-_]profile[-_]store/i
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    stdio: options.stdio || 'pipe'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = (result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
  return result;
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function normalizeZipPath(relativePath) {
  const normalized = String(relativePath).replace(/\\/g, '/');
  if (!normalized || normalized === '.') throw new Error('Empty package path');
  if (path.posix.isAbsolute(normalized)) throw new Error(`Absolute package path rejected: ${relativePath}`);
  if (/^[A-Za-z]:\//.test(normalized)) throw new Error(`Absolute package path rejected: ${relativePath}`);
  if (normalized.split('/').includes('..')) throw new Error(`Path traversal rejected: ${relativePath}`);
  return normalized;
}

function assertSafeRelativePath(relativePath) {
  const normalized = normalizeZipPath(relativePath);
  if (isPortableMetadataPath(normalized)) throw new Error(`Forbidden package metadata path: ${normalized}`);
  const parts = normalized.split('/').filter(Boolean);
  for (const part of parts) {
    if (forbiddenSegments.has(part)) throw new Error(`Forbidden package path: ${normalized}`);
  }
  if (forbiddenFilePatterns.some(pattern => pattern.test(normalized))) {
    throw new Error(`Forbidden package file: ${normalized}`);
  }
  return normalized;
}

function isPortableMetadataPath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  return normalized
    .split('/')
    .filter(Boolean)
    .some(part => part === '__MACOSX' || part === '.DS_Store' || part.startsWith('._'));
}

function prunePortableMetadata(root) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.name === '__MACOSX' || entry.name === '.DS_Store' || entry.name.startsWith('._')) {
      fs.rmSync(absolute, { recursive: true, force: true });
      continue;
    }
    if (entry.isDirectory()) prunePortableMetadata(absolute);
  }
}

function walkFiles(root, visitor, prefix = '') {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const safeRelative = assertSafeRelativePath(relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Symlink rejected: ${safeRelative}`);
    if (stat.isDirectory()) {
      walkFiles(absolute, visitor, safeRelative);
      continue;
    }
    if (!stat.isFile()) throw new Error(`Non-regular file rejected: ${safeRelative}`);
    visitor(absolute, safeRelative, stat);
  }
}

function treeDigest(root) {
  const entries = [];
  walkFiles(root, (absolute, relative, stat) => {
    entries.push({ path: relative, sha256: sha256File(absolute), size: stat.size });
  });
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return sha256Bytes(Buffer.from(JSON.stringify(entries), 'utf8'));
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyDirFiltered(source, destination, filter) {
  if (!fs.existsSync(source)) return;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name);
    const dst = path.join(destination, entry.name);
    if (!filter(src, entry)) continue;
    const stat = fs.lstatSync(src);
    if (stat.isSymbolicLink()) throw new Error(`Symlink rejected: ${src}`);
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      copyDirFiltered(src, dst, filter);
    } else if (entry.isFile()) {
      copyFile(src, dst);
    } else {
      throw new Error(`Non-regular file rejected: ${src}`);
    }
  }
}

function zipDirectory(sourceDir, destinationZip) {
  fs.mkdirSync(path.dirname(destinationZip), { recursive: true });
  fs.rmSync(destinationZip, { force: true });
  run('zip', ['-qry', destinationZip, '.'], { cwd: sourceDir, env: { COPYFILE_DISABLE: '1' } });
}

function listZipEntries(runtimePkg) {
  const result = run('unzip', ['-Z1', runtimePkg]);
  return result.stdout
    .split(/\r?\n/)
    .map(entry => entry.trim())
    .filter(Boolean);
}

function unzipTo(runtimePkg, destinationDir) {
  fs.rmSync(destinationDir, { recursive: true, force: true });
  fs.mkdirSync(destinationDir, { recursive: true });
  for (const entry of listZipEntries(runtimePkg)) {
    assertSafeRelativePath(entry.replace(/\/$/, ''));
  }
  run('unzip', ['-q', runtimePkg, '-d', destinationDir]);
  prunePortableMetadata(destinationDir);
  walkFiles(destinationDir, () => {});
}

function platformParts(platformKey) {
  const [platform, arch] = platformKey.split('-');
  if (!platform || !arch) throw new Error(`Invalid platform key: ${platformKey}`);
  return { platform, arch };
}

module.exports = {
  assertSafeRelativePath,
  copyDirFiltered,
  copyFile,
  isPortableMetadataPath,
  listZipEntries,
  platformParts,
  prunePortableMetadata,
  readJson,
  run,
  sha256File,
  sha256Bytes,
  treeDigest,
  unzipTo,
  walkFiles,
  writeJson,
  zipDirectory
};
