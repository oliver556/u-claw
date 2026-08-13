import { z } from "zod";

import {
  StartupCredentialArtifactSchema,
  StartupLicenseArtifactSchema,
} from "./license-lifecycle.js";

export const ACTIVATION_CONTRACT_VERSION = 1 as const;

const IdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u);
const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const SemverSchema = z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);
const SecureModelEndpointPattern = /^[Hh][Tt][Tt][Pp][Ss]:\/\/(?:\[[0-9A-Fa-f:.]+\]|[^/?#@[\]\\\u0000-\u0020\u007F:]+)(?::[0-9]+)?(?:\/[^?#@\\\u0000-\u0020\u007F]*)?$/u;

const isSecureModelEndpoint = (value: string): boolean => {
  if (!SecureModelEndpointPattern.test(value)) return false;

  try {
    const endpoint = new URL(value);
    return endpoint.protocol === "https:"
      && endpoint.host !== ""
      && endpoint.username === ""
      && endpoint.password === "";
  } catch {
    return false;
  }
};

const SecureModelEndpointSchema = z.string().refine(isSecureModelEndpoint, {
  message: "Model endpoint must be an absolute HTTPS URL without userinfo, query, or fragment.",
});

export const normalizeActivationCodeInput = (value: string): string => value.replaceAll("-", "").toUpperCase();

export const ActivationCodeSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
export type ActivationCode = z.infer<typeof ActivationCodeSchema>;

export const ActivationRequestSchema = z.object({
  activationCode: ActivationCodeSchema,
  usbFingerprint: z.object({
    version: z.literal("uclaw-usb-v1"),
    sha256: Sha256Schema,
  }).strict(),
  clientVersion: SemverSchema,
  idempotencyKey: IdempotencyKeySchema,
}).strict();
export type ActivationRequest = z.infer<typeof ActivationRequestSchema>;

export const BuiltinCredentialArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  deviceId: IdentifierSchema,
  licenseId: IdentifierSchema,
  endpoint: SecureModelEndpointSchema,
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u),
  deviceToken: z.string().regex(/^uclaw_dt_[A-Za-z0-9_-]{43}$/u),
}).strict();
export type BuiltinCredentialArtifact = z.infer<typeof BuiltinCredentialArtifactSchema>;

export const ActivationResponseSchema = z.object({
  activationId: IdentifierSchema,
  deviceId: IdentifierSchema,
  licenseId: IdentifierSchema,
  license: StartupLicenseArtifactSchema,
  startupCredential: StartupCredentialArtifactSchema,
  builtinCredential: BuiltinCredentialArtifactSchema,
  status: z.literal("active"),
}).strict().superRefine((value, context) => {
  for (const [field, artifact] of [
    ["license", value.license],
    ["startupCredential", value.startupCredential],
    ["builtinCredential", value.builtinCredential],
  ] as const) {
    if (artifact.deviceId !== value.deviceId) {
      context.addIssue({ code: "custom", path: [field, "deviceId"], message: "Artifact device ID must match response." });
    }
    if (artifact.licenseId !== value.licenseId) {
      context.addIssue({ code: "custom", path: [field, "licenseId"], message: "Artifact license ID must match response." });
    }
  }
});
export type ActivationResponse = z.infer<typeof ActivationResponseSchema>;

export const ActivationCommitSchema = z.object({
  idempotencyKey: IdempotencyKeySchema,
  artifactGeneration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();
export type ActivationCommit = z.infer<typeof ActivationCommitSchema>;

export const DeviceTokenRequestSchema = z.object({
  deviceId: IdentifierSchema,
  licenseId: IdentifierSchema,
  idempotencyKey: IdempotencyKeySchema,
}).strict();
export type DeviceTokenRequest = z.infer<typeof DeviceTokenRequestSchema>;

export const DeviceTokenResponseSchema = z.object({
  accessToken: z.string().min(16).max(8_192),
  tokenType: z.literal("Bearer"),
  expiresAt: z.iso.datetime({ offset: true }),
}).strict();
export type DeviceTokenResponse = z.infer<typeof DeviceTokenResponseSchema>;

export const ActivationStageSchema = z.enum([
  "requested",
  "server_bound",
  "committed",
  "failed_before_bind",
]);
export type ActivationStage = z.infer<typeof ActivationStageSchema>;

export const ActivationErrorSchema = z.object({
  requestId: IdentifierSchema,
  activationId: IdentifierSchema.nullable(),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/u),
  stage: ActivationStageSchema.nullable(),
  retryable: z.boolean(),
  supportCode: z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,31}$/u),
}).strict();
export type ActivationError = z.infer<typeof ActivationErrorSchema>;

export const ClientPolicySchema = z.object({
  minimumClientVersion: SemverSchema,
  upgradeRequired: z.boolean(),
  feedUrl: z.literal("https://updates.u-claw.org/releases/"),
}).strict();
export type ClientPolicy = z.infer<typeof ClientPolicySchema>;

export const AdminOperationSchema = z.object({
  operatorId: IdentifierSchema,
  requestId: IdentifierSchema,
  idempotencyKey: IdempotencyKeySchema,
  reason: z.string().trim().min(3).max(512),
}).strict();
export type AdminOperation = z.infer<typeof AdminOperationSchema>;

export const AdminInventoryLocatorSchema = z.object({ inventoryId: IdentifierSchema.optional(), username: IdentifierSchema.optional(), deviceId: IdentifierSchema.optional() })
  .strict().refine((value) => [value.inventoryId, value.username, value.deviceId].filter(Boolean).length === 1);
export const AdminInventorySummarySchema = z.object({
  inventoryId: IdentifierSchema, username: IdentifierSchema,
  status: z.enum(["prepared", "binding", "active", "revoked"]),
  newApiSetupStatus: z.enum(["pending", "configured", "suspended"]),
  deviceId: IdentifierSchema.nullable(), licenseId: IdentifierSchema.nullable(),
}).strict();
export const AdminInventorySecretSchema = z.object({ inventoryId: IdentifierSchema, username: z.string(), activationCode: ActivationCodeSchema }).strict();
export const AdminInventoryGenerateSchema = AdminOperationSchema.extend({ count: z.number().int().min(1).max(10_000) }).strict();
export const AdminInventoryImportRecordSchema = z.object({ username: IdentifierSchema, activationCode: ActivationCodeSchema, newApiUserId: IdentifierSchema, newApiUsername: IdentifierSchema, policyDigest: Sha256Schema }).strict();
export const AdminInventoryImportSchema = AdminOperationSchema.extend({ records: z.array(AdminInventoryImportRecordSchema).min(1).max(10_000) }).strict();
export const AdminLicenseMutationSchema = AdminOperationSchema.extend({ confirmTarget: Sha256Schema }).strict();
export const AdminMutationResultSchema = z.object({ licenseId: IdentifierSchema, status: z.enum(["active", "disabled", "revoked", "reissued"]), revision: z.number().int().min(1), replacementInventoryId: IdentifierSchema.nullable() }).strict();
export const AdminReissueResponseSchema = z.object({ licenseId: IdentifierSchema, status: z.literal("reissued"), revision: z.number().int().min(1), replacementInventoryId: IdentifierSchema, username: z.string(), activationCode: ActivationCodeSchema }).strict();
export const AdminAuditEventSchema = z.object({ eventId: IdentifierSchema, actorId: z.string(), action: z.string(), outcome: z.enum(["succeeded", "failed"]), inventoryId: IdentifierSchema.nullable(), deviceId: IdentifierSchema.nullable(), licenseId: IdentifierSchema.nullable(), requestId: IdentifierSchema, reason: z.string().nullable(), idempotencyKey: IdempotencyKeySchema.nullable(), createdAt: z.iso.datetime() }).strict();
export const AdminAuditPageSchema = z.object({ items: z.array(AdminAuditEventSchema).max(500), nextBefore: z.string().min(1).max(512).nullable() }).strict();
export const AdminMarkConfiguredSchema = AdminOperationSchema.extend({ balanceStatus: z.literal("configured") }).strict();
