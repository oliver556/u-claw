import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeAppDir = new URL("../../packaging/windows-runtime-app/", import.meta.url);

async function readJson(name) {
  return JSON.parse(await readFile(new URL(name, runtimeAppDir), "utf8"));
}

function assertProductionLock(manifest, lock) {
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.version, manifest.version);
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);

  for (const [packagePath, packageEntry] of Object.entries(lock.packages)) {
    if (packagePath === "") {
      continue;
    }
    assert.equal(Object.hasOwn(packageEntry, "dev"), false, `${packagePath} must not be dev-only`);
    assert.equal(Object.hasOwn(packageEntry, "link"), false, `${packagePath} must not be a link`);
    assert.match(
      packageEntry.version,
      /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
      `${packagePath} must have a fixed version`,
    );

    const tarball = new URL(packageEntry.resolved);
    assert.equal(tarball.protocol, "https:", `${packagePath} resolved must use HTTPS`);
    assert.equal(tarball.username, "", `${packagePath} resolved must not contain credentials`);
    assert.equal(tarball.password, "", `${packagePath} resolved must not contain credentials`);
    assert.equal(tarball.search, "", `${packagePath} resolved must not contain a query`);
    assert.equal(tarball.hash, "", `${packagePath} resolved must not contain a hash`);
    assert.match(tarball.pathname, /\.tgz$/u, `${packagePath} resolved must be a tarball`);

    assert.match(packageEntry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/u, `${packagePath} must have sha512 integrity`);
    const encodedDigest = packageEntry.integrity.slice("sha512-".length);
    assert.equal(Buffer.from(encodedDigest, "base64").length, 64, `${packagePath} integrity must contain 512 bits`);
    assert.equal(Buffer.from(encodedDigest, "base64").toString("base64"), encodedDigest, `${packagePath} integrity must be canonical base64`);
  }
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
  assertProductionLock(manifest, lock);
});

test("Windows runtime app rejects a transitive dependency without integrity", async () => {
  const manifest = await readJson("package.json");
  const lock = structuredClone(await readJson("package-lock.json"));
  const transitivePath = "node_modules/openclaw/node_modules/@babel/runtime";
  delete lock.packages[transitivePath].integrity;

  assert.throws(() => assertProductionLock(manifest, lock), /integrity/u);
});

test("Windows runtime app lock validation is independent of package entry order", async () => {
  const manifest = await readJson("package.json");
  const lock = structuredClone(await readJson("package-lock.json"));
  const rootPackage = lock.packages[""];
  delete lock.packages[""];
  lock.packages[""] = rootPackage;

  assert.doesNotThrow(() => assertProductionLock(manifest, lock));
});
