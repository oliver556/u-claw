import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { releaseSigningPayload } from "../packaging/build-update-feed.mjs";
import { extractOfflinePayload } from "../packaging/build-offline-updater.mjs";
import {
  runtimeManifestSigningPayload,
  verifySignedRuntimeManifest,
} from "./runtime-manifest.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("build-windows-validation-kit.mjs", import.meta.url));
const productRoot = fileURLToPath(new URL("../", import.meta.url));
const expectedHandoff = [
  "README.txt",
  "U-Claw-Update-test.exe",
  "U-Claw-test-USB",
  "online-feed",
  "test-public.pem",
];

test("validation kit requires formal real-runtime packaging scripts", async () => {
  const source = await readFile(scriptPath, "utf8");
  assert.match(source, /build-windows-runtime\.mjs/u);
  assert.match(source, /build-runtime\.mjs/u);
  assert.match(source, /build-release\.mjs/u);
  assert.match(source, /build-update-feed\.mjs/u);
  assert.match(source, /build-offline-updater\.mjs/u);
  assert.doesNotMatch(source, /portable-runtime\.go/u);
});

test("builds an exact secret-free handoff with distinct signed runtimes", async (t) => {
  const fixture = await createFixture(t);
  const calls = [];
  const logs = [];
  const result = await fixture.build({ calls, logs });

  assert.deepEqual((await readdir(result.handoffDir)).sort(), expectedHandoff.toSorted());
  assert.deepEqual(calls.map(callName), [
    "build-windows-runtime.mjs",
    "build-windows-runtime.mjs",
    "build-runtime.mjs",
    "build-runtime.mjs",
    "go:launcher",
    "build-release.mjs",
    "build-update-feed.mjs",
    "go:offline-updater",
    "build-offline-updater.mjs",
  ]);
  assert.equal(calls[0].args.includes("--cache"), true);
  assert.notEqual(argumentAfter(calls[0].args, "--output"), argumentAfter(calls[1].args, "--output"));

  const usb = path.join(result.handoffDir, "U-Claw-test-USB");
  assert.deepEqual((await readdir(usb)).sort(), [".uclaw", "U-Claw.exe"]);
  assert.deepEqual((await readdir(path.join(usb, ".uclaw"))).sort(), ["data", "runtime.pkg", "version.json"]);
  const initialManifest = JSON.parse(await readFile(path.join(usb, ".uclaw", "version.json"), "utf8"));
  const publicKey = await readFile(path.join(result.handoffDir, "test-public.pem"), "utf8");
  verifySignedRuntimeManifest(initialManifest, { [initialManifest.signature.keyId]: publicKey });
  assert.equal(verify(null, runtimeManifestSigningPayload(initialManifest), publicKey, Buffer.from(initialManifest.signature.value, "base64")), true);

  const feed = JSON.parse(await readFile(path.join(result.handoffDir, "online-feed", "stable.json"), "utf8"));
  verifySignedRuntimeManifest(feed.runtimeManifest, { [feed.runtimeManifest.signature.keyId]: publicKey });
  assert.equal(verify(null, releaseSigningPayload(feed), publicKey, Buffer.from(feed.signature.value, "base64")), true);
  assert.notEqual(initialManifest.runtimeSha256, feed.runtimeManifest.runtimeSha256);
  assert.notEqual(initialManifest.runtimeTreeSha256, feed.runtimeManifest.runtimeTreeSha256);

  const offline = await extractOfflinePayload(path.join(result.handoffDir, "U-Claw-Update-test.exe"));
  assert.deepEqual(JSON.parse(offline.manifest), feed);
  assert.deepEqual(offline.runtime, await readFile(path.join(result.handoffDir, "online-feed", "packages", feed.id, "runtime.pkg")));

  const configPath = path.join(usb, ".uclaw", "data", ".openclaw", "openclaw.json");
  const configInfo = await lstat(configPath);
  assert.equal(configInfo.mode & 0o777, 0o600);
  const configText = await readFile(configPath, "utf8");
  const config = JSON.parse(configText);
  const workspace = "U:\\.uclaw\\data\\workspace";
  assert.deepEqual(config, {
    gateway: { mode: "local", bind: "loopback", auth: { mode: "token", token: config.gateway.auth.token } },
    agents: {
      defaults: { workspace, skipBootstrap: true },
      list: [{ id: "main", default: true, workspace }],
    },
  });
  assert.match(config.gateway.auth.token, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(configText.includes(productRoot), false);

  const deliveredFiles = await walkFiles(result.handoffDir);
  const leakedPrivateKeys = [];
  let tokenOccurrences = 0;
  for (const file of deliveredFiles) {
    const bytes = await readFile(file);
    if (bytes.includes(Buffer.from("PRIVATE KEY-----"))) leakedPrivateKeys.push(file);
    tokenOccurrences += count(bytes.toString("utf8"), config.gateway.auth.token);
  }
  assert.deepEqual(leakedPrivateKeys, []);
  assert.equal(tokenOccurrences, 1);
  assert.equal(logs.some(line => line.includes(config.gateway.auth.token) || line.includes("PRIVATE KEY-----")), false);
  assert.equal(deliveredFiles.some(file => /(?:cache|node_modules|runtime-source|\.log$)/iu.test(path.relative(result.handoffDir, file))), false);
  assert.equal(await exists(result.temporaryRoot), false);
});

test("refuses existing output and removes partial output after failure", async (t) => {
  const existing = await createFixture(t);
  await mkdir(existing.outputDir);
  await writeFile(path.join(existing.outputDir, "keep.txt"), "keep");
  await assert.rejects(existing.build(), /already exists/iu);
  assert.equal(await readFile(path.join(existing.outputDir, "keep.txt"), "utf8"), "keep");

  const failed = await createFixture(t, { failAt: "build-update-feed.mjs" });
  await assert.rejects(failed.build(), /injected runner failure/iu);
  assert.equal(await exists(failed.outputDir), false);
  assert.equal(await exists(failed.temporaryRoot), false);

  const raced = await createFixture(t, { failAt: "build-update-feed.mjs", createOutputBeforeFailure: true });
  await assert.rejects(raced.build(), /injected runner failure/iu);
  assert.equal(await readFile(path.join(raced.outputDir, "external.txt"), "utf8"), "external");
});

async function createFixture(t, { failAt, createOutputBeforeFailure = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "uclaw-validation-kit-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "handoff");
  const cacheDir = path.join(root, "cache");
  const temporaryRoot = path.join(root, "private-temporary");
  await mkdir(cacheDir);
  const injectedKeys = generateKeyPairSync("ed25519");

  return {
    outputDir,
    temporaryRoot,
    async build({ calls = [], logs = [] } = {}) {
      const { buildWindowsValidationKit } = await import("./build-windows-validation-kit.mjs");
      const runner = async (command, args, options = {}) => {
        const call = { command, args: [...args], options };
        calls.push(call);
        const name = callName(call);
        if (name === failAt) {
          if (createOutputBeforeFailure) {
            await mkdir(outputDir);
            await writeFile(path.join(outputDir, "external.txt"), "external");
          }
          throw new Error("injected runner failure");
        }
        if (name === "build-windows-runtime.mjs") {
          await createTinyRealRuntime(argumentAfter(args, "--output"));
          return { stdout: "", stderr: "" };
        }
        if (name === "go:launcher" || name === "go:offline-updater") {
          const output = argumentAfter(args, "-o");
          await mkdir(path.dirname(output), { recursive: true });
          await writeFile(output, name === "go:launcher" ? "MZ-launcher" : "MZ-updater");
          await chmod(output, 0o755);
          return { stdout: "", stderr: "" };
        }
        return execFileAsync(command, args, { ...options, env: { ...process.env, ...options.env } });
      };
      return buildWindowsValidationKit({
        cacheDir,
        outputDir,
        productRoot,
        usbDrive: "U:",
        versions: ["1.0.0", "2.0.0"],
        now: new Date("2026-08-17T00:00:00.000Z"),
        runner,
        logger: line => logs.push(String(line)),
        temporaryRoot,
        signingKeyPair: injectedKeys,
      });
    },
  };
}

async function createTinyRealRuntime(output) {
  await mkdir(path.join(output, "electron", "resources", "app", "node_modules", "openclaw"), { recursive: true });
  await mkdir(path.join(output, "node"), { recursive: true });
  await writeFile(path.join(output, "electron", "electron.exe"), "real electron executable");
  await writeFile(path.join(output, "electron", "resources", "app", "node_modules", "openclaw", "openclaw.mjs"), "export {};\n");
  await writeFile(path.join(output, "node", "node.exe"), "real node executable");
}

function callName({ command, args, options }) {
  if (path.basename(command) === "go") {
    return options.cwd.endsWith(`${path.sep}launcher`) ? "go:launcher" : "go:offline-updater";
  }
  return path.basename(args[0] ?? command);
}

function argumentAfter(args, name) {
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `missing ${name}`);
  return args[index + 1];
}

async function walkFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else files.push(target);
    }
  }
  await visit(root);
  return files;
}

async function exists(target) {
  return lstat(target).then(() => true, error => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

function count(value, needle) {
  return value.split(needle).length - 1;
}
