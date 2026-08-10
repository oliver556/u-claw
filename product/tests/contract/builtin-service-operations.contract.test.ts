import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BUILTIN_SERVICE_OPERATIONS_CONTRACT_VERSION,
  BuiltinDeviceControlsSchema,
  BuiltinDeviceControlsUpdateSchema,
  BuiltinModelRequestSchema,
  BuiltinModelResponseSchema,
  BuiltinServiceHealthSchema,
  BuiltinServiceStatusSchema,
  BuiltinServiceStatusUpdateSchema,
} from "../../shared/src/index.js";

const fixture = JSON.parse(readFileSync(resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/builtin-service-operations-v1.json",
), "utf8")) as Record<string, unknown>;

describe("builtin service operations fixture", () => {
  it("locks strict public v1 payloads without credential material", () => {
    expect(BUILTIN_SERVICE_OPERATIONS_CONTRACT_VERSION).toBe(1);
    expect(fixture.contractVersion).toBe(1);
    for (const status of fixture.statuses as unknown[]) expect(BuiltinServiceStatusSchema.parse(status)).toBeTruthy();
    expect(BuiltinServiceStatusUpdateSchema.parse(fixture.serviceUpdate)).toBeTruthy();
    expect(BuiltinDeviceControlsSchema.parse(fixture.deviceControls)).toBeTruthy();
    expect(BuiltinDeviceControlsUpdateSchema.parse(fixture.deviceUpdate)).toBeTruthy();
    expect(BuiltinModelRequestSchema.parse(fixture.modelRequest)).toBeTruthy();
    expect(BuiltinModelResponseSchema.parse(fixture.modelResponse)).toBeTruthy();
    expect(BuiltinServiceHealthSchema.parse(fixture.health)).toBeTruthy();
    expect(JSON.stringify(fixture)).not.toMatch(
      /authorization|credential|api[_-]?key|providerKey|upstreamKey|tokenSecret|secret|endpoint|username/iu,
    );
  });
});
