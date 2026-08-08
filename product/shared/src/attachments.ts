import { z } from "zod";

import { BasenameSchema, FileRefSchema } from "./common.js";
import { UClawErrorSummarySchema } from "./errors.js";

export const AttachmentStateSchema = z.enum([
  "selected", "validating", "ready", "uploading", "attached", "failed", "cancelled",
]);
export type AttachmentState = z.infer<typeof AttachmentStateSchema>;

export const AttachmentSchema = z.object({
  id: z.string().min(1),
  file: FileRefSchema.refine((file) => file.kind === "attachment", "Attachment file kind required"),
  state: AttachmentStateSchema,
  progress: z.number().min(0).max(1).optional(),
  error: UClawErrorSummarySchema.optional(),
}).strict();
export type Attachment = z.infer<typeof AttachmentSchema>;

export const AttachmentImportInputSchema = z.object({
  name: BasenameSchema,
  mediaType: z.string().min(1),
  size: z.number().int().nonnegative(),
  contentBase64: z.string(),
}).strict();
export type AttachmentImportInput = z.infer<typeof AttachmentImportInputSchema>;

export interface AttachmentService {
  import(input: AttachmentImportInput): Promise<Attachment>;
  get(id: string): Promise<Attachment>;
  prepare(id: string, signal?: AbortSignal): AsyncIterable<Attachment>;
  cancel(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}
