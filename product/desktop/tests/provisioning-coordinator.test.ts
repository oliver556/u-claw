import { createHash } from "node:crypto";

import type {
  IssuedLicense,
  LicenseLifecycleClient,
  NewApiDeviceMapping,
  NewApiIssuedToken,
  NewApiManagementClient,
  NewApiPolicy,
  NewApiToken,
  NewApiUser,
  ProvisioningIdentityInput,
  ProvisioningJournal,
} from "@uclaw/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProvisioningArtifactWriter } from "../src/provisioning/artifact-writer.js";
import {
  ProvisioningCoordinatorError,
  createProvisioningCoordinator,
  deriveProvisioningStepKey,
} from "../src/provisioning/coordinator.js";

const now = "2026-08-10T00:00:00.000Z";
const input: ProvisioningIdentityInput = {
  idempotencyKey: "provision-device-001",
  deviceId: "dev_fixture_001",
  usbFingerprint: "a".repeat(64),
  username: "uclaw_fixture",
  channelId: "channel_builtin_001",
  endpoint: "https://models.example.test/v1/",
  model: "built-in-model",
  notBefore: now,
  expiresAt: "2027-08-10T00:00:00.000Z",
};

function license(licenseId = "lic_fixture_001", fingerprint = input.usbFingerprint): IssuedLicense {
  const startupSecret = "fixture-startup-secret-material-001";
  const startupSecretSalt = "b".repeat(32);
  const startupSecretHash = createHash("sha256")
    .update(Buffer.from("uclaw-startup-secret-v1\0", "utf8"))
    .update(Buffer.from(startupSecretSalt, "hex"))
    .update(Buffer.from([0]))
    .update(Buffer.from(startupSecret, "utf8"))
    .digest("hex");
  return {
    status: {
      licenseId, deviceId: input.deviceId, status: "active", revision: 1,
      notBefore: input.notBefore, expiresAt: input.expiresAt, replacementLicenseId: null, updatedAt: now,
    },
    startupCredential: {
      schemaVersion: 1, deviceId: input.deviceId, licenseId,
      startupSecret,
    },
    license: {
      schemaVersion: 1, deviceId: input.deviceId, licenseId,
      usbFingerprint: { scheme: "uclaw-usb-v1", sha256: fingerprint },
      startupSecretProof: {
        algorithm: "sha256-salt-v1", startupSecretSalt, startupSecretHash,
      },
      notBefore: input.notBefore, expiresAt: input.expiresAt,
      signature: { algorithm: "ed25519", keyId: "fixture-key-001", value: "s".repeat(88) },
    },
  };
}

function setup() {
  const events: string[] = [];
  let journal: ProvisioningJournal | null = null;
  let mapping: NewApiDeviceMapping | undefined;
  let policy: NewApiPolicy = {
    quota: { unit: "tokens", limit: 100_000, period: "monthly" },
    rateLimit: { requestsPerMinute: 60, concurrentRequests: 2 },
    allowedModels: [], disabled: false,
  };
  const user: NewApiUser = {
    id: "usr_fixture_001", deviceId: input.deviceId, username: input.username, status: "active",
    policy, createdAt: now, updatedAt: now,
  };
  let token: NewApiIssuedToken | undefined;
  const issuedLicenses = new Map<string, IssuedLicense>();

  const licenseClient: LicenseLifecycleClient = {
    issueLicense: vi.fn(async () => {
      events.push("license.issue");
      const value = license();
      issuedLicenses.set(value.status.licenseId, value);
      return value;
    }),
    getLicenseStatus: vi.fn(async (licenseId) => {
      events.push("license.status");
      return { status: (issuedLicenses.get(licenseId) ?? license(licenseId)).status, receipt: { value: "r".repeat(40) } };
    }),
    revokeLicense: vi.fn(async (licenseId) => {
      events.push("license.revoke");
      return { status: { ...license().status, licenseId, status: "revoked" as const, revision: 2 }, receipt: { value: "r".repeat(40) } };
    }),
    reissueLicense: vi.fn(async (_licenseId, value) => {
      events.push("license.reissue");
      const replacement = license("lic_fixture_002", value.usbFingerprint);
      replacement.status = { ...replacement.status, notBefore: value.notBefore, expiresAt: value.expiresAt };
      replacement.license = { ...replacement.license, notBefore: value.notBefore, expiresAt: value.expiresAt };
      issuedLicenses.set(replacement.status.licenseId, replacement);
      return replacement;
    }),
  };
  const newApiClient: NewApiManagementClient = {
    getServiceStatus: vi.fn(async () => { throw new Error("operations unavailable"); }),
    updateServiceStatus: vi.fn(async () => { throw new Error("operations unavailable"); }),
    getDeviceControls: vi.fn(async () => { throw new Error("operations unavailable"); }),
    updateDeviceControls: vi.fn(async () => { throw new Error("operations unavailable"); }),
    createUser: vi.fn(async () => { events.push("user.create"); return { ...user, policy }; }),
    getUser: vi.fn(async () => ({ ...user, policy })),
    updatePolicy: vi.fn(async (_userId, value) => { events.push(value.disabled ? "policy.disable" : "policy.bind"); policy = value; return value; }),
    getPolicy: vi.fn(async () => policy),
    createToken: vi.fn(async (value) => {
      events.push("token.create");
      token = {
        token: {
          id: `tok_fixture_00${value.generation}`, userId: value.userId, name: value.name,
          channelId: value.channelId, policyDigest: value.policyDigest, generation: value.generation,
          status: "provisioning", createdAt: now, updatedAt: now,
        },
        secret: `fixture-device-token-secret-material-${value.generation}`,
      };
      return token;
    }),
    activateToken: vi.fn(async (tokenId) => {
      events.push("token.activate");
      if (!token) throw new Error("token missing");
      token = { ...token, token: { ...token.token, id: tokenId, status: "active", updatedAt: now } };
      return token.token;
    }),
    createDeviceMapping: vi.fn(async (value) => {
      events.push("mapping.create");
      const { idempotencyKey: _key, ...fields } = value;
      mapping = { ...fields, failure: null, createdAt: now, updatedAt: now };
      return mapping!;
    }),
    getDeviceMapping: vi.fn(async () => {
      events.push("mapping.get");
      if (!mapping) throw new Error("mapping missing");
      return mapping;
    }),
    updateDeviceStatus: vi.fn(async (_deviceId, value) => {
      events.push(`mapping.${value.status}`);
      if (!mapping) throw new Error("mapping missing");
      mapping = { ...mapping, status: value.status, failure: value.status === "failed" ? value.failure : null, updatedAt: now };
      return mapping;
    }),
    revokeToken: vi.fn(async (tokenId) => {
      events.push("token.revoke");
      if (!token) throw new Error("token missing");
      return { ...token.token, id: tokenId, status: "revoked" } satisfies NewApiToken;
    }),
    getUsage: vi.fn(),
    listAuditEvents: vi.fn(),
  };
  const artifactWriter: ProvisioningArtifactWriter = {
    acquireLock: vi.fn(async () => async () => undefined),
    recoverPendingArtifacts: vi.fn(async () => undefined),
    commitArtifacts: vi.fn(async () => undefined),
    writeJournal: vi.fn(async (value) => { journal = structuredClone(value); events.push(`journal.${value.stage}`); }),
    readJournal: vi.fn(async () => journal === null ? null : structuredClone(journal)),
    writeArtifacts: vi.fn(async () => { events.push("artifacts.write"); }),
    finalizeCredential: vi.fn(async () => { events.push("credential.finalize"); }),
    verifyArtifacts: vi.fn(async (_binding, active) => { events.push(active ? "artifacts.verify-active" : "artifacts.verify"); }),
    cleanupArtifacts: vi.fn(async () => { events.push("artifacts.cleanup"); }),
  };
  const coordinator = createProvisioningCoordinator({ licenseClient, newApiClient, artifactWriter, now: () => new Date(now) });
  return { coordinator, licenseClient, newApiClient, artifactWriter, events, getJournal: () => journal };
}

describe("provisioning coordinator", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("derives bounded domain-separated SHA-256 step keys", () => {
    const one = deriveProvisioningStepKey("x".repeat(128), "license", 1);
    const two = deriveProvisioningStepKey("x".repeat(128), "token", 1);
    const next = deriveProvisioningStepKey("x".repeat(128), "token", 2);
    expect(one).toMatch(/^p_[a-f0-9]{64}$/u);
    expect(new Set([one, two, next]).size).toBe(3);
    expect(one.length).toBeLessThanOrEqual(128);
  });

  it("strictly binds all resources and finalizes active credential only after verification", async () => {
    const context = setup();
    const result = await context.coordinator.provision(input);
    expect(result).toMatchObject({
      deviceId: input.deviceId, usbFingerprint: input.usbFingerprint, licenseId: "lic_fixture_001",
      newApiUserId: "usr_fixture_001", newApiTokenId: "tok_fixture_001", channelId: input.channelId, status: "active",
    });
    expect(context.events).toEqual(expect.arrayContaining([
      "license.issue", "user.create", "policy.bind", "token.create", "mapping.create",
      "artifacts.write", "artifacts.verify", "mapping.active", "token.activate", "credential.finalize",
      "artifacts.verify-active", "license.status", "mapping.get",
    ]));
    expect(context.events.indexOf("artifacts.verify")).toBeLessThan(context.events.indexOf("mapping.active"));
    expect(context.events.indexOf("mapping.active")).toBeLessThan(context.events.indexOf("credential.finalize"));
    expect(context.events.indexOf("mapping.active")).toBeLessThan(context.events.indexOf("token.activate"));
  });

  it("rejects a mismatched remote binding before the next side effect", async () => {
    const context = setup();
    vi.mocked(context.licenseClient.issueLicense).mockResolvedValueOnce(license("lic_fixture_001", "f".repeat(64)));
    await expect(context.coordinator.provision(input)).rejects.toMatchObject({ code: "BINDING_MISMATCH", retryable: false });
    expect(context.newApiClient.createUser).not.toHaveBeenCalled();
    expect(context.licenseClient.revokeLicense).toHaveBeenCalledOnce();
  });

  it("rejects a schema-valid startup secret proof before any New API side effect", async () => {
    const context = setup();
    const mismatched = license();
    mismatched.license = {
      ...mismatched.license,
      startupSecretProof: { ...mismatched.license.startupSecretProof, startupSecretHash: "f".repeat(64) },
    };
    vi.mocked(context.licenseClient.issueLicense).mockResolvedValueOnce(mismatched);
    await expect(context.coordinator.provision(input)).rejects.toMatchObject({ code: "BINDING_MISMATCH" });
    expect(context.newApiClient.createUser).not.toHaveBeenCalled();
  });

  it("rejects a schema-valid policy mutation response before creating a token", async () => {
    const context = setup();
    vi.mocked(context.newApiClient.updatePolicy).mockResolvedValueOnce({
      quota: { unit: "tokens", limit: 100_000, period: "monthly" },
      rateLimit: { requestsPerMinute: 60, concurrentRequests: 2 },
      allowedModels: ["other-model"], disabled: false,
    });
    await expect(context.coordinator.provision(input)).rejects.toMatchObject({ code: "BINDING_MISMATCH" });
    expect(context.newApiClient.createToken).not.toHaveBeenCalled();
  });

  it("replays initial license issue when failure happened before a license id was known", async () => {
    const context = setup();
    vi.mocked(context.licenseClient.issueLicense).mockRejectedValueOnce(new Error("network unavailable"));
    await expect(context.coordinator.provision(input)).rejects.toMatchObject({ code: "LICENSE_FAILED" });
    expect(context.getJournal()).toMatchObject({ generation: 1, stage: "failed" });
    await expect(context.coordinator.provision(input)).resolves.toMatchObject({ status: "active" });
    expect(context.licenseClient.issueLicense).toHaveBeenCalledTimes(2);
    expect(context.licenseClient.reissueLicense).not.toHaveBeenCalled();
  });

  it.each(["license-issued", "token-created", "mapping-created", "artifacts-written"] as const)(
    "replays issue rather than reissuing when a normal provision restarts after %s",
    async (stage) => {
    const context = setup();
    const requestHash = createHash("sha256")
      .update("uclaw-provisioning-request-v1").update("\0").update(JSON.stringify(input)).digest("hex");
    await context.artifactWriter.writeJournal({
      schemaVersion: 1, generation: 1, licenseOperation: "issue", licenseSourceId: null,
      transactionId: `txn_${requestHash.slice(0, 24)}`, requestHash,
      mappedTokenId: stage === "mapping-created" || stage === "artifacts-written" ? "tok_fixture_001" : null,
      previousTokenId: null,
      binding: {
        deviceId: input.deviceId, usbFingerprint: input.usbFingerprint, channelId: input.channelId,
        licenseId: "lic_fixture_001", newApiUserId: "usr_fixture_001", newApiUsername: input.username,
        newApiTokenId: "tok_fixture_001",
      },
      endpoint: input.endpoint, model: input.model, stage, failureCode: null,
      compensation: {
        mapping: stage === "mapping-created" || stage === "artifacts-written" ? "pending" : "not-needed",
        token: "pending", license: "pending", artifacts: stage === "artifacts-written" ? "pending" : "not-needed",
      },
      lifecycle: null, createdAt: now, updatedAt: now,
    });
    vi.clearAllMocks();
    const restarted = createProvisioningCoordinator({
      licenseClient: context.licenseClient,
      newApiClient: context.newApiClient,
      artifactWriter: context.artifactWriter,
      now: () => new Date(now),
    });
    await expect(restarted.provision(input)).resolves.toMatchObject({ status: "active" });
    expect(context.licenseClient.issueLicense).toHaveBeenCalledOnce();
    expect(context.licenseClient.reissueLicense).not.toHaveBeenCalled();
    },
  );

  it.each(["token-created", "mapping-created"] as const)(
    "restarts generation-two %s from the immutable source license",
    async (stage) => {
      const context = setup();
      const requestHash = createHash("sha256")
        .update("uclaw-provisioning-request-v1").update("\0").update(JSON.stringify(input)).digest("hex");
      await context.artifactWriter.writeJournal({
        schemaVersion: 1, generation: 2, licenseOperation: "reissue", licenseSourceId: "lic_fixture_001",
        transactionId: `txn_${requestHash.slice(0, 24)}`, requestHash,
        mappedTokenId: stage === "mapping-created" ? "tok_fixture_002" : "tok_fixture_001",
        previousTokenId: "tok_fixture_001",
        binding: {
          deviceId: input.deviceId, usbFingerprint: input.usbFingerprint, channelId: input.channelId,
          licenseId: "lic_fixture_002", newApiUserId: "usr_fixture_001", newApiUsername: input.username,
          newApiTokenId: "tok_fixture_002",
        },
        endpoint: input.endpoint, model: input.model, stage, failureCode: null,
        compensation: { mapping: "pending", token: "pending", license: "pending", artifacts: "not-needed" },
        lifecycle: null, createdAt: now, updatedAt: now,
      });
      vi.clearAllMocks();
      const restarted = createProvisioningCoordinator({
        licenseClient: context.licenseClient, newApiClient: context.newApiClient,
        artifactWriter: context.artifactWriter, now: () => new Date(now),
      });
      await expect(restarted.provision(input)).resolves.toMatchObject({ status: "active", licenseId: "lic_fixture_002" });
      expect(context.licenseClient.reissueLicense).toHaveBeenCalledWith("lic_fixture_001", expect.anything());
      expect(context.licenseClient.reissueLicense).not.toHaveBeenCalledWith("lic_fixture_002", expect.anything());
    },
  );

  it("serializes same-device requests and replays identical active result", async () => {
    const context = setup();
    let running = 0;
    let maximum = 0;
    vi.mocked(context.licenseClient.issueLicense).mockImplementation(async () => {
      running += 1;
      maximum = Math.max(maximum, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return license();
    });
    const [first, second] = await Promise.all([context.coordinator.provision(input), context.coordinator.provision(input)]);
    expect(second).toEqual(first);
    expect(maximum).toBe(1);
    expect(context.licenseClient.issueLicense).toHaveBeenCalledOnce();
    await expect(context.coordinator.provision({ ...input, username: "uclaw_other" }))
      .rejects.toBeInstanceOf(ProvisioningCoordinatorError);
  });

  it("marks mapping failed and revokes token/license when active credential finalization fails", async () => {
    const context = setup();
    vi.mocked(context.artifactWriter.finalizeCredential).mockRejectedValueOnce(new Error("secret must not leak"));
    const error = await context.coordinator.provision(input).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "ARTIFACT_WRITE_FAILED", retryable: false });
    expect(JSON.stringify(error)).not.toMatch(/secret must not leak|fixture-device-token/iu);
    expect(context.events).toEqual(expect.arrayContaining([
      "mapping.failed", "token.revoke", "license.revoke", "artifacts.cleanup",
    ]));
    const failedUpdates = vi.mocked(context.newApiClient.updateDeviceStatus).mock.calls
      .map((call) => call[1])
      .filter((value) => value.status === "failed");
    expect(failedUpdates.at(-1)).toMatchObject({
      failure: { compensation: { status: "succeeded", attemptedAt: now } },
    });
    expect(context.getJournal()).toMatchObject({ stage: "failed", compensation: { token: "succeeded", license: "succeeded" } });
  });

  it("does not let delayed old-generation compensation mutate a replacement mapping", async () => {
    const context = setup();
    const getMapping = vi.mocked(context.newApiClient.getDeviceMapping).getMockImplementation()!;
    let reads = 0;
    vi.mocked(context.newApiClient.getDeviceMapping).mockImplementation(async (deviceId) => {
      const current = await getMapping(deviceId);
      reads += 1;
      return reads === 1 ? current : {
        ...current, generation: 2, licenseId: "lic_fixture_002", newApiTokenId: "tok_fixture_002",
      };
    });
    vi.mocked(context.artifactWriter.finalizeCredential).mockRejectedValueOnce(new Error("write failed"));
    await expect(context.coordinator.provision(input)).rejects.toMatchObject({ code: "ARTIFACT_WRITE_FAILED" });
    const delayedUpdates = vi.mocked(context.newApiClient.updateDeviceStatus).mock.calls
      .map((call) => call[1])
      .filter((value) => value.status === "failed");
    expect(delayedUpdates).toHaveLength(0);
    expect(context.newApiClient.revokeToken).toHaveBeenCalledWith("tok_fixture_001", expect.anything());
  });

  it("keeps compensation pending when artifact cleanup fails", async () => {
    const context = setup();
    vi.mocked(context.artifactWriter.finalizeCredential).mockRejectedValueOnce(new Error("write failure"));
    vi.mocked(context.artifactWriter.cleanupArtifacts).mockRejectedValueOnce(new Error("cleanup failure"));
    await expect(context.coordinator.provision(input)).rejects.toMatchObject({ code: "COMPENSATION_PENDING", retryable: true });
    expect(context.getJournal()).toMatchObject({ stage: "compensation-pending", compensation: { artifacts: "pending" } });
  });

  it("does not mark nonexistent mapping pending when mapping creation fails", async () => {
    const context = setup();
    vi.mocked(context.newApiClient.createDeviceMapping).mockRejectedValueOnce(new Error("mapping unavailable"));
    await expect(context.coordinator.provision(input)).rejects.toMatchObject({ code: "NEW_API_FAILED", retryable: false });
    expect(context.newApiClient.updateDeviceStatus).not.toHaveBeenCalled();
    expect(context.newApiClient.revokeToken).toHaveBeenCalledOnce();
    expect(context.licenseClient.revokeLicense).toHaveBeenCalledOnce();
    expect(context.getJournal()).toMatchObject({
      stage: "failed", compensation: { mapping: "not-needed", token: "succeeded", license: "succeeded" },
    });
  });

  it("recovers an ambiguous mapping commit from the authoritative mapping", async () => {
    const context = setup();
    const createMapping = vi.mocked(context.newApiClient.createDeviceMapping).getMockImplementation()!;
    vi.mocked(context.newApiClient.createDeviceMapping).mockImplementationOnce(async (value) => {
      await createMapping(value);
      throw Object.assign(new Error("response lost"), { category: "transport" });
    });
    await expect(context.coordinator.provision(input)).resolves.toMatchObject({ status: "active" });
    expect(context.newApiClient.getDeviceMapping).toHaveBeenCalledWith(input.deviceId);
  });

  it("treats an ambiguous mapping POST followed by not-found as not created", async () => {
    const context = setup();
    vi.mocked(context.newApiClient.createDeviceMapping).mockRejectedValueOnce(
      Object.assign(new Error("request lost"), { category: "transport" }),
    );
    vi.mocked(context.newApiClient.getDeviceMapping).mockRejectedValueOnce(
      Object.assign(new Error("missing"), { category: "not-found" }),
    );
    await expect(context.coordinator.provision(input)).rejects.toMatchObject({ code: "NEW_API_FAILED" });
    expect(context.getJournal()).toMatchObject({ compensation: { mapping: "not-needed" } });
    expect(context.newApiClient.updateDeviceStatus).not.toHaveBeenCalled();
  });

  it("does not mutate a non-owned authoritative mapping when a response mismatches", async () => {
    const context = setup();
    const existing = {
      deviceId: input.deviceId, licenseId: "lic_existing_001",
      startupSecretHash: "1".repeat(64), startupSecretSalt: "2".repeat(32), usbFingerprint: input.usbFingerprint,
      newApiUserId: "usr_existing_001", newApiUsername: input.username, newApiTokenId: "tok_existing_001",
      channelId: input.channelId, policyDigest: "3".repeat(64), generation: 1, previousTokenId: null,
      status: "failed" as const,
      failure: { code: "OLD_FAILED", compensation: { tokenId: "tok_existing_001", status: "succeeded" as const, attemptedAt: now } },
      createdAt: now, updatedAt: now,
    };
    vi.mocked(context.newApiClient.createDeviceMapping).mockResolvedValueOnce(existing);
    vi.mocked(context.newApiClient.getDeviceMapping).mockResolvedValue(existing);
    await expect(context.coordinator.provision(input)).rejects.toMatchObject({ code: "BINDING_MISMATCH" });
    expect(context.getJournal()).toMatchObject({ mappedTokenId: null });
    expect(context.newApiClient.updateDeviceStatus).not.toHaveBeenCalled();
  });

  it("marks an owned provisioning mapping failed when its authoritative binding mismatches", async () => {
    const context = setup();
    const createMapping = vi.mocked(context.newApiClient.createDeviceMapping).getMockImplementation()!;
    vi.mocked(context.newApiClient.createDeviceMapping).mockImplementationOnce(async (value) => createMapping({
      ...value, startupSecretHash: "f".repeat(64),
    }));
    await expect(context.coordinator.provision(input)).rejects.toMatchObject({ code: "BINDING_MISMATCH" });
    expect(context.getJournal()).toMatchObject({
      mappedTokenId: "tok_fixture_001", stage: "failed", compensation: { mapping: "succeeded" },
    });
    expect(vi.mocked(context.newApiClient.updateDeviceStatus).mock.calls.map((call) => call[1]))
      .toContainEqual(expect.objectContaining({
        status: "failed", expectedGeneration: 1,
        expectedLicenseId: "lic_fixture_001", expectedTokenId: "tok_fixture_001",
      }));
    await expect(context.coordinator.provision(input)).resolves.toMatchObject({
      status: "active", licenseId: "lic_fixture_002", newApiTokenId: "tok_fixture_002",
    });
  });

  it("journals a created token id before rejecting a mismatched token response", async () => {
    const context = setup();
    vi.mocked(context.newApiClient.createToken).mockResolvedValueOnce({
      token: {
        id: "tok_mismatch_001", userId: "usr_other_001", name: "wrong", channelId: input.channelId,
        policyDigest: "d".repeat(64), generation: 1, status: "provisioning", createdAt: now, updatedAt: now,
      },
      secret: "fixture-device-token-secret-material-mismatch",
    });
    vi.mocked(context.newApiClient.revokeToken).mockResolvedValueOnce({
      id: "tok_mismatch_001", userId: "usr_other_001", name: "wrong", channelId: input.channelId,
      policyDigest: "d".repeat(64), generation: 1, status: "revoked", createdAt: now, updatedAt: now,
    });
    await expect(context.coordinator.provision(input)).rejects.toMatchObject({ code: "BINDING_MISMATCH" });
    expect(context.getJournal()).toMatchObject({ binding: { newApiTokenId: "tok_mismatch_001" } });
    expect(context.newApiClient.revokeToken).toHaveBeenCalledWith("tok_mismatch_001", expect.anything());
  });

  it("fails closed when final authoritative license state does not match", async () => {
    const context = setup();
    vi.mocked(context.licenseClient.getLicenseStatus).mockResolvedValueOnce({
      status: { ...license().status, expiresAt: "2028-08-10T00:00:00.000Z" },
      receipt: { value: "r".repeat(40) },
    });
    await expect(context.coordinator.provision(input)).rejects.toMatchObject({ code: "BINDING_MISMATCH" });
    expect(context.getJournal()).not.toMatchObject({ stage: "active" });
  });

  it("fails closed when the authoritative user is disabled before final commit", async () => {
    const context = setup();
    vi.mocked(context.newApiClient.getUser).mockResolvedValueOnce({
      id: "usr_fixture_001", deviceId: input.deviceId, username: input.username, status: "disabled",
      policy: {
        quota: { unit: "tokens", limit: 100_000, period: "monthly" },
        rateLimit: { requestsPerMinute: 60, concurrentRequests: 2 },
        allowedModels: [input.model], disabled: true,
      },
      createdAt: now, updatedAt: now,
    });
    await expect(context.coordinator.provision(input)).rejects.toMatchObject({ code: "BINDING_MISMATCH" });
    expect(context.getJournal()).not.toMatchObject({ stage: "active" });
  });

  it("keeps compensation pending and retries it from journal", async () => {
    const context = setup();
    vi.mocked(context.artifactWriter.writeArtifacts).mockRejectedValueOnce(new Error("disk failure"));
    vi.mocked(context.newApiClient.revokeToken).mockRejectedValueOnce(new Error("network failure"));
    await expect(context.coordinator.provision(input)).rejects.toMatchObject({ code: "COMPENSATION_PENDING", retryable: true });
    expect(context.getJournal()).toMatchObject({ stage: "compensation-pending", compensation: { token: "pending" } });
    await expect(context.coordinator.provision(input)).resolves.toMatchObject({ status: "active" });
    expect(context.newApiClient.revokeToken).toHaveBeenCalledTimes(2);
  });

  it("journals disable before removing local credential and journals idempotent revoke", async () => {
    const context = setup();
    const active = await context.coordinator.provision(input);
    const binding = {
      deviceId: active.deviceId,
      usbFingerprint: active.usbFingerprint,
      licenseId: active.licenseId,
      newApiUserId: active.newApiUserId,
      newApiUsername: active.newApiUsername,
      newApiTokenId: active.newApiTokenId,
      channelId: active.channelId,
    };
    context.events.length = 0;
    await context.coordinator.applyLifecycle({ action: "disable", idempotencyKey: "lifecycle-disable-001", binding });
    expect(context.events.indexOf("policy.disable")).toBeLessThan(context.events.indexOf("artifacts.cleanup"));
    expect(context.getJournal()).toMatchObject({ stage: "disabled" });
    await context.coordinator.applyLifecycle({ action: "revoke", idempotencyKey: "lifecycle-revoke-001", binding });
    expect(context.getJournal()).toMatchObject({ stage: "revoked" });
  });

  it("resumes the same reissue action after the new binding partially fails", async () => {
    const context = setup();
    const active = await context.coordinator.provision(input);
    const binding = {
      deviceId: active.deviceId, usbFingerprint: active.usbFingerprint, licenseId: active.licenseId,
      newApiUserId: active.newApiUserId, newApiUsername: active.newApiUsername,
      newApiTokenId: active.newApiTokenId, channelId: active.channelId,
    };
    const action = {
      action: "reissue" as const, idempotencyKey: "lifecycle-reissue-recover",
      binding, usbFingerprint: "e".repeat(64), notBefore: input.notBefore,
      expiresAt: "2028-08-10T00:00:00.000Z",
    };
    vi.mocked(context.artifactWriter.writeArtifacts).mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(context.coordinator.applyLifecycle(action)).rejects.toMatchObject({ retryable: true });
    expect(context.getJournal()).toMatchObject({
      stage: "reissuing",
      lifecycle: { requestHash: expect.any(String), sourceBinding: binding, targetGeneration: 2 },
    });
    await expect(context.coordinator.applyLifecycle(action)).resolves.toMatchObject({
      status: "active", usbFingerprint: action.usbFingerprint,
    });
  });

  it("wraps lifecycle failures in fixed public errors", async () => {
    const context = setup();
    const active = await context.coordinator.provision(input);
    const binding = {
      deviceId: active.deviceId, usbFingerprint: active.usbFingerprint, licenseId: active.licenseId,
      newApiUserId: active.newApiUserId, newApiUsername: active.newApiUsername,
      newApiTokenId: active.newApiTokenId, channelId: active.channelId,
    };
    vi.mocked(context.newApiClient.updatePolicy).mockRejectedValueOnce(new Error("fixture lifecycle secret"));
    const error = await context.coordinator.applyLifecycle({
      action: "disable", idempotencyKey: "lifecycle-disable-fail", binding,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "LIFECYCLE_FAILED", retryable: true });
    expect(JSON.stringify(error)).not.toContain("fixture lifecycle secret");
  });
});
