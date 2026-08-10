import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as shared from "../src/index.js";

const fixture = JSON.parse(readFileSync(resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../tests/fixtures/license-lifecycle-v1.json",
), "utf8")) as Record<string, unknown>;

describe("license lifecycle v1 contract", () => {
  it("exports six explicit lifecycle states and strict safe status shapes", () => {
    expect(shared.LICENSE_LIFECYCLE_CONTRACT_VERSION).toBe(1);
    for (const status of ["provisioning", "active", "revoked", "reissued", "expired", "disabled"]) {
      expect(shared.LicenseLifecycleStatusSchema.parse(status)).toBe(status);
    }
    expect(shared.LicenseStatusSummarySchema.parse(fixture.status)).toBeTruthy();
    for (const field of ["startupSecret", "newApiToken", "usbFingerprint", "signature", "authorization"]) {
      expect(() => shared.LicenseStatusSummarySchema.parse({ ...(fixture.status as object), [field]: "leak" })).toThrow();
    }
  });

  it("publishes opaque receipts and strict lifecycle inputs", () => {
    expect(shared.LicenseStatusReceiptSchema.parse(fixture.receipt)).toEqual(fixture.receipt);
    expect(() => shared.LicenseStatusReceiptSchema.parse({ value: "short" })).toThrow();
    expect(shared.LicenseIssueInputSchema.parse({
      idempotencyKey: "issue-fixture-001",
      deviceId: "dev_fixture_001",
      usbFingerprint: "a".repeat(64),
      notBefore: "2026-08-10T00:00:00.000Z",
      expiresAt: "2027-08-10T00:00:00.000Z",
    })).toBeTruthy();
    expect(shared.LicenseMutationInputSchema.parse({ idempotencyKey: "revoke-fixture-001" })).toBeTruthy();
    expect(shared.LicenseReissueInputSchema.parse({
      idempotencyKey: "reissue-fixture-001",
      usbFingerprint: "d".repeat(64),
      notBefore: "2027-08-10T00:00:00.000Z",
      expiresAt: "2028-08-10T00:00:00.000Z",
    })).toBeTruthy();
  });

  it("keeps issuer artifacts separate from status query output", () => {
    const issued = shared.IssuedLicenseSchema.parse({
      status: fixture.status,
      startupCredential: {
        schemaVersion: 1,
        deviceId: "dev_fixture_001",
        licenseId: "lic_fixture_001",
        startupSecret: "fixture-generated-secret-material-001",
      },
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
        notBefore: "2026-08-10T00:00:00.000Z",
        expiresAt: "2027-08-10T00:00:00.000Z",
        signature: { algorithm: "ed25519", keyId: "fixture-key", value: "d".repeat(88) },
      },
    });
    expect(issued.startupCredential.startupSecret).toHaveLength(37);
    expect(JSON.stringify(shared.LicenseStatusResponseSchema.parse({ status: fixture.status, receipt: fixture.receipt })))
      .not.toMatch(/startupSecret|usbFingerprint|signature|authorization/iu);
  });

  it("validates redacted audit and typed errors without request material", () => {
    expect(shared.LicenseLifecycleAuditEventSchema.parse(fixture.auditEvent)).toBeTruthy();
    expect(() => shared.LicenseLifecycleAuditEventSchema.parse({ ...(fixture.auditEvent as object), requestBody: { startupSecret: "leak" } })).toThrow();
    expect(shared.LicenseLifecycleErrorBodySchema.parse({
      error: { category: "status", code: "LICENSE_REVOKED", message: "许可证已撤销。", retryable: false },
    })).toBeTruthy();
  });
});
