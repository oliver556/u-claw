import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { createPackage } from "@electron/asar";
import { build as bundle } from "esbuild";

import { inventoryRuntime } from "./build-runtime.mjs";

const execFileAsync = promisify(execFile);
const versions = JSON.parse(await readFile(new URL("../runtime-versions.json", import.meta.url), "utf8"));
const shaPattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const versionPattern = /^\d+\.\d+\.\d+(?:-\d+)?$/u;

export function createRuntimeProvenance({ commitSha, treeSha256, fileCount, unpackedBytes, host, toolVersions }) {
  return validateRuntimeProvenance({
    schemaVersion: 1,
    runtimeKind: "final",
    commitSha,
    buildHost: { os: host.os, arch: host.arch, runner: host.runner },
    toolVersions,
    artifact: {
      path: "windows-runtime",
      hashAlgorithm: "sha256",
      treeSha256,
      fileCount,
      unpackedBytes,
    },
  });
}

export function validateRuntimeProvenance(value) {
  const fail = (message) => { throw new Error(`invalid runtime provenance: ${message}`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("must be an object");
  const exact = (object, expected, label) => {
    const actual = Object.keys(object).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) fail(`${label} fields are invalid`);
  };
  exact(value, ["schemaVersion", "runtimeKind", "commitSha", "buildHost", "toolVersions", "artifact"], "top-level");
  if (value.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (value.runtimeKind !== "final") fail("runtimeKind must be final");
  if (!commitPattern.test(value.commitSha)) fail("commitSha must be a full lowercase SHA");
  if (!value.buildHost || typeof value.buildHost !== "object") fail("buildHost is required");
  exact(value.buildHost, ["os", "arch", "runner"], "buildHost");
  if (value.buildHost.os !== "win32" || value.buildHost.arch !== "x64") fail("buildHost must be win32/x64");
  if (typeof value.buildHost.runner !== "string" || value.buildHost.runner.length < 1 || value.buildHost.runner.length > 128) fail("buildHost.runner is invalid");
  if (!value.toolVersions || typeof value.toolVersions !== "object") fail("toolVersions is required");
  exact(value.toolVersions, ["node", "npm", "electron", "openclaw"], "toolVersions");
  for (const [name, version] of Object.entries(value.toolVersions)) {
    if (typeof version !== "string" || !versionPattern.test(version)) fail(`toolVersions.${name} is invalid`);
  }
  if (value.toolVersions.node !== versions.node || value.toolVersions.electron !== versions.electron || value.toolVersions.openclaw !== versions.openclaw) {
    fail("tool versions do not match repository pins");
  }
  if (!value.artifact || typeof value.artifact !== "object") fail("artifact is required");
  exact(value.artifact, ["path", "hashAlgorithm", "treeSha256", "fileCount", "unpackedBytes"], "artifact");
  if (value.artifact.path !== "windows-runtime" || value.artifact.hashAlgorithm !== "sha256") fail("artifact identity is invalid");
  if (!shaPattern.test(value.artifact.treeSha256)) fail("artifact treeSha256 is invalid");
  if (!Number.isSafeInteger(value.artifact.fileCount) || value.artifact.fileCount < 1) fail("artifact fileCount is invalid");
  if (!Number.isSafeInteger(value.artifact.unpackedBytes) || value.artifact.unpackedBytes < 1) fail("artifact unpackedBytes is invalid");
  return value;
}

async function requireRegularFile(file, label) {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return info;
}

export async function assertWindowsPeExecutable(file) {
  await requireRegularFile(file, "Electron executable");
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const view = header.subarray(0, bytesRead);
    if (view.length >= 4 && ["cffaedfe", "cefaedfe", "feedfacf", "feedface"].includes(view.subarray(0, 4).toString("hex"))) {
      throw new Error("Electron executable is Mach-O, not Windows PE");
    }
    if (view.length < 0x40 || view.subarray(0, 2).toString("ascii") !== "MZ") throw new Error("Electron executable is not Windows PE");
    const peOffset = view.readUInt32LE(0x3c);
    if (peOffset + 6 > view.length || view.subarray(peOffset, peOffset + 4).toString("binary") !== "PE\0\0") throw new Error("Electron executable is not Windows PE");
    if (view.readUInt16LE(peOffset + 4) !== 0x8664) throw new Error("Electron executable is not Windows x64 PE");
  } finally {
    await handle.close();
  }
}

export async function validateFinalWindowsRuntime({ runtimeDir, provenancePath, expectedCommitSha }) {
  let provenance;
  try {
    provenance = validateRuntimeProvenance(JSON.parse(await readFile(provenancePath, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("final runtime provenance is missing");
    throw error;
  }
  if (expectedCommitSha !== undefined && provenance.commitSha !== expectedCommitSha) throw new Error("runtime provenance commit mismatch");
  await assertWindowsPeExecutable(path.join(runtimeDir, "electron", "electron.exe"));
  await requireRegularFile(path.join(runtimeDir, "resources", "app.asar"), "resources/app.asar");
  const openClawPackage = JSON.parse(await readFile(path.join(runtimeDir, "node_modules", "openclaw", "package.json"), "utf8").catch(() => {
    throw new Error("locked OpenClaw runtime is missing");
  }));
  if (openClawPackage.name !== "openclaw" || openClawPackage.version !== versions.openclaw) throw new Error("locked OpenClaw runtime version mismatch");
  const inventory = await inventoryRuntime(path.resolve(runtimeDir));
  const electronExecutables = inventory.fileRecords.filter(({ path: relative }) => path.posix.basename(relative).toLowerCase() === "electron.exe");
  if (electronExecutables.length !== 1 || electronExecutables[0].path.toLowerCase() !== "electron/electron.exe") {
    throw new Error("final runtime must contain exactly one Electron executable at electron/electron.exe");
  }
  if (inventory.treeSha256 !== provenance.artifact.treeSha256 || inventory.fileCount !== provenance.artifact.fileCount || inventory.unpackedBytes !== provenance.artifact.unpackedBytes) {
    throw new Error("runtime provenance artifact hash does not match windows-runtime");
  }
  return { provenance, inventory };
}

function npmVersionFromUserAgent(userAgent) {
  return /^npm\/([^\s]+)/u.exec(userAgent ?? "")?.[1];
}

function npmCliEntrypoint(env) {
  const candidate = env.npm_execpath;
  if (typeof candidate !== "string" || candidate.length === 0) return undefined;
  return /\.(?:cjs|mjs|js)$/iu.test(candidate) ? candidate : undefined;
}

export async function npmVersion({ env = process.env, execPath = process.execPath, execFileImpl = execFileAsync } = {}) {
  const npmCli = npmCliEntrypoint(env);
  if (npmCli) {
    const { stdout } = await execFileImpl(execPath, [npmCli, "--version"], { encoding: "utf8", windowsHide: true });
    return stdout.trim();
  }
  return npmVersionFromUserAgent(env.npm_config_user_agent) ?? versions.npm;
}

async function requireMissing(target) {
  if (await lstat(target).catch(() => null)) throw new Error("final Windows runtime output already exists");
}

export async function buildFinalWindowsRuntime(options) {
  if ((options.platform ?? process.platform) !== "win32" || (options.arch ?? process.arch) !== "x64") throw new Error("final Windows runtime must be built on Windows x64");
  if (!commitPattern.test(options.commitSha ?? "")) throw new Error("full lowercase source commit SHA is required");
  const repoRoot = path.resolve(options.repoRoot);
  const productRoot = path.join(repoRoot, "product");
  const outputDir = path.resolve(options.outputDir);
  await requireMissing(outputDir);
  const electronDist = path.join(productRoot, "node_modules", "electron", "dist");
  await assertWindowsPeExecutable(path.join(electronDist, "electron.exe"));
  await requireRegularFile(path.join(productRoot, "desktop", "dist", "entry.js"), "built desktop entry");
  await requireRegularFile(path.join(productRoot, "desktop", "dist", "preload.cjs"), "built desktop preload");
  await requireRegularFile(path.join(productRoot, "frontend", "dist", "index.html"), "built frontend");
  const runtimeDependencies = path.join(productRoot, "packaging", "runtime-app", "node_modules");
  await requireRegularFile(path.join(runtimeDependencies, "openclaw", "openclaw.mjs"), "locked OpenClaw entrypoint");

  await mkdir(path.dirname(outputDir), { recursive: true });
  const temporary = await mkdtemp(path.join(path.dirname(outputDir), ".final-windows-runtime-"));
  let committed = false;
  try {
    const runtimeDir = path.join(temporary, "windows-runtime");
    const appStage = path.join(temporary, ".app-stage");
    await cp(electronDist, path.join(runtimeDir, "electron"), { recursive: true, verbatimSymlinks: true });
    await cp(runtimeDependencies, path.join(runtimeDir, "node_modules"), {
      recursive: true,
      verbatimSymlinks: true,
      filter: (source) => path.basename(source) !== ".bin",
    });
    await mkdir(path.join(appStage, "desktop", "dist"), { recursive: true });
    await mkdir(path.join(appStage, "frontend"), { recursive: true });
    await bundle({
      entryPoints: [path.join(productRoot, "desktop", "dist", "entry.js")],
      outfile: path.join(appStage, "desktop", "dist", "entry.js"),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
      external: ["electron"],
      logLevel: "silent",
    });
    await cp(path.join(productRoot, "desktop", "dist", "preload.cjs"), path.join(appStage, "desktop", "dist", "preload.cjs"));
    await cp(path.join(productRoot, "desktop", "dist", "openclaw-extensions"), path.join(appStage, "desktop", "dist", "openclaw-extensions"), { recursive: true });
    await cp(path.join(productRoot, "frontend", "dist"), path.join(appStage, "frontend", "dist"), { recursive: true });
    await writeFile(path.join(appStage, "package.json"), `${JSON.stringify({ name: "u-claw", version: "0.1.0", private: true, type: "module", main: "desktop/dist/entry.js" }, null, 2)}\n`);
    await mkdir(path.join(runtimeDir, "resources"), { recursive: true });
    await createPackage(appStage, path.join(runtimeDir, "resources", "app.asar"));
    await rm(appStage, { recursive: true, force: true });

    const inventory = await inventoryRuntime(runtimeDir);
    const provenance = createRuntimeProvenance({
      commitSha: options.commitSha,
      treeSha256: inventory.treeSha256,
      fileCount: inventory.fileCount,
      unpackedBytes: inventory.unpackedBytes,
      host: { os: "win32", arch: "x64", runner: options.runner ?? process.env.RUNNER_IMAGE ?? "windows-x64" },
      toolVersions: { node: process.versions.node, npm: await npmVersion(), electron: versions.electron, openclaw: versions.openclaw },
    });
    const provenancePath = path.join(temporary, "runtime-provenance.json");
    await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, { flag: "wx" });
    await validateFinalWindowsRuntime({ runtimeDir, provenancePath, expectedCommitSha: options.commitSha });
    await rename(temporary, outputDir);
    committed = true;
    return provenance;
  } finally {
    if (!committed) await rm(temporary, { recursive: true, force: true });
  }
}

async function runCli() {
  const command = process.argv[2];
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      "repo-root": { type: "string", default: fileURLToPath(new URL("../..", import.meta.url)) },
      output: { type: "string", default: "product/dist/final-windows-runtime" },
      commit: { type: "string" },
      runtime: { type: "string", default: "product/dist/final-windows-runtime/windows-runtime" },
      provenance: { type: "string", default: "product/dist/final-windows-runtime/runtime-provenance.json" },
    },
  });
  if (command === "build") {
    const result = await buildFinalWindowsRuntime({ repoRoot: values["repo-root"], outputDir: values.output, commitSha: values.commit ?? process.env.GITHUB_SHA });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "validate") {
    const result = await validateFinalWindowsRuntime({ runtimeDir: values.runtime, provenancePath: values.provenance, expectedCommitSha: values.commit });
    process.stdout.write(`${JSON.stringify(result.provenance, null, 2)}\n`);
    return;
  }
  throw new Error("usage: final-windows-runtime.mjs <build|validate>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
