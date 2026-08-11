import { z } from "zod";

import { SessionSchema } from "./chat.js";
import { UClawErrorSchema } from "./errors.js";

const IdSchema = z.string().trim().min(1).max(512);
const RequestIdSchema = z.string().min(1);
const RelativePathSchema = z.string().max(2_048).refine((value) => {
  const normalized = value.replaceAll("\\", "/");
  return !normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized) &&
    !normalized.split("/").some((segment) => segment === "..");
}, "Path must stay inside the session workspace");
const FilePathSchema = RelativePathSchema.refine((value) => value.length > 0, "File path is required");

export const SessionFileEntrySchema = z.object({
  path: FilePathSchema,
  workspacePath: FilePathSchema.optional(),
  name: z.string().min(1).max(512),
  kind: z.enum(["modified", "read"]),
  missing: z.boolean(),
  size: z.number().int().nonnegative().optional(),
  updatedAtMs: z.number().int().nonnegative().optional(),
  content: z.string().optional(),
}).strict();
export type SessionFileEntry = z.infer<typeof SessionFileEntrySchema>;

export const SessionFileBrowserEntrySchema = z.object({
  path: RelativePathSchema,
  name: z.string().min(1).max(512),
  kind: z.enum(["file", "directory"]),
  sessionKind: z.enum(["modified", "read", "mixed"]).optional(),
  size: z.number().int().nonnegative().optional(),
  updatedAtMs: z.number().int().nonnegative().optional(),
}).strict();

export const SessionFileBrowserResultSchema = z.object({
  path: RelativePathSchema,
  parentPath: RelativePathSchema.optional(),
  search: z.string().optional(),
  entries: z.array(SessionFileBrowserEntrySchema),
  truncated: z.boolean().optional(),
}).strict();

export const SessionFileListInputSchema = z.object({
  sessionId: IdSchema,
  agentId: IdSchema.optional(),
  path: RelativePathSchema.optional(),
  search: z.string().trim().min(1).max(200).optional(),
}).strict();
export type SessionFileListInput = z.infer<typeof SessionFileListInputSchema>;

export const SessionFileGetInputSchema = z.object({
  sessionId: IdSchema,
  path: FilePathSchema,
  agentId: IdSchema.optional(),
}).strict();
export type SessionFileGetInput = z.infer<typeof SessionFileGetInputSchema>;

export const SessionFileListResultSchema = z.object({
  sessionId: IdSchema,
  files: z.array(SessionFileEntrySchema),
  browser: SessionFileBrowserResultSchema.optional(),
}).strict();
export type SessionFileListResult = z.infer<typeof SessionFileListResultSchema>;

export const SessionFileGetResultSchema = z.object({
  sessionId: IdSchema,
  file: SessionFileEntrySchema,
}).strict();
export type SessionFileGetResult = z.infer<typeof SessionFileGetResultSchema>;

const CheckpointSideSchema = z.object({
  sessionId: IdSchema,
  sessionFile: z.string().min(1).optional(),
  leafId: IdSchema.optional(),
  entryId: IdSchema.optional(),
}).strict();

export const SessionCheckpointSchema = z.object({
  checkpointId: IdSchema,
  sessionId: IdSchema,
  transcriptId: IdSchema,
  createdAt: z.number().int().nonnegative(),
  reason: z.enum(["manual", "auto-threshold", "overflow-retry", "timeout-retry"]),
  tokensBefore: z.number().int().nonnegative().optional(),
  tokensAfter: z.number().int().nonnegative().optional(),
  summary: z.string().optional(),
  firstKeptEntryId: IdSchema.optional(),
  preCompaction: CheckpointSideSchema,
  postCompaction: CheckpointSideSchema,
}).strict();
export type SessionCheckpoint = z.infer<typeof SessionCheckpointSchema>;

export const SessionIdInputSchema = z.object({ sessionId: IdSchema, agentId: IdSchema.optional() }).strict();
export const SessionResetInputSchema = SessionIdInputSchema.extend({ reason: z.enum(["new", "reset"]).optional() }).strict();
export const SessionCompactInputSchema = SessionIdInputSchema.extend({ maxLines: z.number().int().positive().optional() }).strict();
export const SessionCheckpointInputSchema = SessionIdInputSchema.extend({ checkpointId: IdSchema }).strict();
export const SessionSteerInputSchema = SessionIdInputSchema.extend({
  message: z.string().trim().min(1).max(200_000),
  thinking: z.string().trim().min(1).max(80).optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
  idempotencyKey: IdSchema.optional(),
}).strict();

export type SessionIdInput = z.infer<typeof SessionIdInputSchema>;
export type SessionResetInput = z.infer<typeof SessionResetInputSchema>;
export type SessionCompactInput = z.infer<typeof SessionCompactInputSchema>;
export type SessionCheckpointInput = z.infer<typeof SessionCheckpointInputSchema>;
export type SessionSteerInput = z.infer<typeof SessionSteerInputSchema>;

export const SessionCheckpointListResultSchema = z.object({
  sessionId: IdSchema,
  checkpoints: z.array(SessionCheckpointSchema),
}).strict();

export const SessionResetResultSchema = z.object({ operation: z.literal("reset"), session: SessionSchema }).strict();
export const SessionCompactResultSchema = z.object({
  operation: z.literal("compact"),
  session: SessionSchema,
  compacted: z.boolean(),
  reason: z.string().optional(),
  kept: z.number().int().nonnegative().optional(),
  checkpoints: z.array(SessionCheckpointSchema),
}).strict();
export const SessionBranchResultSchema = z.object({
  operation: z.literal("branch"), sourceSessionId: IdSchema, session: SessionSchema, checkpoint: SessionCheckpointSchema,
}).strict();
export const SessionRestoreResultSchema = z.object({
  operation: z.literal("restore"), session: SessionSchema, checkpoint: SessionCheckpointSchema,
}).strict();
export const SessionSteerResultSchema = z.object({
  operation: z.literal("steer"), runId: IdSchema, status: z.string().min(1),
  interruptedActiveRun: z.boolean().optional(), messageSeq: z.number().int().positive().optional(), session: SessionSchema,
}).strict();

export interface SessionAdvancedService {
  listFiles(input: SessionFileListInput): Promise<SessionFileListResult>;
  getFile(input: SessionFileGetInput): Promise<SessionFileGetResult>;
  listCheckpoints(input: SessionIdInput): Promise<z.infer<typeof SessionCheckpointListResultSchema>>;
  reset(input: SessionResetInput): Promise<z.infer<typeof SessionResetResultSchema>>;
  compact(input: SessionCompactInput): Promise<z.infer<typeof SessionCompactResultSchema>>;
  branch(input: SessionCheckpointInput): Promise<z.infer<typeof SessionBranchResultSchema>>;
  restore(input: SessionCheckpointInput): Promise<z.infer<typeof SessionRestoreResultSchema>>;
  steer(input: SessionSteerInput): Promise<z.infer<typeof SessionSteerResultSchema>>;
}

export const SessionAdvancedIpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("sessions.files.list"), requestId: RequestIdSchema, params: SessionFileListInputSchema }).strict(),
  z.object({ method: z.literal("sessions.files.get"), requestId: RequestIdSchema, params: SessionFileGetInputSchema }).strict(),
  z.object({ method: z.literal("sessions.checkpoints.list"), requestId: RequestIdSchema, params: SessionIdInputSchema }).strict(),
  z.object({ method: z.literal("sessions.reset"), requestId: RequestIdSchema, params: SessionResetInputSchema }).strict(),
  z.object({ method: z.literal("sessions.compact"), requestId: RequestIdSchema, params: SessionCompactInputSchema }).strict(),
  z.object({ method: z.literal("sessions.branch"), requestId: RequestIdSchema, params: SessionCheckpointInputSchema }).strict(),
  z.object({ method: z.literal("sessions.restore"), requestId: RequestIdSchema, params: SessionCheckpointInputSchema }).strict(),
  z.object({ method: z.literal("sessions.steer"), requestId: RequestIdSchema, params: SessionSteerInputSchema }).strict(),
]);
export type SessionAdvancedIpcRequest = z.infer<typeof SessionAdvancedIpcRequestSchema>;

const SessionAdvancedSuccessResponseSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("sessions.files.list"), requestId: RequestIdSchema, ok: z.literal(true), result: SessionFileListResultSchema }).strict(),
  z.object({ method: z.literal("sessions.files.get"), requestId: RequestIdSchema, ok: z.literal(true), result: SessionFileGetResultSchema }).strict(),
  z.object({ method: z.literal("sessions.checkpoints.list"), requestId: RequestIdSchema, ok: z.literal(true), result: SessionCheckpointListResultSchema }).strict(),
  z.object({ method: z.literal("sessions.reset"), requestId: RequestIdSchema, ok: z.literal(true), result: SessionResetResultSchema }).strict(),
  z.object({ method: z.literal("sessions.compact"), requestId: RequestIdSchema, ok: z.literal(true), result: SessionCompactResultSchema }).strict(),
  z.object({ method: z.literal("sessions.branch"), requestId: RequestIdSchema, ok: z.literal(true), result: SessionBranchResultSchema }).strict(),
  z.object({ method: z.literal("sessions.restore"), requestId: RequestIdSchema, ok: z.literal(true), result: SessionRestoreResultSchema }).strict(),
  z.object({ method: z.literal("sessions.steer"), requestId: RequestIdSchema, ok: z.literal(true), result: SessionSteerResultSchema }).strict(),
]);
const MethodSchema = z.enum(["sessions.files.list", "sessions.files.get", "sessions.checkpoints.list", "sessions.reset", "sessions.compact", "sessions.branch", "sessions.restore", "sessions.steer"]);
export const SessionAdvancedIpcResponseSchema = z.union([
  SessionAdvancedSuccessResponseSchema,
  z.object({ method: MethodSchema, requestId: RequestIdSchema, ok: z.literal(false), error: UClawErrorSchema }).strict(),
]);
export type SessionAdvancedIpcResponse = z.infer<typeof SessionAdvancedIpcResponseSchema>;

export const SESSION_ADVANCED_IPC_CHANNEL = "uclaw:session-advanced";
