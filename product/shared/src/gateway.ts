import { z } from "zod";

import { ISODateTimeSchema, ModelRefSchema } from "./common.js";
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

export const GatewayPhaseSchema = z.enum([
  "idle",
  "validating",
  "preparing-runtime",
  "starting",
  "process-running",
  "service-ready",
  "available",
  "degraded",
  "stopping",
  "stopped",
  "failed",
]);
export type GatewayPhase = z.infer<typeof GatewayPhaseSchema>;

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

export const GatewayUsbStatusSchema = z
  .object({
    state: z.enum(["available", "read-only", "missing", "error"]),
    dataWritable: z.boolean(),
    displayName: z.string().optional(),
  })
  .strict();
export type GatewayUsbStatus = z.infer<typeof GatewayUsbStatusSchema>;

export const GatewayStatusWireSchema = z
  .object({
    connectionState: GatewayConnectionStateSchema,
    protocolVersion: ProtocolVersionSchema,
    phase: GatewayPhaseSchema,
    processAlive: z.boolean(),
    serviceReady: z.boolean(),
    businessAvailable: z.boolean(),
    since: ISODateTimeSchema,
    attempt: z.number().int().nonnegative(),
    endpointLabel: z.string().optional(),
    openClawVersion: z.string().optional(),
    activeModel: ModelRefSchema.optional(),
    usb: GatewayUsbStatusSchema,
    capabilities: CapabilitySetWireSchema.optional(),
    error: UClawErrorSchema.optional(),
  })
  .strict();
export type GatewayStatusWire = z.infer<typeof GatewayStatusWireSchema>;

export type GatewayStatus = Omit<GatewayStatusWire, "capabilities"> & {
  capabilities?: CapabilitySet;
};

export function gatewayStatusFromWire(wire: GatewayStatusWire): GatewayStatus {
  const { capabilities, ...status } = wire;
  return {
    ...status,
    ...(capabilities === undefined ? {} : { capabilities: capabilitySetFromWire(capabilities) }),
  };
}

export function gatewayStatusToWire(status: GatewayStatus): GatewayStatusWire {
  const { capabilities, ...wire } = status;
  return GatewayStatusWireSchema.parse({
    ...wire,
    ...(capabilities === undefined ? {} : { capabilities: capabilitySetToWire(capabilities) }),
  });
}
