import { z } from "zod";

import { BasenameSchema, ControlledRelativePathSchema, ISODateTimeSchema } from "./common.js";
import { UClawErrorSchema } from "./errors.js";

const RequestIdSchema = z.string().min(1).max(128);
const CursorSchema = z.string().min(1).max(128);
const QuerySchema = z.string().trim().max(200).optional();
export const DiagnosticLogLevelSchema = z.enum(["debug", "info", "warning", "error"]);
export const DiagnosticLogSourceSchema = z.enum(["launcher", "desktop", "adapter", "gateway", "openclaw", "channel"]);

export const DiagnosticLogEntrySchema = z.object({
  id: z.string().min(1).max(128),
  timestamp: ISODateTimeSchema,
  level: DiagnosticLogLevelSchema,
  source: DiagnosticLogSourceSchema,
  message: z.string().min(1).max(500),
}).strict();
export type DiagnosticLogEntry = z.infer<typeof DiagnosticLogEntrySchema>;

const LogFilterSchema = z.object({
  cursor: CursorSchema.optional(),
  limit: z.number().int().min(1).max(500).default(100),
  query: QuerySchema,
  levels: z.array(DiagnosticLogLevelSchema).max(4).optional(),
  sources: z.array(DiagnosticLogSourceSchema).max(6).optional(),
  from: ISODateTimeSchema.optional(),
  to: ISODateTimeSchema.optional(),
}).strict();

const ExportParamsSchema = z.object({
  fileName: BasenameSchema,
  query: QuerySchema,
  levels: z.array(DiagnosticLogLevelSchema).max(4).optional(),
  sources: z.array(DiagnosticLogSourceSchema).max(6).optional(),
  from: ISODateTimeSchema.optional(),
  to: ISODateTimeSchema.optional(),
}).strict();

export const DiagnosticsIpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("logs.list"), requestId: RequestIdSchema, params: LogFilterSchema }).strict(),
  z.object({ method: z.literal("logs.export"), requestId: RequestIdSchema, params: ExportParamsSchema }).strict(),
  z.object({ method: z.literal("logs.cleanup-preview"), requestId: RequestIdSchema, params: z.object({ retentionDays: z.number().int().min(1).max(3650) }).strict() }).strict(),
  z.object({ method: z.literal("logs.cleanup"), requestId: RequestIdSchema, params: z.object({ previewId: z.string().uuid(), confirm: z.literal(true) }).strict() }).strict(),
  z.object({ method: z.literal("system.get"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("config.get"), requestId: RequestIdSchema, params: z.object({ query: QuerySchema }).strict() }).strict(),
  z.object({ method: z.literal("config.export"), requestId: RequestIdSchema, params: z.object({ fileName: BasenameSchema }).strict() }).strict(),
  z.object({ method: z.literal("operations.cancel"), requestId: RequestIdSchema, params: z.object({ operationRequestId: RequestIdSchema }).strict() }).strict(),
]);
export type DiagnosticsIpcRequest = z.infer<typeof DiagnosticsIpcRequestSchema>;

const LogPageSchema = z.object({
  items: z.array(DiagnosticLogEntrySchema).max(500),
  nextCursor: CursorSchema.nullable(),
  hasMore: z.boolean(),
}).strict();

const ExportResultSchema = z.object({
  name: BasenameSchema,
  relativePath: ControlledRelativePathSchema,
  bytes: z.number().int().nonnegative(),
  createdAt: ISODateTimeSchema,
}).strict();

const CleanupPreviewSchema = z.object({
  previewId: z.string().uuid(),
  retentionDays: z.number().int().positive(),
  totalBytes: z.number().int().nonnegative(),
  files: z.array(z.object({ name: BasenameSchema, size: z.number().int().nonnegative(), modifiedAt: ISODateTimeSchema }).strict()).max(1000),
}).strict();

export const SystemSummarySchema = z.object({
  product: z.object({ name: z.literal("U-Claw"), version: z.string().min(1).max(80) }).strict(),
  runtime: z.object({ node: z.string().max(80), electron: z.string().max(80), openclaw: z.string().max(80) }).strict(),
  platform: z.enum(["win32", "darwin", "linux", "other"]),
  architecture: z.string().min(1).max(32),
  gateway: z.object({ status: z.enum(["starting", "ready", "degraded", "offline", "unknown"]), port: z.number().int().min(1).max(65535).nullable() }).strict(),
  proxy: z.string().max(300).nullable(),
  portableData: z.object({ state: z.enum(["available", "read-only", "missing", "error"]), writable: z.boolean() }).strict(),
  storage: z.object({ totalBytes: z.number().int().nonnegative(), freeBytes: z.number().int().nonnegative(), usedBytes: z.number().int().nonnegative() }).strict(),
}).strict();
export type SystemSummary = z.infer<typeof SystemSummarySchema>;

const ConfigResultSchema = z.object({
  content: z.string().max(1_000_000),
  entries: z.array(z.object({ path: z.string().min(1).max(300), value: z.string().max(500) }).strict()).max(500),
  truncated: z.boolean(),
}).strict();

const SuccessSchemas = [
  z.object({ method: z.literal("logs.list"), requestId: RequestIdSchema, ok: z.literal(true), result: LogPageSchema }).strict(),
  z.object({ method: z.literal("logs.export"), requestId: RequestIdSchema, ok: z.literal(true), result: ExportResultSchema }).strict(),
  z.object({ method: z.literal("logs.cleanup-preview"), requestId: RequestIdSchema, ok: z.literal(true), result: CleanupPreviewSchema }).strict(),
  z.object({ method: z.literal("logs.cleanup"), requestId: RequestIdSchema, ok: z.literal(true), result: z.object({ removedFiles: z.number().int().nonnegative(), removedBytes: z.number().int().nonnegative(), pendingPhysicalFiles: z.number().int().nonnegative().optional() }).strict() }).strict(),
  z.object({ method: z.literal("system.get"), requestId: RequestIdSchema, ok: z.literal(true), result: SystemSummarySchema }).strict(),
  z.object({ method: z.literal("config.get"), requestId: RequestIdSchema, ok: z.literal(true), result: ConfigResultSchema }).strict(),
  z.object({ method: z.literal("config.export"), requestId: RequestIdSchema, ok: z.literal(true), result: ExportResultSchema }).strict(),
  z.object({ method: z.literal("operations.cancel"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
] as const;

const DiagnosticsMethodSchema = z.enum(["logs.list", "logs.export", "logs.cleanup-preview", "logs.cleanup", "system.get", "config.get", "config.export", "operations.cancel"]);
export const DiagnosticsIpcResponseSchema = z.union([
  ...SuccessSchemas,
  z.object({ method: DiagnosticsMethodSchema, requestId: RequestIdSchema, ok: z.literal(false), error: UClawErrorSchema }).strict(),
]);
export type DiagnosticsIpcResponse = z.infer<typeof DiagnosticsIpcResponseSchema>;
