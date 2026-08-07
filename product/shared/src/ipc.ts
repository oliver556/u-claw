import { z } from "zod";

import {
  MessageEventSchema,
  MessageSchema,
  SendMessageInputSchema,
  SessionSchema,
  SessionSummarySchema,
} from "./chat.js";
import { PageRequestSchema } from "./common.js";
import { UClawErrorSchema } from "./errors.js";
import { CapabilitySetWireSchema, GatewayStatusWireSchema } from "./gateway.js";
import {
  ChannelSummarySchema,
  DiagnosticSummarySchema,
  FileSummarySchema,
  LogSummarySchema,
  ModelSummarySchema,
  SkillSummarySchema,
  ToolSummarySchema,
} from "./management.js";
import {
  ApprovalRequestSchema,
  ResolveExecApprovalInputSchema,
  ResolvePluginApprovalInputSchema,
  ToolCallSchema,
} from "./tools.js";

const EmptyParamsSchema = z.object({}).strict();
const RequestIdSchema = z.string().min(1);
const SubscriptionIdSchema = z.string().min(1);

export const WindowIpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("minimize"), requestId: RequestIdSchema, params: EmptyParamsSchema }).strict(),
  z.object({ method: z.literal("toggle-maximize"), requestId: RequestIdSchema, params: EmptyParamsSchema }).strict(),
  z.object({ method: z.literal("close"), requestId: RequestIdSchema, params: EmptyParamsSchema }).strict(),
]);
export type WindowIpcRequest = z.infer<typeof WindowIpcRequestSchema>;

export const WindowIpcSuccessResponseSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("minimize"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
  z.object({ method: z.literal("toggle-maximize"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
  z.object({ method: z.literal("close"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
]);
export type WindowIpcSuccessResponse = z.infer<typeof WindowIpcSuccessResponseSchema>;

export const WindowIpcFailureResponseSchema = z
  .object({
    method: z.enum(["minimize", "toggle-maximize", "close"]),
    requestId: RequestIdSchema,
    ok: z.literal(false),
    error: UClawErrorSchema,
  })
  .strict();
export type WindowIpcFailureResponse = z.infer<typeof WindowIpcFailureResponseSchema>;

const SessionIdParamsSchema = z.object({ sessionId: z.string().min(1) }).strict();
const SessionPageParamsSchema = SessionIdParamsSchema.extend(PageRequestSchema.shape).strict();
const PageResponseSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable(), hasMore: z.boolean() }).strict();

export const ClientIpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("gateway.negotiate"), requestId: RequestIdSchema, params: EmptyParamsSchema }).strict(),
  z.object({ method: z.literal("gateway.get-status"), requestId: RequestIdSchema, params: EmptyParamsSchema }).strict(),
  z.object({ method: z.literal("gateway.watch-status"), requestId: RequestIdSchema, params: z.object({ subscriptionId: SubscriptionIdSchema }).strict() }).strict(),
  z.object({ method: z.literal("gateway.reconnect"), requestId: RequestIdSchema, params: EmptyParamsSchema }).strict(),
  z.object({ method: z.literal("sessions.list"), requestId: RequestIdSchema, params: PageRequestSchema }).strict(),
  z.object({ method: z.literal("sessions.get"), requestId: RequestIdSchema, params: SessionIdParamsSchema }).strict(),
  z.object({ method: z.literal("sessions.create"), requestId: RequestIdSchema, params: z.object({ title: z.string().optional(), modelId: z.string().min(1).optional() }).strict() }).strict(),
  z.object({ method: z.literal("sessions.remove"), requestId: RequestIdSchema, params: z.object({ sessionId: z.string().min(1), revision: z.string().optional() }).strict() }).strict(),
  z.object({ method: z.literal("chat.list"), requestId: RequestIdSchema, params: SessionPageParamsSchema }).strict(),
  z.object({ method: z.literal("chat.get"), requestId: RequestIdSchema, params: z.object({ sessionId: z.string().min(1), messageId: z.string().min(1) }).strict() }).strict(),
  z.object({ method: z.literal("chat.watch"), requestId: RequestIdSchema, params: z.object({ sessionId: z.string().min(1), subscriptionId: SubscriptionIdSchema }).strict() }).strict(),
  z.object({ method: z.literal("chat.send"), requestId: RequestIdSchema, params: SendMessageInputSchema }).strict(),
  z.object({ method: z.literal("chat.abort"), requestId: RequestIdSchema, params: z.object({ runId: z.string().min(1) }).strict() }).strict(),
  z.object({ method: z.literal("tools.list"), requestId: RequestIdSchema, params: EmptyParamsSchema }).strict(),
  z.object({ method: z.literal("tools.get-call"), requestId: RequestIdSchema, params: z.object({ toolCallId: z.string().min(1) }).strict() }).strict(),
  z.object({ method: z.literal("approvals.list-pending"), requestId: RequestIdSchema, params: z.object({ sessionId: z.string().min(1).optional() }).strict() }).strict(),
  z.object({ method: z.literal("approvals.resolve-exec"), requestId: RequestIdSchema, params: ResolveExecApprovalInputSchema }).strict(),
  z.object({ method: z.literal("approvals.resolve-plugin"), requestId: RequestIdSchema, params: ResolvePluginApprovalInputSchema }).strict(),
  z.object({ method: z.literal("models.list"), requestId: RequestIdSchema, params: EmptyParamsSchema }).strict(),
  z.object({ method: z.literal("models.select-for-session"), requestId: RequestIdSchema, params: z.object({ sessionId: z.string().min(1), modelId: z.string().min(1) }).strict() }).strict(),
  z.object({ method: z.literal("skills.list"), requestId: RequestIdSchema, params: EmptyParamsSchema }).strict(),
  z.object({ method: z.literal("channels.list"), requestId: RequestIdSchema, params: EmptyParamsSchema }).strict(),
  z.object({ method: z.literal("files.list"), requestId: RequestIdSchema, params: z.object({ parentId: z.string().min(1).optional(), cursor: z.string().optional(), limit: z.number().int().positive().optional() }).strict() }).strict(),
  z.object({ method: z.literal("files.read-text"), requestId: RequestIdSchema, params: z.object({ fileId: z.string().min(1) }).strict() }).strict(),
  z.object({ method: z.literal("diagnostics.list"), requestId: RequestIdSchema, params: EmptyParamsSchema }).strict(),
  z.object({ method: z.literal("diagnostics.list-logs"), requestId: RequestIdSchema, params: PageRequestSchema }).strict(),
  z.object({ method: z.literal("subscriptions.cancel"), requestId: RequestIdSchema, params: z.object({ subscriptionId: SubscriptionIdSchema }).strict() }).strict(),
]);
export type ClientIpcRequest = z.infer<typeof ClientIpcRequestSchema>;

export const ClientIpcSuccessResponseSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("gateway.negotiate"), requestId: RequestIdSchema, ok: z.literal(true), result: CapabilitySetWireSchema }).strict(),
  z.object({ method: z.literal("gateway.get-status"), requestId: RequestIdSchema, ok: z.literal(true), result: GatewayStatusWireSchema }).strict(),
  z.object({ method: z.literal("gateway.watch-status"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
  z.object({ method: z.literal("gateway.reconnect"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
  z.object({ method: z.literal("sessions.list"), requestId: RequestIdSchema, ok: z.literal(true), result: PageResponseSchema(SessionSummarySchema) }).strict(),
  z.object({ method: z.literal("sessions.get"), requestId: RequestIdSchema, ok: z.literal(true), result: SessionSchema }).strict(),
  z.object({ method: z.literal("sessions.create"), requestId: RequestIdSchema, ok: z.literal(true), result: SessionSchema }).strict(),
  z.object({ method: z.literal("sessions.remove"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
  z.object({ method: z.literal("chat.list"), requestId: RequestIdSchema, ok: z.literal(true), result: PageResponseSchema(MessageSchema) }).strict(),
  z.object({ method: z.literal("chat.get"), requestId: RequestIdSchema, ok: z.literal(true), result: MessageSchema }).strict(),
  z.object({ method: z.literal("chat.watch"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
  z.object({ method: z.literal("chat.send"), requestId: RequestIdSchema, ok: z.literal(true), result: z.object({ clientRequestId: z.string().min(1), runId: z.string().min(1) }).strict() }).strict(),
  z.object({ method: z.literal("chat.abort"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
  z.object({ method: z.literal("tools.list"), requestId: RequestIdSchema, ok: z.literal(true), result: z.array(ToolSummarySchema) }).strict(),
  z.object({ method: z.literal("tools.get-call"), requestId: RequestIdSchema, ok: z.literal(true), result: ToolCallSchema }).strict(),
  z.object({ method: z.literal("approvals.list-pending"), requestId: RequestIdSchema, ok: z.literal(true), result: z.array(ApprovalRequestSchema) }).strict(),
  z.object({ method: z.literal("approvals.resolve-exec"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
  z.object({ method: z.literal("approvals.resolve-plugin"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
  z.object({ method: z.literal("models.list"), requestId: RequestIdSchema, ok: z.literal(true), result: z.array(ModelSummarySchema) }).strict(),
  z.object({ method: z.literal("models.select-for-session"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
  z.object({ method: z.literal("skills.list"), requestId: RequestIdSchema, ok: z.literal(true), result: z.array(SkillSummarySchema) }).strict(),
  z.object({ method: z.literal("channels.list"), requestId: RequestIdSchema, ok: z.literal(true), result: z.array(ChannelSummarySchema) }).strict(),
  z.object({ method: z.literal("files.list"), requestId: RequestIdSchema, ok: z.literal(true), result: PageResponseSchema(FileSummarySchema) }).strict(),
  z.object({ method: z.literal("files.read-text"), requestId: RequestIdSchema, ok: z.literal(true), result: z.object({ file: FileSummarySchema, content: z.string(), encoding: z.literal("utf-8") }).strict() }).strict(),
  z.object({ method: z.literal("diagnostics.list"), requestId: RequestIdSchema, ok: z.literal(true), result: z.array(DiagnosticSummarySchema) }).strict(),
  z.object({ method: z.literal("diagnostics.list-logs"), requestId: RequestIdSchema, ok: z.literal(true), result: PageResponseSchema(LogSummarySchema) }).strict(),
  z.object({ method: z.literal("subscriptions.cancel"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
]);
export type ClientIpcSuccessResponse = z.infer<typeof ClientIpcSuccessResponseSchema>;

export const ClientIpcFailureResponseSchema = z
  .object({
    method: z.enum([
      "gateway.negotiate", "gateway.get-status", "gateway.watch-status", "gateway.reconnect",
      "sessions.list", "sessions.get", "sessions.create", "sessions.remove",
      "chat.list", "chat.get", "chat.watch", "chat.send", "chat.abort",
      "tools.list", "tools.get-call", "approvals.list-pending", "approvals.resolve-exec", "approvals.resolve-plugin",
      "models.list", "models.select-for-session", "skills.list", "channels.list",
      "files.list", "files.read-text", "diagnostics.list", "diagnostics.list-logs",
      "subscriptions.cancel",
    ]),
    requestId: RequestIdSchema,
    ok: z.literal(false),
    error: UClawErrorSchema,
  })
  .strict();
export type ClientIpcFailureResponse = z.infer<typeof ClientIpcFailureResponseSchema>;

export const ClientIpcEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("gateway.status"), subscriptionId: SubscriptionIdSchema, payload: GatewayStatusWireSchema }).strict(),
  z.object({ event: z.literal("chat.watch-event"), subscriptionId: SubscriptionIdSchema, payload: MessageEventSchema }).strict(),
  z.object({ event: z.literal("chat.send-event"), clientRequestId: z.string().min(1), payload: MessageEventSchema }).strict(),
]);
export type ClientIpcEvent = z.infer<typeof ClientIpcEventSchema>;

export const IpcRequestSchema = z.union([WindowIpcRequestSchema, ClientIpcRequestSchema]);
export type IpcRequest = z.infer<typeof IpcRequestSchema>;
export const IpcResponseSchema = z.union([
  WindowIpcSuccessResponseSchema,
  WindowIpcFailureResponseSchema,
  ClientIpcSuccessResponseSchema,
  ClientIpcFailureResponseSchema,
]);
export type IpcResponse = z.infer<typeof IpcResponseSchema>;
export const IpcEventSchema = ClientIpcEventSchema;
export type IpcEvent = z.infer<typeof IpcEventSchema>;
