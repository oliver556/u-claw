import { z } from "zod";

export const UClawErrorCodeSchema = z.enum([
  "UNKNOWN",
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "CONFLICT",
  "UNSUPPORTED",
  "UNAVAILABLE",
  "TIMEOUT",
  "CANCELLED",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "AUTHORIZATION_REQUIRED",
  "GATEWAY_STARTING",
  "GATEWAY_DISCONNECTED",
  "GATEWAY_FAILED",
  "CONTRACT_INCOMPATIBLE",
  "PROTOCOL_MAPPING_FAILED",
  "USB_MISSING",
  "USB_READ_ONLY",
  "DATA_WRITE_FAILED",
  "FILE_OUTSIDE_ALLOWED_ROOT",
  "FILE_TOO_LARGE",
  "FILE_TYPE_UNSUPPORTED",
  "MODEL_UNAVAILABLE",
  "PROVIDER_AUTH_FAILED",
  "NETWORK_UNREACHABLE",
  "OPERATION_FAILED",
  "ALREADY_COMPLETED",
]);
export type UClawErrorCode = z.infer<typeof UClawErrorCodeSchema>;

export const RecoveryActionSchema = z.enum([
  "retry",
  "open-settings",
  "open-diagnostics",
  "reconnect",
  "safe-exit",
]);
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;

const secretDetectors = [
  /authorization\s*:/i,
  /\bbearer\s+[A-Za-z0-9._~+/=-]+/i,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:api[-_ ]?key|token)\s*[:=]\s*\S+/i,
  /\bsk-[A-Za-z0-9_-]{8,}\b/i,
];

export const RendererSafeTextSchema = z.string().superRefine((value, context) => {
  if (secretDetectors.some((detector) => detector.test(value))) {
    context.addIssue({ code: "custom", message: "Renderer text contains secret material" });
  }
});
export type RendererSafeText = z.infer<typeof RendererSafeTextSchema>;

export const CauseDetailsSchema = z
  .object({
    diagnosticCode: RendererSafeTextSchema.optional(),
    operation: RendererSafeTextSchema.optional(),
    status: RendererSafeTextSchema.optional(),
    field: RendererSafeTextSchema.optional(),
    capability: RendererSafeTextSchema.optional(),
    upstreamCode: RendererSafeTextSchema.optional(),
    retryAfterMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type CauseDetails = z.infer<typeof CauseDetailsSchema>;

export const UClawErrorSummarySchema = z
  .object({
    code: UClawErrorCodeSchema,
    message: RendererSafeTextSchema.pipe(z.string().min(1)),
    retryable: z.boolean(),
  })
  .strict();
export type UClawErrorSummary = z.infer<typeof UClawErrorSummarySchema>;

export const UClawErrorSchema = z
  .object({
    code: UClawErrorCodeSchema,
    message: RendererSafeTextSchema.pipe(z.string().min(1)),
    retryable: z.boolean(),
    recoveryActions: z.array(RecoveryActionSchema).default([]),
    causeDetails: CauseDetailsSchema.default({}),
    correlationId: z.string().optional(),
  })
  .strict();
export type UClawError = z.infer<typeof UClawErrorSchema>;
