import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRuntimePluginManifest } from "./runtime-plugin-manifest.mjs";

test("creates a deterministic machine-readable plugin file inventory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-plugin-manifest-"));
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "package.json"), "{}");
  await writeFile(path.join(root, "openclaw.plugin.json"), "{}");
  await writeFile(path.join(root, "dist/index.js"), "entry");
  const lock = { schemaVersion: 1, id: "openclaw-weixin", package: "@tencent-weixin/openclaw-weixin", version: "2.4.6", npmIntegrity: "sha512-fixture", openclawVersionRange: ">=2026.7.1-2 <2026.8.0" };
  const first = await createRuntimePluginManifest(root, lock);
  const second = await createRuntimePluginManifest(root, lock);
  assert.deepEqual(first, second);
  assert.deepEqual(first.plugins[0].files.map(({ path }) => path), ["dist/index.js", "openclaw.plugin.json", "package.json"]);
  assert.match(first.plugins[0].files[0].sha256, /^[a-f0-9]{64}$/u);
});

test("fails when the distributable entrypoint is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-plugin-manifest-"));
  await writeFile(path.join(root, "package.json"), "{}");
  await writeFile(path.join(root, "openclaw.plugin.json"), "{}");
  await assert.rejects(createRuntimePluginManifest(root, {}), /dist\/index\.js/u);
});

test("fails before manifest creation when the plugin contains secret material", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-plugin-manifest-"));
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "package.json"), "{}");
  await writeFile(path.join(root, "openclaw.plugin.json"), "{}");
  await writeFile(path.join(root, "dist/index.js"), `const apiKey = "${"live_A1b2C3d4E5f6G7h8I9j0"}";`);
  await assert.rejects(createRuntimePluginManifest(root, {}), /secret scan failed/u);
});
