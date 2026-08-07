import { describe, expect, it } from "vitest";

import {
  CapabilitySetWireSchema,
  GatewayStatusWireSchema,
  capabilitySetFromWire,
  capabilitySetToWire,
  gatewayStatusFromWire,
  gatewayStatusToWire,
} from "../src/index.js";

const gatewayStatusWire = {
  connectionState: "ready",
  protocolVersion: 4,
  phase: "available",
  processAlive: true,
  serviceReady: true,
  businessAvailable: true,
  since: "2026-08-07T00:00:00.000Z",
  attempt: 1,
  usb: { state: "available", dataWritable: true, displayName: "U-Claw" },
  capabilities: {
    protocolVersion: 4,
    methods: ["sessions.list"],
    events: ["chat"],
    features: { attachments: false },
  },
} as const;

describe("gateway contracts", () => {
  it("parses a gateway status", () => {
    expect(
      GatewayStatusWireSchema.parse(gatewayStatusWire),
    ).toMatchObject({ connectionState: "ready", phase: "available", processAlive: true });
  });

  it("rejects unsupported protocol versions", () => {
    expect(() =>
      GatewayStatusWireSchema.parse({ ...gatewayStatusWire, protocolVersion: 3 }),
    ).toThrow();
  });

  it("converts gateway status capabilities between wire arrays and service sets", () => {
    const service = gatewayStatusFromWire(GatewayStatusWireSchema.parse(gatewayStatusWire));

    expect(service.capabilities?.methods).toEqual(new Set(["sessions.list"]));
    expect(gatewayStatusToWire(service)).toEqual(gatewayStatusWire);
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
