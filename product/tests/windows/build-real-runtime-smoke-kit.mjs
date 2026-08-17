import { execFile } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { fetchRuntimeArtifact } from "../../packaging/fetch-runtime-artifact.mjs";
import { buildWindowsValidationKit } from "../../scripts/build-windows-validation-kit.mjs";

const execFileAsync = promisify(execFile);
const productRoot = fileURLToPath(new URL("../../", import.meta.url));
const versions = JSON.parse(await readFile(new URL("../../runtime-versions.json", import.meta.url), "utf8"));
const fixtureFingerprint = "f".repeat(64);

function required(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return path.resolve(value);
}

async function sha256(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

async function ensureArtifact(cacheDir, artifact, maxBytes) {
  const target = path.join(cacheDir, path.basename(new URL(artifact.url).pathname));
  const info = await lstat(target).catch(error => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (info !== undefined) {
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes || await sha256(target) !== artifact.sha256) {
      throw new Error("runtime cache contains an invalid artifact");
    }
    return target;
  }
  await fetchRuntimeArtifact({
    url: artifact.url,
    output: target,
    sha256: artifact.sha256,
    maxBytes,
  });
  return target;
}

function linkerJSON(value) {
  return `base64:${Buffer.from(JSON.stringify(value), "utf8").toString("base64")}`;
}

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    ...options,
    env: { ...process.env, ...options.env },
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function buildFixtureLauncher(output, runtimePublicKey, licenseKeys) {
  const pem = await readFile(runtimePublicKey, "utf8");
  const jwk = createPublicKey(pem).export({ format: "jwk" });
  if (typeof jwk.x !== "string") throw new Error("runtime public key export failed");
  const runtimeKeys = {
    "windows-validation-key": Buffer.from(jwk.x, "base64url").toString("base64"),
  };
  const linkerFlags = [
    "-s", "-w", "-H", "windowsgui",
    "-X", `main.trustedRuntimeKeys=${linkerJSON(runtimeKeys)}`,
    "-X", "main.revokedRuntimeKeyIDs=[]",
    "-X", "main.releaseFeedBaseURL=",
    "-X", "main.activationServiceEndpoint=https://activation.invalid/",
    "-X", `main.trustedStartupLicenseKeys=${linkerJSON(licenseKeys)}`,
    "-X", "main.licenseStatusEndpoint=https://license-status.invalid/",
    "-X", `main.trustedLicenseStatusKeys=${linkerJSON(licenseKeys)}`,
  ].join(" ");
  await run("go", [
    "build", "-trimpath", "-tags", "licensefixture",
    "-ldflags", linkerFlags, "-o", output, ".",
  ], {
    cwd: path.join(productRoot, "launcher"),
    env: { CGO_ENABLED: "0", GOOS: "windows", GOARCH: "amd64" },
  });
}

async function main() {
  const { values } = parseArgs({ options: {
    cache: { type: "string" },
    output: { type: "string" },
  } });
  const cacheDir = required(values.cache, "cache");
  const outputDir = required(values.output, "output");
  const existingOutput = await lstat(outputDir).catch(error => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (existingOutput !== undefined) throw new Error("real runtime smoke output already exists");
  await mkdir(cacheDir, { recursive: true });
  await Promise.all([
    ensureArtifact(cacheDir, versions.windowsArtifacts.electron, 256 * 1024 * 1024),
    ensureArtifact(cacheDir, versions.windowsArtifacts.node, 128 * 1024 * 1024),
  ]);

  const temporary = await mkdtemp(path.join(path.dirname(outputDir), ".real-runtime-smoke-"));
  let published = false;
  try {
    const fixtureLicense = path.join(temporary, "license");
    const fixtureKeysPath = path.join(temporary, "license-public-keys.json");
    await run(process.execPath, [
      path.join(productRoot, "tests", "windows", "sign-license-fixture.mjs"),
      "--license-dir", fixtureLicense,
      "--trusted-keys", fixtureKeysPath,
    ]);
    const licenseKeys = JSON.parse(await readFile(fixtureKeysPath, "utf8"));

    await buildWindowsValidationKit({
      cacheDir,
      outputDir,
      feedBaseURL: "",
      activationServiceEndpoint: "https://activation.invalid/",
      activationPublicKeys: licenseKeys,
      licenseStatusEndpoint: "https://license-status.invalid/",
      licenseStatusPublicKeys: licenseKeys,
      versions: ["1.0.0", "2.0.0"],
    });
    published = true;

    const usbRoot = path.join(outputDir, "U-Claw-test-USB");
    const licenseDir = path.join(usbRoot, ".uclaw", "license");
    await mkdir(licenseDir, { recursive: true });
    await cp(fixtureLicense, licenseDir, { recursive: true, force: false, errorOnExist: true });
    await buildFixtureLauncher(
      path.join(usbRoot, "U-Claw.exe"),
      path.join(outputDir, "test-public.pem"),
      licenseKeys,
    );
    const license = JSON.parse(await readFile(path.join(licenseDir, "license.json"), "utf8"));
    if (license.usbFingerprint?.sha256 !== fixtureFingerprint) {
      throw new Error("fixture license fingerprint mismatch");
    }
  } catch (error) {
    if (published) await rm(outputDir, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch(() => {
  process.stderr.write("Real Windows runtime smoke kit build failed\n");
  process.exitCode = 1;
});
