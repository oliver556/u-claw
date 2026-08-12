import { z } from "zod";
import { BasenameSchema, ISODateTimeSchema } from "./common.js";
import { UClawErrorSchema, UClawErrorSummarySchema } from "./errors.js";

const IdSchema = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "ID must not be a path");
const EmptySchema = z.object({}).strict();

export const TaskStatusSchema = z.enum(["queued", "running", "waiting-input", "succeeded", "failed", "cancelled"]);
export const TaskRecordSchema = z.object({
  id: IdSchema,
  title: z.string().trim().min(1),
  status: TaskStatusSchema,
  sessionId: IdSchema.optional(),
  createdAt: ISODateTimeSchema,
  updatedAt: ISODateTimeSchema,
  progress: z.number().min(0).max(100).optional(),
  error: UClawErrorSummarySchema.optional(),
}).strict();
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export const TaskEventSchema = z.object({
  type: z.enum(["created", "updated", "removed"]),
  task: TaskRecordSchema,
}).strict();
export type TaskEvent = z.infer<typeof TaskEventSchema>;

export const ArtifactRecordSchema = z.object({
  id: IdSchema,
  name: BasenameSchema,
  mediaType: z.string().trim().min(1),
  size: z.number().int().nonnegative(),
  status: z.enum(["pending", "ready", "failed", "cancelled"]),
  sessionId: IdSchema.optional(),
  taskId: IdSchema.optional(),
  createdAt: ISODateTimeSchema,
}).strict();
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;

export const ArtifactDownloadSchema = z.object({
  artifactId: IdSchema,
  name: BasenameSchema,
  mediaType: z.string().trim().min(1),
  size: z.number().int().nonnegative().max(100 * 1024 * 1024),
  dataBase64: z.string().max(140 * 1024 * 1024),
}).strict();
export type ArtifactDownload = z.infer<typeof ArtifactDownloadSchema>;

export const PersistedArtifactSchema = ArtifactDownloadSchema.omit({ dataBase64: true }).extend({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  downloadedAt: ISODateTimeSchema,
}).strict();
export type PersistedArtifact = z.infer<typeof PersistedArtifactSchema>;

export const TaskIpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("tasks.list"), requestId: IdSchema, params: EmptySchema }).strict(),
  z.object({ method: z.literal("tasks.get"), requestId: IdSchema, params: z.object({ taskId: IdSchema }).strict() }).strict(),
  z.object({ method: z.literal("tasks.cancel"), requestId: IdSchema, params: z.object({ taskId: IdSchema }).strict() }).strict(),
  z.object({ method: z.literal("tasks.retry"), requestId: IdSchema, params: z.object({ taskId: IdSchema }).strict() }).strict(),
]);
export type TaskIpcRequest = z.infer<typeof TaskIpcRequestSchema>;

export const ArtifactIpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("artifacts.list"), requestId: IdSchema, params: z.object({ sessionId: IdSchema.optional() }).strict() }).strict(),
  z.object({ method: z.literal("artifacts.get"), requestId: IdSchema, params: z.object({ artifactId: IdSchema }).strict() }).strict(),
  z.object({ method: z.literal("artifacts.download"), requestId: IdSchema, params: z.object({ artifactId: IdSchema }).strict() }).strict(),
  z.object({ method: z.literal("artifacts.open"), requestId: IdSchema, params: z.object({ artifactId: IdSchema }).strict() }).strict(),
  z.object({ method: z.literal("artifacts.export"), requestId: IdSchema, params: z.object({ artifactId: IdSchema }).strict() }).strict(),
]);
export type ArtifactIpcRequest = z.infer<typeof ArtifactIpcRequestSchema>;
export const TaskArtifactIpcRequestSchema = z.union([TaskIpcRequestSchema, ArtifactIpcRequestSchema]);
export type TaskArtifactIpcRequest = z.infer<typeof TaskArtifactIpcRequestSchema>;

export const TaskArtifactIpcResponseSchema = z.union([
  z.object({ method: z.string(), requestId: IdSchema, ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ method: z.string(), requestId: IdSchema, ok: z.literal(false), error: UClawErrorSchema }).strict(),
]);
export type TaskArtifactIpcResponse = z.infer<typeof TaskArtifactIpcResponseSchema>;

export const TaskArtifactIpcEventSchema = z.object({ event: z.literal("task"), payload: TaskEventSchema }).strict();
export const TASK_ARTIFACT_IPC_CHANNEL = "uclaw:task-artifacts";
export const TASK_ARTIFACT_EVENT_CHANNEL = "uclaw:task-artifact-event";

export interface TaskArtifactAuthority {
  listTasks(): Promise<TaskRecord[]>;
  getTask(taskId: string): Promise<TaskRecord>;
  cancelTask(taskId: string): Promise<TaskRecord>;
  retryTask(taskId: string): Promise<TaskRecord>;
  watchTasks(listener: (event: TaskEvent) => void): () => void;
  listArtifacts(sessionId?: string): Promise<ArtifactRecord[]>;
  getArtifact(artifactId: string): Promise<ArtifactRecord>;
  downloadArtifact(artifactId: string): Promise<ArtifactDownload>;
}
