import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");

test("release installs the exact WeChat plugin and treats absence as fatal", () => {
  assert.match(workflow, /npm install @tencent-weixin\/openclaw-weixin@2\.4\.6/u);
  assert.doesNotMatch(workflow, /@tencent-weixin\/openclaw-weixin@latest/u);
  assert.match(workflow, /test -f "\$wx_pkg\/dist\/index\.js"/u);
  assert.match(workflow, /test -f "\$wx_pkg\/openclaw\.plugin\.json"/u);
  assert.doesNotMatch(workflow, /WeChat plugin install failed, skipping/u);
});

test("release verifies registry integrity and emits the runtime file inventory", () => {
  assert.match(workflow, /npm view @tencent-weixin\/openclaw-weixin@2\.4\.6 dist\.integrity/u);
  assert.match(workflow, /runtime-plugin-manifest\.mjs/u);
  assert.match(workflow, /--lock product\/runtime-plugins\.json/u);
  assert.match(workflow, /\.uclaw-plugin-manifest\.json/u);
});
