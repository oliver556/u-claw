import { z } from "zod";

import { ControlledRelativePathSchema, ISODateTimeSchema } from "./common.js";

export const DUAL_SYSTEM_USB_LAYOUT_CONTRACT_VERSION = 1;
export const DUAL_SYSTEM_USB_TARGETS = ["win-x64", "macos-arm64"] as const;

export const DualSystemUsbTargetSchema = z.enum(DUAL_SYSTEM_USB_TARGETS);
export type DualSystemUsbTarget = z.infer<typeof DualSystemUsbTargetSchema>;

export const DualSystemUsbTargetPlatformSchema = z.enum(["win32", "darwin"]);
export const DualSystemUsbTargetArchSchema = z.enum(["x64", "arm64"]);

const HexSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const SemverLikeSchema = z.string().min(1).max(64).regex(/^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9._-]+)?$/u);
const StableIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/u);
const HardwareEvidenceStringSchema = z.string().trim().min(1).max(256);
const HardwareUUIDSchema = z.string().trim().min(8).max(64).regex(/^[A-Fa-f0-9][A-Fa-f0-9-]{6,62}[A-Fa-f0-9]$/u);

export const DualSystemUsbTargetPathsSchema = z.object({
  entry: ControlledRelativePathSchema,
  package: ControlledRelativePathSchema,
  manifest: ControlledRelativePathSchema,
  current: ControlledRelativePathSchema,
  installState: ControlledRelativePathSchema,
}).strict();
export type DualSystemUsbTargetPaths = z.infer<typeof DualSystemUsbTargetPathsSchema>;

export const DualSystemUsbManifestSchema = z.object({
  schemaVersion: z.literal(1),
  product: z.literal("U-Claw"),
  usbLayoutVersion: z.literal(1),
  minimumBootstrapVersion: SemverLikeSchema,
  dataRoot: z.literal("data"),
  licenseRoot: z.literal(".uclaw/license"),
  targets: z.object({
    "win-x64": DualSystemUsbTargetPathsSchema,
    "macos-arm64": DualSystemUsbTargetPathsSchema,
  }).strict(),
  signature: z.object({
    algorithm: z.literal("ed25519"),
    keyId: StableIdSchema,
    value: z.string().min(16).max(512),
  }).strict(),
}).strict();
export type DualSystemUsbManifest = z.infer<typeof DualSystemUsbManifestSchema>;

export const DualSystemUsbRuntimeManifestSchema = z.object({
  schemaVersion: z.literal(1),
  releaseId: StableIdSchema,
  releaseSequence: z.number().int().positive(),
  productVersion: SemverLikeSchema,
  nodeVersion: SemverLikeSchema,
  electronVersion: SemverLikeSchema,
  runtimeVersion: SemverLikeSchema,
  runtimeId: StableIdSchema,
  target: DualSystemUsbTargetSchema,
  targetPlatform: DualSystemUsbTargetPlatformSchema,
  targetArch: DualSystemUsbTargetArchSchema,
  runtimeArchive: z.literal("runtime.pkg"),
  runtimeSha256: HexSha256Schema,
  runtimeTreeSha256: HexSha256Schema,
  runtimeBytes: z.number().int().positive(),
  unpackedBytes: z.number().int().positive(),
  fileCount: z.number().int().positive(),
  entrypoint: ControlledRelativePathSchema,
  entryArgs: z.array(z.string().min(1).max(256)).max(16),
  criticalFiles: z.array(z.object({
    path: ControlledRelativePathSchema,
    size: z.number().int().positive(),
    sha256: HexSha256Schema,
  }).strict()).min(1),
}).strict();
export type DualSystemUsbRuntimeManifest = z.infer<typeof DualSystemUsbRuntimeManifestSchema>;

export const DualSystemUsbCurrentSchema = z.object({
  schemaVersion: z.literal(1),
  target: DualSystemUsbTargetSchema,
  releaseId: StableIdSchema,
  releaseSequence: z.number().int().positive(),
  runtimeId: StableIdSchema,
  manifest: ControlledRelativePathSchema,
  package: ControlledRelativePathSchema,
  installedAt: ISODateTimeSchema,
}).strict();
export type DualSystemUsbCurrent = z.infer<typeof DualSystemUsbCurrentSchema>;

export const DualSystemUsbInstallStateSchema = z.object({
  schemaVersion: z.literal(1),
  target: DualSystemUsbTargetSchema,
  transactionId: StableIdSchema,
  state: z.enum(["idle", "installing", "completed", "failed"]),
  releaseId: StableIdSchema,
  releaseSequence: z.number().int().positive(),
  manifest: ControlledRelativePathSchema,
  package: ControlledRelativePathSchema,
  updatedAt: ISODateTimeSchema,
  errorCategory: z.string().min(1).max(128).optional(),
}).strict();
export type DualSystemUsbInstallState = z.infer<typeof DualSystemUsbInstallStateSchema>;

export const DualSystemUsbSharedDataSchema = z.object({
  root: z.literal("data"),
  requiredSubdirs: z.array(ControlledRelativePathSchema).min(3),
  environment: z.object({
    UCLAW_USB_ROOT: z.literal("<usb-root>"),
    UCLAW_DATA_DIR: z.literal("<usb-root>/data"),
    UCLAW_OPENCLAW_HOME: z.literal("<usb-root>/data/.openclaw"),
    OPENCLAW_HOME: z.literal("<usb-root>/data"),
    OPENCLAW_STATE_DIR: z.literal("<usb-root>/data/.openclaw"),
  }).strict(),
  legacyReadonlyProbe: z.literal(".uclaw/data"),
  firstWriteRoot: z.literal("data"),
}).strict();
export type DualSystemUsbSharedData = z.infer<typeof DualSystemUsbSharedDataSchema>;

export const DualSystemUsbLicenseIdentitySchema = z.object({
  root: z.literal(".uclaw/license"),
  bindingScope: z.literal("physical-usb"),
  sharedFiles: z.array(z.enum(["license.json", ".startup-credential.json", ".lifecycle-cache.json"])).length(3),
  forbiddenUniqueFields: z.array(z.enum(["volumeName", "mountPath", "driveLetter"])).min(3),
  serverMapping: z.object({
    fingerprintVersion: z.literal(2),
    deviceAliasesRequired: z.literal(true),
  }).strict(),
}).strict();
export type DualSystemUsbLicenseIdentity = z.infer<typeof DualSystemUsbLicenseIdentitySchema>;

export const DualSystemUsbFingerprintSchemeSchema = z.enum(["uclaw-usb-v1", "uclaw-usb-v2"]);
export type DualSystemUsbFingerprintScheme = z.infer<typeof DualSystemUsbFingerprintSchemeSchema>;

export const DualSystemUsbIdentityEvidenceSchema = z.discriminatedUnion("target", [
  z.object({
    target: z.literal("win-x64"),
    platform: z.literal("win32"),
    arch: z.literal("x64"),
    source: z.literal("windows-storage-descriptor"),
    busType: z.literal("USB"),
    vendor: HardwareEvidenceStringSchema,
    product: HardwareEvidenceStringSchema,
    revision: HardwareEvidenceStringSchema.optional(),
    serial: HardwareEvidenceStringSchema,
    capacityBytes: z.number().int().positive(),
    uniqueDescriptorSha256: HexSha256Schema.optional(),
  }).strict(),
  z.object({
    target: z.literal("macos-arm64"),
    platform: z.literal("darwin"),
    arch: z.literal("arm64"),
    source: z.literal("macos-diskutil"),
    busProtocol: z.literal("USB"),
    deviceLocation: z.enum(["external", "removable", "ejectable"]),
    vendor: HardwareEvidenceStringSchema,
    product: HardwareEvidenceStringSchema,
    revision: HardwareEvidenceStringSchema.optional(),
    serial: HardwareEvidenceStringSchema,
    capacityBytes: z.number().int().positive(),
    volumeUuid: HardwareUUIDSchema,
    mediaUuid: HardwareUUIDSchema.optional(),
  }).strict(),
]);
export type DualSystemUsbIdentityEvidence = z.infer<typeof DualSystemUsbIdentityEvidenceSchema>;

export const DualSystemUsbDeviceAliasSchema = z.object({
  fingerprint: z.object({
    version: DualSystemUsbFingerprintSchemeSchema,
    sha256: HexSha256Schema,
  }).strict(),
  target: DualSystemUsbTargetSchema,
  evidence: DualSystemUsbIdentityEvidenceSchema,
}).strict().superRefine((value, context) => {
  if (value.target !== value.evidence.target) {
    context.addIssue({ code: "custom", path: ["evidence", "target"], message: "Alias target must match evidence target." });
  }
});
export type DualSystemUsbDeviceAlias = z.infer<typeof DualSystemUsbDeviceAliasSchema>;

export const DualSystemUsbLicenseDeviceMappingInputSchema = z.object({
  schemaVersion: z.literal(1),
  fingerprintVersion: z.literal(2),
  deviceId: StableIdSchema.optional(),
  licenseId: StableIdSchema.optional(),
  deviceAliases: z.array(DualSystemUsbDeviceAliasSchema).min(1).max(4),
}).strict().superRefine((value, context) => {
  const targets = new Set(value.deviceAliases.map((alias) => alias.target));
  if (targets.size !== value.deviceAliases.length) {
    context.addIssue({ code: "custom", path: ["deviceAliases"], message: "Device aliases must be target-distinct." });
  }
});
export type DualSystemUsbLicenseDeviceMappingInput = z.infer<typeof DualSystemUsbLicenseDeviceMappingInputSchema>;

export const DualSystemUsbLayoutFixtureSchema = z.object({
  contractVersion: z.literal(DUAL_SYSTEM_USB_LAYOUT_CONTRACT_VERSION),
  rootName: z.literal("U-Claw"),
  expectedTopLevelEntries: z.array(z.enum(["U-Claw.exe", "U-Claw.app", "app", "data", ".uclaw"])).length(5),
  usbManifest: DualSystemUsbManifestSchema,
  runtimeManifests: z.object({
    "win-x64": DualSystemUsbRuntimeManifestSchema,
    "macos-arm64": DualSystemUsbRuntimeManifestSchema,
  }).strict(),
  current: z.object({
    "win-x64": DualSystemUsbCurrentSchema,
    "macos-arm64": DualSystemUsbCurrentSchema,
  }).strict(),
  installState: z.object({
    "win-x64": DualSystemUsbInstallStateSchema,
    "macos-arm64": DualSystemUsbInstallStateSchema,
  }).strict(),
  sharedData: DualSystemUsbSharedDataSchema,
  licenseIdentity: DualSystemUsbLicenseIdentitySchema,
}).strict();
export type DualSystemUsbLayoutFixture = z.infer<typeof DualSystemUsbLayoutFixtureSchema>;

export const DualSystemUsbAcceptanceMatrixSchema = z.object({
  contractVersion: z.literal(DUAL_SYSTEM_USB_LAYOUT_CONTRACT_VERSION),
  requiredHostMatrix: z.array(z.object({
    id: StableIdSchema,
    osFamily: z.enum(["windows-10", "windows-11", "macos"]),
    arch: z.enum(["x64", "arm64"]),
    target: DualSystemUsbTargetSchema.optional(),
    role: z.enum(["single-target", "cross-os"]),
  }).strict()).min(3),
  cases: z.array(z.object({
    id: StableIdSchema,
    category: z.string().min(1).max(64).regex(/^[a-z-]+$/u),
    target: z.union([DualSystemUsbTargetSchema, z.literal("shared"), z.literal("cross-os")]),
    title: z.string().min(1).max(200),
    pass: z.array(z.string().min(1).max(500)).min(1),
  }).strict()).min(1),
}).strict();
export type DualSystemUsbAcceptanceMatrix = z.infer<typeof DualSystemUsbAcceptanceMatrixSchema>;
