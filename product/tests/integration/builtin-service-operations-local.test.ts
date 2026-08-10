import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  createNewApiManagementClient,
  type LocalNewApiManagementServer,
  LocalBuiltinUpstreamError,
  NewApiManagementError,
  startLocalNewApiManagementServer,
} from "../../desktop/src/new-api-management/index.js";

const servers: LocalNewApiManagementServer[] = [];
const channelId = "channel_builtin_ops_001";
const initialPolicy = {
  quota: { unit: "tokens" as const, limit: 10_000, period: "monthly" as const },
  rateLimit: { requestsPerMinute: 30, concurrentRequests: 2 },
  allowedModels: ["model-a", "model-b"],
  disabled: false,
};
const updatedPolicy = {
  quota: { unit: "requests" as const, limit: 500, period: "daily" as const },
  rateLimit: { requestsPerMinute: 12, concurrentRequests: 1 },
  allowedModels: ["model-b"],
  disabled: true,
};

const digestPolicy = (value: unknown): string => createHash("sha256")
  .update("uclaw-new-api-policy-v1\0")
  .update(JSON.stringify(value))
  .digest("hex");

afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

type BuiltinDependencies = NonNullable<Parameters<typeof startLocalNewApiManagementServer>[0]["builtin"]>;

async function setup(configured: boolean | BuiltinDependencies = true) {
  const managementCredential = randomBytes(32).toString("base64url");
  const server = await startLocalNewApiManagementServer({
    hostname: "127.0.0.1",
    managementCredential,
    now: () => new Date("2026-08-11T00:00:00.000Z"),
    ...(configured ? {
      builtin: {
        readLicenseStatus: async (licenseId: string) => ({
          licenseId,
          deviceId: "dev_ops_001",
          status: "active" as const,
          revision: 1,
          notBefore: "2026-08-10T00:00:00.000Z",
          expiresAt: "2027-08-10T00:00:00.000Z",
          replacementLicenseId: null,
          updatedAt: "2026-08-11T00:00:00.000Z",
        }),
        execute: async () => ({ output: "unused", usage: { inputTokens: 1, outputTokens: 1 } }),
        ...(typeof configured === "object" ? configured : {}),
      },
    } : {}),
  });
  servers.push(server);
  return {
    server,
    managementCredential,
    client: createNewApiManagementClient({
      endpoint: server.url,
      managementCredential,
      allowLoopbackHttp: true,
    }),
  };
}

async function activateMapping(client: ReturnType<typeof createNewApiManagementClient>) {
  const created = await createMapping(client);
  await client.updateDeviceStatus(created.mapping.deviceId, {
    idempotencyKey: "ops-data-mapping-active",
    status: "active",
    expectedStatus: "provisioning",
    expectedGeneration: created.mapping.generation,
    expectedLicenseId: created.mapping.licenseId,
    expectedTokenId: created.issued.token.id,
  });
  await client.activateToken(created.issued.token.id, {
    idempotencyKey: "ops-data-token-active",
    deviceId: created.mapping.deviceId,
  });
  return created;
}

async function enableBuiltin(client: ReturnType<typeof createNewApiManagementClient>) {
  return client.updateServiceStatus({
    idempotencyKey: "ops-data-service-enable",
    expectedRevision: 1,
    state: "enabled",
    reasonCode: "OPERATOR_ENABLED",
  });
}

async function dataRequest(
  server: LocalNewApiManagementServer,
  secret: string,
  route: "models/respond" | "health" = "models/respond",
  body: unknown = {
    schemaVersion: 1,
    requestId: "req_builtin_ops_001",
    model: "model-a",
    prompt: "hello",
    maxOutputTokens: 10,
  },
): Promise<Response> {
  return fetch(new URL(route, server.dataUrl), {
    method: route === "health" ? "GET" : "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    ...(route === "health" ? {} : { body: JSON.stringify(body) }),
  });
}

async function createMapping(client: ReturnType<typeof createNewApiManagementClient>) {
  const user = await client.createUser({
    idempotencyKey: "ops-user-create-001",
    deviceId: "dev_ops_001",
    username: "uclaw_ops_001",
  });
  await client.updatePolicy(user.id, initialPolicy);
  const policyDigest = digestPolicy(initialPolicy);
  const issued = await client.createToken({
    idempotencyKey: "ops-token-create-001",
    userId: user.id,
    name: "device",
    channelId,
    policyDigest,
    generation: 1,
  });
  const mapping = await client.createDeviceMapping({
    idempotencyKey: "ops-device-create-001",
    deviceId: "dev_ops_001",
    licenseId: "lic_ops_001",
    startupSecretHash: "a".repeat(64),
    startupSecretSalt: "b".repeat(32),
    usbFingerprint: "c".repeat(64),
    newApiUserId: user.id,
    newApiUsername: user.username,
    newApiTokenId: issued.token.id,
    channelId,
    policyDigest,
    generation: 1,
    previousTokenId: null,
    status: "provisioning",
  });
  return { user, issued, mapping };
}

describe("localhost builtin service management operations", () => {
  it("starts disabled and fails closed when builtin dependencies are absent", async () => {
    const configured = await setup();
    await expect(configured.client.getServiceStatus()).resolves.toMatchObject({
      schemaVersion: 1,
      state: "disabled",
      revision: 1,
      reasonCode: "OPERATOR_DISABLED",
    });

    const unavailable = await setup(false);
    await expect(unavailable.client.updateServiceStatus({
      idempotencyKey: "ops-service-enable-unavailable",
      expectedRevision: 1,
      state: "enabled",
      reasonCode: "OPERATOR_ENABLED",
    })).rejects.toMatchObject({ category: "unavailable", code: "SERVICE_UNAVAILABLE", retryable: false });
  });

  it("enforces service transitions, CAS, sealed replay, and concurrent writes", async () => {
    const { client } = await setup();
    const enabledInput = {
      idempotencyKey: "ops-service-enable-001",
      expectedRevision: 1,
      state: "enabled" as const,
      reasonCode: "OPERATOR_ENABLED" as const,
    };
    const enabled = await client.updateServiceStatus(enabledInput);
    expect(enabled).toMatchObject({ state: "enabled", revision: 2 });

    const maintenance = await client.updateServiceStatus({
      idempotencyKey: "ops-service-maintenance-001",
      expectedRevision: 2,
      state: "maintenance",
      reasonCode: "SCHEDULED_MAINTENANCE",
    });
    await expect(client.updateServiceStatus(enabledInput)).resolves.toEqual(enabled);
    expect(maintenance.revision).toBe(3);

    await expect(client.updateServiceStatus({ ...enabledInput, state: "degraded", reasonCode: "DEGRADED_HEALTH" }))
      .rejects.toMatchObject({ category: "conflict", code: "IDEMPOTENCY_CONFLICT" });
    await expect(client.updateServiceStatus({
      idempotencyKey: "ops-service-stale-001",
      expectedRevision: 2,
      state: "disabled",
      reasonCode: "OPERATOR_DISABLED",
    })).rejects.toMatchObject({ category: "conflict", code: "SERVICE_STATE_CAS_CONFLICT" });
    await expect(client.updateServiceStatus({
      idempotencyKey: "ops-service-noop-001",
      expectedRevision: 3,
      state: "maintenance",
      reasonCode: "SCHEDULED_MAINTENANCE",
    })).rejects.toMatchObject({ category: "conflict", code: "SERVICE_STATE_TRANSITION_INVALID" });

    const concurrent = await Promise.allSettled([
      client.updateServiceStatus({
        idempotencyKey: "ops-service-concurrent-a",
        expectedRevision: 3,
        state: "enabled",
        reasonCode: "RECOVERY_COMPLETE",
      }),
      client.updateServiceStatus({
        idempotencyKey: "ops-service-concurrent-b",
        expectedRevision: 3,
        state: "disabled",
        reasonCode: "OPERATOR_DISABLED",
      }),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = concurrent.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ category: "conflict", code: "SERVICE_STATE_CAS_CONFLICT" });
    await expect(client.getServiceStatus()).resolves.toMatchObject({ revision: 4 });
  });

  it("rejects maintenance to degraded because it is absent from the transition table", async () => {
    const { client } = await setup();
    await client.updateServiceStatus({
      idempotencyKey: "ops-transition-maintenance",
      expectedRevision: 1,
      state: "maintenance",
      reasonCode: "SCHEDULED_MAINTENANCE",
    });
    await expect(client.updateServiceStatus({
      idempotencyKey: "ops-transition-degraded",
      expectedRevision: 2,
      state: "degraded",
      reasonCode: "DEGRADED_HEALTH",
    })).rejects.toMatchObject({ code: "SERVICE_STATE_TRANSITION_INVALID" });
  });

  it("creates controls with mappings and updates policy bindings atomically by device or user", async () => {
    const { client } = await setup();
    const { user, issued, mapping } = await createMapping(client);
    await client.updateDeviceStatus(mapping.deviceId, {
      idempotencyKey: "ops-controls-mapping-active",
      status: "active",
      expectedStatus: "provisioning",
      expectedGeneration: mapping.generation,
      expectedLicenseId: mapping.licenseId,
      expectedTokenId: issued.token.id,
    });
    await client.activateToken(issued.token.id, {
      idempotencyKey: "ops-controls-token-active",
      deviceId: mapping.deviceId,
    });
    const initial = await client.getDeviceControls({ deviceId: mapping.deviceId });
    await expect(client.getDeviceControls({ userId: user.id })).resolves.toEqual(initial);
    expect(initial).toMatchObject({
      schemaVersion: 1,
      deviceId: mapping.deviceId,
      userId: user.id,
      revision: 1,
      generation: 1,
      licenseId: mapping.licenseId,
      tokenId: issued.token.id,
      policy: initialPolicy,
      policyDigest: digestPolicy(initialPolicy),
    });

    const input = {
      idempotencyKey: "ops-controls-update-001",
      expectedRevision: 1,
      expectedGeneration: 1,
      expectedLicenseId: mapping.licenseId,
      expectedTokenId: issued.token.id,
      policy: updatedPolicy,
    };
    const updated = await client.updateDeviceControls({ userId: user.id }, input);
    expect(updated).toMatchObject({ revision: 2, policy: updatedPolicy, policyDigest: digestPolicy(updatedPolicy) });
    await expect(client.updateDeviceControls({ userId: user.id }, input)).resolves.toEqual(updated);
    await expect(client.getDeviceControls({ deviceId: mapping.deviceId })).resolves.toEqual(updated);
    await expect(client.getPolicy(user.id)).resolves.toEqual(updatedPolicy);
    await expect(client.getUser(user.id)).resolves.toMatchObject({ status: "disabled", policy: updatedPolicy });
    await expect(client.getDeviceMapping(mapping.deviceId)).resolves.toMatchObject({ policyDigest: updated.policyDigest });
    await expect(client.activateToken(issued.token.id, {
      idempotencyKey: "ops-controls-token-readback",
      deviceId: mapping.deviceId,
    })).resolves.toMatchObject({ policyDigest: updated.policyDigest });

    await expect(client.updateDeviceControls({ deviceId: mapping.deviceId }, {
      ...input,
      idempotencyKey: "ops-controls-stale-001",
    })).rejects.toMatchObject({ category: "conflict", code: "DEVICE_CONTROLS_CAS_CONFLICT" });
  });

  it("rejects mapping creation when the authoritative user policy changed after token creation", async () => {
    const { client } = await setup();
    const user = await client.createUser({
      idempotencyKey: "ops-race-user-create",
      deviceId: "dev_policy_race",
      username: "uclaw_policy_race",
    });
    await client.updatePolicy(user.id, initialPolicy);
    const originalDigest = digestPolicy(initialPolicy);
    const issued = await client.createToken({
      idempotencyKey: "ops-race-token-create",
      userId: user.id,
      name: "device",
      channelId,
      policyDigest: originalDigest,
      generation: 1,
    });
    await client.updatePolicy(user.id, { ...initialPolicy, allowedModels: ["model-b"] });
    await expect(client.createDeviceMapping({
      idempotencyKey: "ops-race-device-create",
      deviceId: "dev_policy_race",
      licenseId: "lic_policy_race",
      startupSecretHash: "d".repeat(64),
      startupSecretSalt: "e".repeat(32),
      usbFingerprint: "f".repeat(64),
      newApiUserId: user.id,
      newApiUsername: user.username,
      newApiTokenId: issued.token.id,
      channelId,
      policyDigest: originalDigest,
      generation: 1,
      previousTokenId: null,
      status: "provisioning",
    })).rejects.toMatchObject({ category: "conflict", code: "POLICY_BINDING_CONFLICT" });
  });

  it("serializes concurrent controls CAS and prevents non-CAS policy bypass after mapping", async () => {
    const { client } = await setup();
    const { user, issued, mapping } = await createMapping(client);
    const base = {
      expectedRevision: 1,
      expectedGeneration: 1,
      expectedLicenseId: mapping.licenseId,
      expectedTokenId: issued.token.id,
    };
    const concurrent = await Promise.allSettled([
      client.updateDeviceControls({ deviceId: mapping.deviceId }, {
        ...base,
        idempotencyKey: "ops-controls-concurrent-a",
        policy: updatedPolicy,
      }),
      client.updateDeviceControls({ deviceId: mapping.deviceId }, {
        ...base,
        idempotencyKey: "ops-controls-concurrent-b",
        policy: { ...initialPolicy, rateLimit: { requestsPerMinute: 9, concurrentRequests: 1 } },
      }),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.find((result) => result.status === "rejected")).toMatchObject({
      reason: { category: "conflict", code: "DEVICE_CONTROLS_CAS_CONFLICT" },
    });
    await expect(client.getDeviceControls({ deviceId: mapping.deviceId })).resolves.toMatchObject({ revision: 2 });
    await expect(client.updatePolicy(user.id, initialPolicy)).rejects.toMatchObject({
      category: "conflict",
      code: "OPERATIONS_CAS_REQUIRED",
    });
  });

  it("strictly rejects malformed locators and responses and audits successful mutations once", async () => {
    const { client } = await setup();
    const { user, issued, mapping } = await createMapping(client);
    await expect(client.getDeviceControls({ deviceId: mapping.deviceId, userId: user.id } as never)).rejects.toBeTruthy();
    await client.updateDeviceControls({ deviceId: mapping.deviceId }, {
      idempotencyKey: "ops-controls-audit-001",
      expectedRevision: 1,
      expectedGeneration: 1,
      expectedLicenseId: mapping.licenseId,
      expectedTokenId: issued.token.id,
      policy: updatedPolicy,
    });
    await client.updateDeviceControls({ deviceId: mapping.deviceId }, {
      idempotencyKey: "ops-controls-audit-001",
      expectedRevision: 1,
      expectedGeneration: 1,
      expectedLicenseId: mapping.licenseId,
      expectedTokenId: issued.token.id,
      policy: updatedPolicy,
    });
    const events = await client.listAuditEvents({ deviceId: mapping.deviceId, cursor: null, pageSize: 100 });
    expect(events.items.filter((event) => event.action === "device-controls.updated")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(/authorization|managementCredential|provider.?key|upstream.?key|token.?secret|headers|body|endpoint|username/iu);

    const malformed = createNewApiManagementClient({
      endpoint: "https://management.example.test/uclaw-management/v1/",
      managementCredential: randomBytes(32).toString("base64url"),
      fetch: async () => new Response(JSON.stringify({
        schemaVersion: 1,
        state: "disabled",
        revision: 1,
        reasonCode: "OPERATOR_DISABLED",
        updatedAt: "2026-08-11T00:00:00.000Z",
        unknown: true,
      }), { headers: { "content-type": "application/json" } }),
    });
    await expect(malformed.getServiceStatus()).rejects.toBeInstanceOf(NewApiManagementError);
    await expect(malformed.getServiceStatus()).rejects.toMatchObject({ code: "INVALID_RESPONSE_BODY" });
  });
});

describe("localhost builtin service data plane", () => {
  it("serves strict model responses and authenticated health on an independent listener", async () => {
    const { client, server } = await setup({
      readLicenseStatus: async (licenseId) => ({
        licenseId,
        deviceId: "dev_ops_001",
        status: "active",
        revision: 1,
        notBefore: "2026-08-10T00:00:00.000Z",
        expiresAt: "2027-08-10T00:00:00.000Z",
        replacementLicenseId: null,
        updatedAt: "2026-08-11T00:00:00.000Z",
      }),
      execute: async (_request, signal) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        return { output: "answer", usage: { inputTokens: 2, outputTokens: 3 } };
      },
    });
    const { issued } = await activateMapping(client);
    await enableBuiltin(client);

    expect(server.dataUrl).not.toBe(server.url);
    const response = await dataRequest(server, issued.secret);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 1,
      requestId: "req_builtin_ops_001",
      output: "answer",
      usage: { inputTokens: 2, outputTokens: 3 },
      serviceState: "enabled",
      serviceRevision: 2,
    });
    const health = await dataRequest(server, issued.secret, "health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ schemaVersion: 1, acceptingBuiltin: true, state: "enabled", revision: 2 });
    const audit = await client.listAuditEvents({ deviceId: "dev_ops_001", cursor: null, pageSize: 100 });
    expect(audit.items.filter((event) => [
      "builtin.request-succeeded", "builtin.health-queried",
    ].includes(event.action))).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "builtin.request-succeeded", serviceRevision: 2 }),
      expect.objectContaining({ action: "builtin.health-queried", serviceRevision: 2 }),
    ]));
    const allAudit = await client.listAuditEvents({ cursor: null, pageSize: 100 });
    expect(allAudit.items).toContainEqual(expect.objectContaining({ action: "service-state.updated", serviceRevision: 2 }));
  });

  it("separates management and data credentials with the same fixed authentication error", async () => {
    const { client, server, managementCredential } = await setup();
    const { issued } = await activateMapping(client);
    await enableBuiltin(client);
    const invalid = await dataRequest(server, "invalid-device-credential");
    const management = await dataRequest(server, managementCredential);
    const rawToken = await fetch(new URL("models/respond", server.dataUrl), {
      method: "POST",
      headers: { authorization: issued.secret, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, requestId: "req_raw_token_001", model: "model-a", prompt: "hello", maxOutputTokens: 1 }),
    });
    const revokedShape = await Promise.all([invalid, management].map(async (response) => ({
      status: response.status,
      body: await response.json(),
    })));
    expect(revokedShape[0]).toEqual(revokedShape[1]);
    expect(rawToken.status).toBe(401);
    expect(revokedShape[0]).toEqual({
      status: 401,
      body: { error: { category: "authentication", code: "AUTHENTICATION_FAILED", message: "Data authentication failed.", retryable: false } },
    });
    const managementWithDeviceToken = await fetch(new URL("operations/service", server.url), {
      headers: { authorization: `Bearer ${issued.secret}` },
    });
    expect(managementWithDeviceToken.status).toBe(401);
  });

  it("authenticates before reporting unconfigured data dependencies", async () => {
    const { client, server } = await setup(false);
    const { issued, mapping } = await activateMapping(client);
    const invalid = await dataRequest(server, "invalid-device-credential", "health");
    expect(invalid.status).toBe(401);
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: "AUTHENTICATION_FAILED" } });
    const authenticated = await dataRequest(server, issued.secret, "health");
    expect(authenticated.status).toBe(503);
    await expect(authenticated.json()).resolves.toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
    await client.updateDeviceStatus(mapping.deviceId, {
      idempotencyKey: "ops-unconfigured-health-stale",
      status: "disabled",
      expectedStatus: "active",
      expectedGeneration: mapping.generation,
      expectedLicenseId: mapping.licenseId,
      expectedTokenId: mapping.newApiTokenId,
    });
    const stale = await dataRequest(server, issued.secret, "health");
    expect(stale.status).toBe(401);
    await expect(stale.json()).resolves.toEqual({
      error: { category: "authentication", code: "AUTHENTICATION_FAILED", message: "Data authentication failed.", retryable: false },
    });
    await client.updateDeviceStatus(mapping.deviceId, {
      idempotencyKey: "ops-unconfigured-health-reactivate",
      status: "active",
      expectedStatus: "disabled",
      expectedGeneration: mapping.generation,
      expectedLicenseId: mapping.licenseId,
      expectedTokenId: mapping.newApiTokenId,
    });
    await client.revokeToken(issued.token.id, { idempotencyKey: "ops-unconfigured-health-revoke" });
    const revoked = await dataRequest(server, issued.secret, "health");
    expect(revoked.status).toBe(401);
    const revokedBody = await revoked.json();
    expect(revokedBody).toEqual({
      error: { category: "authentication", code: "AUTHENTICATION_FAILED", message: "Data authentication failed.", retryable: false },
    });
    expect(JSON.stringify(revokedBody)).not.toMatch(/state|revision/iu);
  });

  it("rejects invalid, stale, and revoked model credentials before unconfigured dependencies", async () => {
    const { client, server } = await setup(false);
    const { issued, mapping } = await activateMapping(client);
    expect((await dataRequest(server, "invalid-device-credential")).status).toBe(401);
    const authenticated = await dataRequest(server, issued.secret);
    expect(authenticated.status).toBe(503);
    await expect(authenticated.json()).resolves.toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
    await client.updateDeviceStatus(mapping.deviceId, {
      idempotencyKey: "ops-unconfigured-model-stale",
      status: "disabled",
      expectedStatus: "active",
      expectedGeneration: mapping.generation,
      expectedLicenseId: mapping.licenseId,
      expectedTokenId: mapping.newApiTokenId,
    });
    const stale = await dataRequest(server, issued.secret, "models/respond", {
      schemaVersion: 1,
      requestId: "req_unconfigured_stale_001",
      model: "model-a",
      prompt: "must-not-parse",
      maxOutputTokens: 1,
      unknown: true,
    });
    expect(stale.status).toBe(401);
    await client.updateDeviceStatus(mapping.deviceId, {
      idempotencyKey: "ops-unconfigured-model-reactivate",
      status: "active",
      expectedStatus: "disabled",
      expectedGeneration: mapping.generation,
      expectedLicenseId: mapping.licenseId,
      expectedTokenId: mapping.newApiTokenId,
    });
    await client.revokeToken(issued.token.id, { idempotencyKey: "ops-unconfigured-model-revoke" });
    const revoked = await fetch(new URL("models/respond", server.dataUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${issued.secret}`, "content-type": "application/json" },
      body: "{must-not-parse",
    });
    expect(revoked.status).toBe(401);
    const revokedBody = await revoked.json();
    expect(revokedBody).toEqual({
      error: { category: "authentication", code: "AUTHENTICATION_FAILED", message: "Data authentication failed.", retryable: false },
    });
    expect(JSON.stringify(revokedBody)).not.toMatch(/state|revision/iu);
  });

  it("closes state and policy changes immediately without silent service fallback", async () => {
    const { client, server } = await setup();
    const { issued, mapping } = await activateMapping(client);
    await enableBuiltin(client);
    await client.updateServiceStatus({
      idempotencyKey: "ops-data-maintenance",
      expectedRevision: 2,
      state: "maintenance",
      reasonCode: "SCHEDULED_MAINTENANCE",
    });
    const maintenance = await dataRequest(server, issued.secret);
    expect(maintenance.status).toBe(503);
    await expect(maintenance.json()).resolves.toMatchObject({ error: { code: "SERVICE_MAINTENANCE", retryable: false } });
    const health = await dataRequest(server, issued.secret, "health");
    await expect(health.json()).resolves.toEqual({ schemaVersion: 1, acceptingBuiltin: false, state: "maintenance", revision: 3 });

    await client.updateServiceStatus({
      idempotencyKey: "ops-data-disable",
      expectedRevision: 3,
      state: "disabled",
      reasonCode: "OPERATOR_DISABLED",
    });
    const serviceDisabled = await dataRequest(server, issued.secret);
    await expect(serviceDisabled.json()).resolves.toMatchObject({ error: { code: "SERVICE_DISABLED", retryable: false } });
    await client.updateServiceStatus({
      idempotencyKey: "ops-data-reenable",
      expectedRevision: 4,
      state: "enabled",
      reasonCode: "RECOVERY_COMPLETE",
    });
    const controls = await client.getDeviceControls({ deviceId: mapping.deviceId });
    await client.updateDeviceControls({ deviceId: mapping.deviceId }, {
      idempotencyKey: "ops-data-policy-disable",
      expectedRevision: controls.revision,
      expectedGeneration: controls.generation,
      expectedLicenseId: controls.licenseId,
      expectedTokenId: controls.tokenId,
      policy: { ...controls.policy, disabled: true },
    });
    const disabled = await dataRequest(server, issued.secret);
    expect(disabled.status).toBe(403);
    await expect(disabled.json()).resolves.toMatchObject({ error: { category: "disabled", code: "DEVICE_DISABLED" } });
    const disabledControls = await client.getDeviceControls({ deviceId: mapping.deviceId });
    await client.updateDeviceControls({ deviceId: mapping.deviceId }, {
      idempotencyKey: "ops-data-policy-reenable",
      expectedRevision: disabledControls.revision,
      expectedGeneration: disabledControls.generation,
      expectedLicenseId: disabledControls.licenseId,
      expectedTokenId: disabledControls.tokenId,
      policy: initialPolicy,
    });
    expect((await dataRequest(server, issued.secret)).status).toBe(200);
  });

  it("fails closed for revoked tokens and non-active, stale, or timed-out license state", async () => {
    let mode: "active" | "provisioning" | "revoked" | "reissued" | "expired" | "disabled" | "wrong-device" | "malformed" | "shaped-error" | "timeout" = "active";
    const { client, server } = await setup({
      readLicenseStatus: async (licenseId, signal) => {
        if (mode === "timeout") await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("private timeout cause")), { once: true }));
        if (mode === "shaped-error") throw {
          category: "unavailable",
          code: "ATTACKER_CONTROLLED",
          status: 418,
          retryable: false,
          message: "https://private.example.test Authorization Bearer shaped-secret",
        };
        if (mode === "malformed") return { licenseId, private: "must-not-leak" } as never;
        return {
          licenseId,
          deviceId: mode === "wrong-device" ? "dev_other_001" : "dev_ops_001",
          status: ["provisioning", "revoked", "reissued", "expired", "disabled"].includes(mode) ? mode as "provisioning" : "active",
          revision: 1,
          notBefore: "2026-08-10T00:00:00.000Z",
          expiresAt: "2027-08-10T00:00:00.000Z",
          replacementLicenseId: mode === "reissued" ? "lic_replacement_001" : null,
          updatedAt: "2026-08-11T00:00:00.000Z",
        };
      },
      execute: async () => ({ output: "answer", usage: { inputTokens: 1, outputTokens: 1 } }),
      licenseTimeoutMs: 20,
    });
    const { issued } = await activateMapping(client);
    await enableBuiltin(client);
    for (const rejectedMode of ["provisioning", "revoked", "reissued", "expired", "disabled", "wrong-device", "malformed", "shaped-error", "timeout"] as const) {
      mode = rejectedMode;
      const response = await dataRequest(server, issued.secret);
      expect(response.status).toBe(["timeout", "malformed", "shaped-error"].includes(rejectedMode) ? 503 : 401);
      const serialized = JSON.stringify(await response.json());
      expect(serialized).not.toMatch(/private timeout cause|ATTACKER_CONTROLLED|private\.example|shaped-secret|lic_ops_001|dev_ops_001|uclaw_dev_/u);
    }
    mode = "active";
    const mapping = await client.getDeviceMapping("dev_ops_001");
    await client.updateDeviceStatus(mapping.deviceId, {
      idempotencyKey: "ops-data-mapping-disabled",
      status: "disabled",
      expectedStatus: "active",
      expectedGeneration: mapping.generation,
      expectedLicenseId: mapping.licenseId,
      expectedTokenId: mapping.newApiTokenId,
    });
    expect((await dataRequest(server, issued.secret)).status).toBe(401);
    await client.updateDeviceStatus(mapping.deviceId, {
      idempotencyKey: "ops-data-mapping-reactivated",
      status: "active",
      expectedStatus: "disabled",
      expectedGeneration: mapping.generation,
      expectedLicenseId: mapping.licenseId,
      expectedTokenId: mapping.newApiTokenId,
    });
    await client.revokeToken(issued.token.id, { idempotencyKey: "ops-data-revoke-token" });
    expect((await dataRequest(server, issued.secret)).status).toBe(401);
  });

  it("enforces model permission, quota, RPM, and degraded concurrency atomically", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const { client, server } = await setup({
      readLicenseStatus: async (licenseId) => ({
        licenseId, deviceId: "dev_ops_001", status: "active", revision: 1,
        notBefore: "2026-08-10T00:00:00.000Z", expiresAt: "2027-08-10T00:00:00.000Z",
        replacementLicenseId: null, updatedAt: "2026-08-11T00:00:00.000Z",
      }),
      execute: async () => { await barrier; return { output: "answer", usage: { inputTokens: 1, outputTokens: 1 } }; },
    });
    const { issued } = await activateMapping(client);
    await enableBuiltin(client);
    await client.updateServiceStatus({
      idempotencyKey: "ops-data-degraded",
      expectedRevision: 2,
      state: "degraded",
      reasonCode: "DEGRADED_HEALTH",
    });
    const first = dataRequest(server, issued.secret);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const concurrent = await dataRequest(server, issued.secret);
    expect(concurrent.status).toBe(429);
    await expect(concurrent.json()).resolves.toMatchObject({ error: { code: "CONCURRENCY_LIMIT_EXCEEDED" } });
    release();
    expect((await first).status).toBe(200);

    for (let index = 0; index < 14; index += 1) {
      expect((await dataRequest(server, issued.secret, "models/respond", {
        schemaVersion: 1,
        requestId: `req_rpm_${String(index).padStart(3, "0")}`,
        model: "model-a",
        prompt: "hello",
        maxOutputTokens: 10,
      })).status).toBe(200);
    }
    const rpmLimited = await dataRequest(server, issued.secret);
    await expect(rpmLimited.json()).resolves.toMatchObject({ error: { code: "REQUEST_RATE_LIMIT_EXCEEDED" } });
    const healthAfterRpm = await dataRequest(server, issued.secret, "health");
    await expect(healthAfterRpm.json()).resolves.toMatchObject({ acceptingBuiltin: true });

    const forbidden = await dataRequest(server, issued.secret, "models/respond", {
      schemaVersion: 1, requestId: "req_forbidden_001", model: "model-other", prompt: "hello", maxOutputTokens: 1,
    });
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toMatchObject({ error: { category: "model-permission", code: "MODEL_NOT_ALLOWED" } });
  });

  it("classifies upstream failures and consumes full reservation for invalid responses", async () => {
    let result: unknown = { output: "answer", usage: { inputTokens: 99_999, outputTokens: 1 } };
    const { client, server } = await setup({
      readLicenseStatus: async (licenseId) => ({
        licenseId, deviceId: "dev_ops_001", status: "active", revision: 1,
        notBefore: "2026-08-10T00:00:00.000Z", expiresAt: "2027-08-10T00:00:00.000Z",
        replacementLicenseId: null, updatedAt: "2026-08-11T00:00:00.000Z",
      }),
      execute: async () => result as never,
    });
    const { issued, user } = await activateMapping(client);
    await enableBuiltin(client);
    const excessive = await dataRequest(server, issued.secret);
    expect(excessive.status).toBe(502);
    await expect(excessive.json()).resolves.toMatchObject({ error: { category: "invalid-response", code: "UPSTREAM_INVALID_RESPONSE" } });
    await expect(client.getUsage(user.id)).resolves.toMatchObject({ consumed: 15 });

    result = { output: "answer", usage: { inputTokens: 0, outputTokens: 100 } };
    const excessiveOutput = await dataRequest(server, issued.secret, "models/respond", {
      schemaVersion: 1,
      requestId: "req_excessive_output_001",
      model: "model-a",
      prompt: "x".repeat(100),
      maxOutputTokens: 10,
    });
    expect(excessiveOutput.status).toBe(502);
    await expect(excessiveOutput.json()).resolves.toMatchObject({ error: { code: "UPSTREAM_INVALID_RESPONSE" } });

    result = { output: "answer", usage: { inputTokens: 1, outputTokens: 1 }, unknown: true };
    expect((await dataRequest(server, issued.secret)).status).toBe(502);
  });

  it("classifies upstream 4xx and 5xx without leaking causes and releases ordinary failure reservations", async () => {
    let status = 429;
    const { client, server } = await setup({
      readLicenseStatus: async (licenseId) => ({
        licenseId, deviceId: "dev_ops_001", status: "active", revision: 1,
        notBefore: "2026-08-10T00:00:00.000Z", expiresAt: "2027-08-10T00:00:00.000Z",
        replacementLicenseId: null, updatedAt: "2026-08-11T00:00:00.000Z",
      }),
      execute: async () => { throw new LocalBuiltinUpstreamError(status); },
    });
    const { issued, user } = await activateMapping(client);
    await enableBuiltin(client);
    const clientFailure = await dataRequest(server, issued.secret);
    expect(clientFailure.status).toBe(502);
    await expect(clientFailure.json()).resolves.toEqual({
      error: { category: "upstream", code: "UPSTREAM_4XX", message: "Builtin upstream rejected the request.", retryable: false },
    });
    status = 503;
    const serverFailure = await dataRequest(server, issued.secret);
    expect(serverFailure.status).toBe(502);
    await expect(serverFailure.json()).resolves.toEqual({
      error: { category: "upstream", code: "UPSTREAM_5XX", message: "Builtin upstream failed.", retryable: true },
    });
    await expect(client.getUsage(user.id)).resolves.toMatchObject({ consumed: 0 });
  });

  it("rejects malformed and oversized data bodies without logging request or credential material", async () => {
    const { client, server } = await setup();
    const { issued, mapping } = await activateMapping(client);
    await enableBuiltin(client);
    const malformed = await fetch(new URL("models/respond", server.dataUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${issued.secret}`, "content-type": "application/json" },
      body: "{private malformed prompt",
    });
    expect(malformed.status).toBe(400);
    const oversized = await fetch(new URL("models/respond", server.dataUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${issued.secret}`, "content-type": "application/json" },
      body: "x".repeat(256 * 1024 + 1),
    });
    expect(oversized.status).toBe(413);
    const unknown = await dataRequest(server, issued.secret, "models/respond", {
      schemaVersion: 1, requestId: "req_unknown_001", model: "model-a", prompt: "private prompt", maxOutputTokens: 1, secret: issued.secret,
    });
    expect(unknown.status).toBe(400);
    const events = await client.listAuditEvents({ deviceId: mapping.deviceId, cursor: null, pageSize: 100 });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toMatch(/private malformed prompt|private prompt|uclaw_dev_|authorization|headers|body|endpoint|username/iu);
  });

  it("lets admitted work finish while state CAS immediately blocks new reservations", async () => {
    let started!: () => void;
    let release!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const { client, server } = await setup({
      readLicenseStatus: async (licenseId) => ({
        licenseId, deviceId: "dev_ops_001", status: "active", revision: 1,
        notBefore: "2026-08-10T00:00:00.000Z", expiresAt: "2027-08-10T00:00:00.000Z",
        replacementLicenseId: null, updatedAt: "2026-08-11T00:00:00.000Z",
      }),
      execute: async () => { started(); await barrier; return { output: "answer", usage: { inputTokens: 1, outputTokens: 1 } }; },
    });
    const { issued } = await activateMapping(client);
    await enableBuiltin(client);
    const admitted = dataRequest(server, issued.secret);
    await began;
    const maintenance = await client.updateServiceStatus({
      idempotencyKey: "ops-data-race-maintenance",
      expectedRevision: 2,
      state: "maintenance",
      reasonCode: "SCHEDULED_MAINTENANCE",
    });
    expect(maintenance.revision).toBe(3);
    expect((await dataRequest(server, issued.secret)).status).toBe(503);
    release();
    expect((await admitted).status).toBe(200);
  });

  it("rechecks authority after a slow request body before reserving", async () => {
    let executions = 0;
    const { client, server } = await setup({
      readLicenseStatus: async (licenseId) => ({
        licenseId, deviceId: "dev_ops_001", status: "active", revision: 1,
        notBefore: "2026-08-10T00:00:00.000Z", expiresAt: "2027-08-10T00:00:00.000Z",
        replacementLicenseId: null, updatedAt: "2026-08-11T00:00:00.000Z",
      }),
      execute: async () => { executions += 1; return { output: "answer", usage: { inputTokens: 1, outputTokens: 1 } }; },
    });
    const { issued } = await activateMapping(client);
    await enableBuiltin(client);
    const response = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const request = httpRequest(new URL("models/respond", server.dataUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${issued.secret}`, "content-type": "application/json" },
      }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }));
      });
      request.once("error", reject);
      request.write('{"schemaVersion":1,"requestId":"req_slow_body_001",');
      setTimeout(() => request.end('"model":"model-a","prompt":"hello","maxOutputTokens":1}'), 30);
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await client.updateServiceStatus({
      idempotencyKey: "ops-slow-body-maintenance",
      expectedRevision: 2,
      state: "maintenance",
      reasonCode: "SCHEDULED_MAINTENANCE",
    });
    await expect(response).resolves.toMatchObject({ status: 503, body: { error: { code: "SERVICE_MAINTENANCE" } } });
    expect(executions).toBe(0);
  });

  it("uses request units independently from upstream token usage", async () => {
    const { client, server } = await setup({
      readLicenseStatus: async (licenseId) => ({
        licenseId, deviceId: "dev_ops_001", status: "active", revision: 1,
        notBefore: "2026-08-10T00:00:00.000Z", expiresAt: "2027-08-10T00:00:00.000Z",
        replacementLicenseId: null, updatedAt: "2026-08-11T00:00:00.000Z",
      }),
      execute: async () => ({ output: "answer", usage: { inputTokens: 8, outputTokens: 4 } }),
    });
    const { issued, mapping, user } = await activateMapping(client);
    const controls = await client.getDeviceControls({ deviceId: mapping.deviceId });
    await client.updateDeviceControls({ deviceId: mapping.deviceId }, {
      idempotencyKey: "ops-request-unit-policy",
      expectedRevision: controls.revision,
      expectedGeneration: controls.generation,
      expectedLicenseId: controls.licenseId,
      expectedTokenId: controls.tokenId,
      policy: { ...controls.policy, quota: { unit: "requests", limit: 2, period: "daily" } },
    });
    await enableBuiltin(client);
    expect((await dataRequest(server, issued.secret)).status).toBe(200);
    await expect(client.getUsage(user.id)).resolves.toMatchObject({ consumed: 1, remaining: 1 });
  });

  it("releases reservations when caller aborts even if executor ignores the signal", async () => {
    let started!: () => void;
    let release!: () => void;
    let ignoreAbort = true;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const stuck = new Promise<void>((resolve) => { release = resolve; });
    const { client, server } = await setup({
      readLicenseStatus: async (licenseId) => ({
        licenseId, deviceId: "dev_ops_001", status: "active", revision: 1,
        notBefore: "2026-08-10T00:00:00.000Z", expiresAt: "2027-08-10T00:00:00.000Z",
        replacementLicenseId: null, updatedAt: "2026-08-11T00:00:00.000Z",
      }),
      execute: async () => {
        if (ignoreAbort) { started(); await stuck; }
        return { output: "answer", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    });
    const { issued } = await activateMapping(client);
    await enableBuiltin(client);
    await client.updateServiceStatus({
      idempotencyKey: "ops-abort-degraded",
      expectedRevision: 2,
      state: "degraded",
      reasonCode: "DEGRADED_HEALTH",
    });
    const controller = new AbortController();
    const cancelled = fetch(new URL("models/respond", server.dataUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${issued.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, requestId: "req_abort_001", model: "model-a", prompt: "hello", maxOutputTokens: 1 }),
      signal: controller.signal,
    });
    await began;
    controller.abort();
    await expect(cancelled).rejects.toBeTruthy();
    ignoreAbort = false;
    const next = await dataRequest(server, issued.secret);
    release();
    expect(next.status).toBe(200);
  });
});
