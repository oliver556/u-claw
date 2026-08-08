import { z } from "zod";

import { FileRefSchema, ISODateTimeSchema, ModelRefSchema, PageRequestSchema, ResourceRefSchema, StringMapValueSchema } from "./common.js";
import { UClawErrorSchema, UClawErrorSummarySchema } from "./errors.js";
import { ApprovalRequestSchema, ToolCallSchema } from "./tools.js";

export const SessionSummarySchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    createdAt: ISODateTimeSchema.optional(),
    updatedAt: ISODateTimeSchema,
    lastMessagePreview: z.string().optional(),
    model: ModelRefSchema.optional(),
    pinned: z.boolean(),
    groupId: z.string().nullable().optional(),
    status: z.enum(["idle", "running", "waiting-authorization", "failed"]),
  })
  .strict();
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const SessionSchema = SessionSummarySchema.extend({
  revision: z.string().optional(),
  metadata: z.record(z.string(), StringMapValueSchema).optional(),
}).strict();
export type Session = z.infer<typeof SessionSchema>;

export const SessionListRequestSchema = PageRequestSchema.extend({
  query: z.string().min(1).optional(),
}).strict();
export type SessionListRequest = z.infer<typeof SessionListRequestSchema>;

export const CreateSessionInputSchema = z.object({
  title: z.string().trim().min(1).optional(),
  modelId: z.string().min(1).optional(),
}).strict();
export type CreateSessionInput = z.infer<typeof CreateSessionInputSchema>;

export const ContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string(), type: z.literal("text"), text: z.string(), format: z.enum(["plain", "markdown"]) }).strict(),
  z.object({ id: z.string(), type: z.literal("code"), code: z.string(), language: z.string().optional(), filename: z.string().optional() }).strict(),
  z.object({ id: z.string(), type: z.literal("image"), file: FileRefSchema, alt: z.string().optional() }).strict(),
  z.object({ id: z.string(), type: z.literal("file"), file: FileRefSchema }).strict(),
  z.object({ id: z.string(), type: z.literal("citation"), source: ResourceRefSchema, label: z.string(), excerpt: z.string().optional() }).strict(),
  z.object({ id: z.string(), type: z.literal("tool-call"), toolCallId: z.string().min(1) }).strict(),
  z.object({ id: z.string(), type: z.literal("notice"), level: z.enum(["info", "warning", "error"]), text: z.string() }).strict(),
  z.object({ id: z.string(), type: z.literal("unsupported"), originalType: z.string(), summary: z.string() }).strict(),
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

export const MessageSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    runId: z.string().min(1).optional(),
    role: z.enum(["user", "assistant", "system", "tool"]),
    status: z.enum(["queued", "streaming", "waiting-authorization", "completed", "cancelled", "failed"]),
    blocks: z.array(ContentBlockSchema),
    createdAt: ISODateTimeSchema,
    updatedAt: ISODateTimeSchema.optional(),
    model: ModelRefSchema.optional(),
    error: UClawErrorSummarySchema.optional(),
  })
  .strict();
export type Message = z.infer<typeof MessageSchema>;

export const SendMessageInputSchema = z
  .object({
    sessionId: z.string().min(1),
    clientRequestId: z.string().min(1),
    blocks: z.array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("text"), text: z.string(), format: z.enum(["plain", "markdown"]) }).strict(),
        z.object({ type: z.literal("attachment"), attachmentId: z.string().min(1) }).strict(),
      ]),
    ).min(1),
    modelId: z.string().min(1).optional(),
  })
  .strict();
export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

const MessageEventUnionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), runId: z.string().min(1), sessionId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("delta"), runId: z.string().min(1), mode: z.enum(["append", "replace"]), text: z.string() }).strict(),
  z.object({ type: z.literal("tool"), runId: z.string().min(1), tool: ToolCallSchema }).strict(),
  z.object({ type: z.literal("approval"), runId: z.string().min(1), approval: ApprovalRequestSchema }).strict(),
  z.object({ type: z.literal("final"), runId: z.string().min(1), message: MessageSchema }).strict(),
  z.object({ type: z.literal("aborted"), runId: z.string().min(1), reason: z.string().optional() }).strict(),
  z.object({ type: z.literal("error"), runId: z.string().min(1), error: UClawErrorSchema }).strict(),
]);
export const MessageEventSchema = MessageEventUnionSchema.superRefine((event, context) => {
  if (event.type !== "final") return;
  if (event.message.status !== "completed") {
    context.addIssue({ code: "custom", path: ["message", "status"], message: "Final message must be completed" });
  }
  if (event.message.runId !== undefined && event.message.runId !== event.runId) {
    context.addIssue({ code: "custom", path: ["message", "runId"], message: "Final message runId must match event runId" });
  }
});
export type MessageEvent = z.infer<typeof MessageEventSchema>;

const TerminalMessageEventUnionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("final"), runId: z.string().min(1), message: MessageSchema }).strict(),
  z.object({ type: z.literal("aborted"), runId: z.string().min(1), reason: z.string().optional() }).strict(),
  z.object({ type: z.literal("error"), runId: z.string().min(1), error: UClawErrorSchema }).strict(),
]);
export const TerminalMessageEventSchema = TerminalMessageEventUnionSchema.superRefine((event, context) => {
  if (event.type !== "final") return;
  if (event.message.status !== "completed") {
    context.addIssue({ code: "custom", path: ["message", "status"], message: "Final message must be completed" });
  }
  if (event.message.runId !== undefined && event.message.runId !== event.runId) {
    context.addIssue({ code: "custom", path: ["message", "runId"], message: "Final message runId must match event runId" });
  }
});
export type TerminalMessageEvent = z.infer<typeof TerminalMessageEventSchema>;
