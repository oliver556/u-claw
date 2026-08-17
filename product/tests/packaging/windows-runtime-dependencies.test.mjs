import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeAppDir = new URL("../../packaging/windows-runtime-app/", import.meta.url);

async function readJson(name) {
  return JSON.parse(await readFile(new URL(name, runtimeAppDir), "utf8"));
}

test("Windows runtime app locks production dependencies", async () => {
  const manifest = await readJson("package.json");
  const lock = await readJson("package-lock.json");

  assert.equal(manifest.name, "@uclaw/windows-runtime-app");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, "module");
  assert.equal(manifest.main, "desktop/dist/entry.js");
  assert.deepEqual(manifest.dependencies, {
    "@openclaw/fs-safe": "0.4.1",
    jszip: "3.10.1",
    openclaw: "2026.7.1-2",
    semver: "7.8.5",
    undici: "7.29.0",
    zod: "4.4.3",
  });

  const openclawPackage = lock.packages["node_modules/openclaw"];
  assert.equal(openclawPackage.version, "2026.7.1-2");
  assert.equal(
    openclawPackage.integrity,
    "sha512-ycF3yPcbjN6bUPeaUx6Mh6vze1hQWoD3CT/wWcmD7a8xaHHHRUaAlaq+lFxMHf1ssEgODVAwjlzYqp2twkYZ7g==",
  );
  for (const [packagePath, packageEntry] of Object.entries(lock.packages)) {
    assert.equal(
      Object.hasOwn(packageEntry, "link"),
      false,
      `${packagePath || "root package"} must not be a link`,
    );
  }
});
