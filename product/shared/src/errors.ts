import { z } from "zod";

import { StringMapValueSchema } from "./common.js";

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

const sensitiveDetailKey = /(?:api[-_]?key|authorization|cookie|password|secret|token)/i;
const rawSecretValue = /\bBearer\s+\S+|\b(?:api|pk|sk)[-_][A-Za-z0-9_-]{8,}/i;

export const CauseDetailsSchema = z
  .record(z.string(), StringMapValueSchema)
  .superRefine((details, context) => {
    for (const key of Object.keys(details)) {
      if (sensitiveDetailKey.test(key)) {
        context.addIssue({ code: "custom", message: `Sensitive cause detail is forbidden: ${key}` });
      }
    }
    for (const value of Object.values(details)) {
      if (typeof value === "string" && rawSecretValue.test(value)) {
        context.addIssue({ code: "custom", message: "Raw secret in cause details is forbidden" });
      }
    }
  });
export type CauseDetails = z.infer<typeof CauseDetailsSchema>;

export const UClawErrorSummarySchema = z
  .object({
    code: UClawErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
  })
  .strict();
export type UClawErrorSummary = z.infer<typeof UClawErrorSummarySchema>;

export const UClawErrorSchema = z
  .object({
    code: UClawErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
    recoveryActions: z.array(RecoveryActionSchema).default([]),
    causeDetails: CauseDetailsSchema.default({}),
    correlationId: z.string().optional(),
  })
  .strict();
export type UClawError = z.infer<typeof UClawErrorSchema>;
