import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LICENSE_LIFECYCLE_CONTRACT_VERSION,
  LicenseLifecycleAuditEventSchema,
  LicenseStatusReceiptSchema,
  LicenseStatusSummarySchema,
} from "../../shared/src/index.js";

const fixture = JSON.parse(readFileSync(resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/license-lifecycle-v1.json",
), "utf8")) as Record<string, unknown>;

describe("U-Claw license lifecycle v1 fixture", () => {
  it("locks the public status contract without secret material", () => {
    expect(fixture.contractVersion).toBe(LICENSE_LIFECYCLE_CONTRACT_VERSION);
    expect(LicenseStatusSummarySchema.parse(fixture.status)).toBeTruthy();
    expect(LicenseStatusReceiptSchema.parse(fixture.receipt)).toBeTruthy();
    expect(LicenseLifecycleAuditEventSchema.parse(fixture.auditEvent)).toBeTruthy();
    expect(JSON.stringify(fixture)).not.toMatch(/startupSecret|newApiToken|usbFingerprint|signature|authorization/iu);
  });
});
