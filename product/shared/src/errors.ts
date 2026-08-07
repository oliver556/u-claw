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

const REDACTED = "[REDACTED]";
const safeCredentialStatus = /^(?:required|missing|expired|configured|invalid|redacted|unset|none)$/i;
const sensitiveContextKeys = new Set([
  "authorization",
  "cookie",
  "password",
  "secret",
  "token",
  "api_key",
  "access_token",
  "refresh_token",
  "client_secret",
  "aws_access_key_id",
  "aws_secret_access_key",
]);

function redactCapturedValue(
  match: string,
  prefix: string,
  value: string,
): string {
  return safeCredentialStatus.test(value.trim()) ? match : `${prefix}${REDACTED}`;
}

export function redactRendererText(text: string, contextKey?: string): string {
  let redacted = text
    .replace(/(\bauthorization\s*:\s*(?:bearer|basic)\s+)([^\s,;]+)/gi, redactCapturedValue)
    .replace(/(\b(?:set-cookie|cookie)\s*:\s*)([^\r\n]+)/gi, redactCapturedValue)
    .replace(
      /(\b(?:password|client[-_ ]?secret|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|aws[-_ ]?secret[-_ ]?access[-_ ]?key|aws[-_ ]?access[-_ ]?key[-_ ]?id)\s*[:=]\s*)([^\s,;]+)/gi,
      redactCapturedValue,
    )
    .replace(/(\btoken\s*[:=]\s*)([^\s,;]+)/gi, redactCapturedValue)
    .replace(/(\bbearer\s+)([A-Za-z0-9._~+/=-]+)/gi, `$1${REDACTED}`)
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/g, REDACTED)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED)
    .replace(/\bxox[bp]-[A-Za-z0-9-]{16,}\b/g, REDACTED)
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, REDACTED)
    .replace(/\b(?:sk|rk)_live_[A-Za-z0-9_-]{16,}\b/g, REDACTED)
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/gi, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED);

  if (contextKey !== undefined && redacted === text) {
    const normalizedKey = contextKey.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    if (sensitiveContextKeys.has(normalizedKey) && !safeCredentialStatus.test(text.trim())) {
      redacted = REDACTED;
    }
  }

  return redacted;
}

export const RendererSafeTextSchema = z.string().transform((value) => redactRendererText(value));
export type RendererSafeText = z.infer<typeof RendererSafeTextSchema>;

export const RendererSafeScalarSchema = z.union([
  RendererSafeTextSchema,
  z.number(),
  z.boolean(),
  z.null(),
]);
export type RendererSafeScalar = z.infer<typeof RendererSafeScalarSchema>;

export function redactRendererRecord(
  summary: Record<string, RendererSafeScalar>,
): Record<string, RendererSafeScalar> {
  return Object.fromEntries(
    Object.entries(summary).map(([key, value]) => [
      key,
      typeof value === "string" ? redactRendererText(value, key) : value,
    ]),
  );
}

export const RendererSafeSummarySchema = z
  .record(z.string(), RendererSafeScalarSchema)
  .transform(redactRendererRecord);
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
