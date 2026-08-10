import { createHash, randomBytes } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  createNewApiManagementClient,
  type LocalNewApiManagementServer,
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

async function setup(configured = true) {
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
      },
    } : {}),
  });
  servers.push(server);
  return {
    server,
    client: createNewApiManagementClient({
      endpoint: server.url,
      managementCredential,
      allowLoopbackHttp: true,
    }),
  };
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
