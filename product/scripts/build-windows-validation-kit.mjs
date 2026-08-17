import { execFile } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
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
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { signRuntimeManifest } from "./runtime-manifest.mjs";

const execFileAsync = promisify(execFile);
const defaultProductRoot = fileURLToPath(new URL("../", import.meta.url));
const runtimeVersions = JSON.parse(await readFile(new URL("../runtime-versions.json", import.meta.url), "utf8"));
const publicKeyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const maxPublicKeyMapBytes = 64 * 1024;
const handoffEntries = [
  "README.txt",
  "U-Claw-Update-test.exe",
  "U-Claw-test-USB",
  "online-feed",
  "test-public.pem",
];

export async function buildWindowsValidationKit(options) {
  const productRoot = path.resolve(requireText(options.productRoot ?? defaultProductRoot, "productRoot"));
  const cacheDir = path.resolve(requireText(options.cacheDir, "cacheDir"));
  const outputDir = path.resolve(requireText(options.outputDir, "outputDir"));
  const activationServiceEndpoint = normalizeHTTPSEndpoint(options.activationServiceEndpoint, "activation endpoint");
  const activationPublicKeys = normalizePublicKeyMap(options.activationPublicKeys, "activation public keys");
  const licenseStatusEndpoint = normalizeHTTPSEndpoint(options.licenseStatusEndpoint, "license status endpoint");
  const licenseStatusPublicKeys = normalizePublicKeyMap(options.licenseStatusPublicKeys, "license status public keys");
  const feedBaseURL = normalizeHTTPSEndpoint(options.feedBaseURL ?? "", "release feed endpoint", { allowEmpty: true });
  const versions = validateVersions(options.versions ?? ["1.0.0", "2.0.0"]);
  const now = validDate(options.now ?? new Date(), "now");
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const runner = options.runner ?? defaultRunner;
  const logger = options.logger ?? (() => {});
  await requireDirectory(cacheDir, "runtime cache");
  await requireMissing(outputDir, "validation kit output already exists");
  if (isPathInside(outputDir, cacheDir) || isPathInside(cacheDir, outputDir)) {
    throw new Error("runtime cache and validation output must be separate");
  }

  await mkdir(path.dirname(outputDir), { recursive: true });
  const temporaryRoot = options.temporaryRoot
    ? path.resolve(options.temporaryRoot)
    : await mkdtemp(path.join(path.dirname(outputDir), ".windows-validation-kit-"));
  if (isPathInside(temporaryRoot, outputDir) || isPathInside(outputDir, temporaryRoot)) {
    if (!options.temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    throw new Error("validation temporary root and output must be separate");
  }
  if (options.temporaryRoot) {
    await requireMissing(temporaryRoot, "validation temporary root already exists");
    await mkdir(temporaryRoot, { mode: 0o700 });
  }
  const handoffDir = path.join(temporaryRoot, "handoff");
  const keyDir = path.join(temporaryRoot, "private-signing-material");
  try {
    await Promise.all([mkdir(handoffDir), mkdir(keyDir, { mode: 0o700 })]);
    const keyPair = options.signingKeyPair ?? generateKeyPairSync("ed25519");
    const privateKeyPEM = keyPair.privateKey.export({ type: "pkcs8", format: "pem" });
    const publicKeyPEM = keyPair.publicKey.export({ type: "spki", format: "pem" });
    const privateKeyPath = path.join(keyDir, "test-private.pem");
    const publicKeyPath = path.join(keyDir, "test-public.pem");
    await writeFile(privateKeyPath, privateKeyPEM, { flag: "wx", mode: 0o600 });
    await writeFile(publicKeyPath, publicKeyPEM, { flag: "wx", mode: 0o600 });

    const runtimeSources = [path.join(temporaryRoot, "runtime-v1"), path.join(temporaryRoot, "runtime-v2")];
    for (const source of runtimeSources) {
      await runNodeScript(runner, productRoot, "packaging/build-windows-runtime.mjs", [
        "--cache", cacheDir,
        "--output", source,
      ]);
    }
    for (let index = 0; index < runtimeSources.length; index += 1) {
      await writeFile(
        path.join(runtimeSources[index], "electron", "resources", "app", "uclaw-validation-version.json"),
        `${JSON.stringify({ validationVersion: versions[index] })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o644 },
      );
    }

    const runtimePackages = [path.join(temporaryRoot, "runtime-v1.pkg"), path.join(temporaryRoot, "runtime-v2.pkg")];
    const unsignedManifests = [];
    for (let index = 0; index < runtimeSources.length; index += 1) {
      const result = await runNodeScript(runner, productRoot, "packaging/build-runtime.mjs", [
        "--input", runtimeSources[index],
        "--output", runtimePackages[index],
        "--product-version", versions[index],
        "--runtime-id", runtimeVersions.runtimeId,
        "--entrypoint", "electron/electron.exe",
      ]);
      unsignedManifests.push(parseJSONOutput(result.stdout, "build-runtime.mjs"));
    }

    const keyId = "windows-validation-key";
    const signedManifests = unsignedManifests.map((manifest, index) => signRuntimeManifest(manifest, {
      keyId,
      privateKey: keyPair.privateKey,
      signedAt: now,
      expiresAt,
      sequence: index + 1,
    }));
    const manifestPaths = [path.join(temporaryRoot, "manifest-v1.json"), path.join(temporaryRoot, "manifest-v2.json")];
    await Promise.all(signedManifests.map((manifest, index) => writeFile(
      manifestPaths[index],
      `${JSON.stringify(manifest)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    )));

    const rawPublicKey = Buffer.from(keyPair.publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
    const trustedKeys = { [keyId]: rawPublicKey };
    const launcherPath = path.join(temporaryRoot, "U-Claw.exe");
    await runGoBuild(runner, path.join(productRoot, "launcher"), launcherPath, [
      "-X", `main.trustedRuntimeKeys=${encodeFixtureLinkerJSON(trustedKeys)}`,
      "-X", "main.revokedRuntimeKeyIDs=[]",
      "-X", `main.releaseFeedBaseURL=${feedBaseURL}`,
      "-X", `main.activationServiceEndpoint=${activationServiceEndpoint}`,
      "-X", `main.trustedStartupLicenseKeys=${encodeFixtureLinkerJSON(activationPublicKeys)}`,
      "-X", `main.licenseStatusEndpoint=${licenseStatusEndpoint}`,
      "-X", `main.trustedLicenseStatusKeys=${encodeFixtureLinkerJSON(licenseStatusPublicKeys)}`,
    ], ["licensefixture"]);

    const usbDir = path.join(handoffDir, "U-Claw-test-USB");
    await runNodeScript(runner, productRoot, "packaging/build-release.mjs", [
      "--launcher", launcherPath,
      "--runtime-package", runtimePackages[0],
      "--manifest", manifestPaths[0],
      "--public-key", publicKeyPath,
      "--output", usbDir,
    ]);
    await writeInitialOpenClawConfig(usbDir, options.randomBytes ?? randomBytes);

    const feedDir = path.join(handoffDir, "online-feed");
    await runNodeScript(runner, productRoot, "packaging/build-update-feed.mjs", [
      "--runtime", runtimePackages[1],
      "--manifest", manifestPaths[1],
      "--output", feedDir,
      "--id", `windows-validation-${versions[1]}`,
      "--version", versions[1],
      "--notes", "Windows validation update",
      "--published", now.toISOString(),
      "--expires", expiresAt.toISOString(),
      "--sequence", "2",
      "--key-id", keyId,
      "--private-key", privateKeyPath,
      "--public-key", publicKeyPath,
      "--runtime-public-key", publicKeyPath,
    ]);

    const genericUpdater = path.join(temporaryRoot, "offline-updater.exe");
    await runGoBuild(runner, path.join(productRoot, "offline-updater"), genericUpdater);
    await runNodeScript(runner, productRoot, "packaging/build-offline-updater.mjs", [
      "--updater", genericUpdater,
      "--feed", path.join(feedDir, "stable.json"),
      "--runtime", runtimePackages[1],
      "--output", path.join(handoffDir, "U-Claw-Update-test.exe"),
    ]);

    await writeFile(path.join(handoffDir, "test-public.pem"), publicKeyPEM, { flag: "wx", mode: 0o644 });
    await writeFile(path.join(handoffDir, "README.txt"), validationReadme(versions), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    await validateHandoff(handoffDir);
    // Catches cooperative writers; a hostile native replacement between this check and rename remains a platform residual.
    await requireMissing(outputDir, "validation kit output already exists");
    await rename(handoffDir, outputDir);
    logger(`Windows validation kit written to ${outputDir}`);
    return { handoffDir: outputDir, temporaryRoot };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function writeInitialOpenClawConfig(usbDir, randomBytesFn) {
  const dataDirectory = path.join(usbDir, ".uclaw", "data");
  const openClawDirectory = path.join(dataDirectory, ".openclaw");
  await mkdir(path.join(dataDirectory, "workspace"), { recursive: true });
  await mkdir(openClawDirectory, { mode: 0o700 });
  const token = randomBytesFn(32).toString("base64url");
  const workspace = "${OPENCLAW_WORKSPACE_DIR}";
  const config = {
    gateway: { mode: "local", bind: "loopback", auth: { mode: "token", token } },
    agents: {
      defaults: { workspace, skipBootstrap: true },
      list: [{ id: "main", default: true, workspace }],
    },
  };
  await writeFile(path.join(openClawDirectory, "openclaw.json"), `${JSON.stringify(config)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function runNodeScript(runner, productRoot, relativeScript, args) {
  return runner(process.execPath, [path.join(productRoot, relativeScript), ...args], {
    cwd: productRoot,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function runGoBuild(runner, cwd, output, linkerValues = [], tags = []) {
  const linkerFlags = ["-s", "-w", "-H", "windowsgui", ...linkerValues].join(" ");
  const tagArguments = tags.length > 0 ? ["-tags", tags.join(",")] : [];
  return runner("go", ["build", "-trimpath", ...tagArguments, "-ldflags", linkerFlags, "-o", output, "."], {
    cwd,
    env: { CGO_ENABLED: "0", GOOS: "windows", GOARCH: "amd64" },
    windowsHide: true,
  });
}

async function defaultRunner(command, args, options) {
  return execFileAsync(command, args, { ...options, env: { ...process.env, ...options.env } });
}

async function validateHandoff(handoffDir) {
  const entries = (await readdir(handoffDir)).sort();
  if (JSON.stringify(entries) !== JSON.stringify(handoffEntries.toSorted())) {
    throw new Error("validation handoff contains unexpected top-level entries");
  }
  for (const file of await walkFiles(handoffDir)) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("validation handoff contains an unsafe entry");
    if ((await readFile(file)).includes(Buffer.from("PRIVATE KEY-----"))) {
      throw new Error("validation handoff contains private key material");
    }
  }
}

async function walkFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("validation handoff contains a symlink");
      if (entry.isDirectory()) await visit(target);
      else files.push(target);
    }
  }
  await visit(root);
  return files;
}

function validationReadme(versions) {
  return [
    "U-Claw Windows validation kit",
    "",
    `Initial version: ${versions[0]}`,
    `Update version: ${versions[1]}`,
    "This kit embeds the supplied real activation and license-status HTTPS endpoints and public verification keys.",
    "The builder fails closed when any activation configuration is missing or invalid.",
    "An empty release feed base URL explicitly disables Launcher online checks until an HTTPS feed is configured.",
    "1. Copy only the contents of U-Claw-test-USB to the root of the test USB drive.",
    "2. On Windows 10 or 11, connect the network, double-click U-Claw.exe, and complete the existing real activation flow.",
    "3. Confirm .uclaw\\license\\license.json and .uclaw\\license\\.startup-credential.json exist.",
    "4. Exit U-Claw completely.",
    "5. Disconnect the network, then double-click U-Claw.exe for the first normal full startup.",
    "6. Confirm the U-Claw window and local Gateway become ready, then close U-Claw.",
    "7. Copy U-Claw-Update-test.exe to the USB root and run it.",
    "8. Double-click U-Claw.exe again and confirm the updated version starts.",
    "9. Repeat after changing USB ports and on a second Windows computer.",
    "",
    "Do not use this test kit as a production release.",
    "",
  ].join(os.EOL);
}

function parseJSONOutput(stdout, script) {
  try {
    return JSON.parse(String(stdout));
  } catch {
    throw new Error(`${script} returned invalid JSON`);
  }
}

function requireText(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function normalizeHTTPSEndpoint(value, label, { allowEmpty = false } = {}) {
  if (allowEmpty && value === "") return "";
  if (typeof value !== "string" || /\s/u.test(value)) throw new Error(`${label} must be a credential-free HTTPS URL`);
  let endpoint;
  try {
    endpoint = new URL(requireText(value, label));
  } catch {
    throw new Error(`${label} must be a credential-free HTTPS URL`);
  }
  if (endpoint.protocol !== "https:" || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error(`${label} must be a credential-free HTTPS URL`);
  }
  if (!endpoint.pathname.endsWith("/")) endpoint.pathname += "/";
  return endpoint.toString();
}

function encodeFixtureLinkerJSON(value) {
  return `base64:${Buffer.from(JSON.stringify(value)).toString("base64")}`;
}

function normalizePublicKeyMap(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a non-empty public key map`);
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 16) throw new Error(`${label} must be a non-empty public key map`);
  const normalized = Object.create(null);
  for (const [keyId, encodedKey] of entries.sort(([left], [right]) => left.localeCompare(right, "en"))) {
    if (!publicKeyIdPattern.test(keyId) || typeof encodedKey !== "string" || encodedKey.length > 128) {
      throw new Error(`${label} contains an invalid public key`);
    }
    const rawKey = Buffer.from(encodedKey, "base64");
    if (rawKey.length !== 32 || rawKey.toString("base64") !== encodedKey) {
      throw new Error(`${label} contains an invalid public key`);
    }
    normalized[keyId] = encodedKey;
  }
  return normalized;
}

export async function readPublicKeyMapFile(target, label) {
  const file = path.resolve(requireText(target, `${label} file path`));
  const bytes = await readBoundedRegularFile(file, label);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
  return normalizePublicKeyMap(value, label);
}

async function readBoundedRegularFile(file, label) {
  const before = await lstat(file).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink() || before.size > maxPublicKeyMapBytes) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
  if (!handle) throw new Error(`${label} must be a bounded regular file`);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error(`${label} must be a bounded regular file`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length > maxPublicKeyMapBytes || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error(`${label} changed during read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function validateVersions(value) {
  if (!Array.isArray(value) || value.length !== 2 || value[0] === value[1] || !value.every(version => /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version))) {
    throw new Error("versions must contain two distinct semantic versions");
  }
  return [...value];
}

function validDate(value, label) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid date`);
  return date;
}

async function requireDirectory(target, label) {
  const info = await lstat(target).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
}

async function requireMissing(target, message) {
  const info = await lstat(target).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info) throw new Error(message);
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function runCLI() {
  const { values } = parseArgs({ options: {
    cache: { type: "string" },
    output: { type: "string" },
    "feed-base-url": { type: "string", default: "" },
    "activation-endpoint": { type: "string" },
    "activation-public-keys": { type: "string" },
    "license-status-endpoint": { type: "string" },
    "license-status-public-keys": { type: "string" },
  } });
  await buildWindowsValidationKit({
    cacheDir: values.cache,
    outputDir: values.output,
    feedBaseURL: values["feed-base-url"],
    activationServiceEndpoint: values["activation-endpoint"],
    activationPublicKeys: await readPublicKeyMapFile(values["activation-public-keys"], "activation public keys"),
    licenseStatusEndpoint: values["license-status-endpoint"],
    licenseStatusPublicKeys: await readPublicKeyMapFile(values["license-status-public-keys"], "license status public keys"),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCLI().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
