import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";

import {
  buildWindowsRuntime,
  inspectWindowsRuntimeZip,
  runWindowsRuntimeCLI,
} from "../../packaging/build-windows-runtime.mjs";

const execFileAsync = promisify(execFile);
const nodeArchiveRoot = "node-v24.15.0-win-x64";
const fixtureRoots = new Set();

after(async () => {
  await Promise.all([...fixtureRoots].map((root) => rm(root, { recursive: true, force: true })));
});

async function writeZip(file, entries, platform = "DOS", compression = "DEFLATE") {
  const zip = new JSZip();
  for (const entry of entries) {
    zip.file(entry.name, entry.body ?? "fixture", {
      createFolders: false,
      dir: entry.dir ?? false,
      unixPermissions: entry.unixPermissions,
    });
  }
  let bytes = await zip.generateAsync({ type: "nodebuffer", platform, compression });
  for (const entry of entries.filter((candidate) => candidate.forceEmptyDeflate)) {
    bytes = forceEmptyDeflate(bytes, entry.name);
  }
  await writeFile(file, bytes);
}

function findCentralEntry(bytes, entryName) {
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const expected = Buffer.from(entryName);
  let offset = bytes.indexOf(signature);
  while (offset !== -1) {
    const nameLength = bytes.readUInt16LE(offset + 28);
    if (bytes.subarray(offset + 46, offset + 46 + nameLength).equals(expected)) return offset;
    offset = bytes.indexOf(signature, offset + 4);
  }
  throw new Error(`missing central entry: ${entryName}`);
}

function patchEntryName(bytes, from, to) {
  assert.equal(Buffer.byteLength(from), Buffer.byteLength(to));
  const patched = Buffer.from(bytes);
  const centralOffset = findCentralEntry(patched, from);
  const localOffset = patched.readUInt32LE(centralOffset + 42);
  Buffer.from(to).copy(patched, centralOffset + 46);
  Buffer.from(to).copy(patched, localOffset + 30);
  return patched;
}

function patchEntryField(bytes, entryName, centralFieldOffset, localFieldOffset, value) {
  const patched = Buffer.from(bytes);
  const centralOffset = findCentralEntry(patched, entryName);
  const localOffset = patched.readUInt32LE(centralOffset + 42);
  patched.writeUInt32LE(value, centralOffset + centralFieldOffset);
  if (localFieldOffset !== undefined) patched.writeUInt32LE(value, localOffset + localFieldOffset);
  return patched;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function forceEmptyDeflate(bytes, entryName) {
  const name = Buffer.from(entryName);
  let centralOffset = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  while (centralOffset !== -1) {
    const nameLength = bytes.readUInt16LE(centralOffset + 28);
    if (bytes.subarray(centralOffset + 46, centralOffset + 46 + nameLength).equals(name)) break;
    centralOffset = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), centralOffset + 4);
  }
  assert.notEqual(centralOffset, -1);
  const localOffset = bytes.readUInt32LE(centralOffset + 42);
  const dataOffset = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
  const patched = Buffer.concat([bytes.subarray(0, dataOffset), Buffer.from([0x03, 0x00]), bytes.subarray(dataOffset)]);
  const shiftedCentral = centralOffset + 2;
  patched.writeUInt16LE(8, localOffset + 8);
  patched.writeUInt32LE(2, localOffset + 18);
  patched.writeUInt16LE(8, shiftedCentral + 10);
  patched.writeUInt32LE(2, shiftedCentral + 20);
  const endOffset = patched.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  patched.writeUInt32LE(patched.readUInt32LE(endOffset + 16) + 2, endOffset + 16);
  return patched;
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-windows-runtime-"));
  fixtureRoots.add(root);
  const electronArchive = path.join(root, "electron.zip");
  const nodeArchive = path.join(root, "node.zip");
  await writeZip(electronArchive, [
    { name: "electron.exe", body: "electron" },
    { name: "resources/default_app.asar", body: "default" },
    { name: "resources/empty.bin", body: Buffer.alloc(0), forceEmptyDeflate: true },
  ]);
  await writeZip(nodeArchive, [
    { name: `${nodeArchiveRoot}/node.exe`, body: "node" },
    { name: `${nodeArchiveRoot}/README.md`, body: "readme" },
  ]);

  const appDependencyRoot = path.join(root, "app-dependencies");
  await mkdir(path.join(appDependencyRoot, "node_modules", "openclaw"), { recursive: true });
  await writeFile(path.join(appDependencyRoot, "package.json"), JSON.stringify({ name: "fixture", main: "desktop/dist/entry.js" }));
  await writeFile(path.join(appDependencyRoot, "node_modules", "openclaw", "openclaw.mjs"), "export default true;");

  const portableSkillsRoot = path.join(root, "portable-skills");
  await mkdir(path.join(portableSkillsRoot, "alpha-skill"), { recursive: true });
  await writeFile(path.join(portableSkillsRoot, "alpha-skill", "SKILL.md"), "# Alpha skill\n");

  const roots = {};
  for (const [name, required] of [
    ["desktop", "entry.js"],
    ["frontend", "index.html"],
    ["adapter", "index.js"],
    ["shared", "index.js"],
  ]) {
    roots[`${name}Root`] = path.join(root, name);
    await mkdir(path.join(roots[`${name}Root`], "dist"), { recursive: true });
    await writeFile(path.join(roots[`${name}Root`], "package.json"), JSON.stringify({ name: `@uclaw/${name}`, type: "module", main: `dist/${required}` }));
    await writeFile(path.join(roots[`${name}Root`], "dist", required), `${name}-build`);
  }

  return {
    root,
    options: {
      electronArchive,
      nodeArchive,
      appDependencyRoot,
      portableSkillsRoot,
      ...roots,
      outputDir: path.join(root, "runtime"),
    },
  };
}

async function hasSymlink(root) {
  for (const name of await readdir(root)) {
    const target = path.join(root, name);
    const info = await lstat(target);
    if (info.isSymbolicLink()) return true;
    if (info.isDirectory() && await hasSymlink(target)) return true;
  }
  return false;
}

async function temporaryDirectories(parent) {
  return (await readdir(parent)).filter((name) => name.startsWith(".windows-runtime-"));
}

test("assembles one complete offline Windows runtime without symlinks", async () => {
  const { options } = await fixture();
  const result = await buildWindowsRuntime(options);

  assert.equal(result.outputDir, path.resolve(options.outputDir));
  for (const relative of [
    "electron/electron.exe",
    "electron/resources/app/package.json",
    "electron/resources/app/desktop/dist/entry.js",
    "electron/resources/app/frontend/dist/index.html",
    "electron/resources/app/adapter/dist/index.js",
    "electron/resources/app/shared/dist/index.js",
    "electron/resources/app/node_modules/openclaw/openclaw.mjs",
    "electron/resources/portable/skills-cn/alpha-skill/SKILL.md",
    "electron/resources/app/node_modules/@uclaw/adapter/dist/index.js",
    "electron/resources/app/node_modules/@uclaw/shared/dist/index.js",
    "node/node.exe",
  ]) assert.equal((await lstat(path.join(result.outputDir, relative))).isFile(), true, relative);
  assert.equal(await readFile(path.join(result.outputDir, "electron/resources/portable/skills-cn/alpha-skill/SKILL.md"), "utf8"), "# Alpha skill\n");
  assert.equal(await readFile(path.join(result.outputDir, "node", "node.exe"), "utf8"), "node");
  assert.equal(await hasSymlink(result.outputDir), false);
});

test("assembles stored ZIP entries", async () => {
  const { options } = await fixture();
  await writeZip(options.electronArchive, [
    { name: "electron.exe", body: "electron" },
    { name: "resources/default_app.asar", body: "default" },
  ], "DOS", "STORE");
  await writeZip(options.nodeArchive, [
    { name: `${nodeArchiveRoot}/node.exe`, body: "node" },
  ], "DOS", "STORE");
  await buildWindowsRuntime(options);
  assert.equal(await readFile(path.join(options.outputDir, "electron", "electron.exe"), "utf8"), "electron");
  assert.equal(await readFile(path.join(options.outputDir, "node", "node.exe"), "utf8"), "node");
});

test("rejects corrupt ZIP CRC, declared size, partial data, and truncation", async (t) => {
  for (const [name, mutate, message] of [
    ["CRC", (bytes) => patchEntryField(bytes, "electron.exe", 16, 14, 0), /corrupt ZIP entry/i],
    ["declared size", (bytes) => patchEntryField(bytes, "electron.exe", 24, 22, 9), /corrupt ZIP entry|invalid compressed ZIP entry/i],
    ["partial data", (bytes) => {
      const central = findCentralEntry(bytes, "electron.exe");
      const compressed = bytes.readUInt32LE(central + 20);
      return patchEntryField(bytes, "electron.exe", 20, 18, compressed - 1);
    }, /corrupt ZIP entry|invalid compressed ZIP entry/i],
    ["truncated", (bytes) => bytes.subarray(0, bytes.length - 1), /invalid ZIP/i],
  ]) {
    await t.test(name, async () => {
      const { options } = await fixture();
      await writeFile(options.electronArchive, mutate(await readFile(options.electronArchive)));
      await assert.rejects(buildWindowsRuntime(options), message);
    });
  }
});

test("rejects duplicate and case-conflicting ZIP entries", async (t) => {
  await t.test("duplicate", async () => {
    const { options } = await fixture();
    await writeZip(options.electronArchive, [
      { name: "electron.exe" },
      { name: "secondxx.exe" },
    ]);
    await writeFile(options.electronArchive, patchEntryName(await readFile(options.electronArchive), "secondxx.exe", "electron.exe"));
    await assert.rejects(buildWindowsRuntime(options), /duplicate archive path/i);
  });
  await t.test("case conflict", async () => {
    const { options } = await fixture();
    await writeZip(options.electronArchive, [
      { name: "electron.exe" },
      { name: "ELECTRON.EXE" },
    ]);
    await assert.rejects(buildWindowsRuntime(options), /duplicate archive path/i);
  });
});

test("enforces injectable ZIP entry and total byte budgets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-windows-runtime-budget-"));
  fixtureRoots.add(root);
  const archive = path.join(root, "budget.zip");
  await writeZip(archive, [
    { name: "one", body: "123" },
    { name: "two", body: "456" },
  ], "DOS", "STORE");
  const bytes = await readFile(archive);
  assert.throws(() => inspectWindowsRuntimeZip(bytes, { maxArchiveBytes: 1024, maxFileBytes: 10, maxTreeBytes: 100, maxTreeEntries: 1 }), /entry count limit/i);
  assert.throws(() => inspectWindowsRuntimeZip(bytes, { maxArchiveBytes: 1024, maxFileBytes: 10, maxTreeBytes: 5, maxTreeEntries: 10 }), /total size limit/i);
});

test("rejects each missing production build", async (t) => {
  for (const name of ["desktop", "frontend", "adapter", "shared"]) {
    await t.test(name, async () => {
      const { options } = await fixture();
      options[`${name}Root`] = path.join(path.dirname(options[`${name}Root`]), `missing-${name}`);
      await assert.rejects(buildWindowsRuntime(options), new RegExp(`${name} build`, "i"));
    });
  }
});

test("rejects Windows-unsafe ZIP entry paths", async (t) => {
  for (const unsafe of ["../escape", "C:/drive", "back\\slash", "NUL.txt", "name:stream"]) {
    await t.test(unsafe, async () => {
      const { options } = await fixture();
      await writeZip(options.electronArchive, [
        { name: "electron.exe" },
        { name: unsafe },
      ]);
      await assert.rejects(buildWindowsRuntime(options), /unsafe archive path/i);
    });
  }
});

test("rejects ZIP symlink and special entries", async (t) => {
  for (const [name, mode] of [["symlink", 0o120777], ["fifo", 0o010644]]) {
    await t.test(name, async () => {
      const { options } = await fixture();
      await writeZip(options.electronArchive, [
        { name: "electron.exe", unixPermissions: 0o100644 },
        { name, body: "target", unixPermissions: mode },
      ], "UNIX");
      await assert.rejects(buildWindowsRuntime(options), /unsupported archive entry/i);
    });
  }
});

test("rejects a second Electron executable", async () => {
  const { options } = await fixture();
  await writeZip(options.electronArchive, [
    { name: "electron.exe" },
    { name: "activation.exe" },
  ]);
  await assert.rejects(buildWindowsRuntime(options), /exactly one Electron executable/i);
});

test("rejects abnormal Node archive layout and multiple node.exe files", async (t) => {
  await t.test("wrong layout", async () => {
    const { options } = await fixture();
    await writeZip(options.nodeArchive, [{ name: "node.exe" }]);
    await assert.rejects(buildWindowsRuntime(options), /Node archive layout/i);
  });
  await t.test("multiple node.exe", async () => {
    const { options } = await fixture();
    await writeZip(options.nodeArchive, [
      { name: `${nodeArchiveRoot}/node.exe` },
      { name: `${nodeArchiveRoot}/nested/node.exe` },
    ]);
    await assert.rejects(buildWindowsRuntime(options), /exactly one node\.exe/i);
  });
});

test("rejects symlinks in copied source trees", async (t) => {
  const { options } = await fixture();
  try {
    await symlink(path.join(options.desktopRoot, "dist", "entry.js"), path.join(options.desktopRoot, "dist", "linked.js"));
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("symlink unavailable");
      return;
    }
    throw error;
  }
  await assert.rejects(buildWindowsRuntime(options), /symlink|unsupported source entry/i);
});

test("copies complete files when FileHandle.write performs partial writes", async () => {
  const { options } = await fixture();
  const probe = await open(path.join(options.desktopRoot, "dist", "entry.js"), "r");
  const prototype = Object.getPrototypeOf(probe);
  const originalWrite = prototype.write;
  await probe.close();
  prototype.write = function writePartially(buffer, offset, length, position) {
    return originalWrite.call(this, buffer, offset, Math.min(length, 2), position);
  };
  try {
    await buildWindowsRuntime(options);
  } finally {
    prototype.write = originalWrite;
  }
  assert.equal(await readFile(path.join(options.outputDir, "electron", "resources", "app", "desktop", "dist", "entry.js"), "utf8"), "desktop-build");
});

test("rejects a source file above the per-file size limit without reading it", async () => {
  const { options } = await fixture();
  const large = path.join(options.desktopRoot, "dist", "too-large.bin");
  const handle = await open(large, "w");
  await handle.truncate(512 * 1024 * 1024 + 1);
  await handle.close();
  await assert.rejects(buildWindowsRuntime(options), /file size limit/i);
});

test("does not overwrite existing output", async () => {
  const { options } = await fixture();
  await mkdir(options.outputDir);
  await writeFile(path.join(options.outputDir, "keep"), "keep");
  await assert.rejects(buildWindowsRuntime(options), /output already exists/i);
  assert.equal(await readFile(path.join(options.outputDir, "keep"), "utf8"), "keep");
});

test("does not overwrite an empty output directory created during atomic publication", async () => {
  const { root, options } = await fixture();
  const pending = buildWindowsRuntime(options);
  for (let attempt = 0; attempt < 200 && (await temporaryDirectories(root)).length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal((await temporaryDirectories(root)).length, 1);
  await mkdir(options.outputDir);
  await assert.rejects(pending, /output already exists/i);
  assert.deepEqual(await readdir(options.outputDir), []);
  assert.deepEqual(await temporaryDirectories(root), []);
});

test("cleans temporary directory after assembly failure", async () => {
  const { root, options } = await fixture();
  options.frontendRoot = path.join(root, "missing-frontend");
  await assert.rejects(buildWindowsRuntime(options), /frontend build/i);
  assert.deepEqual(await temporaryDirectories(root), []);
});

test("package script exposes the fixed Windows runtime CLI", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.scripts["build:windows-runtime"], "node packaging/build-windows-runtime.mjs");
});

test("CLI rejects missing, duplicate, and unknown arguments before running builds", async (t) => {
  const script = new URL("../../packaging/build-windows-runtime.mjs", import.meta.url);
  for (const [name, arguments_, message] of [
    ["missing", [], /--cache and --output are required/u],
    ["duplicate", ["--cache=a", "--cache=b", "--output=c"], /duplicate argument: --cache/u],
    ["unknown", ["--cache=a", "--output=b", "--download"], /unknown argument: --download/u],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(execFileAsync(process.execPath, [fileURLToPath(script), ...arguments_]), (error) => {
        assert.match(error.stderr, message);
        assert.doesNotMatch(error.stderr, /npm ERR/u);
        return true;
      });
    });
  }
});

async function cliFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-windows-runtime-cli-"));
  fixtureRoots.add(root);
  const cache = path.join(root, "cache");
  await mkdir(cache);
  const electronName = "electron-fixture.zip";
  const nodeName = "node-fixture.zip";
  const electron = Buffer.from("electron archive");
  const node = Buffer.from("node archive");
  await writeFile(path.join(cache, electronName), electron);
  await writeFile(path.join(cache, nodeName), node);
  const npmCLI = path.join(root, "npm-cli.js");
  await writeFile(npmCLI, "// fixture npm CLI");
  return {
    root,
    cache,
    npmCLI,
    versions: {
      node: "24.15.0",
      windowsArtifacts: {
        electron: { url: `https://example.test/${electronName}`, sha256: sha256(electron) },
        node: { url: `https://example.test/${nodeName}`, sha256: sha256(node) },
      },
    },
  };
}

test("Windows CLI executes npm CLI JS with the current Node executable", async () => {
  const fixture = await cliFixture();
  const commands = [];
  const builds = [];
  await runWindowsRuntimeCLI(["--cache", fixture.cache, "--output", path.join(fixture.root, "output")], {
    platform: "win32",
    versions: fixture.versions,
    productRoot: fixture.root,
    npmExecPath: fixture.npmCLI,
    processExecPath: process.execPath,
    execFile: async (...command) => commands.push(command),
    buildRuntime: async (...options) => builds.push(options),
  });

  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0].slice(0, 2), [process.execPath, [fixture.npmCLI, "run", "build"]]);
  assert.deepEqual(commands[1].slice(0, 2), [process.execPath, [fixture.npmCLI, "ci", "--omit=dev", "--ignore-scripts", "--os=win32", "--cpu=x64"]]);
  assert.equal(commands.some(([executable]) => /npm(?:\.cmd)?$/iu.test(executable)), false);
  assert.equal(builds.length, 1);
});

test("Windows CLI resolves npm-cli.js beside the current Node without PATH lookup", async () => {
  const fixture = await cliFixture();
  const fakeNode = path.join(fixture.root, "node.exe");
  const pairedNpmCLI = path.join(fixture.root, "node_modules", "npm", "bin", "npm-cli.js");
  await writeFile(fakeNode, "fixture node");
  await mkdir(path.dirname(pairedNpmCLI), { recursive: true });
  await writeFile(pairedNpmCLI, "// paired fixture npm CLI");
  const commands = [];
  await runWindowsRuntimeCLI(["--cache", fixture.cache, "--output", path.join(fixture.root, "output")], {
    platform: "win32",
    versions: fixture.versions,
    productRoot: fixture.root,
    npmExecPath: undefined,
    processExecPath: fakeNode,
    execFile: async (...command) => commands.push(command),
    buildRuntime: async () => {},
  });
  assert.deepEqual(commands.map(([executable, arguments_]) => [executable, arguments_[0]]), [
    [fakeNode, pairedNpmCLI],
    [fakeNode, pairedNpmCLI],
  ]);
});

test("CLI rejects a cache SHA mismatch before build and npm ci", async () => {
  const fixture = await cliFixture();
  fixture.versions.windowsArtifacts.electron.sha256 = "0".repeat(64);
  let commandCount = 0;
  await assert.rejects(runWindowsRuntimeCLI(["--cache", fixture.cache, "--output", path.join(fixture.root, "output")], {
    platform: "win32",
    versions: fixture.versions,
    productRoot: fixture.root,
    npmExecPath: fixture.npmCLI,
    processExecPath: process.execPath,
    execFile: async () => { commandCount += 1; },
    buildRuntime: async () => assert.fail("buildRuntime must not run"),
  }), /SHA-256 mismatch/i);
  assert.equal(commandCount, 0);
});
