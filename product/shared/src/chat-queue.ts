import { z } from "zod";

import { ISODateTimeSchema } from "./common.js";
import { UClawErrorSummarySchema } from "./errors.js";

const DomainIdSchema = z.string().trim().min(1).max(512);
export const ChatQueueIdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u);

export const ChatQueueStatusSchema = z.enum(["queued", "sending", "failed"]);
export type ChatQueueStatus = z.infer<typeof ChatQueueStatusSchema>;

export const ChatQueueItemSchema = z.object({
  id: DomainIdSchema,
  sessionId: DomainIdSchema,
  text: z.string(),
  attachmentIds: z.array(DomainIdSchema).max(8),
  modelId: DomainIdSchema.optional(),
  skillId: z.string().trim().min(1).max(160).optional(),
  status: ChatQueueStatusSchema,
  idempotencyKey: ChatQueueIdempotencyKeySchema,
  createdAt: ISODateTimeSchema,
  updatedAt: ISODateTimeSchema,
  error: UClawErrorSummarySchema.optional(),
}).strict().superRefine((item, context) => {
  if (item.text.trim() === "" && item.attachmentIds.length === 0) {
    context.addIssue({ code: "custom", path: ["text"], message: "Queue item must contain text or attachments" });
  }
  if (new Set(item.attachmentIds).size !== item.attachmentIds.length) {
    context.addIssue({ code: "custom", path: ["attachmentIds"], message: "Duplicate attachment id" });
  }
  if (item.status === "failed" && item.error === undefined) {
    context.addIssue({ code: "custom", path: ["error"], message: "Failed queue item requires an error" });
  }
  if (item.status !== "failed" && item.error !== undefined) {
    context.addIssue({ code: "custom", path: ["error"], message: "Only failed queue items may contain an error" });
  }
});
export type ChatQueueItem = z.infer<typeof ChatQueueItemSchema>;

export const ChatQueueDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: DomainIdSchema,
  items: z.array(ChatQueueItemSchema),
}).strict().superRefine((document, context) => {
  const itemIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  for (const [index, item] of document.items.entries()) {
    if (item.sessionId !== document.sessionId) {
      context.addIssue({ code: "custom", path: ["items", index, "sessionId"], message: "Queue item session mismatch" });
    }
    if (itemIds.has(item.id)) {
      context.addIssue({ code: "custom", path: ["items", index, "id"], message: "Duplicate queue item id" });
    }
    if (idempotencyKeys.has(item.idempotencyKey)) {
      context.addIssue({ code: "custom", path: ["items", index, "idempotencyKey"], message: "Duplicate idempotency key" });
    }
    itemIds.add(item.id);
    idempotencyKeys.add(item.idempotencyKey);
  }
});
export type ChatQueueDocument = z.infer<typeof ChatQueueDocumentSchema>;

export const ChatQueueListRequestSchema = z.object({ sessionId: DomainIdSchema }).strict();
export type ChatQueueListRequest = z.infer<typeof ChatQueueListRequestSchema>;

export const ChatQueueAddRequestSchema = z.object({
  sessionId: DomainIdSchema,
  text: z.string(),
  attachmentIds: z.array(DomainIdSchema).max(8),
  modelId: DomainIdSchema.optional(),
  skillId: z.string().trim().min(1).max(160).optional(),
  idempotencyKey: ChatQueueIdempotencyKeySchema,
}).strict().superRefine((request, context) => {
  if (request.text.trim() === "" && request.attachmentIds.length === 0) {
    context.addIssue({ code: "custom", path: ["text"], message: "Queue item must contain text or attachments" });
  }
  if (new Set(request.attachmentIds).size !== request.attachmentIds.length) {
    context.addIssue({ code: "custom", path: ["attachmentIds"], message: "Duplicate attachment id" });
  }
});
export type ChatQueueAddRequest = z.infer<typeof ChatQueueAddRequestSchema>;

export const ChatQueueUpdateRequestSchema = z.object({
  sessionId: DomainIdSchema,
  itemId: DomainIdSchema,
  text: z.string().optional(),
  attachmentIds: z.array(DomainIdSchema).max(8).optional(),
  modelId: DomainIdSchema.nullable().optional(),
  skillId: z.string().trim().min(1).max(160).nullable().optional(),
}).strict().superRefine((request, context) => {
  if (request.text === undefined && request.attachmentIds === undefined && request.modelId === undefined && request.skillId === undefined) {
    context.addIssue({ code: "custom", message: "Queue update must contain a change" });
  }
  if (request.attachmentIds !== undefined && new Set(request.attachmentIds).size !== request.attachmentIds.length) {
    context.addIssue({ code: "custom", path: ["attachmentIds"], message: "Duplicate attachment id" });
  }
});
export type ChatQueueUpdateRequest = z.infer<typeof ChatQueueUpdateRequestSchema>;

export const ChatQueueRemoveRequestSchema = z.object({ sessionId: DomainIdSchema, itemId: DomainIdSchema }).strict();
export type ChatQueueRemoveRequest = z.infer<typeof ChatQueueRemoveRequestSchema>;

export const ChatQueueSendRequestSchema = z.object({ sessionId: DomainIdSchema, itemId: DomainIdSchema }).strict();
export type ChatQueueSendRequest = z.infer<typeof ChatQueueSendRequestSchema>;
