import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  createNewApiManagementClient,
  createUnavailableNewApiManagementClient,
  type LocalNewApiManagementServer,
  startLocalNewApiManagementServer,
} from "../../desktop/src/new-api-management/index.js";

const servers: LocalNewApiManagementServer[] = [];
const channelId = "channel_builtin_001";
const policy = {
  quota: { unit: "tokens" as const, limit: 10_000, period: "monthly" as const },
  rateLimit: { requestsPerMinute: 30, concurrentRequests: 2 },
  allowedModels: ["model-a", "model-b"],
  disabled: false,
};
const digestPolicy = (value: unknown) => createHash("sha256")
  .update("uclaw-new-api-policy-v1\0").update(JSON.stringify(value)).digest("hex");
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

async function setup() {
  const server = await startLocalNewApiManagementServer({
    hostname: "127.0.0.1",
    managementCredential: "fixture-management-credential",
    now: () => new Date("2026-08-10T00:00:00.000Z"),
  });
  servers.push(server);
  return {
    server,
    client: createNewApiManagementClient({
      endpoint: server.url,
      managementCredential: "fixture-management-credential",
      allowLoopbackHttp: true,
    }),
  };
}

describe("localhost New API management backend", () => {
  it("uses real HTTP for user, token, mapping, policy, usage, disable, and revoke lifecycle", async () => {
    const { client, server } = await setup();
    const user = await client.createUser({ idempotencyKey: "idem-user-001", deviceId: "dev_001", username: "uclaw_001" });
    await client.updatePolicy(user.id, policy);
    const policyDigest = digestPolicy(policy);
    const issued = await client.createToken({
      idempotencyKey: "idem-token-001", userId: user.id, name: "device", channelId, policyDigest, generation: 1,
    });
    expect(issued.token.status).toBe("provisioning");
    await expect(client.activateToken(issued.token.id, {
      idempotencyKey: "idem-activate-too-early", deviceId: "dev_001",
    })).rejects.toMatchObject({ category: "conflict", code: "TOKEN_MAPPING_INACTIVE" });
    const mapping = await client.createDeviceMapping({
      idempotencyKey: "idem-device-001",
      deviceId: "dev_001",
      licenseId: "lic_001",
      startupSecretHash: "a".repeat(64),
      startupSecretSalt: "b".repeat(32),
      usbFingerprint: "c".repeat(64),
      newApiUserId: user.id,
      newApiUsername: user.username,
      newApiTokenId: issued.token.id,
      channelId, policyDigest, generation: 1, previousTokenId: null,
      status: "provisioning",
    });
    await client.updateDeviceStatus(mapping.deviceId, {
      idempotencyKey: "idem-device-active", status: "active", expectedStatus: "provisioning",
      expectedGeneration: 1, expectedLicenseId: mapping.licenseId, expectedTokenId: issued.token.id,
    });
    await expect(client.updateDeviceStatus(mapping.deviceId, {
      idempotencyKey: "idem-device-stale", status: "failed", expectedStatus: "provisioning",
      expectedGeneration: 1, expectedLicenseId: mapping.licenseId, expectedTokenId: issued.token.id,
      failure: { code: "STALE", compensation: { tokenId: issued.token.id, status: "pending", attemptedAt: null } },
    })).rejects.toMatchObject({ category: "conflict", code: "DEVICE_CAS_CONFLICT" });
    const activated = await client.activateToken(issued.token.id, {
      idempotencyKey: "idem-token-activate", deviceId: mapping.deviceId,
    });
    expect(activated.status).toBe("active");
    await expect(client.getDeviceMapping(mapping.deviceId)).resolves.toMatchObject({
      status: "active", newApiTokenId: issued.token.id, channelId, policyDigest, generation: 1,
    });
    server.recordUsage(user.id, 750);

    expect(issued.secret).toMatch(/^uclaw_dev_/u);
    expect(mapping).toMatchObject({ status: "provisioning", newApiTokenId: issued.token.id });
    expect(policy).toMatchObject({ allowedModels: ["model-a", "model-b"], disabled: false });
    await expect(client.getUsage(user.id)).resolves.toMatchObject({ consumed: 750, remaining: 9_250 });
    await expect(client.updatePolicy(user.id, { ...policy, disabled: true })).resolves.toMatchObject({ disabled: true });
    await expect(client.revokeToken(issued.token.id, { idempotencyKey: "idem-revoke-001" })).resolves.toMatchObject({ status: "revoked" });

    const audit = await client.listAuditEvents({ deviceId: "dev_001", cursor: null, pageSize: 100 });
    expect(audit.items.length).toBeGreaterThan(0);
    expect(audit).toMatchObject({ nextCursor: null, hasMore: false });
    expect(JSON.stringify(audit)).not.toMatch(/fixture-management-credential|uclaw_dev_|authorization|headers|body|startupSecret/iu);
  });

  it("replays identical idempotent requests and conflicts on key reuse or unique values", async () => {
    const { client } = await setup();
    const input = { idempotencyKey: "idem-user-retry", deviceId: "dev_retry", username: "uclaw_retry" };
    const first = await client.createUser(input);
    await client.updatePolicy(first.id, policy);
    const policyDigest = digestPolicy(policy);
    await expect(client.createUser(input)).resolves.toEqual(first);
    await expect(client.createUser({ ...input, username: "uclaw_changed" })).rejects.toMatchObject({
      category: "conflict", code: "IDEMPOTENCY_CONFLICT", retryable: false,
    });
    await expect(client.createUser({ idempotencyKey: "idem-user-other", deviceId: "dev_other", username: input.username })).rejects.toMatchObject({
      category: "conflict", code: "USERNAME_CONFLICT", retryable: false,
    });

    const tokenInput = {
      idempotencyKey: "idem-token-retry", userId: first.id, name: "device", channelId, policyDigest, generation: 1,
    };
    const [issued, concurrentReplay] = await Promise.all([
      client.createToken(tokenInput),
      client.createToken(tokenInput),
    ]);
    expect(concurrentReplay).toEqual(issued);
    await expect(client.createToken(tokenInput)).resolves.toEqual(issued);
  });

  it("records failed provisioning and compensation without exposing credentials", async () => {
    const { client } = await setup();
    const user = await client.createUser({ idempotencyKey: "idem-fail-user", deviceId: "dev_fail", username: "uclaw_fail" });
    await client.updatePolicy(user.id, policy);
    const policyDigest = digestPolicy(policy);
    const issued = await client.createToken({
      idempotencyKey: "idem-fail-token", userId: user.id, name: "device", channelId, policyDigest, generation: 1,
    });
    await client.createDeviceMapping({
      idempotencyKey: "idem-fail-device", deviceId: "dev_fail", licenseId: "lic_fail",
      startupSecretHash: "d".repeat(64), startupSecretSalt: "e".repeat(32), usbFingerprint: "f".repeat(64),
      newApiUserId: user.id, newApiUsername: user.username, newApiTokenId: issued.token.id, status: "provisioning",
      channelId, policyDigest, generation: 1, previousTokenId: null,
    });
    const failed = await client.updateDeviceStatus("dev_fail", {
      idempotencyKey: "idem-fail-status",
      status: "failed",
      expectedStatus: "provisioning", expectedGeneration: 1,
      expectedLicenseId: "lic_fail", expectedTokenId: issued.token.id,
      failure: { code: "WRITE_FAILED", compensation: { tokenId: issued.token.id, status: "pending", attemptedAt: null } },
    });
    expect(failed).toMatchObject({ status: "failed", failure: { compensation: { status: "pending" } } });
    expect(JSON.stringify(failed)).not.toContain(issued.secret);
  });

  it("fails closed when unavailable and rejects non-loopback plain HTTP", async () => {
    const unavailable = createUnavailableNewApiManagementClient("New API management endpoint is not configured.");
    await expect(unavailable.getUsage("usr_001")).rejects.toMatchObject({ category: "unavailable", retryable: false });
    for (const endpoint of ["http://example.test/v1/", "http://192.168.1.10/v1/", "http://127.0.0.2/v1/"]) {
      expect(() => createNewApiManagementClient({ endpoint, managementCredential: "fixture-management-credential" })).toThrow(/HTTPS|loopback/iu);
    }
    expect(() => createNewApiManagementClient({
      endpoint: "http://127.0.0.1/v1/", managementCredential: "fixture-management-credential",
    })).toThrow(/HTTPS|loopback/iu);
  });

  it("refuses non-loopback binding and audits rejected authentication without request data", async () => {
    await expect(startLocalNewApiManagementServer({
      hostname: "0.0.0.0" as never,
      managementCredential: "fixture-management-credential",
    })).rejects.toThrow(/loopback/iu);

    const { client, server } = await setup();
    const unauthorized = createNewApiManagementClient({
      endpoint: server.url,
      managementCredential: "fixture-wrong-credential",
      allowLoopbackHttp: true,
    });
    await expect(unauthorized.getUsage("usr_missing")).rejects.toMatchObject({
      category: "authentication", code: "AUTHENTICATION_FAILED", retryable: false,
    });
    const audit = await client.listAuditEvents({ cursor: null, pageSize: 100 });
    expect(audit.items).toContainEqual(expect.objectContaining({
      action: "request.rejected", subjectType: "request", outcome: "failed", errorCategory: "authentication",
    }));
    expect(JSON.stringify(audit)).not.toMatch(/fixture-wrong-credential|authorization|headers|body/iu);
  });

  it("redacts remote error credentials including the configured management credential", async () => {
    const managementCredential = "fixture-management-credential";
    const githubCredential = `ghp_${"a".repeat(24)}`;
    const client = createNewApiManagementClient({
      endpoint: "https://management.example.test/uclaw-management/v1/",
      managementCredential,
      fetch: async () => new Response(JSON.stringify({
        error: {
          category: "upstream", code: "UPSTREAM_ERROR",
          message: `Remote leaked ${managementCredential} and ${githubCredential}`,
          retryable: false,
        },
      }), { status: 502, headers: { "content-type": "application/json" } }),
    });
    const error = await client.getUsage("usr_fixture_001").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ category: "upstream", code: "UPSTREAM_ERROR" });
    expect(String((error as Error).message)).not.toMatch(/fixture-management-credential|ghp_/u);
    expect((error as Error).cause).toBeUndefined();

    const unavailable = createUnavailableNewApiManagementClient(`Unavailable ${githubCredential}`);
    const unavailableError = await unavailable.getUsage("usr_fixture_001").catch((caught: unknown) => caught);
    expect(String((unavailableError as Error).message)).not.toContain(githubCredential);
  });

  it("does not retain raw transport errors as causes", async () => {
    const client = createNewApiManagementClient({
      endpoint: "https://management.example.test/uclaw-management/v1/",
      managementCredential: "fixture-management-credential",
      fetch: async () => { throw new Error("raw transport detail"); },
    });
    const error = await client.getUsage("usr_fixture_001").catch((caught: unknown) => caught) as Error;
    expect(error.name).toBe("NewApiManagementError");
    expect(error.cause).toBeUndefined();
  });
});
