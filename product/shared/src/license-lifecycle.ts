import { z } from "zod";

import { RendererSafeTextSchema } from "./errors.js";

export const LICENSE_LIFECYCLE_CONTRACT_VERSION = 1 as const;

const IdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u);
const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u);
const TimestampSchema = z.iso.datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const SafeMessageSchema = RendererSafeTextSchema.pipe(z.string().min(1).max(300));

export const LicenseLifecycleStatusSchema = z.enum([
  "provisioning",
  "active",
  "revoked",
  "reissued",
  "expired",
  "disabled",
]);
export type LicenseLifecycleStatus = z.infer<typeof LicenseLifecycleStatusSchema>;

export const LicenseStatusSummarySchema = z.object({
  licenseId: IdentifierSchema,
  deviceId: IdentifierSchema,
  status: LicenseLifecycleStatusSchema,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  notBefore: TimestampSchema,
  expiresAt: TimestampSchema,
  replacementLicenseId: IdentifierSchema.nullable(),
  updatedAt: TimestampSchema,
}).strict().superRefine((value, context) => {
  if ((value.status === "reissued") !== (value.replacementLicenseId !== null)) {
    context.addIssue({ code: "custom", path: ["replacementLicenseId"], message: "Only reissued licenses identify a replacement." });
  }
});
export type LicenseStatusSummary = z.infer<typeof LicenseStatusSummarySchema>;

export const LicenseStatusReceiptSchema = z.object({
  value: z.string().min(32).max(8_192).regex(/^[A-Za-z0-9._~-]+$/u),
}).strict();
export type LicenseStatusReceipt = z.infer<typeof LicenseStatusReceiptSchema>;

export const LicenseStatusResponseSchema = z.object({
  status: LicenseStatusSummarySchema,
  receipt: LicenseStatusReceiptSchema,
}).strict();
export type LicenseStatusResponse = z.infer<typeof LicenseStatusResponseSchema>;

export const StartupCredentialArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  deviceId: IdentifierSchema,
  licenseId: IdentifierSchema,
  startupSecret: z.string().min(32).max(512),
}).strict();

export const StartupLicenseArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  deviceId: IdentifierSchema,
  licenseId: IdentifierSchema,
  usbFingerprint: z.object({
    scheme: z.literal("uclaw-usb-v1"),
    sha256: Sha256Schema,
  }).strict(),
  startupSecretProof: z.object({
    algorithm: z.literal("sha256-salt-v1"),
    startupSecretSalt: z.string().regex(/^[a-f0-9]{32,128}$/u).refine((value) => value.length % 2 === 0),
    startupSecretHash: Sha256Schema,
  }).strict(),
  notBefore: TimestampSchema,
  expiresAt: TimestampSchema,
  signature: z.object({
    algorithm: z.literal("ed25519"),
    keyId: IdentifierSchema,
    value: z.string().min(80).max(256),
  }).strict(),
}).strict();
export type StartupLicenseArtifact = z.infer<typeof StartupLicenseArtifactSchema>;

export const IssuedLicenseSchema = z.object({
  status: LicenseStatusSummarySchema,
  startupCredential: StartupCredentialArtifactSchema,
  license: StartupLicenseArtifactSchema,
}).strict();
export type IssuedLicense = z.infer<typeof IssuedLicenseSchema>;

export const LicenseIssueInputSchema = z.object({
  idempotencyKey: IdempotencyKeySchema,
  deviceId: IdentifierSchema,
  usbFingerprint: Sha256Schema,
  notBefore: TimestampSchema,
  expiresAt: TimestampSchema,
}).strict().superRefine((value, context) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.notBefore)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "License expiry must follow its start time." });
  }
});
export type LicenseIssueInput = z.infer<typeof LicenseIssueInputSchema>;

export const LicenseMutationInputSchema = z.object({
  idempotencyKey: IdempotencyKeySchema,
}).strict();
export type LicenseMutationInput = z.infer<typeof LicenseMutationInputSchema>;

export const LicenseReissueInputSchema = z.object({
  idempotencyKey: IdempotencyKeySchema,
  usbFingerprint: Sha256Schema,
  notBefore: TimestampSchema,
  expiresAt: TimestampSchema,
}).strict().superRefine((value, context) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.notBefore)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "License expiry must follow its start time." });
  }
});
export type LicenseReissueInput = z.infer<typeof LicenseReissueInputSchema>;

export const LicenseLifecycleErrorCategorySchema = z.enum([
  "validation",
  "conflict",
  "authentication",
  "not-found",
  "status",
  "unavailable",
  "transport",
  "invalid-response",
]);
export type LicenseLifecycleErrorCategory = z.infer<typeof LicenseLifecycleErrorCategorySchema>;

export const LicenseLifecycleErrorBodySchema = z.object({
  error: z.object({
    category: LicenseLifecycleErrorCategorySchema,
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/u),
    message: SafeMessageSchema,
    retryable: z.boolean(),
  }).strict(),
}).strict();

export const LicenseLifecycleAuditEventSchema = z.object({
  id: IdentifierSchema,
  action: z.enum([
    "license.issued",
    "license.status-queried",
    "license.revoked",
    "license.reissued",
    "request.rejected",
  ]),
  licenseId: IdentifierSchema,
  deviceId: IdentifierSchema,
  status: LicenseLifecycleStatusSchema,
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  outcome: z.enum(["succeeded", "failed"]),
  errorCategory: LicenseLifecycleErrorCategorySchema.nullable(),
  createdAt: TimestampSchema,
}).strict();
export type LicenseLifecycleAuditEvent = z.infer<typeof LicenseLifecycleAuditEventSchema>;

export interface LicenseLifecycleClient {
  issueLicense(input: LicenseIssueInput): Promise<IssuedLicense>;
  getLicenseStatus(licenseId: string): Promise<LicenseStatusResponse>;
  revokeLicense(licenseId: string, input: LicenseMutationInput): Promise<LicenseStatusResponse>;
  reissueLicense(licenseId: string, input: LicenseReissueInput): Promise<IssuedLicense>;
}
