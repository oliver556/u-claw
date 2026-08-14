import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { scanText, scanTrackedRepository } from "./secret-scan.mjs";

const execFileAsync = promisify(execFile);
const scannerPath = new URL("./secret-scan.mjs", import.meta.url).pathname;
const productRoot = path.resolve(new URL("..", import.meta.url).pathname);

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

test("detects activation, device, bearer, and legacy New API secrets", () => {
  const deviceToken = ["uclaw", "dt", "A1b2".repeat(11).slice(0, 43)].join("_");
  const activationCode = ["0123456789", "ABCDEFGHJK", "MNPQRS"].join("");
  const startupSecret = ["A1b2C3d4", "E5f6G7h8", "I9j0K1l2", "M3n4O5p6"].join("");
  const newApiKey = ["new-api-live", "A1b2C3d4E5f6G7h8"].join("-");
  const source = [
    `copied=${deviceToken}`,
    `Authorization: Bearer ${deviceToken}`,
    `activationCode = "${activationCode}"`,
    `startupSecret = "${startupSecret}"`,
    `newApiKey = "${newApiKey}"`,
    `issuedToken = "${newApiKey}"`,
  ].join("\n");

  assert.deepEqual(scanText("notes/runtime.txt", source), [
    { path: "notes/runtime.txt", line: 1, rule: "DEVICE_TOKEN" },
    { path: "notes/runtime.txt", line: 2, rule: "DEVICE_TOKEN" },
    { path: "notes/runtime.txt", line: 3, rule: "ACTIVATION_CODE" },
    { path: "notes/runtime.txt", line: 4, rule: "CREDENTIAL_ASSIGNMENT" },
    { path: "notes/runtime.txt", line: 5, rule: "CREDENTIAL_ASSIGNMENT" },
    { path: "notes/runtime.txt", line: 6, rule: "CREDENTIAL_ASSIGNMENT" },
  ]);
});

test("enforces exact device token boundaries for every valid ending", () => {
  const endingDash = `uclaw_dt_${"A".repeat(42)}-`;
  const endingUnderscore = `uclaw_dt_${"B".repeat(42)}_`;
  const allLetters = `uclaw_dt_${"C".repeat(43)}`;
  const finding = (line) => ({ path: "notes/device-tokens.txt", line, rule: "DEVICE_TOKEN" });
  const source = [
    endingDash,
    endingUnderscore,
    allLetters,
    `Authorization: Bearer ${endingDash}`,
    `x${allLetters}`,
    `${allLetters}x`,
    `uclaw_dt_${"D".repeat(44)}`,
    `uclaw_dt_fixture${"E".repeat(36)}`,
  ].join("\n");

  assert.deepEqual(scanText("notes/device-tokens.txt", source), [
    finding(1),
    finding(2),
    finding(3),
    finding(4),
  ]);
});

test("scans every device token on a line while skipping only placeholders", () => {
  const placeholder = `uclaw_dt_fixture${"A".repeat(36)}`;
  const realToken = `uclaw_dt_${"B".repeat(43)}`;
  const finding = { path: "notes/device-line.txt", line: 1, rule: "DEVICE_TOKEN" };

  assert.deepEqual(scanText("notes/device-line.txt", `${placeholder}; ${realToken}`), [finding]);
  assert.deepEqual(scanText("notes/device-line.txt", `${realToken}; ${placeholder}`), [finding]);
  assert.deepEqual(scanText("notes/device-line.txt", `${realToken}; ${realToken}`), [finding]);
  assert.deepEqual(scanText("notes/device-line.txt", `${placeholder}; ${placeholder}`), []);
});

test("detects activation codes leaked from test paths", () => {
  const activationCode = ["0123456789", "ABCDEFGHJK", "MNPQRS"].join("");
  const leaked = [
    `ACTIVATION_CODE=${activationCode}`,
    `activationCode: ${activationCode}`,
    `activationCode: '${activationCode}'`,
    `activationCode = \`${activationCode}\``,
    `{"activationCode":"${activationCode}"}`,
  ].join("\n");
  assert.deepEqual(scanText("tests/leaked.txt", leaked), [1, 2, 3, 4, 5].map((line) => ({
    path: "tests/leaked.txt", line, rule: "ACTIVATION_CODE",
  })));
  assert.deepEqual(
    scanText("tests/dynamic-fixture.ts", "const activationCode = ['0123456789', 'ABCDEFGHJK', 'MNPQRS'].join('');\n"),
    [],
  );
  assert.deepEqual(
    scanText("tests/static-fixture.json", '{"activationCode":"TESTTESTTESTTESTTESTTEST12"}\n'),
    [],
  );
  assert.deepEqual(scanText("tests/not-secrets.txt", [
    `activationCode=${activationCode}0`,
    `ordinary text ${activationCode}`,
  ].join("\n")), []);
});

test("detects exact activation code keys across member assignment forms", () => {
  const realCode = ["0123456789", "ABCDEFGHJK", "MNPQRS"].join("");
  const placeholder = "TESTTESTTESTTESTTESTTEST12";
  const path = "tests/member-assignments.ts";
  const source = [
    `request.activationCode = "${realCode}"`,
    `obj["activationCode"] = '${realCode}'`,
    `obj['activation_code'] = \`${realCode}\``,
    `obj[\`activationCode\`] = ${realCode}`,
    `log.info({ nested: { activationCode: "${realCode}" } })`,
    `{"nested":{"activation_code":"${realCode}"}}`,
    `request.activationCode = "${placeholder}"; obj["activationCode"] = "${realCode}"`,
    `myactivationCode = "${realCode}"`,
    `request.reactivationCode = "${realCode}"`,
    `request.activationCodeSuffix = "${realCode}"`,
    `obj["myactivationCode"] = "${realCode}"`,
    `obj["activation" + "Code"] = "${realCode}"`,
    `obj[key] = "${realCode}"`,
  ].join("\n");

  assert.deepEqual(scanText(path, source), [1, 2, 3, 4, 5, 6, 7].map((line) => ({
    path,
    line,
    rule: "ACTIVATION_CODE",
  })));
});

test("detects credential assignments through exact bare and member keys", () => {
  const startupSecret = ["A1b2C3d4", "E5f6G7h8", "I9j0K1l2"].join("");
  const newApiKey = ["new-api-live", "A1b2C3d4E5f6G7h8"].join("-");
  const placeholder = "fixture-startup-secret-000000";
  const path = "tests/member-credentials.ts";
  const source = [
    `request.startupSecret = "${startupSecret}"`,
    `request.newApiKey = '${newApiKey}'`,
    `obj["startup_secret"] = \`${startupSecret}\``,
    `obj['new_api_key'] = ${newApiKey}`,
    `startupSecret=${placeholder};request.startupSecret=${startupSecret}`,
    `newApiKey=${newApiKey};obj['newApiKey']=${placeholder}`,
    `mystartupSecret = "${startupSecret}"`,
    `request.newApiKeySuffix = "${newApiKey}"`,
    `obj["startup" + "Secret"] = "${startupSecret}"`,
    `obj[key] = "${newApiKey}"`,
  ].join("\n");

  assert.deepEqual(scanText(path, source), [1, 2, 3, 4, 5, 6].map((line) => ({
    path,
    line,
    rule: "CREDENTIAL_ASSIGNMENT",
  })));
});

test("scans every activation code assignment on one line", () => {
  const realCode = ["0123456789", "ABCDEFGHJK", "MNPQRS"].join("");
  const placeholder = "TESTTESTTESTTESTTESTTEST12";
  const finding = { path: "tests/same-line.ts", line: 1, rule: "ACTIVATION_CODE" };
  assert.deepEqual(scanText("tests/same-line.ts", `activationCode=${placeholder}; activationCode=${realCode}`), [finding]);
  assert.deepEqual(scanText("tests/same-line.ts", `activationCode=${placeholder};activationCode=${realCode}`), [finding]);
  assert.deepEqual(scanText("tests/same-line.ts", `activationCode=${realCode}; activationCode=${placeholder}`), [finding]);
  assert.deepEqual(scanText("tests/same-line.ts", `activationCode=${placeholder}; activationCode=${placeholder}`), []);
  assert.deepEqual(scanText("tests/same-line.ts", `activationCode=${placeholder}_leaked;activationCode=${realCode}`), [finding]);
  assert.deepEqual(scanText("tests/same-line.ts", [
    `activationCode=${realCode}_suffix`,
    `activationCode=${realCode}-suffix`,
    `activationCode=${realCode}Z`,
    `myactivationCode=${realCode}`,
  ].join("\n")), []);
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
    "const token = `work-chat-${process.pid}-${Date.now()}`;",
  ].join("\n");

  assert.deepEqual(scanText("src/config.ts", source), []);
});

test("scans index, tracked worktree, and untracked nonignored files while skipping binary files", async (t) => {
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
    { path: "untracked.env", line: 1, rule: "CREDENTIAL_ASSIGNMENT" },
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

test("also scans unstaged tracked worktree contents", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-secret-worktree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-q"], { cwd: root });

  const target = path.join(root, "tracked.env");
  await writeFile(target, "api_key=REDACTED\n");
  await execFileAsync("git", ["add", "tracked.env"], { cwd: root });
  const secret = ["live", "Q7mR2tY8pL5nD3xK9wJ4"].join("_");
  await writeFile(target, `api_key=${secret}\n`);

  assert.deepEqual(await scanTrackedRepository(root), [
    { path: "tracked.env", line: 1, rule: "CREDENTIAL_ASSIGNMENT" },
  ]);
});

test("skips ignored files, symlinks, and duplicate index/worktree findings", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-secret-filter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-q"], { cwd: root });

  const secret = ["live", "R8mQ2tY7pL4nD9xK5wH3"].join("_");
  await writeFile(path.join(root, ".gitignore"), "ignored.env\n");
  await writeFile(path.join(root, "tracked.env"), `api_key=${secret}\n`);
  await writeFile(path.join(root, "ignored.env"), `api_key=${secret}\n`);
  await symlink("ignored.env", path.join(root, "linked.env"));
  await execFileAsync("git", ["add", ".gitignore", "tracked.env", "linked.env"], { cwd: root });

  assert.deepEqual(await scanTrackedRepository(root), [
    { path: "tracked.env", line: 1, rule: "CREDENTIAL_ASSIGNMENT" },
  ]);
});

test("fails closed when one file exceeds the size limit", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-secret-file-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await writeFile(path.join(root, "large.txt"), "123456789");

  await assert.rejects(
    scanTrackedRepository(root, { maxFileBytes: 8, maxTotalBytes: 100 }),
    /large\.txt exceeds secret scan file size limit/u,
  );
});

test("fails closed when aggregate input exceeds the total size limit", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-secret-total-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await writeFile(path.join(root, "first.txt"), "123456");
  await writeFile(path.join(root, "second.txt"), "abcdef");

  await assert.rejects(
    scanTrackedRepository(root, { maxFileBytes: 8, maxTotalBytes: 10 }),
    /secret scan total size limit exceeded/u,
  );
});

test("counts identical index and worktree content only once toward total size", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-secret-dedupe-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await writeFile(path.join(root, "tracked.txt"), "123456");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });

  assert.deepEqual(
    await scanTrackedRepository(root, { maxFileBytes: 8, maxTotalBytes: 6 }),
    [],
  );
});

test("fails closed on unmerged index stages without leaking blob contents", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-secret-unmerged-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  const secret = ["live", "S9mQ2tY7pL4nD8xK5wH3"].join("_");
  const objectIds = [];
  for (const [index, contents] of ["base\n", `api_key=${secret}\n`, "theirs\n"].entries()) {
    const blobPath = path.join(root, `blob-${index}.txt`);
    await writeFile(blobPath, contents);
    const { stdout } = await execFileAsync("git", ["hash-object", "-w", blobPath], { cwd: root });
    objectIds.push(stdout.trim());
    await rm(blobPath);
  }
  const indexInfo = objectIds.map((objectId, index) => `100644 ${objectId} ${index + 1}\tconflicted.env`).join("\n");
  execFileSync("git", ["update-index", "--index-info"], { cwd: root, input: `${indexInfo}\n` });

  await assert.rejects(scanTrackedRepository(root), /unmerged index entry: conflicted\.env/u);
  await assert.rejects(
    execFileAsync(process.execPath, [scannerPath], { cwd: root }),
    (error) => {
      assert.equal(error.code, 2);
      assert.equal(error.stdout, "");
      assert.equal(error.stderr, "Secret scan failed\n");
      assert.equal(`${error.stdout}${error.stderr}`.includes(secret), false);
      return true;
    },
  );
});

test("fails closed when git reports a non-UTF-8 path", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "uclaw-secret-path-encoding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  const blobPath = path.join(root, "blob.txt");
  await writeFile(blobPath, "safe\n");
  const { stdout } = await execFileAsync("git", ["hash-object", "-w", blobPath], { cwd: root });
  await rm(blobPath);
  const prefix = Buffer.from(`100644 ${stdout.trim()} 0\t`, "ascii");
  const indexInfo = Buffer.concat([prefix, Buffer.from([0xff]), Buffer.from(".env\n", "ascii")]);
  execFileSync("git", ["update-index", "--index-info"], { cwd: root, input: indexInfo });

  await assert.rejects(scanTrackedRepository(root), /git path is not valid UTF-8/u);
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

test("activation server container is a Go 1.25 linux/amd64 nonroot scratch image", async () => {
  const dockerfile = await readFile(path.join(productRoot, "activation-server", "Dockerfile"), "utf8");
  const normalized = dockerfile.replace(/\\\r?\n\s*/gu, " ");
  const secretInit = await readFile(path.join(productRoot, "activation-server", "cmd", "secret-init", "main.go"), "utf8");
  assert.match(dockerfile, /^FROM --platform=\$BUILDPLATFORM golang:1\.25(?:\.\d+)?-bookworm AS build$/mu);
  assert.match(dockerfile, /^ARG TARGETOS$/mu);
  assert.match(dockerfile, /^ARG TARGETARCH$/mu);
  assert.match(normalized, /RUN CGO_ENABLED=0 GOOS=\$TARGETOS GOARCH=\$TARGETARCH go build [^\n]* -o \/out\/activation-server \.\/cmd\/server\s+&&\s+CGO_ENABLED=0 GOOS=\$TARGETOS GOARCH=\$TARGETARCH go build [^\n]* -o \/out\/secret-init \.\/cmd\/secret-init/u);
  assert.match(dockerfile, /^FROM --platform=\$TARGETPLATFORM scratch$/mu);
  assert.equal(dockerfile.match(/^COPY /gmu)?.length, 5);
  assert.match(dockerfile, /^COPY --from=build \/etc\/ssl\/certs\/ca-certificates\.crt \/etc\/ssl\/certs\/ca-certificates\.crt$/mu);
  assert.match(dockerfile, /^COPY --from=build \/out\/activation-server \/activation-server$/mu);
  assert.match(dockerfile, /^COPY --from=build \/out\/secret-init \/secret-init$/mu);
  assert.equal(dockerfile.match(/^COPY --from=build \/out\/(?:activation-server|secret-init) \/(?:activation-server|secret-init)$/gmu)?.length, 2);
  assert.match(dockerfile, /^ENTRYPOINT \["\/secret-init"\]$/mu);
  assert.match(dockerfile, /^CMD \["\/activation-server"\]$/mu);
  assert.match(secretInit, /const serviceUID = 65532/u);
  assert.match(secretInit, /const serviceGID = 65532/u);
  assert.match(secretInit, /syscall\.Setgroups\(\[\]int\{\}\)/u);
  assert.match(secretInit, /syscall\.Setgid\(serviceGID\)/u);
  assert.match(secretInit, /syscall\.Setuid\(serviceUID\)/u);
  assert.match(secretInit, /syscall\.Exec\(executable, arguments, env\)/u);
});

test("worktree scan opens without following links and reads through the same descriptor with a bound", async () => {
  const scanner = await readFile(scannerPath, "utf8");
  assert.match(scanner, /open\(absolutePath, constants\.O_RDONLY \| constants\.O_NOFOLLOW\)/u);
  assert.match(scanner, /handle\.stat\(\)/u);
  assert.match(scanner, /handle\.read\(/u);
  assert.match(scanner, /limits\.nextReadSize\(length\)/u);
  assert.match(scanner, /maxFileBytes - length \+ 1/u);
  assert.match(scanner, /finally\s*\{\s*await handle\.close\(\)/u);
  assert.doesNotMatch(scanner, /lstat\(absolutePath\)|readFile\(absolutePath\)/u);
});

test("activation server test gate runs tests, race detector, vet, and linux build serially", async () => {
  const packageJson = JSON.parse(await readFile(path.join(productRoot, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["test:activation-server"],
    "cd activation-server && go test -p=1 -count=1 ./... && go test -p=1 -race -count=1 ./... && go vet ./... && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /dev/null ./cmd/server",
  );
});
