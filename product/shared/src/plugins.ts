import { z } from "zod";

import { CapabilityPermissionSchema, CapabilityRiskSchema } from "./capabilities.js";
import { RendererSafeTextSchema, redactRendererValue, UClawErrorSchema } from "./errors.js";

export const LOCKED_OPENCLAW_VERSION = "2026.7.1-2";

export const PluginSourceSchema = z.object({
  provider: z.enum(["fixture", "bundled", "external"]),
  url: z.url().refine((value) => value.startsWith("https://"), "Plugin source must use HTTPS."),
  packaged: z.boolean(),
}).strict();

export const PluginCompatibilitySchema = z.object({
  state: z.enum(["compatible", "incompatible", "unknown"]),
  openClawVersion: z.string().min(1),
  reason: z.string().max(500).optional(),
}).strict();

const PluginCatalogBaseSchema = z.object({
  packageKind: z.literal("plugin"),
  slug: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),
  name: z.string().min(1).max(120),
  description: z.string().max(1_000),
  version: z.string().min(1).max(80),
  installedVersion: z.string().nullable(),
  enabled: z.boolean(),
  updateAvailable: z.boolean(),
  source: PluginSourceSchema,
  integritySha256: z.string().regex(/^[a-f0-9]{64}$/),
  integrityVerified: z.boolean(),
  managedByUClaw: z.boolean(),
  availability: z.enum(["available", "installable", "unpackaged", "incompatible"]),
  compatibility: PluginCompatibilitySchema,
  permissions: z.array(CapabilityPermissionSchema).max(64),
  permissionFingerprint: z.string().min(1).max(128),
  risk: CapabilityRiskSchema,
  nativeCode: z.boolean(),
  commandExecution: z.boolean(),
  mode: z.enum(["fixture", "live"]),
}).strict();

export const PluginCatalogItemSchema = PluginCatalogBaseSchema;
export type PluginCatalogItem = z.infer<typeof PluginCatalogItemSchema>;

export const PluginDetailSchema = PluginCatalogBaseSchema.extend({
  manifest: z.object({
    id: z.string().min(1),
    configSchema: z.record(z.string(), z.unknown()),
    packageName: z.string().min(1),
    entry: z.string().min(1),
    minHostVersion: z.string().min(1),
    pluginApi: z.string().min(1),
  }).strict().nullable(),
}).strict();
export type PluginDetail = z.infer<typeof PluginDetailSchema>;

export const PluginCatalogPageSchema = z.object({
  items: z.array(PluginCatalogItemSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  mode: z.enum(["fixture", "live"]),
  repositoryVerified: z.boolean(),
}).strict();
export type PluginCatalogPage = z.infer<typeof PluginCatalogPageSchema>;

export const PluginConfirmationSchema = z.object({
  permissionFingerprint: z.string().min(1).max(128),
  acceptedRisk: CapabilityRiskSchema,
}).strict();
export type PluginConfirmation = z.infer<typeof PluginConfirmationSchema>;

export const PluginOperationSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  action: z.enum(["install", "update", "uninstall", "enable", "disable"]),
  state: z.enum(["queued", "running", "succeeded", "failed", "recovered"]),
  progress: z.number().int().min(0).max(100),
  phase: z.enum(["queued", "downloading", "validating", "staging", "replacing", "persisting", "complete", "rollback", "failed"]),
  error: z.string().max(500).optional(),
}).strict();
export type PluginOperation = z.infer<typeof PluginOperationSchema>;

export const PluginUiDescriptorSchema = z.object({
  id: z.string().trim().min(1).max(120),
  pluginId: z.string().trim().min(1).max(120),
  pluginName: RendererSafeTextSchema.pipe(z.string().max(120)).optional(),
  surface: z.enum(["session", "tool", "run", "settings"]),
  label: RendererSafeTextSchema.pipe(z.string().min(1).max(120)),
  description: RendererSafeTextSchema.pipe(z.string().max(500)).optional(),
  placement: z.string().trim().max(120).optional(),
  schema: z.unknown().optional(),
  requiredScopes: z.array(z.string().trim().min(1).max(120)).max(16).optional(),
}).strict();
export type PluginUiDescriptor = z.infer<typeof PluginUiDescriptorSchema>;

const PluginActionPayloadSchema = z.json().refine(
  (value) => JSON.stringify(value).length <= 65_536,
  "Plugin action payload exceeds limit.",
);
export const PluginSessionActionResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    result: z.unknown().transform((value) => redactRendererValue(value)).optional(),
    continueAgent: z.boolean().optional(),
    reply: z.unknown().transform((value) => redactRendererValue(value)).optional(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    error: RendererSafeTextSchema.pipe(z.string().min(1).max(500)),
    code: z.string().trim().min(1).max(80).optional(),
    details: z.unknown().transform((value) => redactRendererValue(value)).optional(),
  }).strict(),
]);
export type PluginSessionActionResult = z.infer<typeof PluginSessionActionResultSchema>;

const RequestIdSchema = z.string().min(1);
const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/);
const MutationParamsSchema = z.object({
  slug: SlugSchema,
  confirmation: PluginConfirmationSchema.nullable(),
}).strict();

export const PluginIpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("plugins.search"), requestId: RequestIdSchema, params: z.object({ query: z.string().max(120), cursor: z.string().nullable(), pageSize: z.number().int().min(1).max(50) }).strict() }).strict(),
  z.object({ method: z.literal("plugins.installed"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("plugins.detail"), requestId: RequestIdSchema, params: z.object({ slug: SlugSchema }).strict() }).strict(),
  z.object({ method: z.literal("plugins.install"), requestId: RequestIdSchema, params: MutationParamsSchema }).strict(),
  z.object({ method: z.literal("plugins.update"), requestId: RequestIdSchema, params: MutationParamsSchema }).strict(),
  z.object({ method: z.literal("plugins.uninstall"), requestId: RequestIdSchema, params: z.object({ slug: SlugSchema }).strict() }).strict(),
  z.object({ method: z.literal("plugins.set-enabled"), requestId: RequestIdSchema, params: MutationParamsSchema.extend({ enabled: z.boolean() }).strict() }).strict(),
  z.object({ method: z.literal("plugins.operation"), requestId: RequestIdSchema, params: z.object({ operationId: z.string().min(1) }).strict() }).strict(),
  z.object({ method: z.literal("plugins.ui-descriptors"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("plugins.session-action"), requestId: RequestIdSchema, params: z.object({
    pluginId: SlugSchema,
    actionId: z.string().trim().min(1).max(120),
    sessionKey: z.string().trim().min(1).max(500).optional(),
    payload: PluginActionPayloadSchema.optional(),
  }).strict() }).strict(),
]);
export type PluginIpcRequest = z.infer<typeof PluginIpcRequestSchema>;

const PluginSuccessResponseSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("plugins.search"), requestId: RequestIdSchema, ok: z.literal(true), result: PluginCatalogPageSchema }).strict(),
  z.object({ method: z.literal("plugins.installed"), requestId: RequestIdSchema, ok: z.literal(true), result: z.array(PluginCatalogItemSchema) }).strict(),
  z.object({ method: z.literal("plugins.detail"), requestId: RequestIdSchema, ok: z.literal(true), result: PluginDetailSchema }).strict(),
  ...(["plugins.install", "plugins.update", "plugins.uninstall", "plugins.set-enabled", "plugins.operation"] as const).map((method) =>
    z.object({ method: z.literal(method), requestId: RequestIdSchema, ok: z.literal(true), result: PluginOperationSchema }).strict()),
  z.object({ method: z.literal("plugins.ui-descriptors"), requestId: RequestIdSchema, ok: z.literal(true), result: z.array(PluginUiDescriptorSchema).max(200) }).strict(),
  z.object({ method: z.literal("plugins.session-action"), requestId: RequestIdSchema, ok: z.literal(true), result: PluginSessionActionResultSchema }).strict(),
]);

const PluginMethodSchema = z.enum(["plugins.search", "plugins.installed", "plugins.detail", "plugins.install", "plugins.update", "plugins.uninstall", "plugins.set-enabled", "plugins.operation", "plugins.ui-descriptors", "plugins.session-action"]);
export const PluginIpcResponseSchema = z.union([
  PluginSuccessResponseSchema,
  z.object({ method: PluginMethodSchema, requestId: RequestIdSchema, ok: z.literal(false), error: UClawErrorSchema }).strict(),
]);
export type PluginIpcResponse = z.infer<typeof PluginIpcResponseSchema>;

export interface PluginBridge {
  invoke(request: PluginIpcRequest): Promise<PluginIpcResponse>;
}
