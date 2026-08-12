import { z } from "zod";

import { ISODateTimeSchema } from "./common.js";
import { UClawErrorSchema } from "./errors.js";

const RequestIdSchema = z.string().min(1).max(128);
const TokenSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._-]+$/);
const UpdateIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
export const ReleaseChannelSchema = z.enum(["stable", "beta"]);
export const ReleaseCompatibilitySchema = z.object({
  platform: z.literal("win32"), arch: z.literal("x64"), runtimeId: z.string().min(1).max(128),
}).strict();
export const ReleaseUpdateSchema = z.object({
  id: UpdateIdSchema, version: z.string().min(1).max(128), channel: ReleaseChannelSchema,
  publishedAt: ISODateTimeSchema, notes: z.array(z.string().min(1).max(2_000)).max(50),
  compatibility: ReleaseCompatibilitySchema, bytes: z.number().int().positive(), mandatory: z.boolean(),
  previewToken: TokenSchema,
}).strict();
export type ReleaseUpdate = z.infer<typeof ReleaseUpdateSchema>;

export const ReleaseCheckResultSchema = z.object({
  state: z.enum(["current", "available", "offline", "unavailable", "timeout", "cancelled"]),
  checkedAt: ISODateTimeSchema, currentVersion: z.string().min(1), channel: ReleaseChannelSchema,
  update: ReleaseUpdateSchema.optional(), retryable: z.boolean().optional(), message: z.string().max(500).optional(),
}).strict();
export type ReleaseCheckResult = z.infer<typeof ReleaseCheckResultSchema>;

export const ReleaseOperationSchema = z.object({
  id: UpdateIdSchema, kind: z.enum(["install", "uninstall"]),
  state: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  phase: z.enum(["queued", "downloading", "verifying", "switching", "cleaning", "completed", "failed", "cancelled"]),
  processedItems: z.number().int().nonnegative(), totalItems: z.number().int().nonnegative(),
  partialFailures: z.number().int().nonnegative(), message: z.string().max(500),
  recovery: z.enum(["none", "rolled-back", "recovery-required"]),
}).strict();
export type ReleaseOperation = z.infer<typeof ReleaseOperationSchema>;

export const UninstallPreviewSchema = z.object({
  previewToken: TokenSchema,
  scopes: z.array(z.object({
    id: z.enum(["application", "usb-user-data", "host-cache"]), label: z.string().min(1),
    selected: z.boolean(), protected: z.boolean(), available: z.boolean(), detail: z.string().min(1).max(500),
  }).strict()).length(3),
}).strict();
export type UninstallPreview = z.infer<typeof UninstallPreviewSchema>;
export const ReleaseRollbackPreviewSchema = z.object({
  available: z.boolean(), previewToken: TokenSchema, version: z.string().min(1).max(128).optional(),
}).strict();
export type ReleaseRollbackPreview = z.infer<typeof ReleaseRollbackPreviewSchema>;
export const ReleaseRollbackResultSchema = z.object({
  state: z.literal("rolled-back"), version: z.string().min(1).max(128), message: z.string().min(1).max(500),
}).strict();
export type ReleaseRollbackResult = z.infer<typeof ReleaseRollbackResultSchema>;

export const ReleaseIpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("release.check"), requestId: RequestIdSchema, params: z.object({ channel: ReleaseChannelSchema }).strict() }).strict(),
  z.object({ method: z.literal("release.retry"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("release.cancel-check"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("release.install"), requestId: RequestIdSchema, params: z.object({ updateId: UpdateIdSchema, previewToken: TokenSchema, confirmed: z.literal(true) }).strict() }).strict(),
  z.object({ method: z.literal("release.operation"), requestId: RequestIdSchema, params: z.object({ operationId: UpdateIdSchema }).strict() }).strict(),
  z.object({ method: z.literal("release.cancel"), requestId: RequestIdSchema, params: z.object({ operationId: UpdateIdSchema }).strict() }).strict(),
  z.object({ method: z.literal("release.recovery"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("release.rollback-preview"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("release.rollback"), requestId: RequestIdSchema, params: z.object({ previewToken: TokenSchema, confirmed: z.literal(true) }).strict() }).strict(),
  z.object({ method: z.literal("uninstall.preview"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("uninstall.execute"), requestId: RequestIdSchema, params: z.object({ scopeIds: z.array(z.enum(["host-cache"])).min(1).max(1), previewToken: TokenSchema, confirmed: z.literal(true) }).strict() }).strict(),
]);
export type ReleaseIpcRequest = z.infer<typeof ReleaseIpcRequestSchema>;

const success = (method: z.ZodLiteral<string>, result: z.ZodType) => z.object({ method, requestId: RequestIdSchema, ok: z.literal(true), result }).strict();
const methods = ["release.check", "release.retry", "release.cancel-check", "release.install", "release.operation", "release.cancel", "release.recovery", "release.rollback-preview", "release.rollback", "uninstall.preview", "uninstall.execute"] as const;
export const ReleaseIpcResponseSchema = z.union([
  success(z.literal("release.check"), ReleaseCheckResultSchema), success(z.literal("release.retry"), ReleaseCheckResultSchema),
  success(z.literal("release.cancel-check"), ReleaseCheckResultSchema), success(z.literal("release.install"), ReleaseOperationSchema),
  success(z.literal("release.operation"), ReleaseOperationSchema), success(z.literal("release.cancel"), ReleaseOperationSchema),
  success(z.literal("release.recovery"), z.object({ state: z.enum(["clean", "rolled-back", "recovery-required"]), message: z.string().max(500) }).strict()),
  success(z.literal("release.rollback-preview"), ReleaseRollbackPreviewSchema), success(z.literal("release.rollback"), ReleaseRollbackResultSchema),
  success(z.literal("uninstall.preview"), UninstallPreviewSchema), success(z.literal("uninstall.execute"), ReleaseOperationSchema),
  z.object({ method: z.enum(methods), requestId: RequestIdSchema, ok: z.literal(false), error: UClawErrorSchema }).strict(),
]);
export type ReleaseIpcResponse = z.infer<typeof ReleaseIpcResponseSchema>;
export interface ReleaseBridge { invoke(request: ReleaseIpcRequest): Promise<ReleaseIpcResponse> }
