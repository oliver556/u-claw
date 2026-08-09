import { z } from "zod";

import { UClawErrorSchema } from "./errors.js";

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export const RelativeDomainIdSchema = z.string().max(1024).superRefine((value, context) => {
  const segments = value.split("/");
  if (
    value.length === 0 || value === "." || value.startsWith("/") || value.startsWith("\\") ||
    value.includes("\\") || value.includes(":") || value.includes("\0") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." ||
      segment.endsWith(".") || segment.endsWith(" ") || WINDOWS_DEVICE_NAME.test(segment))
  ) context.addIssue({ code: "custom", message: "Invalid relative domain ID." });
});
export type RelativeDomainId = z.infer<typeof RelativeDomainIdSchema>;

export const DataEntryNameSchema = z.string().trim().min(1).max(255).superRefine((value, context) => {
  if (
    value === "." || value === ".." || value.includes("/") || value.includes("\\") ||
    value.includes(":") || value.includes("\0") || value.endsWith(".") || value.endsWith(" ") ||
    WINDOWS_DEVICE_NAME.test(value)
  ) context.addIssue({ code: "custom", message: "Invalid entry name." });
});

const RequestIdSchema = z.string().min(1).max(128);
const VersionSchema = z.string().min(1).max(256);
export const BackupCollectionIdSchema = z.enum(["workspace-user-files", "openclaw-memory", "openclaw-sessions", "uclaw-configuration"]);
export type BackupCollectionId = z.infer<typeof BackupCollectionIdSchema>;
export const BackupIdSchema = z.string().regex(/^backup-[a-z0-9-]{1,80}$/);
export const MaintenanceOperationIdSchema = z.string().regex(/^operation-[a-z0-9-]{1,80}$/);
export const MaintenancePreviewTokenSchema = z.string().regex(/^preview-[a-z0-9-]{1,80}$/);
export const CleanupCandidateIdSchema = z.enum([
  "cache:electron", "cache:node-compile", "cache:temp", "diagnostics:expired-logs",
  "diagnostics:expired-crash-dumps", "backups:expired",
]);
export type CleanupCandidateId = z.infer<typeof CleanupCandidateIdSchema>;
const UniqueBackupCollectionsSchema = z.array(BackupCollectionIdSchema).min(1).max(4).refine((items) => new Set(items).size === items.length, "Duplicate backup collection ID.");
const UniqueCleanupCandidatesSchema = z.array(CleanupCandidateIdSchema).min(1).max(6).refine((items) => new Set(items).size === items.length, "Duplicate cleanup candidate ID.");
const PageParamsSchema = z.object({
  query: z.string().trim().max(200).optional(),
  cursor: z.string().max(64).optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();

export const DataIpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("data.contract"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("data.status"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("workspace.list"), requestId: RequestIdSchema, params: PageParamsSchema.extend({ parentId: RelativeDomainIdSchema.optional() }).strict() }).strict(),
  z.object({ method: z.literal("workspace.read"), requestId: RequestIdSchema, params: z.object({ entryId: RelativeDomainIdSchema }).strict() }).strict(),
  z.object({ method: z.enum(["workspace.open", "workspace.reveal"]), requestId: RequestIdSchema, params: z.object({ entryId: RelativeDomainIdSchema }).strict() }).strict(),
  z.object({ method: z.literal("workspace.rename"), requestId: RequestIdSchema, params: z.object({ entryId: RelativeDomainIdSchema, name: DataEntryNameSchema, version: VersionSchema }).strict() }).strict(),
  z.object({ method: z.literal("workspace.move"), requestId: RequestIdSchema, params: z.object({ entryId: RelativeDomainIdSchema, destinationId: RelativeDomainIdSchema.optional(), version: VersionSchema }).strict() }).strict(),
  z.object({ method: z.literal("workspace.delete"), requestId: RequestIdSchema, params: z.object({ entryId: RelativeDomainIdSchema, version: VersionSchema, confirmed: z.literal(true) }).strict() }).strict(),
  z.object({ method: z.literal("memory.list"), requestId: RequestIdSchema, params: PageParamsSchema }).strict(),
  z.object({ method: z.literal("memory.read"), requestId: RequestIdSchema, params: z.object({ memoryId: RelativeDomainIdSchema }).strict() }).strict(),
  z.object({ method: z.literal("memory.write"), requestId: RequestIdSchema, params: z.object({ memoryId: RelativeDomainIdSchema, content: z.string().max(2_000_000), version: VersionSchema }).strict() }).strict(),
  z.object({ method: z.literal("memory.delete"), requestId: RequestIdSchema, params: z.object({ memoryId: RelativeDomainIdSchema, version: VersionSchema, confirmed: z.literal(true) }).strict() }).strict(),
  z.object({ method: z.literal("backup.preview"), requestId: RequestIdSchema, params: z.object({ collectionIds: UniqueBackupCollectionsSchema.optional(), trigger: z.enum(["manual", "automatic"]).optional(), retainLatest: z.number().int().min(1).max(20).optional() }).strict() }).strict(),
  z.object({ method: z.literal("backup.list"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("backup.create"), requestId: RequestIdSchema, params: z.object({ collectionIds: UniqueBackupCollectionsSchema, previewToken: MaintenancePreviewTokenSchema, trigger: z.enum(["manual", "automatic"]), retainLatest: z.number().int().min(1).max(20), confirmed: z.literal(true) }).strict() }).strict(),
  z.object({ method: z.literal("backup.restore-preview"), requestId: RequestIdSchema, params: z.object({ backupId: BackupIdSchema, collectionIds: UniqueBackupCollectionsSchema.optional() }).strict() }).strict(),
  z.object({ method: z.literal("backup.restore"), requestId: RequestIdSchema, params: z.object({ backupId: BackupIdSchema, collectionIds: UniqueBackupCollectionsSchema, previewToken: MaintenancePreviewTokenSchema, confirmed: z.literal(true) }).strict() }).strict(),
  z.object({ method: z.literal("storage.stats"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("cleanup.preview"), requestId: RequestIdSchema, params: z.object({ candidateIds: UniqueCleanupCandidatesSchema.optional() }).strict() }).strict(),
  z.object({ method: z.literal("cleanup.execute"), requestId: RequestIdSchema, params: z.object({ candidateIds: UniqueCleanupCandidatesSchema, previewToken: MaintenancePreviewTokenSchema, confirmed: z.literal(true) }).strict() }).strict(),
  z.object({ method: z.literal("maintenance.operation-get"), requestId: RequestIdSchema, params: z.object({ operationId: MaintenanceOperationIdSchema }).strict() }).strict(),
  z.object({ method: z.literal("maintenance.operation-cancel"), requestId: RequestIdSchema, params: z.object({ operationId: MaintenanceOperationIdSchema }).strict() }).strict(),
]);
export type DataIpcRequest = z.infer<typeof DataIpcRequestSchema>;

export const WorkspaceEntrySchema = z.object({
  id: RelativeDomainIdSchema,
  name: z.string().min(1),
  kind: z.enum(["file", "directory"]),
  size: z.number().int().nonnegative(),
  modifiedAt: z.string().datetime(),
  version: VersionSchema,
  readable: z.boolean(),
}).strict();
export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>;

export const MemoryEntrySchema = z.object({
  id: RelativeDomainIdSchema,
  title: z.string().min(1),
  size: z.number().int().nonnegative(),
  modifiedAt: z.string().datetime(),
  version: VersionSchema,
}).strict();
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

export const DataRootContractSchema = z.object({
  contractVersion: z.literal(1),
  roots: z.object({ workspace: z.literal("workspace"), memory: z.literal("workspace"), sessions: z.literal(".openclaw/agents") }).strict(),
  backupSets: z.array(z.enum(["workspace-user-files", "openclaw-memory", "openclaw-sessions", "uclaw-configuration"])).length(4),
  cleanupClasses: z.array(z.enum(["protected-durable", "user-managed", "rebuildable-cache", "diagnostic-retention"])).length(4),
  backupPolicies: z.object({
    "workspace-user-files": z.object({ root: z.literal("data"), includes: z.array(z.string()).min(1), excludes: z.array(z.string()) }).strict(),
    "openclaw-memory": z.object({ root: z.literal("data"), includes: z.array(z.string()).min(1), excludes: z.array(z.string()) }).strict(),
    "openclaw-sessions": z.object({ root: z.literal("data"), includes: z.array(z.string()).min(1), excludes: z.array(z.string()) }).strict(),
    "uclaw-configuration": z.object({ root: z.literal("data"), includes: z.array(z.string()).min(1), excludes: z.array(z.string()) }).strict(),
  }).strict(),
  cleanupPolicies: z.object({
    "protected-durable": z.object({ root: z.literal("data"), includes: z.array(z.string()).min(1) }).strict(),
    "user-managed": z.object({ root: z.literal("data"), includes: z.array(z.string()).min(1), excludes: z.array(z.string()) }).strict(),
    "rebuildable-cache": z.object({ root: z.literal("cache"), includes: z.array(z.string()).min(1) }).strict(),
    "diagnostic-retention": z.object({ root: z.literal("data"), includes: z.array(z.string()).min(1) }).strict(),
  }).strict(),
}).strict();
export type DataRootContract = z.infer<typeof DataRootContractSchema>;

export const DATA_ROOT_CONTRACT: DataRootContract = DataRootContractSchema.parse({
  contractVersion: 1,
  roots: { workspace: "workspace", memory: "workspace", sessions: ".openclaw/agents" },
  backupSets: ["workspace-user-files", "openclaw-memory", "openclaw-sessions", "uclaw-configuration"],
  cleanupClasses: ["protected-durable", "user-managed", "rebuildable-cache", "diagnostic-retention"],
  backupPolicies: {
    "workspace-user-files": { root: "data", includes: ["workspace/**"], excludes: ["workspace/MEMORY.md", "workspace/memory/**", "workspace/AGENTS.md", "workspace/SOUL.md", "workspace/TOOLS.md", "workspace/IDENTITY.md", "workspace/USER.md", "workspace/HEARTBEAT.md", "workspace/BOOTSTRAP.md", "workspace/DREAMS.md", "workspace/.openclaw/**"] },
    "openclaw-memory": { root: "data", includes: ["workspace/MEMORY.md", "workspace/memory/**/*.md"], excludes: [] },
    "openclaw-sessions": { root: "data", includes: [".openclaw/agents/**"], excludes: [] },
    "uclaw-configuration": { root: "data", includes: [".openclaw/**", "desktop/**", "workspace/AGENTS.md", "workspace/SOUL.md", "workspace/TOOLS.md", "workspace/IDENTITY.md", "workspace/USER.md", "workspace/HEARTBEAT.md", "workspace/BOOTSTRAP.md", "workspace/DREAMS.md", "capabilities/**", "channels/**", "mcp/**", "providers/**", "uclaw/**"], excludes: [".openclaw/agents/**"] },
  },
  cleanupPolicies: {
    "protected-durable": { root: "data", includes: ["workspace/MEMORY.md", "workspace/memory/**", "workspace/AGENTS.md", "workspace/SOUL.md", "workspace/TOOLS.md", "workspace/IDENTITY.md", "workspace/USER.md", "workspace/HEARTBEAT.md", "workspace/BOOTSTRAP.md", "workspace/DREAMS.md", ".openclaw/**", "desktop/**", "capabilities/**", "channels/**", "mcp/**", "providers/**", "uclaw/**"] },
    "user-managed": { root: "data", includes: ["workspace/**"], excludes: ["workspace/MEMORY.md", "workspace/memory/**", "workspace/AGENTS.md", "workspace/SOUL.md", "workspace/TOOLS.md", "workspace/IDENTITY.md", "workspace/USER.md", "workspace/HEARTBEAT.md", "workspace/BOOTSTRAP.md", "workspace/DREAMS.md", "workspace/.openclaw/**"] },
    "rebuildable-cache": { root: "cache", includes: ["**"] },
    "diagnostic-retention": { root: "data", includes: ["diagnostics/**"] },
  },
});

const PageSchema = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().nullable(), hasMore: z.boolean() }).strict();
const DataStatusSchema = z.object({ state: z.enum(["available", "read-only", "offline"]), writable: z.boolean() }).strict();
const CollectionSummarySchema = z.object({ id: BackupCollectionIdSchema, label: z.string().min(1).max(40), fileCount: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), risk: z.enum(["normal", "sensitive", "large"]) }).strict();
export const BackupPreviewSchema = z.object({
  previewToken: MaintenancePreviewTokenSchema,
  target: z.literal("当前 U 盘受控备份区"),
  consistency: z.enum(["runtime-coordination-required", "coordinated"]),
  trigger: z.enum(["manual", "automatic"]), retainLatest: z.number().int().min(1).max(20),
  collections: z.array(CollectionSummarySchema).max(4),
  totalFileCount: z.number().int().nonnegative(), totalBytes: z.number().int().nonnegative(),
  warnings: z.array(z.string().min(1).max(160)).max(8),
}).strict();
export type BackupPreview = z.infer<typeof BackupPreviewSchema>;
export const RestorePreviewSchema = z.object({
  previewToken: MaintenancePreviewTokenSchema, backupId: BackupIdSchema,
  source: z.literal("当前 U 盘受控备份区"), target: z.literal("当前 U 盘数据根"),
  collections: z.array(CollectionSummarySchema).min(1).max(4),
  totalFileCount: z.number().int().nonnegative(), totalBytes: z.number().int().nonnegative(),
  overwriteFileCount: z.number().int().nonnegative(), newFileCount: z.number().int().nonnegative(),
  warnings: z.array(z.string().min(1).max(160)).max(8),
}).strict();
export type RestorePreview = z.infer<typeof RestorePreviewSchema>;
export const BackupSummarySchema = z.object({
  id: BackupIdSchema, createdAt: z.string().datetime(), trigger: z.enum(["manual", "automatic"]),
  state: z.enum(["ready", "damaged", "incomplete"]), collections: z.array(BackupCollectionIdSchema).min(1).max(4),
  fileCount: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(),
}).strict();
export type BackupSummary = z.infer<typeof BackupSummarySchema>;
const StorageCategoryIdSchema = z.enum(["configuration", "sessions", "memory", "capabilities", "logs", "cache", "temporary-downloads", "user-files", "backups"]);
export const StorageStatsSchema = z.object({
  state: z.enum(["available", "read-only", "offline", "damaged"]),
  categories: z.array(z.object({ id: StorageCategoryIdSchema, label: z.string().min(1).max(40), bytes: z.number().int().nonnegative(), fileCount: z.number().int().nonnegative(), protected: z.boolean() }).strict()).length(9),
  totalBytes: z.number().int().nonnegative(),
}).strict();
export type StorageStats = z.infer<typeof StorageStatsSchema>;
export const CleanupPreviewSchema = z.object({
  previewToken: MaintenancePreviewTokenSchema,
  candidates: z.array(z.object({ id: CleanupCandidateIdSchema, label: z.string().min(1).max(60), bytes: z.number().int().nonnegative(), fileCount: z.number().int().nonnegative(), reason: z.string().min(1).max(120) }).strict()).max(6),
  totalBytes: z.number().int().nonnegative(), totalFileCount: z.number().int().nonnegative(),
  protectedCategories: z.array(StorageCategoryIdSchema).min(1),
}).strict();
export type CleanupPreview = z.infer<typeof CleanupPreviewSchema>;
export const MaintenanceOperationSchema = z.object({
  id: MaintenanceOperationIdSchema, kind: z.enum(["backup", "restore", "cleanup"]),
  state: z.enum(["queued", "running", "completed", "cancelled", "failed", "needs-recovery"]),
  phase: z.enum(["queued", "coordinating", "scanning", "staging", "verifying", "committing", "rolling-back", "cleaning", "completed", "cancelled", "failed", "needs-recovery"]),
  processedFiles: z.number().int().nonnegative(), totalFiles: z.number().int().nonnegative(),
  processedBytes: z.number().int().nonnegative(), totalBytes: z.number().int().nonnegative(),
  partialFailures: z.number().int().nonnegative(), failures: z.array(z.object({ candidateId: CleanupCandidateIdSchema, code: z.string().min(1).max(40), message: z.string().min(1).max(120) }).strict()).max(20), message: z.string().min(1).max(160),
}).strict();
export type MaintenanceOperation = z.infer<typeof MaintenanceOperationSchema>;

export const DataIpcResponseSchema = z.union([
  z.object({ method: z.literal("data.contract"), requestId: RequestIdSchema, ok: z.literal(true), result: DataRootContractSchema }).strict(),
  z.object({ method: z.literal("data.status"), requestId: RequestIdSchema, ok: z.literal(true), result: DataStatusSchema }).strict(),
  z.object({ method: z.literal("workspace.list"), requestId: RequestIdSchema, ok: z.literal(true), result: PageSchema(WorkspaceEntrySchema) }).strict(),
  z.object({ method: z.literal("workspace.read"), requestId: RequestIdSchema, ok: z.literal(true), result: z.object({ entry: WorkspaceEntrySchema, content: z.string(), encoding: z.literal("utf-8") }).strict() }).strict(),
  z.object({ method: z.enum(["workspace.open", "workspace.reveal", "workspace.delete", "memory.delete"]), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
  z.object({ method: z.enum(["workspace.rename", "workspace.move"]), requestId: RequestIdSchema, ok: z.literal(true), result: WorkspaceEntrySchema }).strict(),
  z.object({ method: z.literal("memory.list"), requestId: RequestIdSchema, ok: z.literal(true), result: PageSchema(MemoryEntrySchema) }).strict(),
  z.object({ method: z.literal("memory.read"), requestId: RequestIdSchema, ok: z.literal(true), result: z.object({ memory: MemoryEntrySchema, content: z.string() }).strict() }).strict(),
  z.object({ method: z.literal("memory.write"), requestId: RequestIdSchema, ok: z.literal(true), result: z.object({ memory: MemoryEntrySchema }).strict() }).strict(),
  z.object({ method: z.literal("backup.preview"), requestId: RequestIdSchema, ok: z.literal(true), result: BackupPreviewSchema }).strict(),
  z.object({ method: z.literal("backup.list"), requestId: RequestIdSchema, ok: z.literal(true), result: z.object({ items: z.array(BackupSummarySchema).max(200) }).strict() }).strict(),
  z.object({ method: z.literal("backup.restore-preview"), requestId: RequestIdSchema, ok: z.literal(true), result: RestorePreviewSchema }).strict(),
  z.object({ method: z.literal("storage.stats"), requestId: RequestIdSchema, ok: z.literal(true), result: StorageStatsSchema }).strict(),
  z.object({ method: z.literal("cleanup.preview"), requestId: RequestIdSchema, ok: z.literal(true), result: CleanupPreviewSchema }).strict(),
  z.object({ method: z.enum(["backup.create", "backup.restore", "cleanup.execute", "maintenance.operation-get", "maintenance.operation-cancel"]), requestId: RequestIdSchema, ok: z.literal(true), result: MaintenanceOperationSchema }).strict(),
  z.object({ method: z.string().min(1), requestId: RequestIdSchema, ok: z.literal(false), error: UClawErrorSchema }).strict(),
]);
export type DataIpcResponse = z.infer<typeof DataIpcResponseSchema>;

export interface DataBridge {
  invoke(request: DataIpcRequest): Promise<DataIpcResponse>;
}
