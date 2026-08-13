import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Agent } from "undici";
import { describe, expect, it } from "vitest";

import { createActivationArtifactWriter } from "../../desktop/src/activation/artifact-writer.js";
import {
  createActivationClient,
  type ActivationClient,
} from "../../desktop/src/activation/client.js";
import { createActivationCoordinator } from "../../desktop/src/activation/coordinator.js";
import { verifyActivationResponse } from "../../desktop/src/main.js";

const run = promisify(execFile);
const productRoot = process.cwd();

async function runGoTests(pattern: string): Promise<string> {
  const result = await run(
    "go",
    ["test", "./...", "-count=1", "-run", pattern, "-v"],
    {
      cwd: `${productRoot}/launcher`,
      env: process.env,
    },
  );
  return `${result.stdout}${result.stderr}`;
}

describe("activation launcher-to-desktop contract", () => {
  it("runs real HTTPS client, coordinator, signed artifacts, commit, cleanup, and exit 20", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-activation-integration-"));
    let server: ReturnType<typeof createServer> | undefined;
    let dispatcher: Agent | undefined;
    let client: ActivationClient | undefined;
    try {
      const packageRoot = join(root, ".uclaw");
      const dataDir = join(packageRoot, "data");
      const cert = join(root, "cert.pem");
      const key = join(root, "key.pem");
      await mkdir(dataDir, { recursive: true });
      await run("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
      ]);

      const fingerprint = "a".repeat(64);
      const startupSecret = "s".repeat(32);
      const salt = "b".repeat(32);
      const secretHash = createHash("sha256")
        .update(Buffer.from("uclaw-startup-secret-v1\0"))
        .update(Buffer.from(salt, "hex"))
        .update(Buffer.from([0]))
        .update(startupSecret)
        .digest("hex");
      const signingKeys = generateKeyPairSync("ed25519");
      const license = {
        schemaVersion: 1 as const,
        usernameId: "username-001",
        deviceId: "device-001",
        licenseId: "license-001",
        usbFingerprint: {
          scheme: "uclaw-usb-v1" as const,
          sha256: fingerprint,
        },
        startupSecretProof: {
          algorithm: "sha256-salt-v1" as const,
          startupSecretSalt: salt,
          startupSecretHash: secretHash,
        },
        notBefore: "2026-08-13T00:00:00Z",
        expiresAt: "2027-08-13T00:00:00Z",
        revision: 1,
        signature: {
          algorithm: "ed25519" as const,
          keyId: "activation-key",
          value: "",
        },
      };
      license.signature.value = sign(
        null,
        Buffer.from(
          JSON.stringify([
            "uclaw-startup-license-v1",
            1,
            license.signature.keyId,
            license.usernameId,
            license.deviceId,
            license.licenseId,
            license.usbFingerprint.scheme,
            fingerprint,
            salt,
            secretHash,
            license.notBefore,
            license.expiresAt,
            license.revision,
          ]),
        ),
        signingKeys.privateKey,
      ).toString("base64");
      const response = {
        activationId: "activation-001",
        deviceId: license.deviceId,
        licenseId: license.licenseId,
        license,
        startupCredential: {
          schemaVersion: 1 as const,
          deviceId: license.deviceId,
          licenseId: license.licenseId,
          startupSecret,
        },
        builtinCredential: {
          schemaVersion: 1 as const,
          deviceId: license.deviceId,
          licenseId: license.licenseId,
          accessToken: "t".repeat(16),
          expiresAt: "2026-08-14T00:00:00.000Z",
        },
        status: "active" as const,
      };
      const requests: Array<{
        url: string;
        idempotencyKey?: string;
        body: unknown;
      }> = [];
      server = createServer(
        { cert: await readFile(cert), key: await readFile(key) },
        (request, reply) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          request.on("end", () => {
            const body = chunks.length
              ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown)
              : null;
            requests.push({
              url: request.url ?? "",
              idempotencyKey: request.headers["idempotency-key"] as
                string | undefined,
              body,
            });
            if (request.url === "/v1/activations") {
              reply.writeHead(200, { "content-type": "application/json" });
              reply.end(JSON.stringify(response));
            } else {
              reply.writeHead(204);
              reply.end();
            }
          });
        },
      );
      await new Promise<void>((resolve, reject) =>
        server!.listen(0, "127.0.0.1", resolve).once("error", reject),
      );
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      dispatcher = new Agent({ connect: { ca: await readFile(cert, "utf8") } });
      client = createActivationClient({
        endpoint: `https://127.0.0.1:${port}/`,
        createDispatcher: () => dispatcher!,
      });
      let failFirstWrite = true;
      const writer = createActivationArtifactWriter({
        packageRoot,
        dataDir,
        platformForTest: "win32",
        allowUnpinnedFilesystemForTest: true,
        beforeArtifactWrite: () => {
          if (failFirstWrite) {
            failFirstWrite = false;
            throw new Error("simulated USB write failure");
          }
        },
      });
      const exits: number[] = [];
      const publicKey = signingKeys.publicKey
        .export({ format: "pem", type: "spki" })
        .toString();
      const coordinator = createActivationCoordinator({
        preflight: async () => {
          await writer.preflight();
          return { usbPresent: true };
        },
        client,
        writer,
        usbFingerprint: { version: "uclaw-usb-v1", sha256: fingerprint },
        clientVersion: "1.0.0",
        randomUUID: () => "integration-uuid-001",
        verifyLicense: async (value) =>
          verifyActivationResponse(
            value,
            fingerprint,
            { "activation-key": publicKey },
            new Date("2026-08-13T12:00:00Z"),
          ),
        commitRemote: (activationId, idempotencyKey, generation, signal) =>
          client.commit(
            activationId,
            { idempotencyKey, artifactGeneration: generation },
            signal,
          ),
        exit: (code) => exits.push(code),
      });
      await expect(coordinator.preflight()).resolves.toEqual({
        state: "input",
      });
      const input = {
        username: "UCLAW-TEST-USER",
        activationCode: "ABCDEFGHJKMNPQRSTVWXYZ2345",
      };
      await expect(coordinator.submit(input)).resolves.toEqual({
        state: "recovery-required",
        code: "RECOVERY_REQUIRED",
      });
      await expect(
        readFile(
          join(dataDir, ".uclaw", "activation-transaction.v1.json"),
          "utf8",
        ),
      ).resolves.toContain('"stage":"server_bound"');

      const restartWriter = createActivationArtifactWriter({
        packageRoot,
        dataDir,
        platformForTest: "win32",
        allowUnpinnedFilesystemForTest: true,
      });
      const restart = createActivationCoordinator({
        preflight: async () => {
          await restartWriter.preflight();
          return { usbPresent: true };
        },
        client,
        writer: restartWriter,
        usbFingerprint: { version: "uclaw-usb-v1", sha256: fingerprint },
        clientVersion: "1.0.0",
        randomUUID: () => "must-not-create-another-key",
        verifyLicense: async (value) =>
          verifyActivationResponse(
            value,
            fingerprint,
            { "activation-key": publicKey },
            new Date("2026-08-13T12:00:00Z"),
          ),
        commitRemote: (activationId, idempotencyKey, generation, signal) =>
          client.commit(
            activationId,
            { idempotencyKey, artifactGeneration: generation },
            signal,
          ),
        exit: (code) => exits.push(code),
      });
      await expect(restart.preflight()).resolves.toEqual({
        state: "recovery-required",
        code: "RECOVERY_INPUT_REQUIRED",
      });
      await expect(
        restart.submit({
          ...input,
          activationCode: "ZZZZZZZZZZZZZZZZZZZZZZZZZZ",
        }),
      ).resolves.toEqual({
        state: "recovery-required",
        code: "RECOVERY_INPUT_MISMATCH",
      });
      const otherDisk = createActivationCoordinator({
        preflight: async () => ({ usbPresent: true }),
        client,
        writer: restartWriter,
        usbFingerprint: { version: "uclaw-usb-v1", sha256: "f".repeat(64) },
        clientVersion: "1.0.0",
        randomUUID: () => "must-not-create-another-key",
        verifyLicense: async () => false,
        commitRemote: async () => undefined,
        exit: (code) => exits.push(code),
      });
      await expect(otherDisk.preflight()).resolves.toEqual({
        state: "recovery-required",
        code: "RECOVERY_INPUT_REQUIRED",
      });
      await expect(otherDisk.submit(input)).resolves.toEqual({
        state: "recovery-required",
        code: "RECOVERY_INPUT_MISMATCH",
      });
      await expect(restart.submit(input)).resolves.toEqual({
        state: "complete",
      });
      expect(requests).toHaveLength(3);
      expect(requests[0]).toMatchObject({
        url: "/v1/activations",
        idempotencyKey: "activation:integration-uuid-001",
      });
      expect(requests[1]).toMatchObject({
        url: "/v1/activations",
        idempotencyKey: "activation:integration-uuid-001",
      });
      expect(requests[2]).toMatchObject({
        url: "/v1/activations/activation-001/commit",
        idempotencyKey: "activation:integration-uuid-001",
        body: {
          idempotencyKey: "activation:integration-uuid-001",
          artifactGeneration: 1,
        },
      });
      expect(
        requests.every(
          (request) =>
            !request.url.includes("unbind") && !request.url.includes("delete"),
        ),
      ).toBe(true);
      expect(exits).toEqual([20]);
      await expect(
        readFile(join(packageRoot, "license", "license.json"), "utf8"),
      ).resolves.toContain('"licenseId":"license-001"');
      await expect(
        readFile(
          join(packageRoot, "license", ".startup-credential.json"),
          "utf8",
        ),
      ).resolves.toContain('"startupSecret"');
      await expect(
        readFile(join(dataDir, ".uclaw", "activation-transaction.v1.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(join(dataDir, ".uclaw", "activation-artifact-backup.v1.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      let launcher;
      try {
        const publicKeyRaw = signingKeys.publicKey.export({ format: "jwk" }).x;
        if (!publicKeyRaw)
          throw new Error("generated Ed25519 public key has no x coordinate");
        launcher = await run(
          "go",
          [
            "test",
            "./...",
            "-count=1",
            "-run",
            "TestActivationArtifactsEnableNormalWorkspaceHarness",
            "-v",
          ],
          {
            cwd: `${productRoot}/launcher`,
            env: {
              ...process.env,
              UCLAW_ACTIVATION_HARNESS_PACKAGE_ROOT: packageRoot,
              UCLAW_ACTIVATION_HARNESS_PUBLIC_KEY: Buffer.from(
                publicKeyRaw,
                "base64url",
              ).toString("base64"),
            },
          },
        );
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string };
        throw new Error(
          `launcher harness failed:\n${failure.stdout ?? ""}${failure.stderr ?? ""}`,
        );
      }
      expect(`${launcher.stdout}${launcher.stderr}`).toContain(
        "NORMAL_WORKSPACE_VISIBLE",
      );
    } finally {
      try {
        if (client) await client.close();
        else if (dispatcher) await dispatcher.close();
      } finally {
        try {
          if (server)
            await new Promise<void>((resolve) =>
              server!.close(() => resolve()),
            );
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  }, 30_000);

  it("uses the signed runtime entrypoint with launcher-owned startup modes", async () => {
    const output = await runGoTests(
      "TestActivationProcessSpecUsesRestrictedStartupMode|TestNormalProcessSpecPreservesManifestArgumentsAndOpenClawEnvironment|TestValidateManifestRejectsLauncherOwnedStartupModeArguments",
    );
    expect(output).toContain(
      "--- PASS: TestActivationProcessSpecUsesRestrictedStartupMode",
    );
    expect(output).toContain(
      "--- PASS: TestNormalProcessSpecPreservesManifestArgumentsAndOpenClawEnvironment",
    );
    expect(output).toContain(
      "--- PASS: TestValidateManifestRejectsLauncherOwnedStartupModeArguments",
    );
  }, 30_000);

  it("accepts only exit 20 and re-runs the full gate at most once", async () => {
    const output = await runGoTests(
      "TestActivationCompletedRecognizesOnlyExitCode20|TestRunActivationCompletionRestartsFullGateOnce|TestRunDoesNotLaunchActivationTwice",
    );
    expect(output).toContain(
      "--- PASS: TestActivationCompletedRecognizesOnlyExitCode20",
    );
    expect(output).toContain(
      "--- PASS: TestRunActivationCompletionRestartsFullGateOnce",
    );
    expect(output).toContain("--- PASS: TestRunDoesNotLaunchActivationTwice");
  }, 30_000);

  it("keeps the restricted desktop IPC contract at exactly five capabilities", async () => {
    const result = await run(
      process.execPath,
      [
        "node_modules/vitest/vitest.mjs",
        "run",
        "desktop/tests/main.test.ts",
        "-t",
        "allows exactly the activation-only IPC capability set|starts activation-only without a Gateway lifecycle",
      ],
      {
        cwd: productRoot,
        env: process.env,
      },
    );
    expect(`${result.stdout}${result.stderr}`).toMatch(/2 passed/u);
  }, 30_000);

  it("packages one portable Electron runtime and rejects activation entrypoint fields or arguments", async () => {
    const result = await run(
      process.execPath,
      [
        "--test",
        "scripts/runtime-manifest.test.mjs",
        "tests/packaging/runtime-package.test.mjs",
      ],
      { cwd: productRoot, env: process.env },
    );
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain(
      "keeps activation mode outside the signed runtime manifest",
    );
    expect(output).toContain(
      "buildRelease writes only the portable release layout",
    );
    expect(output).toContain(
      "buildRuntime rejects a second activation Electron executable",
    );
    expect(output).toMatch(/fail 0/u);
  }, 30_000);
});
