import { execFile, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const privateKeyBegin = /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/u;
const privateKeyEnd = /-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/u;
const quotedCredentialAssignment = /(?:^|[\s{,])["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|secret|token)["']?\s*(?:=|:)\s*(["'])([^"'`\r\n]+)\1/iu;
const environmentCredentialAssignment = /^(?:export\s+)?(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|secret|token)\s*=\s*([^\s#]+)\s*$/iu;
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

export async function scanTrackedRepository(startDirectory = process.cwd()) {
  const { stdout: rootOutput } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd: startDirectory,
    encoding: "utf8",
  });
  const root = rootOutput.trim();
  const { stdout } = await execFileAsync("git", ["ls-files", "--stage", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const entries = stdout.split("\0").filter(Boolean).flatMap((record) => {
    const separator = record.indexOf("\t");
    if (separator < 0) return [];
    const [mode, objectId, stage] = record.slice(0, separator).split(" ");
    if (stage !== "0" || mode === "160000") return [];
    return [{ path: record.slice(separator + 1), objectId }];
  });
  const blobs = readIndexBlobs(root, entries);
  const findings = [];

  for (const [{ path: file }, contents] of entries.map((entry, index) => [entry, blobs[index]])) {
    const source = decodeText(contents);
    if (source === null) continue;
    findings.push(...scanText(file, source));
  }
  return findings;
}

function readIndexBlobs(root, entries) {
  if (entries.length === 0) return [];
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
