import { z } from "zod";

import { FileRefSchema, ISODateTimeSchema, ResourceRefSchema } from "./common.js";
import { UClawErrorSummarySchema } from "./errors.js";
import { ToolRiskSchema } from "./tools.js";

export const SecretStateSchema = z
  .object({ configured: z.boolean(), hint: z.string().optional() })
  .strict();
export type SecretState = z.infer<typeof SecretStateSchema>;

export const ConfigurationFieldSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    kind: z.enum(["text", "secret", "url", "number", "boolean", "select", "multi-select"]),
    required: z.boolean(),
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]).optional(),
    secret: SecretStateSchema.optional(),
    options: z.array(z.object({ value: z.string(), label: z.string() }).strict()).optional(),
  })
  .strict();
export type ConfigurationField = z.infer<typeof ConfigurationFieldSchema>;

export const ModelSummarySchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    providerId: z.string().min(1),
    available: z.boolean(),
    locality: z.enum(["cloud", "local", "unknown"]),
    capabilities: z.array(z.enum(["text", "vision", "tools", "attachments", "unknown"])),
    unavailableReason: UClawErrorSummarySchema.optional(),
  })
  .strict();
export type ModelSummary = z.infer<typeof ModelSummarySchema>;

export const ProviderSummarySchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    kind: z.string().min(1),
    enabled: z.boolean(),
    baseUrl: z.url().optional(),
    credential: SecretStateSchema,
    fields: z.array(ConfigurationFieldSchema),
    health: z.enum(["unknown", "checking", "available", "unavailable"]),
    models: z.array(ModelSummarySchema),
  })
  .strict();
export type ProviderSummary = z.infer<typeof ProviderSummarySchema>;

export const SkillSummarySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    version: z.string().optional(),
    source: z.enum(["bundled", "installed", "workspace", "unknown"]),
    enabled: z.boolean(),
    availability: z.enum(["available", "missing-dependency", "conflict", "error", "unknown"]),
  })
  .strict();
export type SkillSummary = z.infer<typeof SkillSummarySchema>;

export const PluginSummarySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().optional(),
    source: z.string().optional(),
    installed: z.boolean(),
    enabled: z.boolean(),
    state: z.enum(["ready", "restart-required", "error", "unknown"]),
    error: UClawErrorSummarySchema.optional(),
  })
  .strict();
export type PluginSummary = z.infer<typeof PluginSummarySchema>;

export const McpServerSummarySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    enabled: z.boolean(),
    transport: z.enum(["stdio", "http", "sse", "unknown"]),
    projection: z
      .object({
        state: z.enum(["not-projected", "projected", "stale", "unknown"]),
        exposedToolCount: z.number().int().nonnegative().optional(),
        reason: z.string().optional(),
      })
      .strict(),
    probe: z
      .object({
        state: z.enum(["not-run", "running", "passed", "failed", "unavailable"]),
        checkedAt: ISODateTimeSchema.optional(),
        error: UClawErrorSummarySchema.optional(),
      })
      .strict(),
    credential: SecretStateSchema,
    fields: z.array(ConfigurationFieldSchema),
    error: UClawErrorSummarySchema.optional(),
  })
  .strict();
export type McpServerSummary = z.infer<typeof McpServerSummarySchema>;

export const ToolSummarySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    source: z.enum(["built-in", "skill", "plugin", "mcp", "unknown"]),
    sourceId: z.string().optional(),
    available: z.boolean(),
    risk: ToolRiskSchema,
  })
  .strict();
export type ToolSummary = z.infer<typeof ToolSummarySchema>;

export const ChannelSummarySchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["telegram", "qq-bot", "feishu", "wecom", "wechat-personal", "other"]),
    name: z.string().min(1),
    configured: z.boolean(),
    enabled: z.boolean(),
    state: z.enum(["disconnected", "connecting", "connected", "attention", "error", "unknown"]),
    accountLabel: z.string().optional(),
    unreadCount: z.number().int().nonnegative().optional(),
    credential: SecretStateSchema.optional(),
    fields: z.array(ConfigurationFieldSchema).optional(),
    error: UClawErrorSummarySchema.optional(),
  })
  .strict();
export type ChannelSummary = z.infer<typeof ChannelSummarySchema>;

export const FileSummarySchema = FileRefSchema.extend({
  entryType: z.enum(["file", "directory"]),
  modifiedAt: ISODateTimeSchema,
  writable: z.boolean(),
  childrenCount: z.number().int().nonnegative().optional(),
  revision: z.string().optional(),
}).strict();
export type FileSummary = z.infer<typeof FileSummarySchema>;

export const MemorySummarySchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    preview: z.string(),
    source: ResourceRefSchema.optional(),
    createdAt: ISODateTimeSchema.optional(),
    updatedAt: ISODateTimeSchema,
    revision: z.string().optional(),
  })
  .strict();
export type MemorySummary = z.infer<typeof MemorySummarySchema>;

export const LogSummarySchema = z
  .object({
    id: z.string().min(1),
    timestamp: ISODateTimeSchema,
    level: z.enum(["debug", "info", "warning", "error"]),
    source: z.enum(["launcher", "desktop", "adapter", "gateway", "openclaw", "channel"]),
    message: z.string(),
    correlationId: z.string().optional(),
  })
  .strict();
export type LogSummary = z.infer<typeof LogSummarySchema>;

export const DiagnosticSummarySchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    state: z.enum(["pending", "running", "passed", "warning", "failed", "skipped"]),
    summary: z.string().optional(),
    repairable: z.boolean(),
    error: UClawErrorSummarySchema.optional(),
  })
  .strict();
export type DiagnosticSummary = z.infer<typeof DiagnosticSummarySchema>;

export const UpdateSummarySchema = z
  .object({
    state: z.enum(["unknown", "checking", "up-to-date", "available", "downloading", "ready", "applying", "failed"]),
    currentVersion: z.string().min(1),
    availableVersion: z.string().optional(),
    compatibility: z.enum(["compatible", "requires-migration", "incompatible", "unknown"]).optional(),
    checkedAt: ISODateTimeSchema.optional(),
    error: UClawErrorSummarySchema.optional(),
  })
  .strict();
export type UpdateSummary = z.infer<typeof UpdateSummarySchema>;
