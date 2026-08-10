import { describe, expect, it } from "vitest";

import {
  ProvisioningIdentityInputSchema,
  ProvisioningIdentityResultSchema,
  ProvisioningJournalSchema,
  ProvisioningLifecycleActionSchema,
} from "../src/provisioning-identity.js";

const input = {
  idempotencyKey: "provision-device-001",
  deviceId: "dev_fixture_001",
  usbFingerprint: "a".repeat(64),
  username: "uclaw_fixture",
  channelId: "channel_builtin_001",
  endpoint: "https://models.example.test/v1/",
  model: "built-in-model",
  notBefore: "2026-08-10T00:00:00.000Z",
  expiresAt: "2027-08-10T00:00:00.000Z",
};

const binding = {
  deviceId: input.deviceId,
  usbFingerprint: input.usbFingerprint,
  licenseId: "lic_fixture_001",
  newApiUserId: "usr_fixture_001",
  newApiUsername: input.username,
  newApiTokenId: "tok_fixture_001",
  channelId: input.channelId,
};

describe("provisioning identity contract", () => {
  it("accepts exact manufacturing identity input and rejects unknown or insecure fields", () => {
    expect(ProvisioningIdentityInputSchema.parse(input)).toEqual(input);
    expect(() => ProvisioningIdentityInputSchema.parse({ ...input, managementCredential: "secret-value" })).toThrow();
    expect(() => ProvisioningIdentityInputSchema.parse({ ...input, providerKey: "secret-value" })).toThrow();
    expect(() => ProvisioningIdentityInputSchema.parse({ ...input, endpoint: "http://example.test/v1/" })).toThrow();
    expect(() => ProvisioningIdentityInputSchema.parse({ ...input, expiresAt: input.notBefore })).toThrow();
  });

  it("returns only public binding identifiers and rejects secret-bearing or mismatched results", () => {
    const result = {
      transactionId: "txn_fixture_001",
      ...binding,
      endpoint: input.endpoint,
      model: input.model,
      status: "active" as const,
    };
    expect(ProvisioningIdentityResultSchema.parse(result)).toEqual(result);
    for (const forbidden of ["startupSecret", "tokenSecret", "managementCredential", "providerKey", "authorization"]) {
      expect(() => ProvisioningIdentityResultSchema.parse({ ...result, [forbidden]: "secret-value" })).toThrow();
    }
    expect(() => ProvisioningIdentityResultSchema.parse({ ...result, newApiUserId: "usr_other_001", tokenUserId: binding.newApiUserId })).toThrow();
  });

  it("freezes journal stages and compensation without permitting secrets", () => {
    const journal = {
      schemaVersion: 1 as const,
      generation: 1,
      transactionId: "txn_fixture_001",
      requestHash: "b".repeat(64),
      mappedTokenId: binding.newApiTokenId,
      binding,
      endpoint: input.endpoint,
      model: input.model,
      stage: "compensation-pending" as const,
      failureCode: "ARTIFACT_WRITE_FAILED",
      compensation: {
        mapping: "succeeded" as const,
        token: "pending" as const,
        license: "pending" as const,
        artifacts: "pending" as const,
      },
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:01:00.000Z",
    };
    expect(ProvisioningJournalSchema.parse(journal)).toEqual(journal);
    const { generation: _generation, ...withoutGeneration } = journal;
    expect(() => ProvisioningJournalSchema.parse(withoutGeneration)).toThrow();
    expect(() => ProvisioningJournalSchema.parse({ ...journal, stage: "unknown" })).toThrow();
    for (const stage of ["revoking", "revoked", "disabling", "disabled", "reissuing"] as const) {
      expect(ProvisioningJournalSchema.parse({ ...journal, stage }).stage).toBe(stage);
    }
    expect(() => ProvisioningJournalSchema.parse({ ...journal, startupSecret: "secret-value" })).toThrow();
    expect(() => ProvisioningJournalSchema.parse({ ...journal, compensation: { ...journal.compensation, tokenSecret: "secret-value" } })).toThrow();
  });

  it("accepts only explicit lifecycle operations and requires reissue identity", () => {
    expect(ProvisioningLifecycleActionSchema.parse({
      action: "revoke", idempotencyKey: "lifecycle-revoke-001", binding,
    }).action).toBe("revoke");
    expect(ProvisioningLifecycleActionSchema.parse({
      action: "disable", idempotencyKey: "lifecycle-disable-001", binding,
    }).action).toBe("disable");
    expect(ProvisioningLifecycleActionSchema.parse({
      action: "reissue", idempotencyKey: "lifecycle-reissue-001", binding,
      usbFingerprint: "c".repeat(64), notBefore: input.notBefore, expiresAt: input.expiresAt,
    }).action).toBe("reissue");
    expect(() => ProvisioningLifecycleActionSchema.parse({
      action: "reissue", idempotencyKey: "lifecycle-reissue-001", binding,
    })).toThrow();
  });
});
