import { z } from "zod";

import { ISODateTimeSchema } from "./common.js";
import { UClawErrorSchema } from "./errors.js";

export const ProtocolVersionSchema = z.literal(4);
export type ProtocolVersion = z.infer<typeof ProtocolVersionSchema>;

export const GatewayConnectionStateSchema = z.enum([
  "idle",
  "connecting",
  "authenticating",
  "ready",
  "reconnecting",
  "degraded",
  "failed",
  "closed",
]);
export type GatewayConnectionState = z.infer<typeof GatewayConnectionStateSchema>;

export const CapabilitySetWireSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    methods: z.array(z.string()).default([]),
    events: z.array(z.string()).default([]),
    features: z.record(z.string(), z.boolean()).default({}),
  })
  .strict();
export type CapabilitySetWire = z.infer<typeof CapabilitySetWireSchema>;

export type CapabilitySet = {
  protocolVersion: ProtocolVersion;
  methods: ReadonlySet<string>;
  events: ReadonlySet<string>;
  features: Readonly<Record<string, boolean>>;
};

export function capabilitySetFromWire(wire: CapabilitySetWire): CapabilitySet {
  return {
    protocolVersion: wire.protocolVersion,
    methods: new Set(wire.methods),
    events: new Set(wire.events),
    features: Object.freeze({ ...wire.features }),
  };
}

export function capabilitySetToWire(capabilities: CapabilitySet): CapabilitySetWire {
  return CapabilitySetWireSchema.parse({
    protocolVersion: capabilities.protocolVersion,
    methods: [...capabilities.methods],
    events: [...capabilities.events],
    features: capabilities.features,
  });
}

export const GatewayStatusSchema = z
  .object({
    connectionState: GatewayConnectionStateSchema,
    protocolVersion: ProtocolVersionSchema,
    endpointLabel: z.string().optional(),
    connectedAt: ISODateTimeSchema.optional(),
    openClawVersion: z.string().optional(),
    capabilities: CapabilitySetWireSchema.optional(),
    error: UClawErrorSchema.optional(),
  })
  .strict();
export type GatewayStatus = z.infer<typeof GatewayStatusSchema>;
