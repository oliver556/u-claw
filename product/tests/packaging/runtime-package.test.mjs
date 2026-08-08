import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRelease } from "../../packaging/build-release.mjs";
import { buildRuntime } from "../../packaging/build-runtime.mjs";
import { validateRuntimeManifest } from "../../scripts/runtime-manifest.mjs";

async function fixtureRuntime() {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-runtime-"));
  const runtime = path.join(root, "runtime source");
  await mkdir(path.join(runtime, "electron"), { recursive: true });
  await mkdir(path.join(runtime, "resources"), { recursive: true });
  await writeFile(path.join(runtime, "electron", "electron.exe"), "launcher");
  await writeFile(path.join(runtime, "resources", "app.asar"), "application");
  return { root, runtime };
}

function runtimeOptions(root, runtime, overrides = {}) {
  return {
    inputDir: runtime,
    outputFile: path.join(root, "runtime.pkg"),
    productVersion: "0.1.0",
    runtimeId: "openclaw-2026.7.1-2-win-x64",
    entrypoint: "electron/electron.exe",
    entryArgs: ["resources/app.asar"],
    ...overrides,
  };
}

test("buildRuntime rejects missing input and entrypoint", async () => {
  const { root, runtime } = await fixtureRuntime();
  await assert.rejects(
    buildRuntime(runtimeOptions(root, path.join(root, "missing"))),
    /runtime input/i,
  );
  await assert.rejects(
    buildRuntime(runtimeOptions(root, runtime, { entrypoint: "missing.exe" })),
    /entrypoint/i,
  );
});

test("buildRuntime rejects a runtime id that disagrees with canonical pins", async () => {
  const { root, runtime } = await fixtureRuntime();
  await assert.rejects(
    buildRuntime(runtimeOptions(root, runtime, { runtimeId: "openclaw-latest-win-x64" })),
    /runtimeId must be openclaw-2026\.7\.1-2-win-x64/u,
  );
});

test("buildRuntime rejects symlinks and existing output", async (t) => {
  const { root, runtime } = await fixtureRuntime();
  try {
    await symlink(
      path.join(runtime, "resources", "app.asar"),
      path.join(runtime, "resources", "linked.asar"),
    );
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("symlink unavailable");
      return;
    }
    throw error;
  }
  await assert.rejects(buildRuntime(runtimeOptions(root, runtime)), /symlink/i);

  await writeFile(path.join(root, "runtime.pkg"), "keep");
  await assert.rejects(
    buildRuntime(runtimeOptions(root, runtime, { outputFile: path.join(root, "runtime.pkg") })),
    /already exists/i,
  );
  assert.equal(await readFile(path.join(root, "runtime.pkg"), "utf8"), "keep");
});

test("buildRuntime creates a strict manifest from real package bounds", async () => {
  const { root, runtime } = await fixtureRuntime();
  const options = runtimeOptions(root, runtime);
  const manifest = await buildRuntime(options);
  assert.equal(validateRuntimeManifest(manifest), manifest);
  assert.equal(manifest.runtimeArchive, "runtime.pkg");
  assert.equal(manifest.nodeVersion, "24.15.0");
  assert.equal(manifest.electronVersion, "40.10.6");
  assert.equal(manifest.runtimeVersion, "2026.7.1-2");
  assert.equal(manifest.targetPlatform, "win32");
  assert.equal(manifest.targetArch, "x64");
  assert.equal(manifest.fileCount, 2);
  assert.equal(manifest.unpackedBytes, Buffer.byteLength("launcherapplication"));
  assert.equal(manifest.runtimeBytes, (await stat(options.outputFile)).size);
  assert.match(manifest.runtimeSha256, /^[a-f0-9]{64}$/u);
});

test("buildRelease writes only the portable release layout", async () => {
  const { root, runtime } = await fixtureRuntime();
  const runtimePackage = path.join(root, "runtime.pkg");
  const manifest = await buildRuntime(runtimeOptions(root, runtime, { outputFile: runtimePackage }));
  const launcher = path.join(root, "launcher.exe");
  await writeFile(launcher, "launcher-binary");
  const outputDir = path.join(root, "U-Claw Portable");

  await buildRelease({ launcherPath: launcher, runtimePackagePath: runtimePackage, manifest, outputDir });

  assert.deepEqual(await readdir(outputDir), [".uclaw", "U-Claw.exe"]);
  assert.deepEqual(await readdir(path.join(outputDir, ".uclaw")), ["data", "runtime.pkg", "version.json"]);
  assert.deepEqual(await readdir(path.join(outputDir, ".uclaw", "data")), []);
  const writtenManifest = JSON.parse(await readFile(path.join(outputDir, ".uclaw", "version.json"), "utf8"));
  assert.deepEqual(writtenManifest, manifest);
});

test("buildRelease rejects invalid manifest, mismatched package, and existing output", async () => {
  const { root, runtime } = await fixtureRuntime();
  const runtimePackage = path.join(root, "runtime.pkg");
  const manifest = await buildRuntime(runtimeOptions(root, runtime, { outputFile: runtimePackage }));
  const launcher = path.join(root, "launcher.exe");
  await writeFile(launcher, "launcher-binary");

  await assert.rejects(
    buildRelease({
      launcherPath: launcher,
      runtimePackagePath: runtimePackage,
      manifest: { ...manifest, extra: true },
      outputDir: path.join(root, "invalid manifest"),
    }),
    /unexpected field/i,
  );

  const existingOutput = path.join(root, "existing release");
  await mkdir(existingOutput);
  await assert.rejects(
    buildRelease({ launcherPath: launcher, runtimePackagePath: runtimePackage, manifest, outputDir: existingOutput }),
    /already exists/i,
  );

  await writeFile(runtimePackage, "tampered");
  await assert.rejects(
    buildRelease({
      launcherPath: launcher,
      runtimePackagePath: runtimePackage,
      manifest,
      outputDir: path.join(root, "mismatched package"),
    }),
    /package/i,
  );
});
