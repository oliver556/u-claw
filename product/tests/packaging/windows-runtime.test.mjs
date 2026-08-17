import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { open, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { promisify } from "node:util";

import JSZip from "jszip";

import { buildWindowsRuntime } from "../../packaging/build-windows-runtime.mjs";

const execFileAsync = promisify(execFile);
const nodeArchiveRoot = "node-v24.15.0-win-x64";
const fixtureRoots = new Set();

after(async () => {
  await Promise.all([...fixtureRoots].map((root) => rm(root, { recursive: true, force: true })));
});

async function writeZip(file, entries, platform = "DOS") {
  const zip = new JSZip();
  for (const entry of entries) {
    zip.file(entry.name, entry.body ?? "fixture", {
      createFolders: false,
      dir: entry.dir ?? false,
      unixPermissions: entry.unixPermissions,
    });
  }
  let bytes = await zip.generateAsync({ type: "nodebuffer", platform, compression: "DEFLATE" });
  for (const entry of entries.filter((candidate) => candidate.forceEmptyDeflate)) {
    bytes = forceEmptyDeflate(bytes, entry.name);
  }
  await writeFile(file, bytes);
}

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
    "electron/resources/app/node_modules/@uclaw/adapter/dist/index.js",
    "electron/resources/app/node_modules/@uclaw/shared/dist/index.js",
    "node/node.exe",
  ]) assert.equal((await lstat(path.join(result.outputDir, relative))).isFile(), true, relative);
  assert.equal(await readFile(path.join(result.outputDir, "node", "node.exe"), "utf8"), "node");
  assert.equal(await hasSymlink(result.outputDir), false);
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
      await assert.rejects(execFileAsync(process.execPath, [script.pathname, ...arguments_]), (error) => {
        assert.match(error.stderr, message);
        assert.doesNotMatch(error.stderr, /npm ERR/u);
        return true;
      });
    });
  }
});
