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
  /\bauthorization\s*:\s*(?:bearer|basic)\s+\S+/i,
  /\bbearer\s+[A-Za-z0-9._~+/=-]+/i,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:password|client[-_ ]?secret|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|aws[-_ ]?secret[-_ ]?access[-_ ]?key|aws[-_ ]?access[-_ ]?key[-_ ]?id)\s*[:=]\s*(?!(?:required|missing|expired|configured|invalid|redacted|unset|none)\b)\S+/i,
  /\btoken\s*[:=]\s*(?!(?:required|missing|expired|configured|invalid|redacted|unset|none)\b)\S+/i,
  /\b(?:cookie|set-cookie)\s*:\s*\S+/i,
  /\bsk-[A-Za-z0-9_-]{8,}\b/i,
];

export const RendererSafeTextSchema = z.string().superRefine((value, context) => {
  if (secretDetectors.some((detector) => detector.test(value))) {
    context.addIssue({ code: "custom", message: "Renderer text contains secret material" });
  }
});
export type RendererSafeText = z.infer<typeof RendererSafeTextSchema>;

const sensitiveSummaryKey = /(?:^|[_-])(?:authorization|cookie|password|secret|token)(?:$|[_-])|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret/i;

export const RendererSafeScalarSchema = z.union([
  RendererSafeTextSchema,
  z.number(),
  z.boolean(),
  z.null(),
]);
export type RendererSafeScalar = z.infer<typeof RendererSafeScalarSchema>;

export const RendererSafeSummarySchema = z
  .record(z.string(), RendererSafeScalarSchema)
  .superRefine((summary, context) => {
    for (const key of Object.keys(summary)) {
      const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
      if (sensitiveSummaryKey.test(normalizedKey)) {
        context.addIssue({ code: "custom", message: `Sensitive summary key is forbidden: ${key}` });
      }
    }
  });
export type RendererSafeSummary = z.infer<typeof RendererSafeSummarySchema>;

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
