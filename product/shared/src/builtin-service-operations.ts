import { z } from "zod";

import { NewApiPolicySchema } from "./new-api-management.js";

export const BUILTIN_SERVICE_OPERATIONS_CONTRACT_VERSION = 1 as const;

const IdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u);
const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u);
const TimestampSchema = z.iso.datetime({ offset: true });
const RevisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const ModelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u);
const OpenAIUnixTimestampSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const OpenAITokenCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const PromptSchema = z.string().min(1).max(65_536).refine(
  (value) => new TextEncoder().encode(value).byteLength <= 65_536,
  "Prompt must not exceed 65536 UTF-8 bytes.",
);

export const BuiltinServiceStateSchema = z.enum(["enabled", "disabled", "degraded", "maintenance"]);
export type BuiltinServiceState = z.infer<typeof BuiltinServiceStateSchema>;

export const BuiltinServiceReasonCodeSchema = z.enum([
  "OPERATOR_ENABLED",
  "OPERATOR_DISABLED",
  "DEGRADED_HEALTH",
  "SCHEDULED_MAINTENANCE",
  "RECOVERY_COMPLETE",
]);
export type BuiltinServiceReasonCode = z.infer<typeof BuiltinServiceReasonCodeSchema>;

const stateMatchesReason = (value: { state: BuiltinServiceState; reasonCode: BuiltinServiceReasonCode }): boolean => {
  switch (value.state) {
    case "enabled":
      return value.reasonCode === "OPERATOR_ENABLED" || value.reasonCode === "RECOVERY_COMPLETE";
    case "disabled":
      return value.reasonCode === "OPERATOR_DISABLED";
    case "degraded":
      return value.reasonCode === "DEGRADED_HEALTH";
    case "maintenance":
      return value.reasonCode === "SCHEDULED_MAINTENANCE";
  }
};

export const BuiltinServiceStatusSchema = z.object({
  schemaVersion: z.literal(1),
  state: BuiltinServiceStateSchema,
  revision: RevisionSchema,
  reasonCode: BuiltinServiceReasonCodeSchema,
  updatedAt: TimestampSchema,
}).strict().refine(stateMatchesReason, {
  path: ["reasonCode"],
  message: "Service state and reason code do not match.",
});
export type BuiltinServiceStatus = z.infer<typeof BuiltinServiceStatusSchema>;

export const BuiltinServiceStatusUpdateSchema = z.object({
  idempotencyKey: IdempotencyKeySchema,
  expectedRevision: RevisionSchema,
  state: BuiltinServiceStateSchema,
  reasonCode: BuiltinServiceReasonCodeSchema,
}).strict().refine(stateMatchesReason, {
  path: ["reasonCode"],
  message: "Service state and reason code do not match.",
});
export type BuiltinServiceStatusUpdate = z.infer<typeof BuiltinServiceStatusUpdateSchema>;

export const BuiltinDeviceLocatorSchema = z.union([
  z.object({ deviceId: IdentifierSchema }).strict(),
  z.object({ userId: IdentifierSchema }).strict(),
]);
export type BuiltinDeviceLocator = z.infer<typeof BuiltinDeviceLocatorSchema>;

export const BuiltinDeviceControlsSchema = z.object({
  schemaVersion: z.literal(1),
  deviceId: IdentifierSchema,
  userId: IdentifierSchema,
  revision: RevisionSchema,
  policy: NewApiPolicySchema,
  policyDigest: Sha256Schema,
  generation: RevisionSchema,
  licenseId: IdentifierSchema,
  tokenId: IdentifierSchema,
  updatedAt: TimestampSchema,
}).strict();
export type BuiltinDeviceControls = z.infer<typeof BuiltinDeviceControlsSchema>;

export const BuiltinDeviceControlsUpdateSchema = z.object({
  idempotencyKey: IdempotencyKeySchema,
  expectedRevision: RevisionSchema,
  expectedGeneration: RevisionSchema,
  expectedLicenseId: IdentifierSchema,
  expectedTokenId: IdentifierSchema,
  policy: NewApiPolicySchema,
}).strict();
export type BuiltinDeviceControlsUpdate = z.infer<typeof BuiltinDeviceControlsUpdateSchema>;

export const BuiltinModelRequestSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: IdentifierSchema,
  model: ModelSchema,
  prompt: PromptSchema,
  maxOutputTokens: z.number().int().min(1).max(32_768),
}).strict();
export type BuiltinModelRequest = z.infer<typeof BuiltinModelRequestSchema>;

export const BuiltinModelUsageSchema = z.object({
  inputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  outputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
export type BuiltinModelUsage = z.infer<typeof BuiltinModelUsageSchema>;

export const BuiltinModelResponseSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: IdentifierSchema,
  output: z.string().max(1_048_576),
  usage: BuiltinModelUsageSchema,
  serviceState: BuiltinServiceStateSchema,
  serviceRevision: RevisionSchema,
}).strict();
export type BuiltinModelResponse = z.infer<typeof BuiltinModelResponseSchema>;

export const OpenAIModelSchema = z.object({
  id: ModelSchema,
  object: z.literal("model"),
  created: OpenAIUnixTimestampSchema,
  owned_by: IdentifierSchema,
}).strict();
export type OpenAIModel = z.infer<typeof OpenAIModelSchema>;

export const OpenAIModelsResponseSchema = z.object({
  object: z.literal("list"),
  data: z.array(OpenAIModelSchema),
}).strict();
export type OpenAIModelsResponse = z.infer<typeof OpenAIModelsResponseSchema>;

export const OpenAIChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
}).strict();
export type OpenAIChatMessage = z.infer<typeof OpenAIChatMessageSchema>;

export const OpenAIChatCompletionRequestSchema = z.object({
  model: ModelSchema,
  messages: z.array(OpenAIChatMessageSchema).min(1),
  stream: z.literal(false),
}).strict();
export type OpenAIChatCompletionRequest = z.infer<typeof OpenAIChatCompletionRequestSchema>;

export const OpenAIChatCompletionResponseSchema = z.object({
  id: IdentifierSchema,
  object: z.literal("chat.completion"),
  created: OpenAIUnixTimestampSchema,
  model: ModelSchema,
  choices: z.array(z.object({
    index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    message: z.object({
      role: z.literal("assistant"),
      content: z.string(),
    }).strict(),
    finish_reason: z.enum(["stop", "length", "content_filter"]),
  }).strict()),
  usage: z.object({
    prompt_tokens: OpenAITokenCountSchema,
    completion_tokens: OpenAITokenCountSchema,
    total_tokens: OpenAITokenCountSchema,
  }).strict(),
}).strict();
export type OpenAIChatCompletionResponse = z.infer<typeof OpenAIChatCompletionResponseSchema>;

export const BuiltinServiceHealthSchema = z.object({
  schemaVersion: z.literal(1),
  acceptingBuiltin: z.boolean(),
  state: BuiltinServiceStateSchema,
  revision: RevisionSchema,
}).strict().refine(
  (value) => !value.acceptingBuiltin || value.state === "enabled" || value.state === "degraded",
  { path: ["acceptingBuiltin"], message: "Disabled and maintenance services cannot accept builtin requests." },
);
export type BuiltinServiceHealth = z.infer<typeof BuiltinServiceHealthSchema>;
