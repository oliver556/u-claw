import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createNewApiManagementClient,
  startLocalNewApiManagementServer,
  type LocalNewApiManagementServer,
} from "../../desktop/src/new-api-management/index.js";
import { createMainProcessModelRouting, ModelSourceFailure } from "../../desktop/src/providers/model-source-router.js";
import { createProviderStore } from "../../desktop/src/providers/provider-store.js";

const servers: LocalNewApiManagementServer[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("typed New API model source routing integration", () => {
  it("keeps builtin quota and credentials isolated when an external source is active", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-routing-integration-"));
    roots.push(dataDir);
    const server = await startLocalNewApiManagementServer({ managementCredential: "fixture-management-credential" });
    servers.push(server);
    const management = createNewApiManagementClient({
      endpoint: server.url, managementCredential: "fixture-management-credential", allowLoopbackHttp: true,
    });
    const user = await management.createUser({ idempotencyKey: "route-user-001", deviceId: "route_device", username: "route_user" });
    const policy = {
      quota: { unit: "tokens" as const, limit: 100_000, period: "monthly" as const },
      rateLimit: { requestsPerMinute: 60, concurrentRequests: 2 },
      allowedModels: ["builtin-model"], disabled: false,
    };
    await management.updatePolicy(user.id, policy);
    const policyDigest = createHash("sha256").update("uclaw-new-api-policy-v1\0").update(JSON.stringify(policy)).digest("hex");
    const issuedToken = await management.createToken({
      idempotencyKey: "route-token-001", userId: user.id, name: "device",
      channelId: "channel_builtin_001", policyDigest, generation: 1,
    });
    const provisioning = await management.createDeviceMapping({
      idempotencyKey: "route-device-001", deviceId: "route_device", licenseId: "route_license",
      startupSecretHash: "a".repeat(64), startupSecretSalt: "b".repeat(32), usbFingerprint: "c".repeat(64),
      newApiUserId: user.id, newApiUsername: user.username, newApiTokenId: issuedToken.token.id, status: "provisioning",
      channelId: "channel_builtin_001", policyDigest, generation: 1, previousTokenId: null,
    });
    const mapping = await management.updateDeviceStatus(provisioning.deviceId, {
      idempotencyKey: "route-active-001", status: "active", expectedStatus: "provisioning",
      expectedGeneration: 1, expectedLicenseId: provisioning.licenseId, expectedTokenId: issuedToken.token.id,
    });
    const activeToken = await management.activateToken(issuedToken.token.id, {
      idempotencyKey: "route-token-active-001", deviceId: provisioning.deviceId,
    });

    const providers = createProviderStore({ dataDir });
    const domestic = vi.fn(async () => { throw new ModelSourceFailure("domestic", "quota"); });
    const custom = vi.fn(async () => ({ source: "custom" as const }));
    const routing = createMainProcessModelRouting({
      dataDir, providers, allowLoopbackHttp: true, executors: { domestic, custom },
    });
    const endpoint = new URL("/v1", server.url).href;
    await routing.credentials.provision({
      endpoint, model: "builtin-model", mapping, issuedToken: { ...issuedToken, token: activeToken },
    });

    const loadActive = vi.spyOn(routing.credentials, "loadActive");
    await providers.setEnabled("deepseek", true);
    const externalError = await routing.routeChatSend({ prompt: "external" }).catch((error: unknown) => error);
    expect(externalError).toMatchObject({ source: "domestic", category: "quota", code: "MODEL_UNAVAILABLE" });
    expect(loadActive).not.toHaveBeenCalled();
    expect(domestic).toHaveBeenCalledOnce();
    expect(custom).not.toHaveBeenCalled();

    const serialized = JSON.stringify(externalError);
    expect(serialized).not.toContain(endpoint);
    expect(serialized).not.toContain(user.username);
    expect(serialized).not.toContain(issuedToken.secret);
  });

  it("applies authoritative service and device lifecycle changes without builtin fallback or reprovisioning", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-routing-lifecycle-"));
    roots.push(dataDir);
    let licenseState: "active" | "revoked" | "disabled" | "expired" | "reissued" = "active";
    let licenseRevision = 1;
    let upstreamCalls = 0;
    const server = await startLocalNewApiManagementServer({
      managementCredential: "fixture-lifecycle-management-credential",
      now: () => new Date("2026-08-11T00:00:00.000Z"),
      builtin: {
        readLicenseStatus: async (licenseId) => ({
          licenseId,
          deviceId: "route_lifecycle_device",
          status: licenseState,
          revision: licenseRevision,
          notBefore: "2026-08-10T00:00:00.000Z",
          expiresAt: "2027-08-10T00:00:00.000Z",
          replacementLicenseId: licenseState === "reissued" ? "route_replacement_license" : null,
          updatedAt: "2026-08-11T00:00:00.000Z",
        }),
        execute: async () => {
          upstreamCalls += 1;
          return { output: "builtin-answer", usage: { inputTokens: 1, outputTokens: 1 } };
        },
      },
    });
    servers.push(server);
    const management = createNewApiManagementClient({
      endpoint: server.url,
      managementCredential: "fixture-lifecycle-management-credential",
      allowLoopbackHttp: true,
    });
    const user = await management.createUser({
      idempotencyKey: "route-lifecycle-user",
      deviceId: "route_lifecycle_device",
      username: "route_lifecycle_user",
    });
    const policy = {
      quota: { unit: "requests" as const, limit: 100, period: "daily" as const },
      rateLimit: { requestsPerMinute: 60, concurrentRequests: 2 },
      allowedModels: ["builtin-model"],
      disabled: false,
    };
    await management.updatePolicy(user.id, policy);
    const policyDigest = createHash("sha256").update("uclaw-new-api-policy-v1\0").update(JSON.stringify(policy)).digest("hex");
    const issued = await management.createToken({
      idempotencyKey: "route-lifecycle-token",
      userId: user.id,
      name: "device",
      channelId: "route_lifecycle_channel",
      policyDigest,
      generation: 1,
    });
    const provisioning = await management.createDeviceMapping({
      idempotencyKey: "route-lifecycle-mapping",
      deviceId: "route_lifecycle_device",
      licenseId: "route_lifecycle_license",
      startupSecretHash: "a".repeat(64),
      startupSecretSalt: "b".repeat(32),
      usbFingerprint: "c".repeat(64),
      newApiUserId: user.id,
      newApiUsername: user.username,
      newApiTokenId: issued.token.id,
      channelId: "route_lifecycle_channel",
      policyDigest,
      generation: 1,
      previousTokenId: null,
      status: "provisioning",
    });
    const mapping = await management.updateDeviceStatus(provisioning.deviceId, {
      idempotencyKey: "route-lifecycle-mapping-active",
      status: "active",
      expectedStatus: "provisioning",
      expectedGeneration: 1,
      expectedLicenseId: provisioning.licenseId,
      expectedTokenId: issued.token.id,
    });
    const activeToken = await management.activateToken(issued.token.id, {
      idempotencyKey: "route-lifecycle-token-active",
      deviceId: mapping.deviceId,
    });
    await management.updateServiceStatus({
      idempotencyKey: "route-lifecycle-service-enable",
      expectedRevision: 1,
      state: "enabled",
      reasonCode: "OPERATOR_ENABLED",
    });

    const providers = createProviderStore({ dataDir });
    const domestic = vi.fn(async () => ({ source: "domestic" as const }));
    const custom = vi.fn(async () => ({ source: "custom" as const }));
    const routing = createMainProcessModelRouting({
      dataDir,
      providers,
      allowLoopbackHttp: true,
      executors: { domestic, custom },
    });
    await routing.credentials.provision({
      endpoint: server.dataUrl,
      model: "builtin-model",
      mapping,
      issuedToken: { ...issued, token: activeToken },
    });
    let requestSequence = 0;
    const routeBuiltin = () => routing.routeChatSend({
      schemaVersion: 1 as const,
      requestId: `route_lifecycle_request_${++requestSequence}`,
      model: "builtin-model",
      prompt: "hello",
      maxOutputTokens: 10,
    });

    await expect(routeBuiltin()).resolves.toMatchObject({ serviceState: "enabled", output: "builtin-answer" });
    await management.updateServiceStatus({
      idempotencyKey: "route-lifecycle-service-degraded",
      expectedRevision: 2,
      state: "degraded",
      reasonCode: "DEGRADED_HEALTH",
    });
    await expect(routeBuiltin()).resolves.toMatchObject({ serviceState: "degraded", serviceRevision: 3 });

    await management.updateServiceStatus({
      idempotencyKey: "route-lifecycle-service-maintenance",
      expectedRevision: 3,
      state: "maintenance",
      reasonCode: "SCHEDULED_MAINTENANCE",
    });
    await expect(routeBuiltin()).rejects.toMatchObject({ category: "unavailable", code: "SERVICE_MAINTENANCE", retryable: false });
    const callsBeforeExternal = upstreamCalls;
    const loadActive = vi.spyOn(routing.credentials, "loadActive");
    await providers.setApiKey("deepseek", randomBytes(24).toString("hex"));
    await providers.setEnabled("deepseek", true);
    await expect(routeBuiltin()).resolves.toEqual({ source: "domestic" });
    expect(upstreamCalls).toBe(callsBeforeExternal);
    expect(loadActive).not.toHaveBeenCalled();
    await providers.create({
      id: "route-lifecycle-custom",
      name: "Lifecycle custom",
      enabled: true,
      baseUrl: "https://custom.example.test/v1",
      model: "custom-model",
    });
    await providers.setApiKey("route-lifecycle-custom", randomBytes(24).toString("hex"));
    await expect(routeBuiltin()).resolves.toEqual({ source: "custom" });
    expect(upstreamCalls).toBe(callsBeforeExternal);
    expect(loadActive).not.toHaveBeenCalled();
    loadActive.mockRestore();
    await providers.remove("route-lifecycle-custom");
    await providers.setEnabled("deepseek", false);
    await management.updateServiceStatus({
      idempotencyKey: "route-lifecycle-service-disable",
      expectedRevision: 4,
      state: "disabled",
      reasonCode: "OPERATOR_DISABLED",
    });
    await expect(routeBuiltin()).rejects.toMatchObject({ category: "unavailable", code: "SERVICE_DISABLED", retryable: false });
    await management.updateServiceStatus({
      idempotencyKey: "route-lifecycle-service-reenable",
      expectedRevision: 5,
      state: "enabled",
      reasonCode: "RECOVERY_COMPLETE",
    });

    const controls = await management.getDeviceControls({ deviceId: mapping.deviceId });
    await management.updateDeviceControls({ deviceId: mapping.deviceId }, {
      idempotencyKey: "route-lifecycle-policy-disable",
      expectedRevision: controls.revision,
      expectedGeneration: controls.generation,
      expectedLicenseId: controls.licenseId,
      expectedTokenId: controls.tokenId,
      policy: { ...controls.policy, disabled: true },
    });
    await expect(routeBuiltin()).rejects.toMatchObject({ category: "disabled", code: "DEVICE_DISABLED" });
    const disabledControls = await management.getDeviceControls({ deviceId: mapping.deviceId });
    await management.updateDeviceControls({ deviceId: mapping.deviceId }, {
      idempotencyKey: "route-lifecycle-policy-reenable",
      expectedRevision: disabledControls.revision,
      expectedGeneration: disabledControls.generation,
      expectedLicenseId: disabledControls.licenseId,
      expectedTokenId: disabledControls.tokenId,
      policy,
    });
    await expect(routeBuiltin()).resolves.toMatchObject({ serviceState: "enabled" });

    for (const state of ["revoked", "disabled", "expired", "reissued"] as const) {
      licenseState = state;
      licenseRevision += 1;
      await expect(routeBuiltin()).rejects.toMatchObject({ category: "authentication", code: "AUTHENTICATION_FAILED" });
    }
    licenseState = "active";
    licenseRevision += 1;
    await expect(routeBuiltin()).resolves.toMatchObject({ serviceState: "enabled" });

    await management.updateDeviceStatus(mapping.deviceId, {
      idempotencyKey: "route-lifecycle-mapping-disable",
      status: "disabled",
      expectedStatus: "active",
      expectedGeneration: mapping.generation,
      expectedLicenseId: mapping.licenseId,
      expectedTokenId: mapping.newApiTokenId,
    });
    await expect(routeBuiltin()).rejects.toMatchObject({ category: "authentication", code: "AUTHENTICATION_FAILED" });
    await management.updateDeviceStatus(mapping.deviceId, {
      idempotencyKey: "route-lifecycle-mapping-reenable",
      status: "active",
      expectedStatus: "disabled",
      expectedGeneration: mapping.generation,
      expectedLicenseId: mapping.licenseId,
      expectedTokenId: mapping.newApiTokenId,
    });
    await expect(routeBuiltin()).resolves.toMatchObject({ serviceState: "enabled" });

    await management.revokeToken(issued.token.id, { idempotencyKey: "route-lifecycle-token-revoke" });
    await expect(routeBuiltin()).rejects.toMatchObject({ category: "authentication", code: "AUTHENTICATION_FAILED" });
    expect(domestic).toHaveBeenCalledOnce();
    expect(custom).toHaveBeenCalledOnce();
  });
});
