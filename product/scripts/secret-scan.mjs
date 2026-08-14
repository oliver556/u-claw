import { execFile, execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaultMaxFileBytes = 5 * 1024 * 1024;
const defaultMaxTotalBytes = 100 * 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const privateKeyBegin = /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/u;
const privateKeyEnd = /-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/u;
const credentialField = "(?:api[_-]?key|new[_-]?api[_-]?(?:key|token)|access[_-]?token|auth[_-]?token|issued[_-]?token|startup[_-]?secret|client[_-]?secret|private[_-]?key|password|passwd|secret|token)";
const quotedCredentialAssignment = new RegExp(`(?:^|[\\s{,])["']?${credentialField}["']?\\s*(?:=|:)\\s*(["'])([^"'\\x60\\r\\n]+)\\1`, "iu");
const environmentCredentialAssignment = new RegExp(`^(?:export\\s+)?${credentialField}\\s*=\\s*([^\\s#]+)\\s*$`, "iu");
const deviceTokenPattern = /\buclaw_dt_[A-Za-z0-9_-]{43}\b/gu;
const activationCodeAssignmentSource = String.raw`(?:^|[\s{,])["']?activation[_-]?code["']?\s*(?:=|:)\s*(["'\x60]?)([0-9A-HJKMNP-TV-Z]{26})\1(?![0-9A-HJKMNP-TV-Z])`;
const activationCodePlaceholder = "TESTTESTTESTTESTTESTTEST12";
const tokenPatterns = [
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{82}\b/gu,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,255}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{20,255}\b/gu,
];
const explicitPlaceholder = /^(?:redacted|masked|placeholder|changeme)$/iu;
const conventionalPlaceholder = /^(?:fixture|example|dummy|fake|sample|test[-_ ]?only)(?:[-_ ].*)?$/iu;
const conventionalTokenPlaceholder = /^(?:fixture|example|dummy|fake|sample|testonly)[A-Za-z0-9_-]*$/iu;

export function scanText(filePath, source) {
  const lines = source.split(/\r?\n/u);
  const findings = [];
  let privateKeyStart = -1;
  let privateKeyBody = [];

  for (const [index, line] of lines.entries()) {
    if (privateKeyStart >= 0) {
      if (privateKeyEnd.test(line)) {
        if (!isPrivateKeyPlaceholder(privateKeyBody.join(""))) {
          findings.push({ path: filePath, line: privateKeyStart + 1, rule: "PRIVATE_KEY_BLOCK" });
        }
        privateKeyStart = -1;
        privateKeyBody = [];
      } else {
        privateKeyBody.push(line);
      }
      continue;
    }

    if (privateKeyBegin.test(line)) {
      privateKeyStart = index;
      privateKeyBody = [];
      continue;
    }

    deviceTokenPattern.lastIndex = 0;
    const deviceToken = deviceTokenPattern.exec(line)?.[0];
    if (deviceToken && !isPlaceholder(deviceToken, { token: true })) {
      findings.push({ path: filePath, line: index + 1, rule: "DEVICE_TOKEN" });
      continue;
    }

    const activationCodes = line.matchAll(new RegExp(activationCodeAssignmentSource, "giu"));
    if ([...activationCodes].some((match) => match[2] !== activationCodePlaceholder)) {
      findings.push({ path: filePath, line: index + 1, rule: "ACTIVATION_CODE" });
      continue;
    }

    const quotedAssignment = quotedCredentialAssignment.exec(line);
    const environmentAssignment = environmentCredentialAssignment.exec(line);
    const assignedValue = quotedAssignment?.[2] ?? environmentAssignment?.[1];
    if (assignedValue && isCredentialValue(assignedValue)) {
      findings.push({ path: filePath, line: index + 1, rule: "CREDENTIAL_ASSIGNMENT" });
      continue;
    }

    if (containsHighConfidenceToken(line)) {
      findings.push({ path: filePath, line: index + 1, rule: "HIGH_CONFIDENCE_TOKEN" });
    }
  }

  if (privateKeyStart >= 0 && !isPrivateKeyPlaceholder(privateKeyBody.join(""))) {
    findings.push({ path: filePath, line: privateKeyStart + 1, rule: "PRIVATE_KEY_BLOCK" });
  }
  return findings;
}

export async function scanTrackedRepository(startDirectory = process.cwd(), options = {}) {
  const limits = createLimits(options);
  const { stdout: rootOutput } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd: startDirectory,
    encoding: "utf8",
  });
  const root = rootOutput.trim();
  const { stdout } = await execFileAsync("git", ["ls-files", "--stage", "-z"], {
    cwd: root,
    encoding: null,
    maxBuffer: 16 * 1024 * 1024,
  });
  const entries = splitNul(stdout).flatMap((record) => {
    const separator = record.indexOf(9);
    if (separator < 0) return [];
    const [mode, objectId, stage] = record.subarray(0, separator).toString("ascii").split(" ");
    const file = decodeGitPath(record.subarray(separator + 1));
    if (stage !== "0") throw new Error(`unmerged index entry: ${file}`);
    if (mode === "160000") return [];
    if (!mode.startsWith("100")) return [];
    return [{ path: file, objectId }];
  });
  const blobs = readIndexBlobs(root, entries, limits);
  const indexContents = new Map(entries.map((entry, index) => [entry.path, blobs[index]]));
  const findings = [];
  const findingKeys = new Set();

  for (const [{ path: file }, contents] of entries.map((entry, index) => [entry, blobs[index]])) {
    const source = decodeText(contents);
    if (source === null) continue;
    addFindings(findings, findingKeys, scanText(file, source));
  }

  const worktreePaths = await listWorktreePaths(root);
  for (const file of worktreePaths) {
    const absolutePath = path.join(root, file);
    let handle;
    try {
      handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ELOOP") continue;
      throw error;
    }
    let readResult;
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) continue;
      limits.checkFile(file, metadata.size);
      readResult = await readBounded(handle, file, limits, indexContents.get(file));
    } finally {
      await handle.close();
    }
    const { contents, matchesIndex } = readResult;
    if (matchesIndex) continue;
    limits.add(file, contents.length);
    const source = decodeText(contents);
    if (source === null) continue;
    addFindings(findings, findingKeys, scanText(file, source));
  }
  return findings;
}

function readIndexBlobs(root, entries, limits) {
  if (entries.length === 0) return [];
  const sizeOutput = execFileSync("git", ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
    cwd: root,
    encoding: "utf8",
    input: `${entries.map(({ objectId }) => objectId).join("\n")}\n`,
    maxBuffer: 16 * 1024 * 1024,
  });
  const sizeLines = sizeOutput.trimEnd().split("\n");
  if (sizeLines.length !== entries.length) throw new Error("invalid git cat-file size response");
  sizeLines.forEach((header, index) => {
    const [objectId, type, sizeText] = header.split(" ");
    const size = Number(sizeText);
    if (objectId !== entries[index].objectId || type !== "blob" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("invalid git cat-file size header");
    }
    limits.add(entries[index].path, size);
  });
  const output = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root,
    encoding: null,
    input: `${entries.map(({ objectId }) => objectId).join("\n")}\n`,
    maxBuffer: 256 * 1024 * 1024,
  });
  const blobs = [];
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd < 0) throw new Error("invalid git cat-file response");
    const header = output.subarray(offset, headerEnd).toString("ascii");
    const [objectId, type, sizeText] = header.split(" ");
    const size = Number(sizeText);
    if (objectId !== entry.objectId || type !== "blob" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("invalid git cat-file header");
    }
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= output.length || output[contentEnd] !== 10) {
      throw new Error("invalid git cat-file body");
    }
    blobs.push(output.subarray(contentStart, contentEnd));
    offset = contentEnd + 1;
  }
  if (offset !== output.length) throw new Error("unexpected git cat-file output");
  return blobs;
}

async function listWorktreePaths(root) {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: null, maxBuffer: 16 * 1024 * 1024 },
  );
  return [...new Set(splitNul(stdout).map(decodeGitPath))].sort();
}

function splitNul(output) {
  const records = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    if (index > start) records.push(output.subarray(start, index));
    start = index + 1;
  }
  if (start !== output.length) throw new Error("invalid NUL-delimited git output");
  return records;
}

function decodeGitPath(contents) {
  try {
    return utf8Decoder.decode(contents);
  } catch {
    throw new Error("git path is not valid UTF-8");
  }
}

async function readBounded(handle, file, limits, indexContent) {
  const chunks = [];
  let length = 0;
  let matchesIndex = indexContent !== undefined;
  for (;;) {
    const chunk = Buffer.allocUnsafe(limits.nextReadSize(length));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    const contents = chunk.subarray(0, bytesRead);
    if (matchesIndex && !contents.equals(indexContent.subarray(length, length + bytesRead))) {
      matchesIndex = false;
    }
    length += bytesRead;
    if (!matchesIndex) limits.checkCandidate(file, length);
    chunks.push(contents);
  }
  if (matchesIndex && length !== indexContent.length) matchesIndex = false;
  if (!matchesIndex) limits.checkCandidate(file, length);
  return { contents: Buffer.concat(chunks, length), matchesIndex };
}

function addFindings(target, keys, additions) {
  for (const finding of additions) {
    const key = `${finding.path}\0${finding.line}\0${finding.rule}`;
    if (keys.has(key)) continue;
    keys.add(key);
    target.push(finding);
  }
}

function createLimits({ maxFileBytes = defaultMaxFileBytes, maxTotalBytes = defaultMaxTotalBytes }) {
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 0) throw new TypeError("maxFileBytes must be a non-negative safe integer");
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 0) throw new TypeError("maxTotalBytes must be a non-negative safe integer");
  let total = 0;
  return {
    nextReadSize(length) {
      return Math.min(64 * 1024, maxFileBytes - length + 1);
    },
    checkFile(file, size) {
      if (size > maxFileBytes) throw new Error(`${file} exceeds secret scan file size limit`);
    },
    checkCandidate(file, size) {
      this.checkFile(file, size);
      if (!Number.isSafeInteger(total + size) || total + size > maxTotalBytes) throw new Error("secret scan total size limit exceeded");
    },
    add(file, size) {
      this.checkFile(file, size);
      total += size;
      if (!Number.isSafeInteger(total) || total > maxTotalBytes) throw new Error("secret scan total size limit exceeded");
    },
  };
}

function decodeText(contents) {
  if (contents.includes(0)) return null;
  try {
    return utf8Decoder.decode(contents);
  } catch {
    return null;
  }
}

function containsHighConfidenceToken(line) {
  for (const pattern of tokenPatterns) {
    pattern.lastIndex = 0;
    for (const match of line.matchAll(pattern)) {
      if (!isPlaceholder(match[0], { token: true })) return true;
    }
  }
  return false;
}

function isCredentialValue(value) {
  if (isPlaceholder(value) || value.length < 12 || /^https?:\/\//iu.test(value)) return false;
  if (containsHighConfidenceToken(value)) return true;
  const classes = [/[a-z]/u, /[A-Z]/u, /\d/u, /[^A-Za-z0-9]/u];
  return classes.filter((pattern) => pattern.test(value)).length >= 3;
}

function isPrivateKeyPlaceholder(value) {
  const normalized = value.replace(/\s/gu, "");
  if (/^(?:fixture|example|placeholder|redacted|masked|dummy|fake|sample)$/iu.test(normalized)) return true;
  return /^<[^>]+>$/u.test(normalized) || /^(?:\.{3,}|[*xX0_-]{8,})$/u.test(normalized);
}

function isPlaceholder(value, options = {}) {
  const normalized = value.trim();
  if (!normalized || explicitPlaceholder.test(normalized) || conventionalPlaceholder.test(normalized)) return true;
  if (/^<[^>]+>$/u.test(normalized) || /^\$\{[^}]+\}$/u.test(normalized)) return true;
  if (/^(?:\.{3,}|[*xX0_-]{8,})$/u.test(normalized)) return true;
  const tokenBody = normalized.replace(/^(?:gh[pousr]_|github_pat_|sk-(?:proj-)?|xox[baprs]-)/u, "");
  if ((options.token || tokenBody !== normalized) && conventionalTokenPlaceholder.test(tokenBody)) return true;
  return normalized === "AKIAIOSFODNN7EXAMPLE";
}

async function runCLI() {
  const findings = await scanTrackedRepository();
  if (findings.length === 0) return;
  process.stdout.write(`${findings.map(({ path: file, line, rule }) => `${file}:${line} ${rule}`).join("\n")}\n`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCLI().catch(() => {
    process.stderr.write("Secret scan failed\n");
    process.exitCode = 2;
  });
}
