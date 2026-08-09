import { z } from "zod";

import { BasenameSchema, ISODateTimeSchema } from "./common.js";
import { UClawErrorSummarySchema } from "./errors.js";

export const ActivityDomainIdSchema = z.string().min(1).max(256).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
  "Domain ID must not be a path",
);

export const TaskActivityStateSchema = z.enum([
  "running",
  "waiting-input",
  "succeeded",
  "failed",
  "cancelled",
]);
export type TaskActivityState = z.infer<typeof TaskActivityStateSchema>;

export const TaskActivitySchema = z.object({
  id: ActivityDomainIdSchema,
  sessionId: ActivityDomainIdSchema,
  sessionTitle: z.string(),
  runId: ActivityDomainIdSchema.optional(),
  title: z.string().min(1),
  state: TaskActivityStateSchema,
  updatedAt: ISODateTimeSchema,
  error: UClawErrorSummarySchema.optional(),
}).strict();
export type TaskActivity = z.infer<typeof TaskActivitySchema>;

export const TaskActivitySnapshotSchema = z.object({
  contractVersion: z.literal(1),
  generatedAt: ISODateTimeSchema,
  source: z.literal("openclaw"),
  tasks: z.array(TaskActivitySchema),
}).strict();
export type TaskActivitySnapshot = z.infer<typeof TaskActivitySnapshotSchema>;

export const ArtifactStatusSchema = z.enum(["pending", "ready", "failed", "cancelled"]);
export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;

export const ArtifactEntrySchema = z.object({
  id: ActivityDomainIdSchema,
  sessionId: ActivityDomainIdSchema,
  messageId: ActivityDomainIdSchema,
  runId: ActivityDomainIdSchema.optional(),
  name: BasenameSchema,
  mediaType: z.string().min(1),
  size: z.number().int().nonnegative(),
  createdAt: ISODateTimeSchema,
  status: ArtifactStatusSchema,
}).strict();
export type ArtifactEntry = z.infer<typeof ArtifactEntrySchema>;

export const ArtifactSnapshotSchema = z.object({
  contractVersion: z.literal(1),
  generatedAt: ISODateTimeSchema,
  source: z.literal("openclaw"),
  artifacts: z.array(ArtifactEntrySchema),
}).strict();
export type ArtifactSnapshot = z.infer<typeof ArtifactSnapshotSchema>;

export interface ActivityCenterService {
  list(): Promise<TaskActivitySnapshot>;
}

export interface ArtifactService {
  list(sessionId?: string): Promise<ArtifactSnapshot>;
}
