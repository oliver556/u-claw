import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  NewApiAuditEventSchema,
  NewApiDeviceMappingSchema,
  NewApiPolicySchema,
  NewApiUsageSchema,
} from "../../shared/src/index.js";

const fixture = JSON.parse(readFileSync(resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/new-api-management-v1.json",
), "utf8")) as Record<string, unknown>;

describe("U-Claw New API management adapter fixture", () => {
  it("locks the public v1 fixture without private upstream claims", () => {
    expect(fixture.contractVersion).toBe(1);
    expect(NewApiDeviceMappingSchema.parse(fixture.device)).toBeTruthy();
    expect(NewApiPolicySchema.parse(fixture.policy)).toBeTruthy();
    expect(NewApiUsageSchema.parse(fixture.usage)).toBeTruthy();
    expect(NewApiAuditEventSchema.parse(fixture.auditEvent)).toBeTruthy();
    expect(JSON.stringify(fixture)).not.toMatch(/authorization|api[_-]?key|upstream|tokenSecret|startupSecret":/iu);
  });
});
