import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Agent, fetch as undiciFetch } from "undici";
import { afterEach, describe, expect, it } from "vitest";

import { createActivationArtifactWriter } from "../../desktop/src/activation/artifact-writer.js";
import { createActivationClient, type ActivationClient } from "../../desktop/src/activation/client.js";
import { createActivationCoordinator } from "../../desktop/src/activation/coordinator.js";
import { verifyActivationResponse } from "../../desktop/src/main.js";
import { createBuiltinCredentialStore } from "../../desktop/src/providers/builtin-credential-store.js";
import { fetchCommercialModels } from "../../desktop/src/providers/commercial-openclaw-lifecycle.js";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function closeServer(server: ReturnType<typeof createServer> | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise<void>((resolve, reject) => server.close((error) => {
    if (error) reject(error);
    else resolve();
  }));
}

describe("activation to OpenClaw commercial Provider through Node HTTPS proxy fixture", () => {
  it("persists a model-agnostic device credential and reads the dynamic catalog without leaking secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-activation-model-proxy-"));
    roots.push(root);
    const packageRoot = join(root, "package");
    const dataDir = join(packageRoot, "data");
    await mkdir(dataDir, { recursive: true });
    const certPath = join(root, "cert.pem");
    const keyPath = join(root, "key.pem");
    let server: ReturnType<typeof createServer> | undefined;
    let activationDispatcher: Agent | undefined;
    let modelDispatcher: Agent | undefined;
    let activationClient: ActivationClient | undefined;
    try {
      await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyPath, "-out", certPath, "-days", "1"]);

    const activationCode = ["0123456789", "ABCDEFGHJK", "MNPQRS"].join("");
    const startupSecret = ["fixture", "startup", "secret", "0123456789abcdef"].join("-");
    const deviceToken = ["uclaw", "dt", `fixture${"D".repeat(36)}`].join("_");
    const newApiKey = ["fixture", "New API", "key", "must-not-be-used"].join("-");
    expect(deviceToken).toHaveLength(52);
    const fingerprint = "a".repeat(64);
    const salt = "b".repeat(32);
    const secretHash = createHash("sha256").update(Buffer.from("uclaw-startup-secret-v1\0"))
      .update(Buffer.from(salt, "hex")).update(Buffer.from([0])).update(startupSecret).digest("hex");
    const signingKeys = generateKeyPairSync("ed25519");
    const license = {
      schemaVersion: 1 as const, usernameId: "fixture-user-001", deviceId: "fixture-device-001", licenseId: "fixture-license-001",
      usbFingerprint: { scheme: "uclaw-usb-v1" as const, sha256: fingerprint },
      startupSecretProof: { algorithm: "sha256-salt-v1" as const, startupSecretSalt: salt, startupSecretHash: secretHash },
      notBefore: "2026-08-13T00:00:00Z", expiresAt: "2027-08-13T00:00:00Z", revision: 1,
      signature: { algorithm: "ed25519" as const, keyId: "fixture-signing-key", value: "" },
    };
    license.signature.value = sign(null, Buffer.from(JSON.stringify([
      "uclaw-startup-license-v1", 1, license.signature.keyId, license.usernameId, license.deviceId, license.licenseId,
      license.usbFingerprint.scheme, fingerprint, salt, secretHash, license.notBefore, license.expiresAt, license.revision,
    ])), signingKeys.privateKey).toString("base64");

    let endpoint = "";
    let revoked = false;
    let upstreamModelCalls = 0;
    const publicRecords: unknown[] = [];
    const authorizations: string[] = [];
    server = createServer({ cert: await readFile(certPath), key: await readFile(keyPath) }, (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown : null;
        if (request.url === "/v1/activations") {
          expect(body).toEqual({ activationCode, usbFingerprint: { version: "uclaw-usb-v1", sha256: fingerprint }, clientVersion: "1.0.0", idempotencyKey: "activation:fixture-uuid" });
          expect(body).not.toHaveProperty("username");
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            activationId: "fixture-activation-001", deviceId: license.deviceId, licenseId: license.licenseId, license,
            startupCredential: { schemaVersion: 1, deviceId: license.deviceId, licenseId: license.licenseId, startupSecret },
            builtinCredential: { schemaVersion: 2, deviceId: license.deviceId, licenseId: license.licenseId, endpoint: `${endpoint}model-api/`, deviceToken },
            status: "active",
          }));
          return;
        }
        if (request.url === "/v1/activations/fixture-activation-001/commit") {
          publicRecords.push({ type: "commit", status: 204 });
          response.writeHead(204).end();
          return;
        }
        if (request.url === "/model-api/v1/models" || request.url === "/model-api/v1/chat/completions") {
          const authorization = String(request.headers.authorization ?? "");
          authorizations.push(authorization);
          if (authorization !== `Bearer ${deviceToken}` || revoked) {
            response.writeHead(401, { "content-type": "application/json" });
            response.end(JSON.stringify({ code: "AUTHENTICATION_FAILED", message: "Device credential rejected.", requestId: "fixture-request-rejected" }));
            return;
          }
          upstreamModelCalls += 1;
          if (request.url.endsWith("/models")) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ object: "list", data: [{ id: "fixture-default-model", object: "model", created: 1, owned_by: "fixture" }] }));
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: "fixture-chat-001", object: "chat.completion", created: 1, model: "fixture-default-model", choices: [{ index: 0, message: { role: "assistant", content: "fixture assistant answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }));
          return;
        }
        response.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
    const address = server.address();
    endpoint = `https://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
    const ca = await readFile(certPath, "utf8");
    activationDispatcher = new Agent({ connect: { ca } });
    modelDispatcher = new Agent({ connect: { ca } });
    activationClient = createActivationClient({ endpoint, createDispatcher: () => activationDispatcher! });
      const writer = createActivationArtifactWriter({ packageRoot, dataDir });
      const exits: number[] = [];
      const publicKey = signingKeys.publicKey.export({ format: "pem", type: "spki" }).toString();
      const coordinator = createActivationCoordinator({
        preflight: async () => { await writer.preflight(); return { usbPresent: true }; }, client: activationClient, writer,
        usbFingerprint: { version: "uclaw-usb-v1", sha256: fingerprint }, clientVersion: "1.0.0", randomUUID: () => "fixture-uuid",
        verifyLicense: (value) => verifyActivationResponse(value, fingerprint, { "fixture-signing-key": publicKey }, new Date("2026-08-13T12:00:00Z")),
        commitRemote: (id, key, generation, signal) => activationClient.commit(id, { idempotencyKey: key, artifactGeneration: generation }, signal),
        exit: (code) => exits.push(code),
      });
      await expect(coordinator.preflight()).resolves.toEqual({ state: "input" });
      await expect(coordinator.submit({ activationCode })).resolves.toEqual({ state: "complete" });
      expect(exits).toEqual([20]);

      const credentialPath = join(dataDir, ".uclaw", "builtin-model-credential.v1.json");
      const credentialBody = JSON.parse(await readFile(credentialPath, "utf8"));
      expect(credentialBody).toEqual({ schemaVersion: 2, deviceId: license.deviceId, licenseId: license.licenseId, endpoint: `${endpoint}model-api/`, deviceToken });
      if (process.platform !== "win32") expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
      const credentialArtifacts = (await readdir(join(dataDir, ".uclaw"))).filter((name) => name.includes("credential"));
      expect(credentialArtifacts).toEqual(["builtin-model-credential.v1.json"]);
      await expect(readFile(join(dataDir, ".uclaw", "activation-builtin-credential.v1.json"))).rejects.toMatchObject({ code: "ENOENT" });

      const store = createBuiltinCredentialStore({ dataDir });
      const loaded = await store.loadActive();
      const modelFetch = ((input: string | URL | Request, init?: RequestInit) =>
        undiciFetch(input, { ...init, dispatcher: modelDispatcher })) as typeof fetch;
      expect(loaded.model).toBeUndefined();
      await expect(fetchCommercialModels(loaded, modelFetch)).resolves.toEqual([
        { id: "fixture-default-model", name: "fixture-default-model" },
      ]);
      expect(authorizations).toEqual([`Bearer ${deviceToken}`]);
      expect(authorizations.join(" ")).not.toContain("New API");

      const callsBeforeRevocation = upstreamModelCalls;
      revoked = true;
      const revokedError = await fetchCommercialModels(loaded, modelFetch).catch((error: unknown) => error);
      expect(revokedError).toBeInstanceOf(Error);
      expect(upstreamModelCalls).toBe(callsBeforeRevocation);
      publicRecords.push(JSON.parse(JSON.stringify(revokedError)));
      const publicJson = JSON.stringify(publicRecords);
      for (const secret of [activationCode, startupSecret, deviceToken, newApiKey]) expect(publicJson).not.toContain(secret);
      // Production path has no injectable logger. Public leak evidence covers
      // MessageEvents, serialized errors, and commit records only.
    } finally {
      const closeResults = await Promise.allSettled([
        activationClient?.close() ?? activationDispatcher?.close() ?? Promise.resolve(),
        modelDispatcher?.close() ?? Promise.resolve(),
        closeServer(server),
      ]);
      const removeResult = await Promise.allSettled([rm(root, { recursive: true, force: true })]);
      if (removeResult[0].status === "fulfilled") {
        const rootIndex = roots.indexOf(root);
        if (rootIndex >= 0) roots.splice(rootIndex, 1);
      }
      const cleanupErrors = [...closeResults, ...removeResult]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "Activation model proxy fixture cleanup failed.");
      }
    }
  }, 30_000);
});
