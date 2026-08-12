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

export const normalizeActivationCodeInput = (value: string): string => value.replaceAll("-", "").toUpperCase();

export const ActivationCodeSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
export type ActivationCode = z.infer<typeof ActivationCodeSchema>;

export const ActivationRequestSchema = z.object({
  username: z.string().trim().min(3).max(128),
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
  accessToken: z.string().min(16).max(8_192),
  expiresAt: z.iso.datetime({ offset: true }),
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
  latestClientVersion: SemverSchema,
  upgradeRequired: z.boolean(),
  statusRefreshSeconds: z.number().int().min(1).max(86_400),
  maximumOfflineGraceSeconds: z.number().int().min(0).max(86_400),
}).strict();
export type ClientPolicy = z.infer<typeof ClientPolicySchema>;
