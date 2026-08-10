import { z } from "zod";

import { RendererSafeTextSchema } from "./errors.js";
import type {
  BuiltinDeviceControls,
  BuiltinDeviceControlsUpdate,
  BuiltinDeviceLocator,
  BuiltinServiceStatus,
  BuiltinServiceStatusUpdate,
} from "./builtin-service-operations.js";

export const NEW_API_MANAGEMENT_CONTRACT_VERSION = 1 as const;

const IdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u);
const UsernameSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/u);
const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u);
const TimestampSchema = z.iso.datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const SecretSaltSchema = z.string().regex(/^[a-f0-9]{32,128}$/u);
const SafeMessageSchema = RendererSafeTextSchema.pipe(z.string().min(1).max(300));

export const NewApiProvisioningStatusSchema = z.enum(["provisioning", "active", "failed", "disabled", "revoked"]);
export type NewApiProvisioningStatus = z.infer<typeof NewApiProvisioningStatusSchema>;

export const NewApiCompensationSchema = z.object({
  tokenId: IdentifierSchema,
  status: z.enum(["pending", "succeeded", "failed"]),
  attemptedAt: TimestampSchema.nullable(),
}).strict();
export type NewApiCompensation = z.infer<typeof NewApiCompensationSchema>;

export const NewApiProvisioningFailureSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/u),
  compensation: NewApiCompensationSchema,
}).strict();
export type NewApiProvisioningFailure = z.infer<typeof NewApiProvisioningFailureSchema>;

export const NewApiDeviceMappingSchema = z.object({
  deviceId: IdentifierSchema,
  licenseId: IdentifierSchema,
  startupSecretHash: Sha256Schema,
  startupSecretSalt: SecretSaltSchema,
  usbFingerprint: Sha256Schema,
  newApiUserId: IdentifierSchema,
  newApiUsername: UsernameSchema,
  newApiTokenId: IdentifierSchema,
  channelId: IdentifierSchema,
  policyDigest: Sha256Schema,
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  previousTokenId: IdentifierSchema.nullable(),
  status: NewApiProvisioningStatusSchema,
  failure: NewApiProvisioningFailureSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.status === "failed" && value.failure === null) {
    context.addIssue({ code: "custom", path: ["failure"], message: "Failed provisioning requires a compensation record." });
  }
  if (value.status !== "failed" && value.failure !== null) {
    context.addIssue({ code: "custom", path: ["failure"], message: "Only failed provisioning may carry a failure record." });
  }
});
export type NewApiDeviceMapping = z.infer<typeof NewApiDeviceMappingSchema>;

export const NewApiQuotaSchema = z.object({
  unit: z.enum(["tokens", "requests"]),
  limit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  period: z.enum(["daily", "monthly", "lifetime"]),
}).strict();

export const NewApiRateLimitSchema = z.object({
  requestsPerMinute: z.number().int().min(1).max(1_000_000),
  concurrentRequests: z.number().int().min(1).max(10_000),
}).strict();

export const NewApiPolicySchema = z.object({
  quota: NewApiQuotaSchema,
  rateLimit: NewApiRateLimitSchema,
  allowedModels: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u)).max(200)
    .refine((models) => new Set(models).size === models.length, "Allowed models must be unique."),
  disabled: z.boolean(),
}).strict();
export type NewApiPolicy = z.infer<typeof NewApiPolicySchema>;

export const NewApiUserSchema = z.object({
  id: IdentifierSchema,
  deviceId: IdentifierSchema,
  username: UsernameSchema,
  status: z.enum(["active", "disabled"]),
  policy: NewApiPolicySchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().superRefine((value, context) => {
  if ((value.status === "disabled") !== value.policy.disabled) {
    context.addIssue({ code: "custom", path: ["status"], message: "User status must match policy.disabled." });
  }
});
export type NewApiUser = z.infer<typeof NewApiUserSchema>;

export const NewApiTokenSchema = z.object({
  id: IdentifierSchema,
  userId: IdentifierSchema,
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/u),
  channelId: IdentifierSchema,
  policyDigest: Sha256Schema,
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  status: z.enum(["provisioning", "active", "revoked"]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();
export type NewApiToken = z.infer<typeof NewApiTokenSchema>;

export const NewApiIssuedTokenSchema = z.object({
  token: NewApiTokenSchema,
  secret: z.string().min(24).max(512),
}).strict();
export type NewApiIssuedToken = z.infer<typeof NewApiIssuedTokenSchema>;

export const NewApiUsageSchema = z.object({
  userId: IdentifierSchema,
  consumed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  remaining: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  resetAt: TimestampSchema.nullable(),
  updatedAt: TimestampSchema,
}).strict();
export type NewApiUsage = z.infer<typeof NewApiUsageSchema>;

export const NewApiAuditEventSchema = z.object({
  id: IdentifierSchema,
  action: z.enum([
    "user.created", "token.created", "token.activated", "token.revoked", "device.created", "device.status-updated",
    "policy.updated", "service-state.updated", "device-controls.updated", "usage.queried", "request.rejected",
  ]),
  subjectType: z.enum(["service", "user", "token", "device", "request"]),
  subjectId: IdentifierSchema,
  deviceId: IdentifierSchema.nullable(),
  outcome: z.enum(["succeeded", "failed"]),
  errorCategory: z.enum(["validation", "conflict", "authentication", "not-found", "disabled", "quota", "rate-limit", "model-permission", "upstream", "unavailable", "transport", "invalid-response"]).nullable(),
  createdAt: TimestampSchema,
}).strict();
export type NewApiAuditEvent = z.infer<typeof NewApiAuditEventSchema>;

export const NewApiErrorCategorySchema = z.enum([
  "validation", "conflict", "authentication", "not-found", "disabled", "quota", "rate-limit",
  "model-permission", "upstream", "unavailable", "transport", "invalid-response",
]);
export type NewApiErrorCategory = z.infer<typeof NewApiErrorCategorySchema>;

export const NewApiManagementErrorBodySchema = z.object({
  error: z.object({
    category: NewApiErrorCategorySchema,
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/u),
    message: SafeMessageSchema,
    retryable: z.boolean(),
  }).strict(),
}).strict();
export type NewApiManagementErrorBody = z.infer<typeof NewApiManagementErrorBodySchema>;

export const NewApiCreateUserInputSchema = z.object({
  idempotencyKey: IdempotencyKeySchema,
  deviceId: IdentifierSchema,
  username: UsernameSchema,
}).strict();
export type NewApiCreateUserInput = z.infer<typeof NewApiCreateUserInputSchema>;

export const NewApiCreateTokenInputSchema = z.object({
  idempotencyKey: IdempotencyKeySchema,
  userId: IdentifierSchema,
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/u),
  channelId: IdentifierSchema,
  policyDigest: Sha256Schema,
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();
export type NewApiCreateTokenInput = z.infer<typeof NewApiCreateTokenInputSchema>;

export const NewApiActivateTokenInputSchema = z.object({
  idempotencyKey: IdempotencyKeySchema,
  deviceId: IdentifierSchema,
}).strict();
export type NewApiActivateTokenInput = z.infer<typeof NewApiActivateTokenInputSchema>;

export const NewApiCreateDeviceMappingInputSchema = z.object({
  idempotencyKey: IdempotencyKeySchema,
  deviceId: IdentifierSchema,
  licenseId: IdentifierSchema,
  startupSecretHash: Sha256Schema,
  startupSecretSalt: SecretSaltSchema,
  usbFingerprint: Sha256Schema,
  newApiUserId: IdentifierSchema,
  newApiUsername: UsernameSchema,
  newApiTokenId: IdentifierSchema,
  channelId: IdentifierSchema,
  policyDigest: Sha256Schema,
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  previousTokenId: IdentifierSchema.nullable(),
  status: z.literal("provisioning"),
}).strict();
export type NewApiCreateDeviceMappingInput = z.infer<typeof NewApiCreateDeviceMappingInputSchema>;

const NewApiDeviceStatusCasSchema = z.object({
  idempotencyKey: IdempotencyKeySchema,
  expectedStatus: NewApiProvisioningStatusSchema,
  expectedGeneration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  expectedLicenseId: IdentifierSchema,
  expectedTokenId: IdentifierSchema,
});
export const NewApiUpdateDeviceStatusInputSchema = z.discriminatedUnion("status", [
  NewApiDeviceStatusCasSchema.extend({ status: z.enum(["active", "disabled", "revoked"]), failure: z.undefined().optional() }).strict(),
  NewApiDeviceStatusCasSchema.extend({ status: z.literal("failed"), failure: NewApiProvisioningFailureSchema }).strict(),
]);
export type NewApiUpdateDeviceStatusInput = z.infer<typeof NewApiUpdateDeviceStatusInputSchema>;

export const NewApiRevokeTokenInputSchema = z.object({ idempotencyKey: IdempotencyKeySchema }).strict();
export type NewApiRevokeTokenInput = z.infer<typeof NewApiRevokeTokenInputSchema>;

export const NewApiAuditQuerySchema = z.object({
  deviceId: IdentifierSchema.optional(),
  cursor: z.string().regex(/^(?:0|[1-9][0-9]{0,8})$/u).nullable(),
  pageSize: z.number().int().min(1).max(100),
}).strict();
export type NewApiAuditQuery = z.infer<typeof NewApiAuditQuerySchema>;

export const NewApiAuditPageSchema = z.object({
  items: z.array(NewApiAuditEventSchema).max(100),
  nextCursor: z.string().regex(/^[1-9][0-9]{0,8}$/u).nullable(),
  hasMore: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.hasMore !== (value.nextCursor !== null)) {
    context.addIssue({ code: "custom", path: ["hasMore"], message: "Audit pagination state is inconsistent." });
  }
});
export type NewApiAuditPage = z.infer<typeof NewApiAuditPageSchema>;

export interface NewApiManagementClient {
  getServiceStatus(): Promise<BuiltinServiceStatus>;
  updateServiceStatus(input: BuiltinServiceStatusUpdate): Promise<BuiltinServiceStatus>;
  getDeviceControls(locator: BuiltinDeviceLocator): Promise<BuiltinDeviceControls>;
  updateDeviceControls(locator: BuiltinDeviceLocator, input: BuiltinDeviceControlsUpdate): Promise<BuiltinDeviceControls>;
  createUser(input: NewApiCreateUserInput): Promise<NewApiUser>;
  getUser(userId: string): Promise<NewApiUser>;
  createToken(input: NewApiCreateTokenInput): Promise<NewApiIssuedToken>;
  activateToken(tokenId: string, input: NewApiActivateTokenInput): Promise<NewApiToken>;
  createDeviceMapping(input: NewApiCreateDeviceMappingInput): Promise<NewApiDeviceMapping>;
  getDeviceMapping(deviceId: string): Promise<NewApiDeviceMapping>;
  updateDeviceStatus(deviceId: string, input: NewApiUpdateDeviceStatusInput): Promise<NewApiDeviceMapping>;
  updatePolicy(userId: string, policy: NewApiPolicy): Promise<NewApiPolicy>;
  getPolicy(userId: string): Promise<NewApiPolicy>;
  getUsage(userId: string): Promise<NewApiUsage>;
  revokeToken(tokenId: string, input: NewApiRevokeTokenInput): Promise<NewApiToken>;
  listAuditEvents(query: NewApiAuditQuery): Promise<NewApiAuditPage>;
}
