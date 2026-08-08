import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const captureUrl = new URL("./capture-openclaw-v4.mjs", import.meta.url);
const sanitizerUrl = new URL("./sanitize-openclaw-v4-capture.mjs", import.meta.url);

test("capture harness records configured and rejected models.list frames", async () => {
  const source = await readFile(captureUrl, "utf8");
  assert.match(source, /captureRequest\(client, "models\.list", \{ view: "configured" \}\)/u);
  assert.match(source, /captureRequest\(client, "models\.list", \{ view: "invalid" \}\)/u);
  assert.match(source, /writeFile\(join\(outputDir, "models\.list\.json"\)/u);
});

test("capture harness bounds Gateway handshakes with its own defined helper", async () => {
  const source = await readFile(captureUrl, "utf8");
  assert.match(source, /function withTimeout\(/u);
  assert.doesNotMatch(source, /\btimeout\(/u);
  assert.match(source, /withTimeout\(hello, 10_000, "Gateway hello"\)/u);
  assert.match(source, /withTimeout\(requesterHello, 10_000, "requester Gateway hello"\)/u);
});

test("sanitizer rebuilds models.list fixture hashes and provenance from raw capture", async () => {
  const source = await readFile(sanitizerUrl, "utf8");
  assert.match(source, /rawNames = \[[^\]]*"models\.list\.json"/su);
  assert.match(source, /readJson\("models\.list\.json"\)/u);
  assert.match(source, /function projectModelsListResponse\(/u);
  assert.doesNotMatch(source, /responseFrame:\s*modelsList\.(?:configured|invalidView)\.responseFrame/u);
  for (const field of ["id", "name", "provider", "alias", "available", "contextWindow", "reasoning", "api", "input"]) {
    assert.match(source, new RegExp(`\\b${field}\\b`, "u"));
  }
});
