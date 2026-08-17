import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

import { isSafeWindowsRelativePath } from "../scripts/runtime-manifest.mjs";

const execFileAsync = promisify(execFile);
const runtimeVersions = JSON.parse(await readFile(new URL("../runtime-versions.json", import.meta.url), "utf8"));
const productRoot = fileURLToPath(new URL("../", import.meta.url));

const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_TREE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_TREE_ENTRIES = 200_000;
const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export async function buildWindowsRuntime({
  electronArchive,
  nodeArchive,
  appDependencyRoot,
  desktopRoot,
  frontendRoot,
  adapterRoot,
  sharedRoot,
  outputDir,
}) {
  return buildWindowsRuntimeImpl({
    electronArchive,
    nodeArchive,
    appDependencyRoot,
    desktopRoot,
    frontendRoot,
    adapterRoot,
    sharedRoot,
    outputDir,
  }, {});
}

async function buildWindowsRuntimeImpl({
  electronArchive,
  nodeArchive,
  appDependencyRoot,
  desktopRoot,
  frontendRoot,
  adapterRoot,
  sharedRoot,
  outputDir,
}, expectedDigests) {
  const output = path.resolve(requirePath(outputDir, "outputDir"));
  await requireMissing(output, "Windows runtime output already exists");
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = await mkdtemp(path.join(path.dirname(output), ".windows-runtime-"));
  let published = false;
  try {
    const budget = createBudget();
    const electronEntries = await readZipStrict(electronArchive, budget, expectedDigests.electron);
    validateElectronEntries(electronEntries);
    await extractEntries(electronEntries, path.join(temporary, "electron"));

    const nodeEntries = await readZipStrict(nodeArchive, budget, expectedDigests.node);
    const nodeEntry = validateNodeEntries(nodeEntries);
    await writeArchiveEntry(nodeEntry, path.join(temporary, "node", "node.exe"));

    const appRoot = path.join(temporary, "electron", "resources", "app");
    await copyAppDependencies(appDependencyRoot, appRoot, budget);
    await copyWorkspaceBuild("desktop", desktopRoot, appRoot, budget);
    await copyWorkspaceBuild("frontend", frontendRoot, appRoot, budget);
    await copyWorkspaceBuild("adapter", adapterRoot, appRoot, budget);
    await copyWorkspaceBuild("shared", sharedRoot, appRoot, budget);
    await copyInternalWorkspacePackage("adapter", adapterRoot, appRoot, budget);
    await copyInternalWorkspacePackage("shared", sharedRoot, appRoot, budget);

    await verifyWindowsRuntimeTree(temporary);
    await requireMissing(output, "Windows runtime output already exists");
    try {
      await rename(temporary, output);
    } catch (error) {
      if (["EEXIST", "ENOTEMPTY", "EISDIR", "ENOTDIR"].includes(error.code)) {
        throw new Error("Windows runtime output already exists");
      }
      throw error;
    }
    published = true;
    return { outputDir: output };
  } finally {
    if (!published) await rm(temporary, { recursive: true, force: true });
  }
}

function requirePath(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function createBudget() {
  return { entries: 0, bytes: 0 };
}

function chargeEntry(budget) {
  budget.entries += 1;
  if (budget.entries > MAX_TREE_ENTRIES) throw new Error("Windows runtime exceeds entry count limit");
}

function chargeFile(budget, size, label) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`${label} has invalid size`);
  if (size > MAX_FILE_BYTES) throw new Error(`${label} exceeds file size limit`);
  chargeEntry(budget);
  budget.bytes += size;
  if (!Number.isSafeInteger(budget.bytes) || budget.bytes > MAX_TREE_BYTES) {
    throw new Error("Windows runtime exceeds total size limit");
  }
}

async function readZipStrict(archive, budget, expectedDigest) {
  const archivePath = path.resolve(requirePath(archive, "archive"));
  const bytes = await readRegularFileBounded(archivePath, "ZIP archive", MAX_ARCHIVE_BYTES);
  if (expectedDigest && createHash("sha256").update(bytes).digest("hex") !== expectedDigest) {
    throw new Error("cached runtime archive SHA-256 mismatch");
  }
  return parseZip(bytes, budget);
}

async function readRegularFileBounded(source, label, maxBytes) {
  const before = await lstat(source).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if (before.size > maxBytes) throw new Error(`${label} exceeds size limit`);
  const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error(`${label} changed during read`);
    }
    const bytes = Buffer.allocUnsafe(opened.size);
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await handle.read(bytes, position, bytes.length - position, position);
      if (bytesRead === 0) throw new Error(`${label} changed during read`);
      position += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error(`${label} changed during read`);
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseZip(bytes, budget) {
  const endOffset = findEndRecord(bytes);
  const disk = bytes.readUInt16LE(endOffset + 4);
  const centralDisk = bytes.readUInt16LE(endOffset + 6);
  const diskEntries = bytes.readUInt16LE(endOffset + 8);
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount || entryCount === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new Error("unsupported ZIP layout");
  }
  if (centralOffset + centralSize > endOffset) throw new Error("invalid ZIP central directory");

  const entries = [];
  const seen = new Set();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new Error("invalid ZIP central directory");
    const madeBy = bytes.readUInt16LE(cursor + 4);
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const checksum = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > bytes.length || compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new Error("unsupported ZIP layout");
    if ((flags & 1) !== 0 || ![0, 8].includes(method)) throw new Error("unsupported ZIP compression");
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decodeZipName(nameBytes, flags);
    const isDirectory = name.endsWith("/");
    const relative = isDirectory ? name.slice(0, -1) : name;
    if (name.includes("\\") || !isSafeWindowsRelativePath(relative)) throw new Error(`unsafe archive path: ${name}`);
    const canonical = relative.toLowerCase();
    if (seen.has(canonical)) throw new Error(`duplicate archive path: ${name}`);
    seen.add(canonical);
    validateArchiveType({ madeBy, externalAttributes, isDirectory, name });
    if (isDirectory) chargeEntry(budget);
    else chargeFile(budget, size, `archive entry ${name}`);

    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new Error("invalid ZIP local header");
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (localFlags !== flags || localMethod !== method || dataOffset + compressedSize > bytes.length) throw new Error("invalid ZIP local header");
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (!localName.equals(nameBytes)) throw new Error("ZIP entry names do not match");
    entries.push({ name: relative, isDirectory, method, checksum, size, compressed: bytes.subarray(dataOffset, dataOffset + compressedSize) });
    cursor = recordEnd;
  }
  if (cursor !== centralOffset + centralSize) throw new Error("invalid ZIP central directory size");
  return entries;
}

function findEndRecord(bytes) {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === END_SIGNATURE) {
      const commentLength = bytes.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === bytes.length) return offset;
    }
  }
  throw new Error("invalid ZIP end record");
}

function decodeZipName(bytes, flags) {
  if ((flags & 0x800) === 0 && bytes.some((byte) => byte > 0x7f)) throw new Error("unsupported non-UTF-8 ZIP path");
  const name = bytes.toString("utf8");
  if (Buffer.from(name, "utf8").equals(bytes) === false) throw new Error("invalid UTF-8 ZIP path");
  return name;
}

function validateArchiveType({ madeBy, externalAttributes, isDirectory, name }) {
  const platform = madeBy >>> 8;
  const unixMode = externalAttributes >>> 16;
  const unixType = unixMode & 0o170000;
  const dosDirectory = (externalAttributes & 0x10) !== 0;
  const dosVolume = (externalAttributes & 0x08) !== 0;
  if (dosVolume) throw new Error(`unsupported archive entry: ${name}`);
  if (platform === 3 && unixType !== 0) {
    const expectedType = isDirectory ? 0o040000 : 0o100000;
    if (unixType !== expectedType) throw new Error(`unsupported archive entry: ${name}`);
  }
  if (dosDirectory !== isDirectory && platform !== 3) throw new Error(`unsupported archive entry: ${name}`);
}

function validateElectronEntries(entries) {
  const executables = entries.filter((entry) => !entry.isDirectory && entry.name.toLowerCase().endsWith(".exe"));
  if (executables.length !== 1 || executables[0].name.toLowerCase() !== "electron.exe") {
    throw new Error("Electron archive must contain exactly one Electron executable at electron.exe");
  }
}

function validateNodeEntries(entries) {
  const root = `node-v${runtimeVersions.node}-win-x64`;
  if (entries.some((entry) => entry.name !== root && !entry.name.startsWith(`${root}/`))) {
    throw new Error("Node archive layout must use the locked win-x64 root");
  }
  const nodeExecutables = entries.filter((entry) => !entry.isDirectory && path.posix.basename(entry.name).toLowerCase() === "node.exe");
  if (nodeExecutables.length !== 1) throw new Error("Node archive must contain exactly one node.exe");
  if (nodeExecutables[0].name !== `${root}/node.exe`) throw new Error("Node archive layout must contain the locked node.exe path");
  return nodeExecutables[0];
}

async function extractEntries(entries, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const target = path.join(destination, ...entry.name.split("/"));
    if (entry.isDirectory) await mkdir(target, { recursive: true });
    else await writeArchiveEntry(entry, target);
  }
}

async function writeArchiveEntry(entry, target) {
  await mkdir(path.dirname(target), { recursive: true });
  let body;
  try {
    body = entry.method === 0 ? Buffer.from(entry.compressed) : inflateRawSync(entry.compressed, { maxOutputLength: Math.max(1, entry.size) });
  } catch {
    throw new Error(`invalid compressed ZIP entry: ${entry.name}`);
  }
  if (body.length !== entry.size || crc32(body) !== entry.checksum) throw new Error(`corrupt ZIP entry: ${entry.name}`);
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1) current = (current & 1) === 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  return current >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

async function copyAppDependencies(sourceRoot, appRoot, budget) {
  const source = await requireRealDirectory(sourceRoot, "app dependency root");
  await mkdir(appRoot, { recursive: true });
  await copyRegularFile(path.join(source, "package.json"), path.join(appRoot, "package.json"), "app manifest", budget);
  await copyDirectory(path.join(source, "node_modules"), path.join(appRoot, "node_modules"), "production node_modules", budget);
}

async function copyWorkspaceBuild(name, sourceRoot, appRoot, budget) {
  const source = await requireRealDirectory(sourceRoot, `${name} build root`);
  const dist = path.join(source, "dist");
  await requireRealDirectory(dist, `${name} build`);
  const destination = path.join(appRoot, name);
  await mkdir(destination, { recursive: true });
  await copyRegularFile(path.join(source, "package.json"), path.join(destination, "package.json"), `${name} manifest`, budget);
  await copyDirectory(dist, path.join(destination, "dist"), `${name} build`, budget);
}

async function copyInternalWorkspacePackage(name, sourceRoot, appRoot, budget) {
  const source = path.resolve(requirePath(sourceRoot, `${name}Root`));
  const destination = path.join(appRoot, "node_modules", "@uclaw", name);
  await mkdir(destination, { recursive: true });
  await copyRegularFile(path.join(source, "package.json"), path.join(destination, "package.json"), `${name} manifest`, budget);
  await copyDirectory(path.join(source, "dist"), path.join(destination, "dist"), `${name} build`, budget);
}

async function requireRealDirectory(target, label) {
  const resolved = path.resolve(requirePath(target, label));
  const info = await lstat(resolved).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  return resolved;
}

async function copyDirectory(source, destination, label, budget) {
  await requireRealDirectory(source, label);
  chargeEntry(budget);
  await mkdir(destination, { recursive: true });
  const canonicalNames = new Set();
  const children = await readdir(source);
  children.sort((left, right) => left.localeCompare(right, "en"));
  for (const name of children) {
    if (name.includes("\\") || !isSafeWindowsRelativePath(name)) throw new Error(`unsafe source path: ${name}`);
    const canonical = name.toLowerCase();
    if (canonicalNames.has(canonical)) throw new Error(`duplicate Windows source path: ${name}`);
    canonicalNames.add(canonical);
    const sourceChild = path.join(source, name);
    const destinationChild = path.join(destination, name);
    const info = await lstat(sourceChild);
    if (info.isSymbolicLink()) throw new Error(`source symlink is forbidden: ${sourceChild}`);
    if (info.isDirectory()) await copyDirectory(sourceChild, destinationChild, label, budget);
    else if (info.isFile()) await copyRegularFile(sourceChild, destinationChild, label, budget, info);
    else throw new Error(`unsupported source entry: ${sourceChild}`);
  }
}

async function copyRegularFile(source, destination, label, budget, initialInfo) {
  const before = initialInfo ?? await lstat(source).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink()) throw new Error(`${label} must contain only regular files`);
  chargeFile(budget, before.size, label);
  await mkdir(path.dirname(destination), { recursive: true });
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  let sourceHandle;
  let destinationHandle;
  try {
    sourceHandle = await open(source, flags);
    const opened = await sourceHandle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error(`${label} changed during copy`);
    destinationHandle = await open(destination, "wx", 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < opened.size) {
      const length = Math.min(buffer.length, opened.size - position);
      const { bytesRead } = await sourceHandle.read(buffer, 0, length, position);
      if (bytesRead === 0) throw new Error(`${label} changed during copy`);
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(buffer, written, bytesRead - written, position + written);
        if (result.bytesWritten === 0) throw new Error(`${label} could not be copied`);
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    const after = await sourceHandle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error(`${label} changed during copy`);
    await destinationHandle.sync();
  } finally {
    await destinationHandle?.close();
    await sourceHandle?.close();
  }
}

async function verifyWindowsRuntimeTree(root) {
  const required = [
    "electron/electron.exe",
    "electron/resources/app/package.json",
    "electron/resources/app/desktop/dist/entry.js",
    "electron/resources/app/frontend/dist/index.html",
    "electron/resources/app/node_modules/openclaw/openclaw.mjs",
    "node/node.exe",
  ];
  for (const relative of required) {
    const info = await lstat(path.join(root, ...relative.split("/"))).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`Windows runtime required file is missing: ${relative}`);
  }
  const budget = createBudget();
  await verifyDirectory(root, "", budget);
}

async function verifyDirectory(root, relativeDirectory, budget) {
  chargeEntry(budget);
  const directory = relativeDirectory ? path.join(root, ...relativeDirectory.split("/")) : root;
  const children = await readdir(directory);
  const seen = new Set();
  for (const name of children) {
    const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
    if (relative.includes("\\") || !isSafeWindowsRelativePath(relative)) throw new Error(`unsafe Windows runtime path: ${relative}`);
    if (seen.has(name.toLowerCase())) throw new Error(`duplicate Windows runtime path: ${relative}`);
    seen.add(name.toLowerCase());
    const info = await lstat(path.join(root, ...relative.split("/")));
    if (info.isSymbolicLink()) throw new Error(`Windows runtime symlink is forbidden: ${relative}`);
    if (info.isDirectory()) await verifyDirectory(root, relative, budget);
    else if (info.isFile()) chargeFile(budget, info.size, `Windows runtime file ${relative}`);
    else throw new Error(`unsupported Windows runtime entry: ${relative}`);
  }
}

async function requireMissing(target, message) {
  const info = await lstat(target).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info) throw new Error(message);
}

function parseCLIArguments(arguments_) {
  const values = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const token = arguments_[index];
    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    if (name !== "--cache" && name !== "--output") throw new Error(`unknown argument: ${token}`);
    if (Object.hasOwn(values, name)) throw new Error(`duplicate argument: ${name}`);
    const value = equals === -1 ? arguments_[++index] : token.slice(equals + 1);
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${name}`);
    values[name] = value;
  }
  if (!values["--cache"] || !values["--output"]) throw new Error("--cache and --output are required");
  return { cache: path.resolve(values["--cache"]), output: path.resolve(values["--output"]) };
}

async function runCLI() {
  const { cache, output } = parseCLIArguments(process.argv.slice(2));
  await execFileAsync("npm", ["run", "build"], { cwd: productRoot, windowsHide: true });
  const appDependencyRoot = path.join(productRoot, "packaging", "windows-runtime-app");
  await execFileAsync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--os=win32", "--cpu=x64"], {
    cwd: appDependencyRoot,
    env: { ...process.env, npm_config_bin_links: "false" },
    windowsHide: true,
  });
  const archiveName = (url) => path.basename(new URL(url).pathname);
  await buildWindowsRuntimeImpl({
    electronArchive: path.join(cache, archiveName(runtimeVersions.windowsArtifacts.electron.url)),
    nodeArchive: path.join(cache, archiveName(runtimeVersions.windowsArtifacts.node.url)),
    appDependencyRoot,
    desktopRoot: path.join(productRoot, "desktop"),
    frontendRoot: path.join(productRoot, "frontend"),
    adapterRoot: path.join(productRoot, "adapter"),
    sharedRoot: path.join(productRoot, "shared"),
    outputDir: output,
  }, {
    electron: runtimeVersions.windowsArtifacts.electron.sha256,
    node: runtimeVersions.windowsArtifacts.node.sha256,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCLI().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
