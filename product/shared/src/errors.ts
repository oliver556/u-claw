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
  "CONFIRMATION_REQUIRED",
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
const safeCredentialStatus = /^(?:authentication required|required|missing|expired|configured|not configured|unavailable|invalid|redacted|unset|none)$/i;
const explicitlySafeContextKeys = new Set([
  "token_count",
  "input_tokens",
  "output_tokens",
  "max_tokens",
  "api_key_status",
  "token_status",
  "configured",
  "present",
  "enabled",
]);
const exactSensitiveContextKeys = new Set([
  "authorization",
  "cookie",
  "headers",
  "request_headers",
  "response_headers",
  "body",
  "content",
  "conversation",
  "message",
  "messages",
  "prompt",
  "text",
  "password",
  "private_key",
  "secret",
  "token",
  "api_key",
  "access_token",
  "refresh_token",
  "client_secret",
  "aws_access_key_id",
  "aws_secret_access_key",
]);

export function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function isSafeCredentialStatus(value: string): boolean {
  return safeCredentialStatus.test(value.trim().replace(/[.!?,;:]+$/g, "").trim());
}

function isSensitiveContextKey(key: string): boolean {
  const normalizedKey = normalizeKey(key);
  if (explicitlySafeContextKeys.has(normalizedKey)) return false;
  return exactSensitiveContextKeys.has(normalizedKey) ||
    /(?:^|_)(?:authorization|cookie|credentials?|headers?|key|password|private_key|secret|token)(?:_|$)/.test(normalizedKey);
}

function redactCapturedValue(
  match: string,
  prefix: string,
  value: string,
): string {
  return isSafeCredentialStatus(value) ? match : `${prefix}${REDACTED}`;
}

export function redactRendererText(text: string, contextKey?: string): string {
  if (/[{[]\s*"[^"\r\n]+"\s*:/.test(text)) return REDACTED;

  let redacted = text
    .replace(
      /(\bauthorization\s*:\s*(?:bearer|basic)\s+)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|authentication\s+required|not\s+configured|[^\s,;]+)/gi,
      redactCapturedValue,
    )
    .replace(/(\b(?:set-cookie|cookie)\s*:\s*)([^\r\n]+)/gi, redactCapturedValue)
    .replace(
      /(\b(?:password|client[-_ ]?secret|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|aws[-_ ]?secret[-_ ]?access[-_ ]?key|aws[-_ ]?access[-_ ]?key[-_ ]?id)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|not\s+configured|[^\s,;]+)/gi,
      redactCapturedValue,
    )
    .replace(/(\btoken\s*[:=]\s*)(not\s+configured|[^\s,;]+)/gi, redactCapturedValue)
    .replace(
      /(\bbearer\s+)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|authentication\s+required|not\s+configured|[^\s,;]+)/gi,
      redactCapturedValue,
    )
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/g, REDACTED)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED)
    .replace(/\bxox[bp]-[A-Za-z0-9-]{16,}\b/g, REDACTED)
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, REDACTED)
    .replace(/\b(?:sk|rk)_live_[A-Za-z0-9_-]{16,}\b/g, REDACTED)
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/gi, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\bfile:\/\/\/[^\r\n"'<>]*/gi, REDACTED)
    .replace(/\b[A-Za-z]:[\\/][^\r\n"'<>]*/g, REDACTED)
    .replace(/\\\\[^\r\n"'<>]*/g, REDACTED)
    .replace(/(^|[\s("'=:])\/(?:Users|home|private|Volumes|var\/folders|etc|tmp|opt|root|usr\/local|workspace|data|mnt)(?:\/[^\r\n"'<>]*)?/g, `$1${REDACTED}`)
    .replace(/~\/[^\r\n"'<>]*/g, REDACTED);

  if (contextKey !== undefined && redacted === text) {
    if (isSensitiveContextKey(contextKey) && text !== "" && !isSafeCredentialStatus(text)) {
      redacted = REDACTED;
    }
  }

  return redacted;
}

export type RendererRedactedValue =
  | string
  | number
  | boolean
  | null
  | RendererRedactedValue[]
  | { [key: string]: RendererRedactedValue };

const safeRecordTextKeys = new Set(["status", "state", "outcome", "level", "source", "api_key_status", "token_status"]);
const safeRecordTextValue = /^(?:idle|ready|pending|running|completed|failed|success|succeeded|warning|error|debug|info|cancelled|canceled|aborted|missing|expired|configured|not configured|unavailable|invalid|redacted|unset|none)$/i;
const safeRecordBooleanKeys = new Set(["configured", "enabled", "present", "retryable", "success"]);
const safeRecordNumberKeys = new Set(["count", "duration_ms", "exit_code", "input_tokens", "max_tokens", "output_tokens", "token_count"]);

export function redactRendererValue(value: unknown, contextKey?: string): RendererRedactedValue {
  return redactUnknown(value, contextKey);
}

function redactUnknown(
  value: unknown,
  contextKey: string | undefined,
): RendererRedactedValue {
  if (contextKey !== undefined && isSensitiveContextKey(contextKey)) {
    if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) return value as null | "" | [];
    if (typeof value === "string" && isSafeCredentialStatus(value)) return value;
    return REDACTED;
  }
  if (contextKey !== undefined) {
    const normalizedKey = normalizeKey(contextKey);
    if (typeof value === "string" && safeRecordTextKeys.has(normalizedKey) && safeRecordTextValue.test(value.trim())) {
      return redactRendererText(value, contextKey);
    }
    if (typeof value === "boolean" && safeRecordBooleanKeys.has(normalizedKey)) return value;
    if (typeof value === "number" && Number.isFinite(value) && safeRecordNumberKeys.has(normalizedKey)) return value;
    return REDACTED;
  }
  if (typeof value === "string") return redactRendererText(value, contextKey);
  if (value === null) return value;
  if (typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return REDACTED;

  const result: Record<string, RendererRedactedValue> = {};
  for (const [index, [rawKey, rawValue]] of Object.entries(value).slice(0, 64).entries()) {
    const safeKey = rawKey.length <= 64 && /^[A-Za-z0-9_.-]+$/.test(rawKey) && redactRendererText(rawKey) === rawKey;
    const key = safeKey ? rawKey : `field_${index + 1}`;
    result[key] = redactUnknown(rawValue, rawKey);
  }
  return result;
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

export const RendererSafeValueSchema = z.union([
  RendererSafeScalarSchema,
  z.array(RendererSafeScalarSchema),
]);
export type RendererSafeValue = z.infer<typeof RendererSafeValueSchema>;

export function redactRendererRecord(
  summary: Record<string, RendererSafeValue>,
): Record<string, RendererSafeValue> {
  return Object.fromEntries(
    Object.entries(summary).map(([key, value]) => {
      if (isSensitiveContextKey(key)) {
        if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) {
          return [key, value];
        }
        if (typeof value === "string" && isSafeCredentialStatus(value)) {
          return [key, value];
        }
        return [key, REDACTED];
      }

      if (typeof value === "string") return [key, redactRendererText(value)];
      if (Array.isArray(value)) {
        return [key, value.map((item) => typeof item === "string" ? redactRendererText(item) : item)];
      }
      return [key, value];
    }),
  );
}

export const RendererSafeSummarySchema = z
  .record(z.string(), RendererSafeValueSchema)
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
