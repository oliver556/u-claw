import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NewApiManagementClient, ProvisioningBinding } from "@uclaw/shared";
import { afterEach, describe, expect, it } from "vitest";

import {
  createLicenseLifecycleClient,
  startLocalLicenseLifecycleServer,
  type LocalLicenseLifecycleServer,
} from "../../desktop/src/license-lifecycle/index.js";
import {
  createNewApiManagementClient,
  startLocalNewApiManagementServer,
  type LocalNewApiManagementServer,
} from "../../desktop/src/new-api-management/index.js";
import { createBuiltinCredentialStore } from "../../desktop/src/providers/builtin-credential-store.js";
import {
  createProvisioningArtifactWriter,
  createProvisioningCoordinator,
  type ProvisioningArtifactWriter,
} from "../../desktop/src/provisioning/index.js";

const roots: string[] = [];
const newApiServers: LocalNewApiManagementServer[] = [];
const licenseServers: LocalLicenseLifecycleServer[] = [];
const rawServers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(newApiServers.splice(0).map((server) => server.close()));
  await Promise.all(licenseServers.splice(0).map((server) => server.close()));
  await Promise.all(rawServers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const input = {
  idempotencyKey: "provision-local-device-001",
  deviceId: "dev_local_fixture_001",
  usbFingerprint: "a".repeat(64),
  username: "uclaw_local_fixture",
  channelId: "channel_builtin_local",
  endpoint: "",
  model: "built-in-model",
  notBefore: "2026-08-10T00:00:00.000Z",
  expiresAt: "2027-08-10T00:00:00.000Z",
};

function bindingOf(result: Awaited<ReturnType<ReturnType<typeof createProvisioningCoordinator>["provision"]>>): ProvisioningBinding {
  return {
    deviceId: result.deviceId,
    usbFingerprint: result.usbFingerprint,
    licenseId: result.licenseId,
    newApiUserId: result.newApiUserId,
    newApiUsername: result.newApiUsername,
    newApiTokenId: result.newApiTokenId,
    channelId: result.channelId,
  };
}

async function setup(overrides: { newApiClient?: NewApiManagementClient; writer?: (base: ProvisioningArtifactWriter) => ProvisioningArtifactWriter } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "uclaw-provisioning-local-"));
  roots.push(dataDir);
  const keys = generateKeyPairSync("ed25519");
  const licenseServer = await startLocalLicenseLifecycleServer({
    managementCredential: "fixture-license-management-credential",
    signingKeyId: "fixture-license-key",
    signingPrivateKey: keys.privateKey,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
  });
  const newApiServer = await startLocalNewApiManagementServer({
    managementCredential: "fixture-new-api-management-credential",
    now: () => new Date("2026-08-10T00:00:00.000Z"),
  });
  licenseServers.push(licenseServer);
  newApiServers.push(newApiServer);
  const licenseClient = createLicenseLifecycleClient({
    endpoint: licenseServer.url,
    managementCredential: "fixture-license-management-credential",
    allowLoopbackHttp: true,
  });
  const newApiClient = overrides.newApiClient ?? createNewApiManagementClient({
    endpoint: newApiServer.url,
    managementCredential: "fixture-new-api-management-credential",
    allowLoopbackHttp: true,
  });
  const credentialStore = createBuiltinCredentialStore({ dataDir, allowLoopbackHttp: true });
  const baseWriter = createProvisioningArtifactWriter({ dataDir, credentialStore });
  const artifactWriter = overrides.writer?.(baseWriter) ?? baseWriter;
  const coordinator = createProvisioningCoordinator({
    licenseClient, newApiClient, artifactWriter, now: () => new Date("2026-08-10T00:00:00.000Z"),
  });
  return {
    dataDir, licenseServer, newApiServer, licenseClient, newApiClient, credentialStore, artifactWriter, coordinator,
    input: { ...input, endpoint: new URL("/v1/", newApiServer.url).href },
  };
}

async function invalidJsonEndpoint(): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{invalid-json");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  rawServers.push({ close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) });
  return `http://127.0.0.1:${address.port}/uclaw-management/v1/`;
}

describe("localhost provisioning identity transaction", () => {
  it("provisions once under duplicate and concurrent calls, then loads active credential", async () => {
    const context = await setup();
    const [first, second] = await Promise.all([
      context.coordinator.provision(context.input),
      context.coordinator.provision(context.input),
    ]);
    expect(second).toEqual(first);
    await expect(context.coordinator.provision(context.input)).resolves.toEqual(first);
    await expect(context.credentialStore.loadActive()).resolves.toMatchObject({
      deviceId: first.deviceId, userId: first.newApiUserId, tokenId: first.newApiTokenId, model: context.input.model,
    });
    const audit = await context.newApiClient.listAuditEvents({ deviceId: first.deviceId, cursor: null, pageSize: 100 });
    expect(audit.items.filter((event) => event.action === "user.created")).toHaveLength(1);
    expect(audit.items.filter((event) => event.action === "token.created")).toHaveLength(1);
    expect(audit.items.filter((event) => event.action === "device.created")).toHaveLength(1);
  });

  it("fails closed for auth, network, and invalid response without leaking remote data", async () => {
    const authenticated = await setup();
    const wrongAuth = createNewApiManagementClient({
      endpoint: authenticated.newApiServer.url,
      managementCredential: "fixture-wrong-management-credential",
      allowLoopbackHttp: true,
    });
    const authContext = await setup({ newApiClient: wrongAuth });
    const authError = await authContext.coordinator.provision(authContext.input).catch((error: unknown) => error);
    expect(authError).toMatchObject({ code: "NEW_API_FAILED", retryable: false });

    const networkClient = createNewApiManagementClient({
      endpoint: "http://127.0.0.1:1/uclaw-management/v1/",
      managementCredential: "fixture-network-management-credential",
      allowLoopbackHttp: true,
      timeoutMs: 100,
    });
    const networkContext = await setup({ newApiClient: networkClient });
    await expect(networkContext.coordinator.provision(networkContext.input)).rejects.toMatchObject({ code: "NEW_API_FAILED" });

    const invalidClient = createNewApiManagementClient({
      endpoint: await invalidJsonEndpoint(),
      managementCredential: "fixture-invalid-management-credential",
      allowLoopbackHttp: true,
    });
    const invalidContext = await setup({ newApiClient: invalidClient });
    const invalidError = await invalidContext.coordinator.provision(invalidContext.input).catch((error: unknown) => error);
    expect(invalidError).toMatchObject({ code: "NEW_API_FAILED" });
    expect(JSON.stringify([authError, invalidError])).not.toMatch(/fixture-wrong|fixture-invalid|authorization|invalid-json/iu);
  });

  it("persists compensation pending and recovers with rotated generation and token", async () => {
    let failWrite = true;
    let failRevoke = true;
    const context = await setup({
      writer: (base) => ({
        ...base,
        async writeArtifacts(value) {
          if (failWrite) {
            failWrite = false;
            throw new Error("fixture startup secret must not leak");
          }
          return base.writeArtifacts(value);
        },
      }),
    });
    const originalRevoke = context.newApiClient.revokeToken.bind(context.newApiClient);
    const client: NewApiManagementClient = {
      ...context.newApiClient,
      async revokeToken(tokenId, value) {
        if (failRevoke) {
          failRevoke = false;
          throw new Error("fixture token secret must not leak");
        }
        return originalRevoke(tokenId, value);
      },
    };
    const coordinator = createProvisioningCoordinator({
      licenseClient: context.licenseClient,
      newApiClient: client,
      artifactWriter: context.artifactWriter,
      now: () => new Date("2026-08-10T00:00:00.000Z"),
    });
    const firstError = await coordinator.provision(context.input).catch((error: unknown) => error);
    expect(firstError).toMatchObject({ code: "COMPENSATION_PENDING", retryable: true });
    expect(await context.artifactWriter.readJournal()).toMatchObject({
      generation: 1, stage: "compensation-pending", compensation: { token: "pending", license: "succeeded" },
    });
    const recovered = await coordinator.provision(context.input);
    expect(recovered).toMatchObject({ status: "active" });
    expect(await context.artifactWriter.readJournal()).toMatchObject({ generation: 2, stage: "active" });
    expect(JSON.stringify(firstError)).not.toMatch(/startup secret|token secret/iu);
  });

  it("recovers after mapping creation fails before any mapping exists", async () => {
    const context = await setup();
    let failMapping = true;
    const originalCreateMapping = context.newApiClient.createDeviceMapping.bind(context.newApiClient);
    const client: NewApiManagementClient = {
      ...context.newApiClient,
      async createDeviceMapping(value) {
        if (failMapping) {
          failMapping = false;
          throw new Error("mapping unavailable");
        }
        return originalCreateMapping(value);
      },
    };
    const coordinator = createProvisioningCoordinator({
      licenseClient: context.licenseClient,
      newApiClient: client,
      artifactWriter: context.artifactWriter,
      now: () => new Date("2026-08-10T00:00:00.000Z"),
    });
    await expect(coordinator.provision(context.input)).rejects.toMatchObject({ code: "NEW_API_FAILED" });
    expect(await context.artifactWriter.readJournal()).toMatchObject({ stage: "failed", mappedTokenId: null });
    await expect(coordinator.provision(context.input)).resolves.toMatchObject({ status: "active" });
    expect(await context.artifactWriter.readJournal()).toMatchObject({ generation: 2, stage: "active" });
  });

  it("revokes old token and replaces binding during reissue", async () => {
    const context = await setup();
    const active = await context.coordinator.provision(context.input);
    const reissued = await context.coordinator.applyLifecycle({
      action: "reissue",
      idempotencyKey: "lifecycle-reissue-local-001",
      binding: bindingOf(active),
      usbFingerprint: "e".repeat(64),
      notBefore: context.input.notBefore,
      expiresAt: "2028-08-10T00:00:00.000Z",
    });
    expect(reissued.licenseId).not.toBe(active.licenseId);
    expect(reissued.newApiTokenId).not.toBe(active.newApiTokenId);
    expect(reissued.usbFingerprint).toBe("e".repeat(64));
    await expect(context.coordinator.applyLifecycle({
      action: "reissue",
      idempotencyKey: "lifecycle-reissue-local-001",
      binding: bindingOf(active),
      usbFingerprint: "e".repeat(64),
      notBefore: context.input.notBefore,
      expiresAt: "2028-08-10T00:00:00.000Z",
    })).resolves.toEqual(reissued);
    await expect(context.newApiClient.revokeToken(active.newApiTokenId, {
      idempotencyKey: "verify-old-token-revoked",
    })).resolves.toMatchObject({ status: "revoked" });
    await expect(context.credentialStore.loadActive()).resolves.toMatchObject({ tokenId: reissued.newApiTokenId });
  });

  it("keeps secrets out of result, errors, journal, audit, and ordinary config", async () => {
    const context = await setup();
    const result = await context.coordinator.provision(context.input);
    const journalText = await readFile(join(context.dataDir, ".uclaw", "provisioning-transaction.v1.json"), "utf8");
    const audit = await context.newApiClient.listAuditEvents({ cursor: null, pageSize: 100 });
    const safe = JSON.stringify({ result, journal: JSON.parse(journalText), audit });
    expect(safe).not.toMatch(/startupSecret|tokenSecret|managementCredential|authorization|providerKey|upstreamKey|fixture-.*credential/iu);
    expect(safe).not.toContain("uclaw_dev_");
    expect(safe).not.toContain("fixture-license-management-credential");
    expect(safe).not.toContain("fixture-new-api-management-credential");
  });
});
