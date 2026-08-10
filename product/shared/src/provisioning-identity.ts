import { z } from "zod";

const IdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u);
const UsernameSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/u);
const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const TimestampSchema = z.iso.datetime({ offset: true });
const ModelSchema = z.string().trim().min(1).max(160);

const EndpointSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const loopback = new Set(["localhost", "127.0.0.1", "::1"]).has(hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      || url.username || url.password || url.search || url.hash) {
    context.addIssue({ code: "custom", message: "Provisioning endpoint must use HTTPS or exact loopback HTTP." });
  }
});

export const ProvisioningIdentityInputSchema = z.object({
  idempotencyKey: IdempotencyKeySchema,
  deviceId: IdentifierSchema,
  usbFingerprint: Sha256Schema,
  username: UsernameSchema,
  channelId: IdentifierSchema,
  endpoint: EndpointSchema,
  model: ModelSchema,
  notBefore: TimestampSchema,
  expiresAt: TimestampSchema,
}).strict().superRefine((value, context) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.notBefore)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "Provisioning expiry must follow its start time." });
  }
});
export type ProvisioningIdentityInput = z.infer<typeof ProvisioningIdentityInputSchema>;

export const ProvisioningBindingSchema = z.object({
  deviceId: IdentifierSchema,
  usbFingerprint: Sha256Schema,
  licenseId: IdentifierSchema,
  newApiUserId: IdentifierSchema,
  newApiUsername: UsernameSchema,
  newApiTokenId: IdentifierSchema,
  channelId: IdentifierSchema,
}).strict();
export type ProvisioningBinding = z.infer<typeof ProvisioningBindingSchema>;

export const ProvisioningIdentityResultSchema = ProvisioningBindingSchema.extend({
  transactionId: IdentifierSchema,
  endpoint: EndpointSchema,
  model: ModelSchema,
  status: z.enum(["active", "disabled", "revoked"]),
}).strict();
export type ProvisioningIdentityResult = z.infer<typeof ProvisioningIdentityResultSchema>;

export const ProvisioningJournalStageSchema = z.enum([
  "started",
  "license-issued",
  "user-created",
  "token-created",
  "mapping-pending",
  "mapping-created",
  "artifacts-written",
  "active",
  "compensating",
  "failed",
  "compensation-pending",
  "revoking",
  "revoked",
  "disabling",
  "disabled",
  "reissuing",
]);
export type ProvisioningJournalStage = z.infer<typeof ProvisioningJournalStageSchema>;

const CompensationStepSchema = z.enum(["not-needed", "pending", "succeeded"]);
const ReissueLifecycleSchema = z.object({
  action: z.literal("reissue"),
  requestHash: Sha256Schema,
  sourceBinding: ProvisioningBindingSchema,
  target: z.object({
    usbFingerprint: Sha256Schema,
    notBefore: TimestampSchema,
    expiresAt: TimestampSchema,
  }).strict(),
  targetGeneration: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
  phase: z.enum(["started", "source-revoked", "artifacts-cleaned", "replacement-issued", "active"]),
}).strict();
export const ProvisioningJournalSchema = z.object({
  schemaVersion: z.literal(1),
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  licenseOperation: z.enum(["issue", "reissue"]),
  licenseSourceId: IdentifierSchema.nullable(),
  transactionId: IdentifierSchema,
  requestHash: Sha256Schema,
  mappedTokenId: IdentifierSchema.nullable(),
  previousTokenId: IdentifierSchema.nullable(),
  binding: ProvisioningBindingSchema.partial().required({ deviceId: true, usbFingerprint: true, channelId: true }),
  endpoint: EndpointSchema,
  model: ModelSchema,
  stage: ProvisioningJournalStageSchema,
  failureCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/u).nullable(),
  compensation: z.object({
    mapping: CompensationStepSchema,
    token: CompensationStepSchema,
    license: CompensationStepSchema,
    artifacts: CompensationStepSchema,
  }).strict(),
  lifecycle: ReissueLifecycleSchema.nullable().default(null),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().superRefine((value, context) => {
  if ((value.licenseOperation === "reissue") !== (value.licenseSourceId !== null)) {
    context.addIssue({ code: "custom", path: ["licenseSourceId"], message: "Reissue requires an immutable source license." });
  }
});
export type ProvisioningJournal = z.infer<typeof ProvisioningJournalSchema>;

const LifecycleBaseSchema = z.object({
  idempotencyKey: IdempotencyKeySchema,
  binding: ProvisioningBindingSchema,
});

export const ProvisioningLifecycleActionSchema = z.discriminatedUnion("action", [
  LifecycleBaseSchema.extend({ action: z.literal("revoke") }).strict(),
  LifecycleBaseSchema.extend({ action: z.literal("disable") }).strict(),
  LifecycleBaseSchema.extend({
    action: z.literal("reissue"),
    usbFingerprint: Sha256Schema,
    notBefore: TimestampSchema,
    expiresAt: TimestampSchema,
  }).strict().superRefine((value, context) => {
    if (Date.parse(value.expiresAt) <= Date.parse(value.notBefore)) {
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "Reissue expiry must follow its start time." });
    }
  }),
]);
export type ProvisioningLifecycleAction = z.infer<typeof ProvisioningLifecycleActionSchema>;
