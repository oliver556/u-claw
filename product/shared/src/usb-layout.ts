import { z } from "zod";

import { ISODateTimeSchema } from "./common.js";
import { RuntimeTargetSchema } from "./runtime-target.js";

const RelativePathSchema = z.string().min(1).max(32767).refine((value) => {
  if (value.startsWith("/") || value.startsWith("\\") || value.includes("\0")) return false;
  return value.replaceAll("\\", "/").split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}, "expected a safe relative path");

const RuntimeTargetLayoutSchema = z.object({
  entry: RelativePathSchema,
  package: RelativePathSchema,
  manifest: RelativePathSchema,
  current: RelativePathSchema,
  installState: RelativePathSchema,
}).strict();

export const UsbManifestSchema = z.object({
  schemaVersion: z.literal(1),
  product: z.literal("U-Claw"),
  usbLayoutVersion: z.literal(1),
  minimumBootstrapVersion: z.string().min(1).max(128),
  dataRoot: z.literal("data"),
  licenseRoot: z.literal(".uclaw/license"),
  targets: z.object({
    "win-x64": RuntimeTargetLayoutSchema,
    "macos-arm64": RuntimeTargetLayoutSchema,
  }).strict(),
  signature: z.object({
    algorithm: z.literal("ed25519"),
    keyId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
    value: z.string().min(86).max(88),
  }).strict(),
}).strict();
export type UsbManifest = z.infer<typeof UsbManifestSchema>;

export const TargetRuntimeCurrentSchema = z.object({
  schemaVersion: z.literal(1),
  target: RuntimeTargetSchema,
  releaseId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  releaseSequence: z.number().int().positive(),
  runtimeId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  runtimeSha256: z.string().regex(/^[A-Fa-f0-9]{64}$/),
  installedAt: ISODateTimeSchema,
}).strict();
export type TargetRuntimeCurrent = z.infer<typeof TargetRuntimeCurrentSchema>;

export const TargetInstallStateSchema = z.object({
  schemaVersion: z.literal(1),
  target: RuntimeTargetSchema,
  state: z.enum(["idle", "downloading", "verifying", "switching", "complete", "failed"]),
  releaseId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/).optional(),
  releaseSequence: z.number().int().positive().optional(),
  runtimeId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/).optional(),
  startedAt: ISODateTimeSchema,
  updatedAt: ISODateTimeSchema,
  message: z.string().max(500).optional(),
}).strict();
export type TargetInstallState = z.infer<typeof TargetInstallStateSchema>;
