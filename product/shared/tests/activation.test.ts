import { describe, expect, it } from "vitest";

import {
  ActivationCommitSchema,
  ActivationErrorSchema,
  ActivationRequestSchema,
  ActivationResponseSchema,
  ClientPolicySchema,
  LicenseStatusSummarySchema,
  normalizeActivationCodeInput,
} from "../src/index.js";

const request = {
  username: "UCLAW-00000001",
  activationCode: "0123456789ABCDEFGHJKMNPQRS",
  usbFingerprint: {
    version: "uclaw-usb-v1",
    sha256: "a".repeat(64),
  },
  clientVersion: "1.0.0",
  idempotencyKey: "activation-fixture-001",
};

describe("activation API contract", () => {
  it("separates UI normalization from the strict wire activation code", () => {
    expect(normalizeActivationCodeInput("01234-56789-abcde-fghjk-mnpqrs")).toBe("0123456789ABCDEFGHJKMNPQRS");
    expect(ActivationRequestSchema.parse(request).activationCode).toBe("0123456789ABCDEFGHJKMNPQRS");
    expect(() => ActivationRequestSchema.parse({ ...request, activationCode: "01234-56789-ABCDE-FGHJK-MNPQRS" })).toThrow();
    expect(() => ActivationRequestSchema.parse({ ...request, activationCode: "0123456789ABCDEFGHJKMNPQRS0" })).toThrow();
    expect(() => ActivationRequestSchema.parse({ ...request, activationCode: "01234-56789-ABCDE-FGHIJ-KLMNOP" })).toThrow();
    expect(() => ActivationRequestSchema.parse({ ...request, status: "active" })).toThrow();
  });

  it("accepts strict activation response and commit payloads", () => {
    const response = {
      activationId: "act_fixture_001",
      deviceId: "dev_fixture_001",
      licenseId: "lic_fixture_001",
      license: {
        schemaVersion: 1,
        deviceId: "dev_fixture_001",
        licenseId: "lic_fixture_001",
        usbFingerprint: { scheme: "uclaw-usb-v1", sha256: "a".repeat(64) },
        startupSecretProof: {
          algorithm: "sha256-salt-v1",
          startupSecretSalt: "b".repeat(32),
          startupSecretHash: "c".repeat(64),
        },
        notBefore: "2026-08-13T00:00:00.000Z",
        expiresAt: "2027-08-13T00:00:00.000Z",
        signature: { algorithm: "ed25519", keyId: "fixture-key", value: "d".repeat(88) },
      },
      startupCredential: {
        schemaVersion: 1,
        deviceId: "dev_fixture_001",
        licenseId: "lic_fixture_001",
        startupSecret: "fixture-generated-secret-material-001",
      },
      builtinCredential: {
        schemaVersion: 1,
        deviceId: "dev_fixture_001",
        licenseId: "lic_fixture_001",
        accessToken: "fixture-short-lived-token-material",
        expiresAt: "2026-08-13T01:00:00.000Z",
      },
      status: "active",
    };

    expect(ActivationResponseSchema.parse(response)).toEqual(response);
    expect(() => ActivationResponseSchema.parse({
      ...response,
      startupCredential: { ...response.startupCredential, deviceId: "dev_other_001" },
    })).toThrow();
    expect(() => ActivationResponseSchema.parse({
      ...response,
      builtinCredential: { ...response.builtinCredential, internalUrl: "https://internal.invalid" },
    })).toThrow();
    expect(ActivationCommitSchema.parse({
      idempotencyKey: "commit-fixture-001",
      artifactGeneration: 1,
    })).toBeTruthy();
    expect(() => ActivationCommitSchema.parse({
      idempotencyKey: "commit-fixture-001",
      artifactGeneration: 1,
      releaseBinding: true,
    })).toThrow();
  });

  it("accepts only the redacted public error envelope", () => {
    const error = {
      requestId: "req_fixture_001",
      activationId: "act_fixture_001",
      code: "ACTIVATION_SERVICE_UNAVAILABLE",
      stage: "server_bound",
      retryable: true,
      supportCode: "ACT-NET-004",
    };

    expect(ActivationErrorSchema.parse(error)).toEqual(error);
    for (const leakedField of ["message", "sql", "stack", "usbFingerprint", "activationCode", "authorization"]) {
      expect(() => ActivationErrorSchema.parse({ ...error, [leakedField]: "leak" })).toThrow();
    }
  });

  it("freezes client policy and license status fields", () => {
    expect(ClientPolicySchema.parse({
      minimumClientVersion: "1.0.0",
      latestClientVersion: "1.1.0",
      upgradeRequired: false,
      statusRefreshSeconds: 900,
      maximumOfflineGraceSeconds: 86_400,
    })).toBeTruthy();
    expect(LicenseStatusSummarySchema.parse({
      licenseId: "lic_fixture_001",
      deviceId: "dev_fixture_001",
      status: "active",
      revision: 1,
      notBefore: "2026-08-13T00:00:00.000Z",
      expiresAt: "2027-08-13T00:00:00.000Z",
      replacementLicenseId: null,
      updatedAt: "2026-08-13T00:00:00.000Z",
    })).toBeTruthy();
  });
});
