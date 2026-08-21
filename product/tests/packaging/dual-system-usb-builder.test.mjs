import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildDualSystemUsb, dualSystemUsbLayoutContract } from "../../packaging/build-dual-system-usb.mjs";
import { buildRuntime } from "../../packaging/build-runtime.mjs";
import { validateRuntimeManifest } from "../../scripts/runtime-manifest.mjs";

const runtimeIds = {
  "win-x64": "openclaw-2026.7.1-2-win-x64",
  "macos-arm64": "openclaw-2026.7.1-2-macos-arm64",
};
const entrypoints = {
  "win-x64": "electron/electron.exe",
  "macos-arm64": "Electron.app/Contents/MacOS/Electron",
};

async function fixtureRuntime(root, target) {
  const runtime = path.join(root, `${target}-runtime`);
  if (target === "win-x64") {
    await mkdir(path.join(runtime, "electron"), { recursive: true });
    await mkdir(path.join(runtime, "resources"), { recursive: true });
    await writeFile(path.join(runtime, "electron", "electron.exe"), "fixture-electron");
    await writeFile(path.join(runtime, "resources", "app.asar"), "application");
  } else {
    await mkdir(path.join(runtime, "Electron.app", "Contents", "MacOS"), { recursive: true });
    await mkdir(path.join(runtime, "Electron.app", "Contents", "Resources"), { recursive: true });
    await writeFile(path.join(runtime, "Electron.app", "Contents", "MacOS", "Electron"), "fixture-electron");
    await writeFile(path.join(runtime, "Electron.app", "Contents", "Resources", "app.asar"), "application");
  }
  await mkdir(path.join(runtime, "node_modules", "openclaw"), { recursive: true });
  await writeFile(path.join(runtime, "node_modules", "openclaw", "openclaw.mjs"), "export {};");
  return runtime;
}

async function buildFixtureRuntimePackage(root, target) {
  const runtime = await fixtureRuntime(root, target);
  const packagePath = path.join(root, `${target}.pkg`);
  const manifest = await buildRuntime({
    inputDir: runtime,
    outputFile: packagePath,
    productVersion: "0.1.0",
    releaseId: `release-${target}`,
    releaseSequence: target === "win-x64" ? 1 : 2,
    runtimeId: runtimeIds[target],
    target,
    entrypoint: entrypoints[target],
    entryArgs: target === "win-x64" ? ["resources/app.asar"] : [],
    allowFixtureRuntime: true,
  });
  return { packagePath, manifest };
}

async function fixtureEntries(root) {
  const winLauncherPath = path.join(root, "U-Claw.exe");
  const macosAppPath = path.join(root, "U-Claw.app");
  await writeFile(winLauncherPath, "launcher");
  await mkdir(path.join(macosAppPath, "Contents", "MacOS"), { recursive: true });
  await writeFile(path.join(macosAppPath, "Contents", "MacOS", "U-Claw"), "app");
  return { winLauncherPath, macosAppPath };
}

test("buildRuntime keeps legacy win manifest stable unless target is explicit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-runtime-target-"));
  const runtime = await fixtureRuntime(root, "win-x64");
  const manifest = await buildRuntime({
    inputDir: runtime,
    outputFile: path.join(root, "legacy.pkg"),
    productVersion: "0.1.0",
    releaseId: "release-win-x64",
    releaseSequence: 1,
    runtimeId: runtimeIds["win-x64"],
    entrypoint: entrypoints["win-x64"],
    entryArgs: ["resources/app.asar"],
    allowFixtureRuntime: true,
  });

  assert.equal(Object.hasOwn(manifest, "target"), false);
  assert.equal(validateRuntimeManifest(manifest), manifest);
  assert.equal(manifest.targetPlatform, "win32");
  assert.equal(manifest.targetArch, "x64");
});

test("buildRuntime emits target-aware macos-arm64 runtime package contract", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-runtime-macos-"));
  const { packagePath, manifest } = await buildFixtureRuntimePackage(root, "macos-arm64");

  assert.equal(validateRuntimeManifest(manifest), manifest);
  assert.equal(manifest.target, "macos-arm64");
  assert.equal(manifest.targetPlatform, "darwin");
  assert.equal(manifest.targetArch, "arm64");
  assert.equal(manifest.runtimeArchive, "runtime.pkg");
  assert.equal(manifest.entrypoint, "Electron.app/Contents/MacOS/Electron");
  assert.equal(manifest.runtimeBytes, (await stat(packagePath)).size);
});

test("buildDualSystemUsb writes fixture-aligned target-local package layout", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-dual-system-usb-"));
  const layout = dualSystemUsbLayoutContract();
  const entries = await fixtureEntries(root);
  const win = await buildFixtureRuntimePackage(root, "win-x64");
  const macos = await buildFixtureRuntimePackage(root, "macos-arm64");
  const outputDir = path.join(root, "U-Claw");

  const result = await buildDualSystemUsb({
    outputDir,
    ...entries,
    installedAt: "2026-08-21T00:00:00.000Z",
    targets: {
      "win-x64": win,
      "macos-arm64": macos,
    },
  });

  assert.deepEqual((await readdir(outputDir)).sort(), [".uclaw", "U-Claw.app", "U-Claw.exe", "app", "data"]);
  assert.deepEqual(JSON.parse(await readFile(path.join(outputDir, "app", "usb-manifest.json"), "utf8")), layout.usbManifest);
  assert.deepEqual(result.runtimeManifests["win-x64"], win.manifest);
  assert.deepEqual(result.runtimeManifests["macos-arm64"], macos.manifest);
  await assert.rejects(readFile(path.join(outputDir, ".uclaw", "runtime.pkg")), /ENOENT/u);

  for (const target of ["win-x64", "macos-arm64"]) {
    const paths = layout.usbManifest.targets[target];
    await access(path.join(outputDir, paths.package));
    const manifest = JSON.parse(await readFile(path.join(outputDir, paths.manifest), "utf8"));
    assert.deepEqual(manifest, target === "win-x64" ? win.manifest : macos.manifest);
    const current = JSON.parse(await readFile(path.join(outputDir, paths.current), "utf8"));
    const installState = JSON.parse(await readFile(path.join(outputDir, paths.installState), "utf8"));
    assert.equal(current.target, target);
    assert.equal(current.manifest, paths.manifest);
    assert.equal(current.package, paths.package);
    assert.equal(installState.target, target);
    assert.equal(installState.state, "completed");
  }
});

test("buildDualSystemUsb rejects legacy manifests without explicit target", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-dual-system-usb-legacy-"));
  const entries = await fixtureEntries(root);
  const runtime = await fixtureRuntime(root, "win-x64");
  const legacyWin = {
    packagePath: path.join(root, "legacy-win.pkg"),
    manifest: await buildRuntime({
      inputDir: runtime,
      outputFile: path.join(root, "legacy-win.pkg"),
      productVersion: "0.1.0",
      releaseId: "release-win-x64",
      releaseSequence: 1,
      runtimeId: runtimeIds["win-x64"],
      entrypoint: entrypoints["win-x64"],
      entryArgs: ["resources/app.asar"],
      allowFixtureRuntime: true,
    }),
  };
  const macos = await buildFixtureRuntimePackage(root, "macos-arm64");

  await assert.rejects(
    buildDualSystemUsb({
      outputDir: path.join(root, "U-Claw"),
      ...entries,
      targets: {
        "win-x64": legacyWin,
        "macos-arm64": macos,
      },
    }),
    /win-x64 runtime manifest target is required/u,
  );
});
