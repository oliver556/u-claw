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

export const SkillSourceSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("skillhub"),
    url: z.url().refine((value) => value.startsWith("https://"), "Skill source must use HTTPS."),
  }).strict(),
  z.object({ provider: z.literal("portable"), origin: z.literal("bundled") }).strict(),
  z.object({ provider: z.literal("openclaw"), origin: z.enum(["managed", "workspace"]) }).strict(),
]);

const PricingTypeSchema = z.enum(["free", "paid"]);
const SkillLogoUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && [
    "api.skillhub.cn",
    "skillhub-1388575217.cos.accelerate.myqcloud.com",
  ].includes(url.hostname);
}, "Skill logo must use a trusted SkillHub HTTPS URL.");
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
  categories: z.array(z.string().min(1).max(80)).max(32).default([]),
  logoUrl: SkillLogoUrlSchema.nullable().optional(),
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

export const SkillImportSelectionSchema = z.object({
  token: z.string().min(16).max(160).regex(/^[A-Za-z0-9_-]+$/),
  fileName: z.string().min(1).max(240),
  sizeBytes: z.number().int().positive().max(20 * 1024 * 1024),
}).strict();
export type SkillImportSelection = z.infer<typeof SkillImportSelectionSchema>;

const RequestIdSchema = z.string().min(1);
const SearchParamsSchema = z.object({
  query: z.string().max(120),
  category: z.string().min(1).max(80).nullable().optional(),
  cursor: z.string().nullable(),
  pageSize: z.number().int().min(1).max(50),
}).strict();
const SlugParamsSchema = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/) }).strict();
const MutationParamsSchema = z.object({ slug: SlugParamsSchema.shape.slug, confirmation: SkillConfirmationSchema.nullable() }).strict();
const SkillImportTokenSchema = z.string().min(16).max(160).regex(/^[A-Za-z0-9_-]+$/);
const SkillHubIdentitySchema = z.string().regex(/^@[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9._-]{0,79}$/);

export const SkillMissingRequirementsSchema = z.object({
  bins: z.array(z.string().min(1).max(160)).max(128),
  anyBins: z.array(z.string().min(1).max(160)).max(128),
  env: z.array(z.string().min(1).max(160)).max(128),
  config: z.array(z.string().min(1).max(240)).max(128),
  os: z.array(z.string().min(1).max(80)).max(32),
}).strict();
export type SkillMissingRequirements = z.infer<typeof SkillMissingRequirementsSchema>;

export const SkillRuntimeItemSchema = z.object({
  id: z.string().min(1).max(160),
  runtimeId: z.string().min(1).max(160).optional(),
  name: z.string().min(1).max(160),
  description: z.string().max(2_000).optional(),
  source: z.string().min(1).max(160),
  bundled: z.boolean(),
  disabled: z.boolean(),
  eligible: z.boolean(),
  modelVisible: z.boolean(),
  userInvocable: z.boolean(),
  commandVisible: z.boolean(),
  availability: z.enum(["available", "disabled", "missing-dependency", "conflict", "not-detected", "error"]),
  missing: SkillMissingRequirementsSchema,
  conflicts: z.array(z.string().min(1).max(160)).max(32),
}).strict();
export type SkillRuntimeItem = z.infer<typeof SkillRuntimeItemSchema>;

export const SkillRuntimeInventorySchema = z.object({
  workspaceDir: z.string().min(1).max(160),
  managedSkillsDir: z.string().min(1).max(160),
  skills: z.array(SkillRuntimeItemSchema),
}).strict();
export type SkillRuntimeInventory = z.infer<typeof SkillRuntimeInventorySchema>;

export const LocalSkillDetailSchema = z.object({
  slug: SlugParamsSchema.shape.slug,
  name: z.string().min(1).max(120),
  description: z.string().max(1_000),
  markdown: z.string().max(1_048_576),
}).strict();
export type LocalSkillDetail = z.infer<typeof LocalSkillDetailSchema>;

export const SkillCuratorEntrySchema = z.object({
  skillFile: z.string().min(1).max(1_024), skillKey: z.string().min(1).max(160), skillName: z.string().min(1).max(160),
  state: z.enum(["active", "stale", "archived"]), pinned: z.boolean(),
  createdAtMs: z.number(), stateChangedAtMs: z.number(), lastUsedAtMs: z.number().nullable(),
  useCount: z.number(), archivedReason: z.string().nullable(),
}).strict();
export const SkillCuratorStatusSchema = z.object({
  lastAttemptAtMs: z.number().nullable(), lastSuccessAtMs: z.number().nullable(), lastError: z.string().nullable(),
  counts: z.object({ active: z.number(), stale: z.number(), archived: z.number() }).strict(),
  skills: z.array(SkillCuratorEntrySchema).max(10_000),
  overlaps: z.array(z.object({ left: z.string().min(1).max(160), right: z.string().min(1).max(160), score: z.number() }).strict()).max(10_000),
}).strict();
export type SkillCuratorStatus = z.infer<typeof SkillCuratorStatusSchema>;

export const SkillProposalManifestEntrySchema = z.object({
  id: z.string().min(1).max(160), kind: z.enum(["create", "update"]),
  status: z.enum(["pending", "applied", "rejected", "quarantined", "stale"]),
  title: z.string().min(1).max(240), description: z.string().min(1).max(4_000), skillName: z.string().min(1).max(160), skillKey: z.string().min(1).max(160),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  scanState: z.enum(["pending", "clean", "failed", "quarantined"]),
  workspaceMismatch: z.literal(true).optional(),
}).strict();
export const SkillProposalManifestSchema = z.object({
  schema: z.literal("openclaw.skill-workshop.proposals-manifest.v1"),
  updatedAt: z.iso.datetime(), proposals: z.array(SkillProposalManifestEntrySchema).max(10_000),
}).strict();
export type SkillProposalManifest = z.infer<typeof SkillProposalManifestSchema>;

const SkillProposalIdSchema = z.string().min(1).max(160);
const SkillProposalPathSchema = z.string().min(1).max(1_024);
const SkillProposalHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const SkillProposalOriginSchema = z.object({
  agentId: z.string().min(1).max(160).optional(),
  sessionKey: z.string().min(1).max(240).optional(),
  runId: z.string().min(1).max(160).optional(),
  messageId: z.string().min(1).max(160).optional(),
}).strict();
const SkillProposalScanFindingSchema = z.object({
  ruleId: z.string().min(1).max(160),
  severity: z.enum(["info", "warn", "critical"]),
  file: SkillProposalPathSchema,
  line: z.number().int().min(1),
  message: z.string().min(1).max(4_000),
  evidence: z.string().max(16_000),
}).strict();
const SkillProposalScanSchema = z.object({
  state: z.enum(["pending", "clean", "failed", "quarantined"]),
  scannedAt: z.iso.datetime(),
  critical: z.number().int().nonnegative(),
  warn: z.number().int().nonnegative(),
  info: z.number().int().nonnegative(),
  findings: z.array(SkillProposalScanFindingSchema).max(10_000),
}).strict();
const SkillProposalSupportFileSchema = z.object({
  path: SkillProposalPathSchema, sizeBytes: z.number().int().nonnegative().max(262_144), hash: SkillProposalHashSchema,
  targetExisted: z.boolean().optional(), targetContentHash: SkillProposalHashSchema.optional(),
}).strict();
export const SkillProposalRecordSchema = z.object({
  schema: z.literal("openclaw.skill-workshop.proposal.v1"),
  id: SkillProposalIdSchema,
  kind: z.enum(["create", "update"]),
  status: z.enum(["pending", "applied", "rejected", "quarantined", "stale"]),
  title: z.string().min(1).max(240), description: z.string().min(1).max(4_000),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), createdBy: z.enum(["skill-workshop", "cli", "gateway"]),
  origin: SkillProposalOriginSchema.optional(),
  proposedVersion: z.string().min(1).max(64), draftFile: z.literal("PROPOSAL.md"), draftHash: SkillProposalHashSchema,
  supportFiles: z.array(SkillProposalSupportFileSchema).max(64).optional(),
  target: z.object({
    skillName: z.string().min(1).max(160), skillKey: z.string().min(1).max(160),
    skillDir: SkillProposalPathSchema, skillFile: SkillProposalPathSchema,
    source: z.string().max(240).optional(), currentContentHash: SkillProposalHashSchema.optional(),
  }).strict(),
  scan: SkillProposalScanSchema,
  goal: z.string().max(4_000).optional(), evidence: z.string().max(4_000).optional(),
  appliedAt: z.iso.datetime().optional(), rejectedAt: z.iso.datetime().optional(), quarantinedAt: z.iso.datetime().optional(), staleAt: z.iso.datetime().optional(),
  statusReason: z.string().max(4_000).optional(),
}).strict();
export type SkillProposalRecord = z.infer<typeof SkillProposalRecordSchema>;

export const SkillProposalInspectSchema = z.object({
  record: SkillProposalRecordSchema,
  content: z.string().max(1_048_576),
  supportFiles: z.array(z.object({ path: SkillProposalPathSchema, content: z.string().max(262_144) }).strict()).max(64).optional(),
}).strict();
export type SkillProposalInspect = z.infer<typeof SkillProposalInspectSchema>;
export const SkillProposalActionResultSchema = z.union([
  z.object({ record: SkillProposalRecordSchema, targetSkillFile: SkillProposalPathSchema }).strict(),
  SkillProposalRecordSchema,
]);
export type SkillProposalActionResult = z.infer<typeof SkillProposalActionResultSchema>;

const ProposalIdSchema = z.string().min(1).max(160);
const ProposalNameSchema = z.string().trim().min(1).max(120);
const ProposalDescriptionSchema = z.string().trim().min(1).max(2_000);
const ProposalContentSchema = z.string().min(1).max(200_000);
const ProposalContextSchema = z.string().trim().min(1).max(4_000);
const NullableProposalContextSchema = ProposalContextSchema.nullable();

export const SkillProposalCreateInputSchema = z.object({
  name: ProposalNameSchema,
  description: ProposalDescriptionSchema,
  content: ProposalContentSchema,
  goal: ProposalContextSchema.optional(),
  evidence: ProposalContextSchema.optional(),
}).strict();
export type SkillProposalCreateInput = z.infer<typeof SkillProposalCreateInputSchema>;

export const SkillProposalUpdateInputSchema = z.object({
  skillName: ProposalNameSchema,
  description: ProposalDescriptionSchema.optional(),
  content: ProposalContentSchema,
  goal: ProposalContextSchema.optional(),
  evidence: ProposalContextSchema.optional(),
}).strict();
export type SkillProposalUpdateInput = z.infer<typeof SkillProposalUpdateInputSchema>;

export const SkillProposalReviseInputSchema = z.object({
  proposalId: ProposalIdSchema,
  content: ProposalContentSchema,
  description: ProposalDescriptionSchema.optional(),
  goal: ProposalContextSchema.optional(),
  evidence: ProposalContextSchema.optional(),
}).strict();
export type SkillProposalReviseInput = z.infer<typeof SkillProposalReviseInputSchema>;

export const SkillProposalRevisionRequestInputSchema = z.object({
  proposalId: ProposalIdSchema,
  instructions: z.string().trim().min(1).max(8_000),
  sessionKey: z.string().trim().min(1).max(240),
  targetAgentId: z.string().trim().min(1).max(160).optional(),
  sessionId: z.string().trim().min(1).max(160).optional(),
}).strict();
export type SkillProposalRevisionRequestInput = z.infer<typeof SkillProposalRevisionRequestInputSchema>;

export const SkillProposalRevisionRunSchema = z.object({
  runId: z.string().min(1).max(160),
  status: z.enum(["started", "in_flight", "ok", "timeout", "error"]),
}).strict();
export type SkillProposalRevisionRun = z.infer<typeof SkillProposalRevisionRunSchema>;

const ProposalCreateParamsSchema = SkillProposalCreateInputSchema.extend({
  goal: NullableProposalContextSchema.optional(),
  evidence: NullableProposalContextSchema.optional(),
}).strict();
const ProposalUpdateParamsSchema = SkillProposalUpdateInputSchema.extend({
  description: ProposalDescriptionSchema.nullable().optional(),
  goal: NullableProposalContextSchema.optional(),
  evidence: NullableProposalContextSchema.optional(),
}).strict();
const ProposalReviseParamsSchema = SkillProposalReviseInputSchema.extend({
  description: ProposalDescriptionSchema.nullable().optional(),
  goal: NullableProposalContextSchema.optional(),
  evidence: NullableProposalContextSchema.optional(),
}).strict();
const ProposalRevisionRequestParamsSchema = SkillProposalRevisionRequestInputSchema.extend({
  targetAgentId: z.string().trim().min(1).max(160).nullable().optional(),
  sessionId: z.string().trim().min(1).max(160).nullable().optional(),
}).strict();

export const SkillIpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("skills.search"), requestId: RequestIdSchema, params: SearchParamsSchema }).strict(),
  z.object({ method: z.literal("skills.installed"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("skills.detail"), requestId: RequestIdSchema, params: SlugParamsSchema }).strict(),
  z.object({ method: z.literal("skills.local-detail"), requestId: RequestIdSchema, params: SlugParamsSchema }).strict(),
  z.object({ method: z.literal("skills.install"), requestId: RequestIdSchema, params: MutationParamsSchema }).strict(),
  z.object({ method: z.literal("skills.update"), requestId: RequestIdSchema, params: MutationParamsSchema }).strict(),
  z.object({ method: z.literal("skills.uninstall"), requestId: RequestIdSchema, params: SlugParamsSchema }).strict(),
  z.object({ method: z.literal("skills.set-enabled"), requestId: RequestIdSchema, params: MutationParamsSchema.extend({ enabled: z.boolean() }).strict() }).strict(),
  z.object({ method: z.literal("skills.operation"), requestId: RequestIdSchema, params: z.object({ operationId: z.string().min(1) }).strict() }).strict(),
  z.object({ method: z.literal("skills.runtime-status"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("skills.import-select"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("skills.import-prepare"), requestId: RequestIdSchema, params: z.object({ token: SkillImportTokenSchema }).strict() }).strict(),
  z.object({ method: z.literal("skills.import-install"), requestId: RequestIdSchema, params: z.object({ token: SkillImportTokenSchema, confirmation: SkillConfirmationSchema }).strict() }).strict(),
  z.object({ method: z.literal("skills.import-dispose"), requestId: RequestIdSchema, params: z.object({ token: SkillImportTokenSchema }).strict() }).strict(),
  z.object({ method: z.literal("skills.open-hub"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("skills.resolve-install"), requestId: RequestIdSchema, params: z.object({ identity: SkillHubIdentitySchema }).strict() }).strict(),
  z.object({ method: z.literal("skills.curator-status"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("skills.curator-action"), requestId: RequestIdSchema, params: z.object({ skill: z.string().min(1), action: z.enum(["pin", "unpin", "restore"]) }).strict() }).strict(),
  z.object({ method: z.literal("skills.proposals-list"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("skills.proposal-inspect"), requestId: RequestIdSchema, params: z.object({ proposalId: z.string().min(1) }).strict() }).strict(),
  z.object({ method: z.literal("skills.proposal-action"), requestId: RequestIdSchema, params: z.object({ proposalId: z.string().min(1), action: z.enum(["apply", "reject", "quarantine"]), reason: z.string().max(500).nullable() }).strict() }).strict(),
  z.object({ method: z.literal("skills.proposal-create"), requestId: RequestIdSchema, params: ProposalCreateParamsSchema }).strict(),
  z.object({ method: z.literal("skills.proposal-update"), requestId: RequestIdSchema, params: ProposalUpdateParamsSchema }).strict(),
  z.object({ method: z.literal("skills.proposal-revise"), requestId: RequestIdSchema, params: ProposalReviseParamsSchema }).strict(),
  z.object({ method: z.literal("skills.proposal-request-revision"), requestId: RequestIdSchema, params: ProposalRevisionRequestParamsSchema }).strict(),
]);
export type SkillIpcRequest = z.infer<typeof SkillIpcRequestSchema>;

const SkillSuccessResponseSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("skills.search"), requestId: RequestIdSchema, ok: z.literal(true), result: SkillCatalogPageSchema }).strict(),
  z.object({ method: z.literal("skills.installed"), requestId: RequestIdSchema, ok: z.literal(true), result: z.array(SkillCatalogItemSchema) }).strict(),
  z.object({ method: z.literal("skills.detail"), requestId: RequestIdSchema, ok: z.literal(true), result: SkillDetailSchema }).strict(),
  z.object({ method: z.literal("skills.local-detail"), requestId: RequestIdSchema, ok: z.literal(true), result: LocalSkillDetailSchema }).strict(),
  ...(["skills.install", "skills.update", "skills.uninstall", "skills.set-enabled", "skills.operation"] as const).map((method) =>
    z.object({ method: z.literal(method), requestId: RequestIdSchema, ok: z.literal(true), result: SkillOperationSchema }).strict()),
  z.object({ method: z.literal("skills.runtime-status"), requestId: RequestIdSchema, ok: z.literal(true), result: SkillRuntimeInventorySchema }).strict(),
  z.object({ method: z.literal("skills.import-select"), requestId: RequestIdSchema, ok: z.literal(true), result: SkillImportSelectionSchema.nullable() }).strict(),
  z.object({ method: z.literal("skills.import-prepare"), requestId: RequestIdSchema, ok: z.literal(true), result: SkillDetailSchema }).strict(),
  z.object({ method: z.literal("skills.import-install"), requestId: RequestIdSchema, ok: z.literal(true), result: SkillOperationSchema }).strict(),
  z.object({ method: z.literal("skills.import-dispose"), requestId: RequestIdSchema, ok: z.literal(true), result: z.object({ disposed: z.literal(true) }).strict() }).strict(),
  z.object({ method: z.literal("skills.open-hub"), requestId: RequestIdSchema, ok: z.literal(true), result: z.object({ opened: z.literal(true) }).strict() }).strict(),
  z.object({ method: z.literal("skills.resolve-install"), requestId: RequestIdSchema, ok: z.literal(true), result: SkillDetailSchema }).strict(),
  z.object({ method: z.literal("skills.curator-status"), requestId: RequestIdSchema, ok: z.literal(true), result: SkillCuratorStatusSchema }).strict(),
  z.object({ method: z.literal("skills.curator-action"), requestId: RequestIdSchema, ok: z.literal(true), result: SkillCuratorEntrySchema }).strict(),
  z.object({ method: z.literal("skills.proposals-list"), requestId: RequestIdSchema, ok: z.literal(true), result: SkillProposalManifestSchema }).strict(),
  z.object({ method: z.literal("skills.proposal-inspect"), requestId: RequestIdSchema, ok: z.literal(true), result: SkillProposalInspectSchema }).strict(),
  z.object({ method: z.literal("skills.proposal-action"), requestId: RequestIdSchema, ok: z.literal(true), result: SkillProposalActionResultSchema }).strict(),
  ...(["skills.proposal-create", "skills.proposal-update", "skills.proposal-revise"] as const).map((method) =>
    z.object({ method: z.literal(method), requestId: RequestIdSchema, ok: z.literal(true), result: SkillProposalInspectSchema }).strict()),
  z.object({ method: z.literal("skills.proposal-request-revision"), requestId: RequestIdSchema, ok: z.literal(true), result: SkillProposalRevisionRunSchema }).strict(),
]);

export const SkillIpcResponseSchema = z.union([
  SkillSuccessResponseSchema,
  z.object({
    method: z.enum(["skills.search", "skills.installed", "skills.detail", "skills.local-detail", "skills.install", "skills.update", "skills.uninstall", "skills.set-enabled", "skills.operation", "skills.runtime-status", "skills.import-select", "skills.import-prepare", "skills.import-install", "skills.import-dispose", "skills.open-hub", "skills.resolve-install", "skills.curator-status", "skills.curator-action", "skills.proposals-list", "skills.proposal-inspect", "skills.proposal-action", "skills.proposal-create", "skills.proposal-update", "skills.proposal-revise", "skills.proposal-request-revision"]),
    requestId: RequestIdSchema,
    ok: z.literal(false),
    error: UClawErrorSchema,
  }).strict(),
]);
export type SkillIpcResponse = z.infer<typeof SkillIpcResponseSchema>;

export interface SkillBridge {
  invoke(request: SkillIpcRequest): Promise<SkillIpcResponse>;
}
