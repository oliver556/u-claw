import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { releaseSigningPayload } from "../packaging/build-update-feed.mjs";
import { verifyUpdateDeployment } from "./verify-update-deployment.mjs";

const execFileAsync = promisify(execFile);
const keys = generateKeyPairSync("ed25519");

async function certificate() {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-update-tls-"));
  const key = path.join(root, "localhost.key");
  const cert = path.join(root, "localhost.crt");
  await execFileAsync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1",
    "-keyout", key, "-out", cert,
  ]);
  return { key: await readFile(key), cert: await readFile(cert) };
}

function signedFeed(runtime, overrides = {}) {
  const unsigned = {
    schemaVersion: 1,
    id: "release-42",
    version: "1.2.3",
    channel: "stable",
    publishedAt: "2026-08-14T00:00:00.000Z",
    expiresAt: "2027-08-14T00:00:00.000Z",
    sequence: 42,
    notes: ["Security update"],
    compatibility: { platform: "win32", arch: "x64", runtimeId: "runtime-1" },
    package: {
      bytes: runtime.length,
      sha256: createHash("sha256").update(runtime).digest("hex"),
    },
    runtimeManifest: { schemaVersion: 1 },
    mandatory: false,
    ...overrides,
  };
  const feed = { ...unsigned, signature: { algorithm: "ed25519", keyId: "release-key-1", value: "" } };
  feed.signature.value = sign(null, releaseSigningPayload(feed), keys.privateKey).toString("base64");
  return feed;
}

async function withFixture(t, handler) {
  const tls = await certificate();
  const requests = [];
  const server = createServer(tls, handler(requests));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return { baseURL: `https://127.0.0.1:${address.port}/releases/`, ca: tls.cert, requests };
}

test("verifies signed manifest and exact runtime over HTTPS", async (t) => {
  const runtime = Buffer.from("runtime-package");
  const feed = signedFeed(runtime);
  const fixture = await withFixture(t, (requests) => (request, response) => {
    requests.push({ host: request.headers.host, method: request.method, url: request.url });
    if (request.url === "/releases/stable.json") {
      const body = Buffer.from(JSON.stringify(feed));
      response.writeHead(200, { "content-type": "application/json", "content-length": body.length });
      response.end(body);
    } else if (request.url === "/releases/packages/release-42/runtime.pkg") {
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": runtime.length });
      response.end(runtime);
    } else {
      response.writeHead(404).end();
    }
  });

  const result = await verifyUpdateDeployment({ baseURL: fixture.baseURL, publicKey: keys.publicKey, ca: fixture.ca });
  assert.deepEqual(result, { id: "release-42", version: "1.2.3", bytes: runtime.length });
  assert.deepEqual(fixture.requests.map(({ method, url }) => [method, url]), [
    ["GET", "/releases/stable.json"],
    ["GET", "/releases/packages/release-42/runtime.pkg"],
  ]);
  assert.equal(fixture.requests.some(({ host }) => host?.includes("license.yiyong.me")), false);
});

test("rejects HTTP and credential-bearing base URLs before requests", async () => {
  await assert.rejects(verifyUpdateDeployment({ baseURL: "http://updates.yiyong.me/releases/", publicKey: keys.publicKey }), /HTTPS/i);
  await assert.rejects(verifyUpdateDeployment({ baseURL: "https://user:pass@updates.yiyong.me/releases/", publicKey: keys.publicKey }), /credentials/i);
});

test("rejects redirects and oversized manifests", async (t) => {
  await t.test("redirect", async (t) => {
    const fixture = await withFixture(t, () => (_request, response) => response.writeHead(302, { location: "https://license.yiyong.me/" }).end());
    await assert.rejects(verifyUpdateDeployment({ baseURL: fixture.baseURL, publicKey: keys.publicKey, ca: fixture.ca }), /redirect|status/i);
  });
  await t.test("oversized", async (t) => {
    const fixture = await withFixture(t, () => (_request, response) => {
      response.writeHead(200, { "content-length": 1_048_577 });
      response.end(Buffer.alloc(1_048_577));
    });
    await assert.rejects(verifyUpdateDeployment({ baseURL: fixture.baseURL, publicKey: keys.publicKey, ca: fixture.ca }), /manifest.*large/i);
  });
});

test("rejects bad package length, digest, and bytes beyond signed size", async (t) => {
  for (const mode of ["length", "digest", "overflow"]) {
    await t.test(mode, async (t) => {
      const runtime = Buffer.from("runtime-package");
      const feed = signedFeed(runtime, mode === "digest" ? { package: { bytes: runtime.length, sha256: "0".repeat(64) } } : {});
      const fixture = await withFixture(t, () => (request, response) => {
        if (request.url.endsWith("stable.json")) {
          const body = Buffer.from(JSON.stringify(feed));
          response.writeHead(200, { "content-length": body.length }).end(body);
          return;
        }
        if (mode === "length") response.writeHead(200, { "content-length": runtime.length + 1 }).end(runtime);
        else if (mode === "overflow") response.writeHead(200).end(Buffer.concat([runtime, Buffer.from("extra")]));
        else response.writeHead(200, { "content-length": runtime.length }).end(runtime);
      });
      await assert.rejects(
        verifyUpdateDeployment({ baseURL: fixture.baseURL, publicKey: keys.publicKey, ca: fixture.ca }),
        /length|size|SHA-256|digest|signed/i,
      );
    });
  }
});

test("repository exposes the read-only deployment contract", async () => {
  const packageJSON = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJSON.scripts["verify:update-deployment"], "node scripts/verify-update-deployment.mjs");
  const nginx = await readFile(new URL("../../deploy/updates/nginx.conf.example", import.meta.url), "utf8");
  assert.match(nginx, /server_name updates\.yiyong\.me;/u);
  assert.match(nginx, /limit_except GET HEAD \{ deny all; \}/u);
  assert.match(nginx, /try_files \$uri =404;/u);
  assert.match(nginx, /X-Content-Type-Options nosniff always/u);
  const readme = await readFile(new URL("../../deploy/updates/README.md", import.meta.url), "utf8");
  assert.match(readme, /先上传[^\n]*runtime\.pkg/u);
  assert.match(readme, /后[^\n]*stable\.json/u);
  assert.match(readme, /不需要[^\n]*(?:New API|API)/u);
  assert.match(readme, /verify-update-deployment\.mjs --base-url https:\/\/updates\.yiyong\.me\/releases\//u);
});
