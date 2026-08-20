import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../openclaw-extensions/uclaw-commercial-image/", import.meta.url);

test("commercial image extension owns the OpenClaw provider and multipart edit contract", async () => {
  const manifest = JSON.parse(await readFile(new URL("openclaw.plugin.json", root), "utf8"));
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const source = await readFile(new URL("dist/index.js", root), "utf8");

  assert.equal(manifest.id, "uclaw-commercial-image");
  assert.deepEqual(manifest.contracts.imageGenerationProviders, ["uclaw-commercial"]);
  assert.equal(packageJson.peerDependencies.openclaw, "2026.7.1-2");
  assert.equal(packageJson.openclaw.compat.pluginApi, ">=2026.7.1");
  assert.match(source, /createOpenAiCompatibleImageGenerationProvider/u);
  assert.match(source, /buildGenerateRequest/u);
  assert.match(source, /buildEditRequest:\s*multipartEdit/u);
  assert.match(source, /form\.append\("image\[\]"/u);
  assert.doesNotMatch(source, /form\.set\("(?:n|size)"/u);
  assert.doesNotMatch(source, /uclaw_dt_|Bearer\s+[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}/u);
});
