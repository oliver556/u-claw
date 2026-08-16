import { z } from "zod";

import { BasenameSchema, FileRefSchema } from "./common.js";
import { UClawErrorSummarySchema } from "./errors.js";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENT_BASE64_LENGTH = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;
export const MAX_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_BASE64_TOTAL_LENGTH = Math.ceil(MAX_ATTACHMENT_TOTAL_BYTES / 3) * 4;
export const MAX_VIDEO_ATTACHMENT_BYTES = 500 * 1024 * 1024;
export const MAX_ATTACHMENT_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENT_CHUNK_BASE64_LENGTH = Math.ceil(MAX_ATTACHMENT_CHUNK_BYTES / 3) * 4;

export const AttachmentCategorySchema = z.enum(["image", "video", "file"]);
export type AttachmentCategory = z.infer<typeof AttachmentCategorySchema>;

export const AttachmentMediaTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "application/pdf",
  "text/plain",
]);
export type AttachmentMediaType = z.infer<typeof AttachmentMediaTypeSchema>;

export function attachmentCategoryForMediaType(mediaType: AttachmentMediaType): AttachmentCategory {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  return "file";
}

export const AttachmentStateSchema = z.enum([
  "selected", "validating", "ready", "uploading", "attached", "failed", "cancelled",
]);
export type AttachmentState = z.infer<typeof AttachmentStateSchema>;

export const AttachmentSchema = z.object({
  id: z.string().min(1),
  file: FileRefSchema.refine((file) => file.kind === "attachment", "Attachment file kind required"),
  category: AttachmentCategorySchema.optional(),
  state: AttachmentStateSchema,
  progress: z.number().min(0).max(1).optional(),
  error: UClawErrorSummarySchema.optional(),
}).strict();
export type Attachment = z.infer<typeof AttachmentSchema>;

export const AttachmentImportInputSchema = z.object({
  name: BasenameSchema,
  mediaType: z.string().min(1).refine((mediaType) => !mediaType.startsWith("video/"), "Video requires streaming import"),
  size: z.number().int().nonnegative(),
  contentBase64: z.string().max(MAX_ATTACHMENT_BASE64_LENGTH),
}).strict();
export type AttachmentImportInput = z.infer<typeof AttachmentImportInputSchema>;

export const AttachmentImportBeginInputSchema = z.object({
  name: BasenameSchema,
  mediaType: AttachmentMediaTypeSchema,
  size: z.number().int().nonnegative(),
}).strict().superRefine((input, context) => {
  const maxBytes = input.mediaType.startsWith("video/") ? MAX_VIDEO_ATTACHMENT_BYTES : MAX_ATTACHMENT_BYTES;
  if (input.size > maxBytes) {
    context.addIssue({ code: "too_big", origin: "number", maximum: maxBytes, inclusive: true, path: ["size"], message: `Attachment exceeds ${maxBytes} bytes` });
  }
});
export type AttachmentImportBeginInput = z.infer<typeof AttachmentImportBeginInputSchema>;

export const AttachmentImportChunkInputSchema = z.object({
  importId: z.string().min(1),
  offset: z.number().int().nonnegative(),
  contentBase64: z.string().min(1).max(MAX_ATTACHMENT_CHUNK_BASE64_LENGTH),
}).strict();
export type AttachmentImportChunkInput = z.infer<typeof AttachmentImportChunkInputSchema>;

export const AttachmentImportFinishInputSchema = z.object({ importId: z.string().min(1) }).strict();
export type AttachmentImportFinishInput = z.infer<typeof AttachmentImportFinishInputSchema>;

export interface AttachmentService {
  import(input: AttachmentImportInput): Promise<Attachment>;
  beginImport?(input: AttachmentImportBeginInput): Promise<{ importId: string }>;
  importChunk?(input: AttachmentImportChunkInput): Promise<{ nextOffset: number }>;
  finishImport?(input: AttachmentImportFinishInput): Promise<Attachment>;
  get(id: string): Promise<Attachment>;
  prepare(id: string, signal?: AbortSignal): AsyncIterable<Attachment>;
  cancel(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  retain?(id: string): Promise<void>;
  release?(id: string): Promise<void>;
  referencedAttachmentIds?(): ReadonlySet<string> | Promise<ReadonlySet<string>>;
}
