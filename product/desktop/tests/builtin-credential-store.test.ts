import { randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NewApiDeviceMapping, NewApiIssuedToken } from "@uclaw/shared";
import { afterEach, describe, expect, it } from "vitest";
import { getFsSafePythonConfig } from "@openclaw/fs-safe/config";

import { createBuiltinCredentialStore } from "../src/providers/builtin-credential-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function setup(allowLoopbackHttp = true) {
  const dataDir = await mkdtemp(join(tmpdir(), "uclaw-builtin-credential-"));
  roots.push(dataDir);
  return { dataDir, store: createBuiltinCredentialStore({ dataDir, allowLoopbackHttp }) };
}

function provisionInput(endpoint = "http://127.0.0.1:18090/v1") {
  const suffix = randomUUID().replaceAll("-", "");
  const timestamp = new Date().toISOString();
  const userId = `usr_${suffix}`;
  const tokenId = `tok_${suffix}`;
  const mapping: NewApiDeviceMapping = {
    deviceId: `dev_${suffix}`,
    licenseId: `lic_${suffix}`,
    startupSecretHash: "a".repeat(64),
    startupSecretSalt: "b".repeat(32),
    usbFingerprint: "c".repeat(64),
    newApiUserId: userId,
    newApiUsername: `user_${suffix}`,
    newApiTokenId: tokenId,
    channelId: "channel_builtin_001",
    policyDigest: "d".repeat(64),
    generation: 1,
    previousTokenId: null,
    status: "active",
    failure: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const issuedToken: NewApiIssuedToken = {
    token: {
      id: tokenId, userId, name: "device", channelId: mapping.channelId,
      policyDigest: mapping.policyDigest, generation: mapping.generation,
      status: "active", createdAt: timestamp, updatedAt: timestamp,
    },
    secret: randomBytes(32).toString("base64url"),
  };
  return { endpoint, model: "builtin-model", mapping, issuedToken };
}

describe("builtin credential store", () => {
  it("keeps activation credentials separate from normal active credentials", async () => {
    const { store } = await setup(true);
    await store.provision(provisionInput());
    const before = await store.loadActive();
    await store.provisionActivation!({
      schemaVersion: 1,
      deviceId: "device-activation-001",
      licenseId: "license-activation-001",
      accessToken: "a".repeat(16),
      expiresAt: "2026-08-14T00:00:00.000Z",
    });
    await expect(store.loadActive()).resolves.toEqual(before);
    await expect(store.loadActivation!()).resolves.toMatchObject({ deviceId: "device-activation-001" });
  });
  it("does not initialize the credential root until the first I/O operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-builtin-invalid-root-"));
    roots.push(root);
    const dataDir = join(root, "plain-file");
    await writeFile(dataDir, "not a directory");

    createBuiltinCredentialStore({ dataDir });
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("reports an unsafe credential root on the first load", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-builtin-invalid-root-"));
    roots.push(root);
    const dataDir = join(root, "plain-file");
    await writeFile(dataDir, "not a directory");

    const store = createBuiltinCredentialStore({ dataDir });
    await expect(store.loadActive()).rejects.toMatchObject({ code: "BUILTIN_CREDENTIAL_UNSAFE" });
  });

  it("requires pinned filesystem access and rejects Windows before P3-T08", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-builtin-windows-"));
    roots.push(dataDir);
    expect(() => createBuiltinCredentialStore({ dataDir, platformForTest: "win32" }))
      .toThrow(/P3-T08 native helper/u);
    const testOnly = createBuiltinCredentialStore({
      dataDir, platformForTest: "win32", allowUnpinnedFilesystemForTest: true,
    });
    expect(testOnly.pinnedFilesystem).toBe(false);
    const native = createBuiltinCredentialStore({ dataDir });
    expect(native.pinnedFilesystem).toBe(true);
    expect(getFsSafePythonConfig().mode).toBe("require");
  });

  it("fails closed when credential is missing", async () => {
    const { store } = await setup();
    await expect(store.loadActive()).rejects.toMatchObject({ code: "BUILTIN_CREDENTIAL_MISSING" });
  });

  it("persists a P3-T01 typed device token in a main-only mode-0600 store", async () => {
    const { dataDir, store } = await setup();
    const input = provisionInput();
    await store.provision(input);

    await expect(store.loadActive()).resolves.toMatchObject({
      endpoint: new URL(input.endpoint),
      deviceId: input.mapping.deviceId,
      userId: input.mapping.newApiUserId,
      tokenId: input.issuedToken.token.id,
      tokenSecret: input.issuedToken.secret,
      model: input.model,
    });
    const path = join(dataDir, ".uclaw", "builtin-model-credential.v1.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toContain(input.issuedToken.secret);
  });

  it("rejects mismatched, inactive, or failed P3-T01 token mappings", async () => {
    const { store } = await setup();
    const input = provisionInput();
    await expect(store.provision({
      ...input,
      issuedToken: { ...input.issuedToken, token: { ...input.issuedToken.token, userId: `other_${randomUUID().replaceAll("-", "")}` } },
    })).rejects.toMatchObject({ code: "BUILTIN_CREDENTIAL_INVALID" });
    await expect(store.provision({
      ...input,
      mapping: { ...input.mapping, status: "disabled" },
    })).rejects.toMatchObject({ code: "BUILTIN_CREDENTIAL_INVALID" });
    await expect(store.provision({
      ...input,
      issuedToken: { ...input.issuedToken, token: { ...input.issuedToken.token, status: "revoked" } },
    })).rejects.toMatchObject({ code: "BUILTIN_CREDENTIAL_INVALID" });
    await expect(store.provision({
      ...input,
      issuedToken: { ...input.issuedToken, token: { ...input.issuedToken.token, channelId: "channel_other_001" } },
    })).rejects.toMatchObject({ code: "BUILTIN_CREDENTIAL_INVALID" });
  });

  it("rejects a hardlinked credential target", async () => {
    const { dataDir, store } = await setup();
    const uclawDir = join(dataDir, ".uclaw");
    await mkdir(uclawDir, { recursive: true });
    const source = join(dataDir, "linked-secret.json");
    await writeFile(source, "preserve-me", { mode: 0o600 });
    await link(source, join(uclawDir, "builtin-model-credential.v1.json"));
    await expect(store.provision(provisionInput())).rejects.toMatchObject({ code: "BUILTIN_CREDENTIAL_UNSAFE" });
    expect(await readFile(source, "utf8")).toBe("preserve-me");
  });

  it("allows provisioning credentials for the pre-activation connectivity gate", async () => {
    const { store } = await setup();
    const input = provisionInput();
    await expect(store.provision({
      ...input,
      mapping: { ...input.mapping, status: "provisioning" },
      issuedToken: { ...input.issuedToken, token: { ...input.issuedToken.token, status: "provisioning" } },
    })).resolves.toBeUndefined();
    await expect(store.loadForConnectivityCheck()).resolves.toMatchObject({ tokenId: input.issuedToken.token.id });
    await expect(store.loadActive()).rejects.toMatchObject({ code: "BUILTIN_CREDENTIAL_INVALID" });
  });

  it("allows loopback HTTP only under explicit development-test policy", async () => {
    const development = await setup(true);
    await expect(development.store.provision(provisionInput("http://localhost:18090/v1"))).resolves.toBeUndefined();

    const production = await setup(false);
    await expect(production.store.provision(provisionInput("http://127.0.0.1:18090/v1"))).rejects.toMatchObject({ code: "BUILTIN_ENDPOINT_INSECURE" });
    await expect(production.store.provision(provisionInput("https://builtin.example.test/v1"))).resolves.toBeUndefined();
    for (const endpoint of [
      "http://example.test/v1",
      "http://127.0.0.2/v1",
      "https://user:password@example.test/v1",
      "https://example.test/v1?token=value",
      "https://example.test/v1#fragment",
    ]) {
      await expect(production.store.provision(provisionInput(endpoint))).rejects.toMatchObject({ code: "BUILTIN_ENDPOINT_INSECURE" });
    }
  });

  it("clears the credential and returns to fail-closed state", async () => {
    const { store } = await setup();
    await store.provision(provisionInput());
    await store.clear();
    await expect(store.loadActive()).rejects.toMatchObject({ code: "BUILTIN_CREDENTIAL_MISSING" });
  });
});
