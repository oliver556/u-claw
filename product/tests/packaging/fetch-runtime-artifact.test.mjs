import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import { fetchRuntimeArtifact } from "../../packaging/fetch-runtime-artifact.mjs";

const execFileAsync = promisify(execFile);
let tls;

before(async () => {
  tls = await certificate();
});

after(async () => {
  if (tls) await rm(tls.root, { recursive: true, force: true });
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function certificate() {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-fetch-runtime-tls-"));
  const key = path.join(root, "localhost.key");
  const cert = path.join(root, "localhost.crt");
  try {
    await execFileAsync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1",
      "-keyout", key, "-out", cert,
    ], { windowsHide: true });
    return { root, key: await readFile(key), cert: await readFile(cert) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function withFixture(t, handler) {
  const server = createServer({ key: tls.key, cert: tls.cert }, handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return { url: `https://127.0.0.1:${address.port}/runtime.pkg`, trustedCa: tls.cert };
}

async function fixtureOutput() {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-fetch-runtime-"));
  const output = path.join(root, "nested", "runtime.pkg");
  return { root, output };
}

async function siblingEntries(output) {
  return readdir(path.dirname(output)).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
}

function deferred() {
  let resolve;
  const promise = new Promise((value) => { resolve = value; });
  return { promise, resolve };
}

test("fetchRuntimeArtifact downloads exact bounded bytes over trusted HTTPS", async (t) => {
  const runtime = Buffer.from("exact runtime artifact bytes");
  const fixture = await withFixture(t, (_request, response) => {
    response.writeHead(200, { "content-length": runtime.length });
    response.end(runtime);
  });
  const { output } = await fixtureOutput();

  await fetchRuntimeArtifact({
    url: fixture.url,
    output,
    sha256: sha256(runtime),
    maxBytes: runtime.length,
    trustedCa: fixture.trustedCa,
  });

  assert.deepEqual(await readFile(output), runtime);
});

test("fetchRuntimeArtifact rejects redirects without following them", async (t) => {
  let redirected = false;
  const fixture = await withFixture(t, (request, response) => {
    if (request.url === "/runtime.pkg") response.writeHead(302, { location: "/redirected" }).end();
    else {
      redirected = true;
      response.writeHead(200).end("wrong");
    }
  });
  const { output } = await fixtureOutput();

  await assert.rejects(fetchRuntimeArtifact({
    url: fixture.url,
    output,
    sha256: sha256("wrong"),
    maxBytes: 10,
    trustedCa: fixture.trustedCa,
  }), { message: "runtime artifact response status must be 200" });
  assert.equal(redirected, false);
  await assert.rejects(lstat(output), { code: "ENOENT" });
  assert.deepEqual(await siblingEntries(output), []);
});

test("fetchRuntimeArtifact removes temporary bytes that exceed maxBytes", async (t) => {
  const runtime = Buffer.from("too many artifact bytes");
  const fixture = await withFixture(t, (_request, response) => response.writeHead(200).end(runtime));
  const { output } = await fixtureOutput();

  await assert.rejects(fetchRuntimeArtifact({
    url: fixture.url,
    output,
    sha256: sha256(runtime),
    maxBytes: runtime.length - 1,
    trustedCa: fixture.trustedCa,
  }), { message: "runtime artifact exceeds maxBytes" });
  await assert.rejects(lstat(output), { code: "ENOENT" });
  assert.deepEqual(await siblingEntries(output), []);
});

test("fetchRuntimeArtifact removes temporary bytes on SHA-256 mismatch", async (t) => {
  const runtime = Buffer.from("artifact with wrong digest");
  const fixture = await withFixture(t, (_request, response) => response.writeHead(200).end(runtime));
  const { output } = await fixtureOutput();

  await assert.rejects(fetchRuntimeArtifact({
    url: fixture.url,
    output,
    sha256: "0".repeat(64),
    maxBytes: runtime.length,
    trustedCa: fixture.trustedCa,
  }), { message: "runtime artifact SHA-256 mismatch" });
  await assert.rejects(lstat(output), { code: "ENOENT" });
  assert.deepEqual(await siblingEntries(output), []);
});

test("fetchRuntimeArtifact rejects existing output without modifying it", async (t) => {
  const fixture = await withFixture(t, (_request, response) => response.writeHead(200).end("new"));
  const { output } = await fixtureOutput();
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, "keep");

  await assert.rejects(fetchRuntimeArtifact({
    url: fixture.url,
    output,
    sha256: sha256("new"),
    maxBytes: 3,
    trustedCa: fixture.trustedCa,
  }), { message: "runtime artifact output already exists" });
  assert.equal(await readFile(output, "utf8"), "keep");
});

test("fetchRuntimeArtifact does not overwrite output created during download", async (t) => {
  const runtime = Buffer.from("runtime published after concurrent output creation");
  const received = deferred();
  const resume = deferred();
  const fixture = await withFixture(t, async (_request, response) => {
    response.writeHead(200, { "content-length": runtime.length });
    response.write(runtime.subarray(0, 8));
    received.resolve();
    await resume.promise;
    response.end(runtime.subarray(8));
  });
  const { output } = await fixtureOutput();
  const pending = fetchRuntimeArtifact({
    url: fixture.url,
    output,
    sha256: sha256(runtime),
    maxBytes: runtime.length,
    trustedCa: fixture.trustedCa,
  });

  try {
    await received.promise;
    await writeFile(output, "concurrent output");
    resume.resolve();
    await assert.rejects(pending, { message: "runtime artifact output already exists" });
  } finally {
    resume.resolve();
  }
  assert.equal(await readFile(output, "utf8"), "concurrent output");
  assert.deepEqual(await siblingEntries(output), ["runtime.pkg"]);
});

test("fetchRuntimeArtifact removes temporary bytes when response disconnects", async (t) => {
  const fixture = await withFixture(t, (_request, response) => {
    response.writeHead(200, { "content-length": 32 });
    response.write("partial");
    response.destroy();
  });
  const { output } = await fixtureOutput();

  await assert.rejects(fetchRuntimeArtifact({
    url: fixture.url,
    output,
    sha256: "a".repeat(64),
    maxBytes: 32,
    trustedCa: fixture.trustedCa,
  }));
  await assert.rejects(lstat(output), { code: "ENOENT" });
  assert.deepEqual(await siblingEntries(output), []);
});

test("fetchRuntimeArtifact rejects unsafe URLs before making requests", async (t) => {
  let requests = 0;
  const fixture = await withFixture(t, (_request, response) => {
    requests += 1;
    response.writeHead(200).end("unexpected network request");
  });
  const { output } = await fixtureOutput();
  const options = { output, sha256: "a".repeat(64), maxBytes: 1, trustedCa: fixture.trustedCa };
  await assert.rejects(fetchRuntimeArtifact({ ...options, url: "http://example.test/runtime.pkg" }), { message: "runtime artifact URL must use HTTPS" });
  await assert.rejects(fetchRuntimeArtifact({ ...options, url: "https://user:pass@example.test/runtime.pkg" }), { message: "runtime artifact URL must not include credentials" });
  await assert.rejects(fetchRuntimeArtifact({ ...options, url: `${fixture.url}?version=1` }), { message: "runtime artifact URL must not include query or fragment" });
  await assert.rejects(fetchRuntimeArtifact({ ...options, url: `${fixture.url}#runtime` }), { message: "runtime artifact URL must not include query or fragment" });
  await assert.rejects(fetchRuntimeArtifact({ ...options, url: `${fixture.url}?` }), { message: "runtime artifact URL must not include query or fragment" });
  await assert.rejects(fetchRuntimeArtifact({ ...options, url: `${fixture.url}#` }), { message: "runtime artifact URL must not include query or fragment" });
  await assert.rejects(fetchRuntimeArtifact({ ...options, url: "not a URL" }), { message: "runtime artifact URL is invalid" });
  assert.equal(requests, 0);
});

test("fetchRuntimeArtifact validates checksum and maxBytes", async () => {
  const { output } = await fixtureOutput();
  const options = { url: "https://example.test/runtime.pkg", output };
  await assert.rejects(fetchRuntimeArtifact({ ...options, sha256: "A".repeat(64), maxBytes: 1 }), { message: "runtime artifact SHA-256 must be 64 lowercase hex characters" });
  await assert.rejects(fetchRuntimeArtifact({ ...options, sha256: "a".repeat(64), maxBytes: 0 }), { message: "runtime artifact maxBytes must be a positive safe integer" });
});
