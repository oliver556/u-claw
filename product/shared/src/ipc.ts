import { z } from "zod";

import { MessageEventSchema, MessageSchema, SendMessageInputSchema, SessionSchema, SessionSummarySchema } from "./chat.js";
import { UClawErrorSchema } from "./errors.js";
import { CapabilitySetWireSchema, GatewayStatusSchema } from "./gateway.js";
import {
  ChannelSummarySchema,
  DiagnosticSummarySchema,
  FileSummarySchema,
  ModelSummarySchema,
  SkillSummarySchema,
} from "./management.js";
import { ApprovalDecisionSchema } from "./tools.js";

const EmptyPayloadSchema = z.object({}).strict();

const WindowRequestSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("window.minimize"), payload: EmptyPayloadSchema }).strict(),
  z.object({ channel: z.literal("window.toggle-maximize"), payload: EmptyPayloadSchema }).strict(),
  z.object({ channel: z.literal("window.close"), payload: EmptyPayloadSchema }).strict(),
]);

const ClientRequestSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("client.gateway.status"), payload: EmptyPayloadSchema }).strict(),
  z.object({ channel: z.literal("client.gateway.negotiate"), payload: EmptyPayloadSchema }).strict(),
  z.object({ channel: z.literal("client.sessions.list"), payload: z.object({ cursor: z.string().optional(), limit: z.number().int().positive().optional() }).strict() }).strict(),
  z.object({ channel: z.literal("client.sessions.get"), payload: z.object({ sessionId: z.string().min(1) }).strict() }).strict(),
  z.object({ channel: z.literal("client.chat.send"), payload: SendMessageInputSchema }).strict(),
  z.object({ channel: z.literal("client.chat.abort"), payload: z.object({ runId: z.string().min(1) }).strict() }).strict(),
  z.object({ channel: z.literal("client.approvals.resolve-exec"), payload: z.object({ requestId: z.string().min(1), decision: ApprovalDecisionSchema }).strict() }).strict(),
  z.object({ channel: z.literal("client.approvals.resolve-plugin"), payload: z.object({ requestId: z.string().min(1), decision: ApprovalDecisionSchema }).strict() }).strict(),
  z.object({ channel: z.literal("client.models.list"), payload: EmptyPayloadSchema }).strict(),
  z.object({ channel: z.literal("client.skills.list"), payload: EmptyPayloadSchema }).strict(),
  z.object({ channel: z.literal("client.channels.list"), payload: EmptyPayloadSchema }).strict(),
  z.object({ channel: z.literal("client.files.read"), payload: z.object({ fileId: z.string().min(1) }).strict() }).strict(),
  z.object({ channel: z.literal("client.diagnostics.list"), payload: EmptyPayloadSchema }).strict(),
]);

export const IpcRequestSchema = z.union([WindowRequestSchema, ClientRequestSchema]);
export type IpcRequest = z.infer<typeof IpcRequestSchema>;

const IpcSuccessResponseSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("window.minimize"), ok: z.literal(true), data: z.null() }).strict(),
  z.object({ channel: z.literal("window.toggle-maximize"), ok: z.literal(true), data: z.null() }).strict(),
  z.object({ channel: z.literal("window.close"), ok: z.literal(true), data: z.null() }).strict(),
  z.object({ channel: z.literal("client.gateway.status"), ok: z.literal(true), data: GatewayStatusSchema }).strict(),
  z.object({ channel: z.literal("client.gateway.negotiate"), ok: z.literal(true), data: CapabilitySetWireSchema }).strict(),
  z.object({
    channel: z.literal("client.sessions.list"),
    ok: z.literal(true),
    data: z.object({ items: z.array(SessionSummarySchema), nextCursor: z.string().nullable(), hasMore: z.boolean() }).strict(),
  }).strict(),
  z.object({ channel: z.literal("client.sessions.get"), ok: z.literal(true), data: SessionSchema }).strict(),
  z.object({ channel: z.literal("client.chat.send"), ok: z.literal(true), data: z.null() }).strict(),
  z.object({ channel: z.literal("client.chat.abort"), ok: z.literal(true), data: z.null() }).strict(),
  z.object({ channel: z.literal("client.approvals.resolve-exec"), ok: z.literal(true), data: z.null() }).strict(),
  z.object({ channel: z.literal("client.approvals.resolve-plugin"), ok: z.literal(true), data: z.null() }).strict(),
  z.object({ channel: z.literal("client.models.list"), ok: z.literal(true), data: z.array(ModelSummarySchema) }).strict(),
  z.object({ channel: z.literal("client.skills.list"), ok: z.literal(true), data: z.array(SkillSummarySchema) }).strict(),
  z.object({ channel: z.literal("client.channels.list"), ok: z.literal(true), data: z.array(ChannelSummarySchema) }).strict(),
  z.object({
    channel: z.literal("client.files.read"),
    ok: z.literal(true),
    data: z.object({ file: FileSummarySchema, content: z.string(), encoding: z.literal("utf-8") }).strict(),
  }).strict(),
  z.object({ channel: z.literal("client.diagnostics.list"), ok: z.literal(true), data: z.array(DiagnosticSummarySchema) }).strict(),
]);

const IpcFailureResponseSchema = z
  .object({
    channel: z.enum([
      "window.minimize",
      "window.toggle-maximize",
      "window.close",
      "client.gateway.status",
      "client.gateway.negotiate",
      "client.sessions.list",
      "client.sessions.get",
      "client.chat.send",
      "client.chat.abort",
      "client.approvals.resolve-exec",
      "client.approvals.resolve-plugin",
      "client.models.list",
      "client.skills.list",
      "client.channels.list",
      "client.files.read",
      "client.diagnostics.list",
    ]),
    ok: z.literal(false),
    error: UClawErrorSchema,
  })
  .strict();

export const IpcResponseSchema = z.union([IpcSuccessResponseSchema, IpcFailureResponseSchema]);
export type IpcResponse = z.infer<typeof IpcResponseSchema>;

export const IpcEventSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("client.gateway.changed"), payload: GatewayStatusSchema }).strict(),
  z.object({ channel: z.literal("client.chat.event"), payload: MessageEventSchema }).strict(),
  z.object({ channel: z.literal("client.chat.message"), payload: MessageSchema }).strict(),
]);
export type IpcEvent = z.infer<typeof IpcEventSchema>;
