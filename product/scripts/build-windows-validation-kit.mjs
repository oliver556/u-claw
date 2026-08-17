import { execFile } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
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
  const usbDrive = validateUSBDrive(options.usbDrive ?? "U:");
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
    const trustedKeys = JSON.stringify({ [keyId]: rawPublicKey });
    const launcherPath = path.join(temporaryRoot, "U-Claw.exe");
    await runGoBuild(runner, path.join(productRoot, "launcher"), launcherPath, [
      "-X", `main.trustedRuntimeKeys=${trustedKeys}`,
      "-X", "main.revokedRuntimeKeyIDs=[]",
      "-X", `main.releaseFeedBaseURL=${options.feedBaseURL ?? ""}`,
    ]);

    const usbDir = path.join(handoffDir, "U-Claw-test-USB");
    await runNodeScript(runner, productRoot, "packaging/build-release.mjs", [
      "--launcher", launcherPath,
      "--runtime-package", runtimePackages[0],
      "--manifest", manifestPaths[0],
      "--public-key", publicKeyPath,
      "--output", usbDir,
    ]);
    await writeInitialOpenClawConfig(usbDir, usbDrive);

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
    await writeFile(path.join(handoffDir, "README.txt"), validationReadme(versions, usbDrive), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    await validateHandoff(handoffDir);
    await requireMissing(outputDir, "validation kit output already exists");
    await rename(handoffDir, outputDir);
    logger(`Windows validation kit written to ${outputDir}`);
    return { handoffDir: outputDir, temporaryRoot };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function writeInitialOpenClawConfig(usbDir, usbDrive) {
  const dataDirectory = path.join(usbDir, ".uclaw", "data");
  const openClawDirectory = path.join(dataDirectory, ".openclaw");
  await mkdir(path.join(dataDirectory, "workspace"), { recursive: true });
  await mkdir(openClawDirectory, { mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  const workspace = `${usbDrive}\\.uclaw\\data\\workspace`;
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

async function runGoBuild(runner, cwd, output, linkerValues = []) {
  const linkerFlags = ["-s", "-w", "-H", "windowsgui", ...linkerValues].join(" ");
  return runner("go", ["build", "-trimpath", "-ldflags", linkerFlags, "-o", output, "."], {
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

function validationReadme(versions, usbDrive) {
  return [
    "U-Claw Windows validation kit",
    "",
    `Initial version: ${versions[0]}`,
    `Update version: ${versions[1]}`,
    `Expected USB drive during validation: ${usbDrive}`,
    "",
    "1. Copy only the contents of U-Claw-test-USB to the root of the test USB drive.",
    "2. On Windows 10 or 11, disconnect the network and double-click U-Claw.exe.",
    "3. Confirm the U-Claw window and local Gateway become ready, then close U-Claw.",
    "4. Copy U-Claw-Update-test.exe to the USB root and run it.",
    "5. Double-click U-Claw.exe again and confirm the updated version starts.",
    "6. Repeat after changing USB ports and on a second Windows computer.",
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

function validateUSBDrive(value) {
  if (!/^[A-Za-z]:$/u.test(value ?? "")) throw new Error("usbDrive must be a Windows drive letter");
  return value.toUpperCase();
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
    "usb-drive": { type: "string", default: "U:" },
    "feed-base-url": { type: "string", default: "" },
  } });
  await buildWindowsValidationKit({
    cacheDir: values.cache,
    outputDir: values.output,
    usbDrive: values["usb-drive"],
    feedBaseURL: values["feed-base-url"],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCLI().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
