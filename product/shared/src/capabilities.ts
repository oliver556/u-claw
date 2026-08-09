import { z } from "zod";

import { UClawErrorSchema } from "./errors.js";

export const CapabilityPackageKindSchema = z.enum(["skill", "plugin", "mcp"]);
export type CapabilityPackageKind = z.infer<typeof CapabilityPackageKindSchema>;

export const CapabilityRiskSchema = z.enum(["low", "medium", "high", "critical"]);
export type CapabilityRisk = z.infer<typeof CapabilityRiskSchema>;

export const CapabilityPermissionSchema = z.object({
  kind: z.enum(["filesystem", "network", "command", "environment"]),
  access: z.enum(["read", "write", "connect", "execute", "read-secret"]),
  target: z.string().min(1).max(240),
  risk: CapabilityRiskSchema,
  reason: z.string().min(1).max(500),
}).strict();
export type CapabilityPermission = z.infer<typeof CapabilityPermissionSchema>;
export const SkillPermissionSchema = CapabilityPermissionSchema;
export type SkillPermission = CapabilityPermission;

export const SkillSourceSchema = z.object({
  provider: z.literal("skillhub"),
  url: z.url().refine((value) => value.startsWith("https://"), "Skill source must use HTTPS."),
}).strict();

const PricingTypeSchema = z.enum(["free", "paid"]);
const SkillCatalogBaseSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),
  name: z.string().min(1).max(120),
  description: z.string().max(1_000),
  version: z.string().min(1).max(80),
  pricingType: PricingTypeSchema,
  installedVersion: z.string().nullable(),
  enabled: z.boolean(),
  updateAvailable: z.boolean(),
  source: SkillSourceSchema,
  permissions: z.array(SkillPermissionSchema).max(64),
  permissionFingerprint: z.string().min(1).max(128),
  risk: CapabilityRiskSchema,
  mode: z.enum(["fixture", "live"]),
}).strict();

export const SkillCatalogItemSchema = SkillCatalogBaseSchema;
export type SkillCatalogItem = z.infer<typeof SkillCatalogItemSchema>;

export const SkillDetailSchema = SkillCatalogBaseSchema.extend({
  manifest: z.object({
    kind: z.literal("skill"),
    id: z.string().min(1),
    version: z.string().min(1),
    entry: z.string().min(1),
  }).strict(),
}).strict();
export type SkillDetail = z.infer<typeof SkillDetailSchema>;

export const SkillCatalogPageSchema = z.object({
  items: z.array(SkillCatalogItemSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  mode: z.enum(["fixture", "live"]),
}).strict();
export type SkillCatalogPage = z.infer<typeof SkillCatalogPageSchema>;

export const SkillConfirmationSchema = z.object({
  permissionFingerprint: z.string().min(1).max(128),
  acceptedRisk: CapabilityRiskSchema,
}).strict();
export type SkillConfirmation = z.infer<typeof SkillConfirmationSchema>;

export const SkillOperationSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  action: z.enum(["install", "update", "uninstall", "enable", "disable"]),
  state: z.enum(["queued", "running", "succeeded", "failed", "recovered"]),
  progress: z.number().int().min(0).max(100),
  phase: z.enum(["queued", "downloading", "validating", "staging", "replacing", "persisting", "complete", "rollback", "failed"]),
  error: z.string().max(500).optional(),
}).strict();
export type SkillOperation = z.infer<typeof SkillOperationSchema>;

const RequestIdSchema = z.string().min(1);
const SearchParamsSchema = z.object({
  query: z.string().max(120),
  cursor: z.string().nullable(),
  pageSize: z.number().int().min(1).max(50),
}).strict();
const SlugParamsSchema = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/) }).strict();
const MutationParamsSchema = z.object({ slug: SlugParamsSchema.shape.slug, confirmation: SkillConfirmationSchema.nullable() }).strict();

export const SkillIpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("skills.search"), requestId: RequestIdSchema, params: SearchParamsSchema }).strict(),
  z.object({ method: z.literal("skills.installed"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("skills.detail"), requestId: RequestIdSchema, params: SlugParamsSchema }).strict(),
  z.object({ method: z.literal("skills.install"), requestId: RequestIdSchema, params: MutationParamsSchema }).strict(),
  z.object({ method: z.literal("skills.update"), requestId: RequestIdSchema, params: MutationParamsSchema }).strict(),
  z.object({ method: z.literal("skills.uninstall"), requestId: RequestIdSchema, params: SlugParamsSchema }).strict(),
  z.object({ method: z.literal("skills.set-enabled"), requestId: RequestIdSchema, params: MutationParamsSchema.extend({ enabled: z.boolean() }).strict() }).strict(),
  z.object({ method: z.literal("skills.operation"), requestId: RequestIdSchema, params: z.object({ operationId: z.string().min(1) }).strict() }).strict(),
]);
export type SkillIpcRequest = z.infer<typeof SkillIpcRequestSchema>;

const SkillSuccessResponseSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("skills.search"), requestId: RequestIdSchema, ok: z.literal(true), result: SkillCatalogPageSchema }).strict(),
  z.object({ method: z.literal("skills.installed"), requestId: RequestIdSchema, ok: z.literal(true), result: z.array(SkillCatalogItemSchema) }).strict(),
  z.object({ method: z.literal("skills.detail"), requestId: RequestIdSchema, ok: z.literal(true), result: SkillDetailSchema }).strict(),
  ...(["skills.install", "skills.update", "skills.uninstall", "skills.set-enabled", "skills.operation"] as const).map((method) =>
    z.object({ method: z.literal(method), requestId: RequestIdSchema, ok: z.literal(true), result: SkillOperationSchema }).strict()),
]);

export const SkillIpcResponseSchema = z.union([
  SkillSuccessResponseSchema,
  z.object({
    method: z.enum(["skills.search", "skills.installed", "skills.detail", "skills.install", "skills.update", "skills.uninstall", "skills.set-enabled", "skills.operation"]),
    requestId: RequestIdSchema,
    ok: z.literal(false),
    error: UClawErrorSchema,
  }).strict(),
]);
export type SkillIpcResponse = z.infer<typeof SkillIpcResponseSchema>;

export interface SkillBridge {
  invoke(request: SkillIpcRequest): Promise<SkillIpcResponse>;
}
