import { z } from "zod";

import { DataIpcRequestSchema, DataIpcResponseSchema } from "./data.js";
import { ReleaseIpcRequestSchema } from "./release.js";
export { ReleaseIpcRequestSchema, ReleaseIpcResponseSchema } from "./release.js";
export { DataIpcRequestSchema, DataIpcResponseSchema } from "./data.js";
export type { DataIpcRequest, DataIpcResponse } from "./data.js";
export { DiagnosticsIpcRequestSchema, DiagnosticsIpcResponseSchema } from "./diagnostics.js";
export type { DiagnosticsIpcRequest, DiagnosticsIpcResponse } from "./diagnostics.js";

import { SkillIpcRequestSchema, SkillIpcResponseSchema } from "./capabilities.js";
export { SkillIpcRequestSchema, SkillIpcResponseSchema } from "./capabilities.js";
import { PluginIpcRequestSchema, PluginIpcResponseSchema } from "./plugins.js";
export { PluginIpcRequestSchema, PluginIpcResponseSchema } from "./plugins.js";
export type { PluginIpcRequest, PluginIpcResponse } from "./plugins.js";

import { AttachmentImportInputSchema, AttachmentSchema } from "./attachments.js";
import { ActivityDomainIdSchema, ArtifactSnapshotSchema, TaskActivitySnapshotSchema } from "./activity.js";

import {
  MessageEventSchema,
  MessageSchema,
  SendMessageInputSchema,
  SessionSchema,
  SessionSummarySchema,
} from "./chat.js";
import { PageRequestSchema } from "./common.js";
import { UClawErrorSchema } from "./errors.js";
import { ProviderIpcRequestSchema, ProviderIpcResponseSchema } from "./providers.js";
import { ChannelIpcRequestSchema, ChannelIpcResponseSchema } from "./channels.js";
import { McpIpcRequestSchema, McpIpcResponseSchema } from "./mcp.js";
export { ChannelIpcRequestSchema, ChannelIpcResponseSchema } from "./channels.js";
export type { ChannelIpcRequest, ChannelIpcResponse } from "./channels.js";
export { McpIpcRequestSchema, McpIpcResponseSchema } from "./mcp.js";
export type { McpIpcRequest, McpIpcResponse } from "./mcp.js";
export { ProviderIpcRequestSchema, ProviderIpcResponseSchema } from "./providers.js";
export type { ProviderIpcRequest, ProviderIpcResponse } from "./providers.js";
import { CapabilitySetWireSchema, GatewayStatusWireSchema } from "./gateway.js";
import { SessionOrganizerDocumentSchema } from "./session-organizer.js";
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

export const AttachmentIpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("select"), requestId: RequestIdSchema, params: EmptyParamsSchema }).strict(),
  z.object({ method: z.literal("import"), requestId: RequestIdSchema, params: AttachmentImportInputSchema }).strict(),
  z.object({ method: z.literal("get"), requestId: RequestIdSchema, params: z.object({ attachmentId: z.string().min(1) }).strict() }).strict(),
  z.object({ method: z.literal("prepare"), requestId: RequestIdSchema, params: z.object({ attachmentId: z.string().min(1) }).strict() }).strict(),
  z.object({ method: z.literal("cancel"), requestId: RequestIdSchema, params: z.object({ attachmentId: z.string().min(1) }).strict() }).strict(),
  z.object({ method: z.literal("remove"), requestId: RequestIdSchema, params: z.object({ attachmentId: z.string().min(1) }).strict() }).strict(),
]);
export type AttachmentIpcRequest = z.infer<typeof AttachmentIpcRequestSchema>;

export const AttachmentIpcResponseSchema = z.union([
  z.discriminatedUnion("method", [
    z.object({ method: z.literal("select"), requestId: RequestIdSchema, ok: z.literal(true), result: z.array(AttachmentSchema) }).strict(),
    z.object({ method: z.literal("import"), requestId: RequestIdSchema, ok: z.literal(true), result: AttachmentSchema }).strict(),
    z.object({ method: z.literal("get"), requestId: RequestIdSchema, ok: z.literal(true), result: AttachmentSchema }).strict(),
    z.object({ method: z.literal("prepare"), requestId: RequestIdSchema, ok: z.literal(true), result: z.array(AttachmentSchema) }).strict(),
    z.object({ method: z.literal("cancel"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
    z.object({ method: z.literal("remove"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
  ]),
  z.object({
    method: z.enum(["select", "import", "get", "prepare", "cancel", "remove"]),
    requestId: RequestIdSchema,
    ok: z.literal(false),
    error: UClawErrorSchema,
  }).strict(),
]);
export type AttachmentIpcResponse = z.infer<typeof AttachmentIpcResponseSchema>;

export const WindowIpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("minimize"), requestId: RequestIdSchema, params: EmptyParamsSchema }).strict(),
  z.object({ method: z.literal("toggle-maximize"), requestId: RequestIdSchema, params: EmptyParamsSchema }).strict(),
  z.object({ method: z.literal("close"), requestId: RequestIdSchema, params: EmptyParamsSchema }).strict(),
  z.object({ method: z.literal("open-advanced-console"), requestId: RequestIdSchema, params: EmptyParamsSchema }).strict(),
]);
export type WindowIpcRequest = z.infer<typeof WindowIpcRequestSchema>;

export const WindowIpcSuccessResponseSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("minimize"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
  z.object({ method: z.literal("toggle-maximize"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
  z.object({ method: z.literal("close"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
  z.object({ method: z.literal("open-advanced-console"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
]);
export type WindowIpcSuccessResponse = z.infer<typeof WindowIpcSuccessResponseSchema>;

export const WindowIpcFailureResponseSchema = z
  .object({
    method: z.enum(["minimize", "toggle-maximize", "close", "open-advanced-console"]),
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
  z.object({ method: z.literal("sessions.rename"), requestId: RequestIdSchema, params: z.object({ sessionId: z.string().min(1), title: z.string().trim().min(1) }).strict() }).strict(),
  z.object({ method: z.literal("sessions.remove"), requestId: RequestIdSchema, params: z.object({ sessionId: z.string().min(1), revision: z.string().optional() }).strict() }).strict(),
  z.object({ method: z.literal("activity.list"), requestId: RequestIdSchema, params: EmptyParamsSchema }).strict(),
  z.object({ method: z.literal("artifacts.list"), requestId: RequestIdSchema, params: z.object({ sessionId: ActivityDomainIdSchema.optional() }).strict() }).strict(),
  z.object({ method: z.literal("session-organizer.get"), requestId: RequestIdSchema, params: EmptyParamsSchema }).strict(),
  z.object({ method: z.literal("session-organizer.set-pinned"), requestId: RequestIdSchema, params: z.object({ sessionId: z.string().min(1), pinned: z.boolean() }).strict() }).strict(),
  z.object({ method: z.literal("session-organizer.create-group"), requestId: RequestIdSchema, params: z.object({ name: z.string().trim().min(1).max(80) }).strict() }).strict(),
  z.object({ method: z.literal("session-organizer.rename-group"), requestId: RequestIdSchema, params: z.object({ groupId: z.string().min(1), name: z.string().trim().min(1).max(80) }).strict() }).strict(),
  z.object({ method: z.literal("session-organizer.assign-group"), requestId: RequestIdSchema, params: z.object({ sessionId: z.string().min(1), groupId: z.string().min(1).nullable() }).strict() }).strict(),
  z.object({ method: z.literal("chat.list"), requestId: RequestIdSchema, params: SessionPageParamsSchema }).strict(),
  z.object({ method: z.literal("chat.get"), requestId: RequestIdSchema, params: z.object({ sessionId: z.string().min(1), messageId: z.string().min(1) }).strict() }).strict(),
  z.object({ method: z.literal("chat.watch"), requestId: RequestIdSchema, params: z.object({ sessionId: z.string().min(1), subscriptionId: SubscriptionIdSchema }).strict() }).strict(),
  z.object({ method: z.literal("chat.send"), requestId: RequestIdSchema, params: SendMessageInputSchema }).strict(),
  z.object({ method: z.literal("chat.abort"), requestId: RequestIdSchema, params: z.object({ runId: z.string().min(1) }).strict() }).strict(),
  z.object({ method: z.literal("chat.cancel-stream"), requestId: RequestIdSchema, params: z.object({ clientRequestId: z.string().min(1) }).strict() }).strict(),
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
  z.object({ method: z.literal("sessions.rename"), requestId: RequestIdSchema, ok: z.literal(true), result: SessionSchema }).strict(),
  z.object({ method: z.literal("sessions.remove"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
  z.object({ method: z.literal("activity.list"), requestId: RequestIdSchema, ok: z.literal(true), result: TaskActivitySnapshotSchema }).strict(),
  z.object({ method: z.literal("artifacts.list"), requestId: RequestIdSchema, ok: z.literal(true), result: ArtifactSnapshotSchema }).strict(),
  z.object({ method: z.literal("session-organizer.get"), requestId: RequestIdSchema, ok: z.literal(true), result: SessionOrganizerDocumentSchema }).strict(),
  z.object({ method: z.literal("session-organizer.set-pinned"), requestId: RequestIdSchema, ok: z.literal(true), result: SessionOrganizerDocumentSchema }).strict(),
  z.object({ method: z.literal("session-organizer.create-group"), requestId: RequestIdSchema, ok: z.literal(true), result: SessionOrganizerDocumentSchema }).strict(),
  z.object({ method: z.literal("session-organizer.rename-group"), requestId: RequestIdSchema, ok: z.literal(true), result: SessionOrganizerDocumentSchema }).strict(),
  z.object({ method: z.literal("session-organizer.assign-group"), requestId: RequestIdSchema, ok: z.literal(true), result: SessionOrganizerDocumentSchema }).strict(),
  z.object({ method: z.literal("chat.list"), requestId: RequestIdSchema, ok: z.literal(true), result: PageResponseSchema(MessageSchema) }).strict(),
  z.object({ method: z.literal("chat.get"), requestId: RequestIdSchema, ok: z.literal(true), result: MessageSchema }).strict(),
  z.object({ method: z.literal("chat.watch"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
  z.object({ method: z.literal("chat.send"), requestId: RequestIdSchema, ok: z.literal(true), result: z.object({ clientRequestId: z.string().min(1), runId: z.string().min(1) }).strict() }).strict(),
  z.object({ method: z.literal("chat.abort"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
  z.object({ method: z.literal("chat.cancel-stream"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
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
      "sessions.list", "sessions.get", "sessions.create", "sessions.rename", "sessions.remove",
      "activity.list", "artifacts.list",
      "session-organizer.get", "session-organizer.set-pinned", "session-organizer.create-group", "session-organizer.rename-group", "session-organizer.assign-group",
      "chat.list", "chat.get", "chat.watch", "chat.send", "chat.abort", "chat.cancel-stream",
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
  z.object({ event: z.literal("subscription.closed"), subscriptionId: SubscriptionIdSchema, error: UClawErrorSchema.optional() }).strict(),
]);
export type ClientIpcEvent = z.infer<typeof ClientIpcEventSchema>;

export const IpcRequestSchema = z.union([WindowIpcRequestSchema, ClientIpcRequestSchema, AttachmentIpcRequestSchema, ProviderIpcRequestSchema, SkillIpcRequestSchema, PluginIpcRequestSchema, ChannelIpcRequestSchema, McpIpcRequestSchema, DataIpcRequestSchema, ReleaseIpcRequestSchema]);
export type IpcRequest = z.infer<typeof IpcRequestSchema>;
export const IpcResponseSchema = z.union([
  WindowIpcSuccessResponseSchema,
  WindowIpcFailureResponseSchema,
  ClientIpcSuccessResponseSchema,
  ClientIpcFailureResponseSchema,
  AttachmentIpcResponseSchema,
  ProviderIpcResponseSchema,
  SkillIpcResponseSchema,
  PluginIpcResponseSchema,
  ChannelIpcResponseSchema,
  McpIpcResponseSchema,
  DataIpcResponseSchema,
]);
export type IpcResponse = z.infer<typeof IpcResponseSchema>;
export const IpcEventSchema = ClientIpcEventSchema;
export type IpcEvent = z.infer<typeof IpcEventSchema>;
