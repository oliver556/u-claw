import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { scanText, scanTrackedRepository } from "./secret-scan.mjs";

const execFileAsync = promisify(execFile);
const scannerPath = new URL("./secret-scan.mjs", import.meta.url).pathname;

test("detects private-key blocks and high-confidence credential assignments", () => {
  const beginPrivateKey = `-----BEGIN ${"PRIVATE KEY"}-----`;
  const privateKey = [
    beginPrivateKey,
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
    "-----END PRIVATE KEY-----",
  ].join("\n");
  const apiKey = ["live", "7Qh4pK9vN2xR8mT5cW1z"].join("_");
  const source = `header\n${privateKey}\napiKey = "${apiKey}"\n`;

  assert.deepEqual(scanText("config/runtime.env", source), [
    { path: "config/runtime.env", line: 2, rule: "PRIVATE_KEY_BLOCK" },
    { path: "config/runtime.env", line: 5, rule: "CREDENTIAL_ASSIGNMENT" },
  ]);
});

test("does not treat placeholder substrings inside secret material as placeholders", () => {
  const beginPrivateKey = `-----BEGIN ${"PRIVATE KEY"}-----`;
  const source = [
    beginPrivateKey,
    "MIIexampleQIBADANBgkqhkiG9w0BAQEF",
    "-----END PRIVATE KEY-----",
    "apiKey = \"prod_A12345678zX\"",
    "apiKey = \"prod_example_A7mQ2rT9xK4\"",
    `copied = "${["xoxb", "1234567890", "1234567890", "secret"].join("-")}"`,
  ].join("\n");

  assert.deepEqual(scanText("config/production.env", source), [
    { path: "config/production.env", line: 1, rule: "PRIVATE_KEY_BLOCK" },
    { path: "config/production.env", line: 4, rule: "CREDENTIAL_ASSIGNMENT" },
    { path: "config/production.env", line: 5, rule: "CREDENTIAL_ASSIGNMENT" },
    { path: "config/production.env", line: 6, rule: "HIGH_CONFIDENCE_TOKEN" },
  ]);
});

test("detects standalone high-confidence provider tokens", () => {
  const token = `ghp_${"A1b2".repeat(10)}`;
  assert.deepEqual(scanText("notes.txt", `token copied here: ${token}\n`), [
    { path: "notes.txt", line: 1, rule: "HIGH_CONFIDENCE_TOKEN" },
  ]);
});

test("detects modern GitHub fine-grained access tokens", () => {
  const body = "11AA22bb33CC44dd55EE66ff77GG88hh99II00jj".repeat(3).slice(0, 82);
  const token = ["github", "pat", body].join("_");
  assert.deepEqual(scanText("notes.txt", `token copied here: ${token}\n`), [
    { path: "notes.txt", line: 1, rule: "HIGH_CONFIDENCE_TOKEN" },
  ]);
});

test("ignores fixture, example, redacted, and masked placeholders", () => {
  const beginPrivateKey = `-----BEGIN ${"PRIVATE KEY"}-----`;
  const source = [
    "apiKey = \"fixture-api-key-000000000000\"",
    "token: \"REDACTED\"",
    "password = \"<example-password>\"",
    "client_secret = \"xxxxxxxxxxxxxxxxxxxxxxxx\"",
    "apiKey = \"fixture-context-secret-1\"",
    "authToken = \"fixture-ipc-secret-3\"",
    "apiKey = \"fixture-sk-live-12345678\"",
    "aws = \"AKIAIOSFODNN7EXAMPLE\"",
    "copied = \"ghp_fixtureA123456789012345678901234567890\"",
    "provider = \"sk-fixture-main-only-12345678\"",
    beginPrivateKey,
    "REDACTED",
    "-----END PRIVATE KEY-----",
  ].join("\n");

  assert.deepEqual(scanText("tests/fixtures/example.env", source), []);
});

test("ignores schema declarations, property reads, and similarly named fields", () => {
  const source = [
    "const apiKey = document.getElementById('apiKey').value.trim();",
    "secret: z.string().min(1).max(8_192).optional(),",
    "previewToken: operation.previewToken,",
    "const token = request.params.token;",
  ].join("\n");

  assert.deepEqual(scanText("src/config.ts", source), []);
});

test("scans tracked text files while skipping untracked and binary files", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-secret-scan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "nested"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });

  const trackedSecret = ["live", "V8mQ2rT7pL4nC9xK5wH3"].join("_");
  const untrackedSecret = ["live", "U9nR3tY8pL5mD2xK7wJ4"].join("_");
  await writeFile(path.join(root, "tracked.env"), `api_key=${trackedSecret}\n`);
  await writeFile(path.join(root, "untracked.env"), `api_key=${untrackedSecret}\n`);
  await writeFile(path.join(root, "binary.bin"), Buffer.from(`prefix\0api_key=${trackedSecret}`));
  await execFileAsync("git", ["add", "tracked.env", "binary.bin"], { cwd: root });

  assert.deepEqual(await scanTrackedRepository(path.join(root, "nested")), [
    { path: "tracked.env", line: 1, rule: "CREDENTIAL_ASSIGNMENT" },
  ]);
});

test("scans staged index blobs instead of divergent worktree contents", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-secret-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-q"], { cwd: root });

  const stagedSecret = ["live", "K8mQ2rT7pL4nC9xV5wH3"].join("_");
  const target = path.join(root, "staged.env");
  await writeFile(target, `api_key=${stagedSecret}\n`);
  await execFileAsync("git", ["add", "staged.env"], { cwd: root });
  await writeFile(target, "api_key=REDACTED\n");

  assert.deepEqual(await scanTrackedRepository(root), [
    { path: "staged.env", line: 1, rule: "CREDENTIAL_ASSIGNMENT" },
  ]);
});

test("CLI reports only path, line, and rule without echoing secret values", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-secret-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  const secret = ["live", "B7mQ4rT9pL2nC8xK5wH3"].join("_");
  await writeFile(path.join(root, "secrets.env"), `api_key=${secret}\n`);
  await execFileAsync("git", ["add", "secrets.env"], { cwd: root });

  await assert.rejects(
    execFileAsync(process.execPath, [scannerPath], { cwd: root }),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout.trim(), "secrets.env:1 CREDENTIAL_ASSIGNMENT");
      assert.equal(error.stdout.includes(secret), false);
      assert.equal(error.stderr, "");
      return true;
    },
  );
});
