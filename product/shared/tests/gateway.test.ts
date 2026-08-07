import { describe, expect, it } from "vitest";

import {
  CapabilitySetWireSchema,
  GatewayStatusSchema,
  capabilitySetFromWire,
  capabilitySetToWire,
} from "../src/index.js";

describe("gateway contracts", () => {
  it("parses a gateway status", () => {
    expect(
      GatewayStatusSchema.parse({
        connectionState: "ready",
        protocolVersion: 4,
        endpointLabel: "localhost:18789",
        connectedAt: "2026-08-07T00:00:00.000Z",
      }),
    ).toMatchObject({ connectionState: "ready", protocolVersion: 4 });
  });

  it("rejects unsupported protocol versions", () => {
    expect(() =>
      GatewayStatusSchema.parse({ connectionState: "ready", protocolVersion: 3 }),
    ).toThrow();
  });

  it("converts serializable capabilities to readonly sets and back", () => {
    const wire = CapabilitySetWireSchema.parse({
      protocolVersion: 4,
      methods: ["sessions.list"],
      events: ["chat"],
      features: { attachments: false },
    });
    const service = capabilitySetFromWire(wire);

    expect(service.methods).toEqual(new Set(["sessions.list"]));
    expect(capabilitySetToWire(service)).toEqual(wire);
  });
});
