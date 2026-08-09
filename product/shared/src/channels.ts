import { z } from "zod";

import { ISODateTimeSchema } from "./common.js";
import { RendererSafeTextSchema, UClawErrorSchema } from "./errors.js";

export const CHANNEL_CONFIG_VERSION = 1 as const;
export const ChannelKindSchema = z.enum(["telegram", "qq-bot", "feishu", "wecom"]);
export type ChannelKind = z.infer<typeof ChannelKindSchema>;
export const ChannelStatusSchema = z.enum([
  "not-configured", "pending-verification", "connecting", "connected", "disconnected",
  "auth-failed", "rate-limited", "network-error", "needs-action",
]);
export type ChannelStatus = z.infer<typeof ChannelStatusSchema>;

const SecretSchema = z.string().min(1).max(8192).refine((value) => value === value.trim() && !value.includes("\0"));
const IdSchema = z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/u);
const DraftBaseSchema = z.object({ id: IdSchema, name: z.string().trim().min(1).max(80), enabled: z.boolean() }).strict();

const TelegramDraftSchema = DraftBaseSchema.extend({ kind: z.literal("telegram"), mode: z.literal("bot"), credentials: z.object({ botToken: SecretSchema }).strict() }).strict();
const QqBotDraftSchema = DraftBaseSchema.extend({ kind: z.literal("qq-bot"), mode: z.literal("app"), credentials: z.object({ appId: z.string().trim().min(1).max(128), clientSecret: SecretSchema }).strict() }).strict();
const FeishuWebsocketDraftSchema = DraftBaseSchema.extend({ kind: z.literal("feishu"), mode: z.literal("websocket"), credentials: z.object({ appId: z.string().trim().min(1).max(256), appSecret: SecretSchema }).strict() }).strict();
const FeishuWebhookDraftSchema = DraftBaseSchema.extend({ kind: z.literal("feishu"), mode: z.literal("webhook"), credentials: z.object({ appId: z.string().trim().min(1).max(256), appSecret: SecretSchema, verificationToken: SecretSchema, encryptKey: SecretSchema }).strict() }).strict();
const WecomWebsocketDraftSchema = DraftBaseSchema.extend({ kind: z.literal("wecom"), mode: z.literal("websocket"), credentials: z.object({ botId: z.string().trim().min(1).max(256), secret: SecretSchema }).strict() }).strict();
const WecomWebhookDraftSchema = DraftBaseSchema.extend({ kind: z.literal("wecom"), mode: z.literal("webhook"), credentials: z.object({ token: SecretSchema, encodingAESKey: SecretSchema, receiveId: z.string().trim().min(1).max(256).optional() }).strict() }).strict();

export const ChannelDraftSchema = z.union([
  TelegramDraftSchema, QqBotDraftSchema, FeishuWebsocketDraftSchema,
  FeishuWebhookDraftSchema, WecomWebsocketDraftSchema, WecomWebhookDraftSchema,
]);
export type ChannelDraft = z.infer<typeof ChannelDraftSchema>;

export const ChannelErrorSummarySchema = z.object({
  category: z.enum(["authentication", "rate-limit", "network", "timeout", "capability", "operation"]),
  code: z.string().min(1).max(80),
  message: RendererSafeTextSchema,
  retryable: z.boolean(),
}).strict();
export type ChannelErrorSummary = z.infer<typeof ChannelErrorSummarySchema>;

const ChannelRuntimeStateSchema = z.object({
  status: ChannelStatusSchema.optional(),
  lastCheckedAt: ISODateTimeSchema.optional(),
  error: ChannelErrorSummarySchema.optional(),
});
const runtimeStateShape = ChannelRuntimeStateSchema.shape;
export const ChannelConfigEntrySchema = z.union([
  TelegramDraftSchema.extend(runtimeStateShape).strict(),
  QqBotDraftSchema.extend(runtimeStateShape).strict(),
  FeishuWebsocketDraftSchema.extend(runtimeStateShape).strict(),
  FeishuWebhookDraftSchema.extend(runtimeStateShape).strict(),
  WecomWebsocketDraftSchema.extend(runtimeStateShape).strict(),
  WecomWebhookDraftSchema.extend(runtimeStateShape).strict(),
]);
export type ChannelConfigEntry = z.infer<typeof ChannelConfigEntrySchema>;

export const ChannelConfigDocumentSchema = z.object({
  schemaVersion: z.literal(CHANNEL_CONFIG_VERSION),
  channels: z.array(ChannelConfigEntrySchema).max(100),
}).strict().superRefine((document, context) => {
  const ids = new Set<string>();
  for (const channel of document.channels) {
    if (ids.has(channel.id)) context.addIssue({ code: "custom", path: ["channels"], message: "Channel IDs must be unique" });
    ids.add(channel.id);
  }
});
export type ChannelConfigDocument = z.infer<typeof ChannelConfigDocumentSchema>;

const HintSchema = z.string().regex(/^\.\.\..{1,4}$/u);
export const ManagedChannelSummarySchema = z.object({
  id: IdSchema,
  kind: ChannelKindSchema,
  name: z.string().min(1),
  mode: z.enum(["bot", "app", "websocket", "webhook"]),
  configured: z.boolean(),
  enabled: z.boolean(),
  status: ChannelStatusSchema,
  capability: z.enum(["available", "unavailable"]),
  capabilityReason: RendererSafeTextSchema.optional(),
  credentialHints: z.record(z.string(), HintSchema),
  lastCheckedAt: ISODateTimeSchema.optional(),
  error: ChannelErrorSummarySchema.optional(),
}).strict();
export type ManagedChannelSummary = z.infer<typeof ManagedChannelSummarySchema>;
export const ChannelSnapshotSchema = z.object({ schemaVersion: z.literal(CHANNEL_CONFIG_VERSION), channels: z.array(ManagedChannelSummarySchema) }).strict();
export type ChannelSnapshot = z.infer<typeof ChannelSnapshotSchema>;

export const ChannelOperationResultSchema = z.object({
  channelId: IdSchema,
  status: ChannelStatusSchema,
  checkedAt: ISODateTimeSchema,
  error: ChannelErrorSummarySchema.optional(),
}).strict();
export type ChannelOperationResult = z.infer<typeof ChannelOperationResultSchema>;

const RequestIdSchema = z.string().min(1);
const ChannelIdParamsSchema = z.object({ channelId: IdSchema }).strict();
export const ChannelIpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("channels.list-managed"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("channels.create"), requestId: RequestIdSchema, params: z.object({ channel: ChannelDraftSchema }).strict() }).strict(),
  z.object({ method: z.literal("channels.update"), requestId: RequestIdSchema, params: z.object({ channelId: IdSchema, channel: ChannelDraftSchema }).strict() }).strict(),
  z.object({ method: z.literal("channels.remove"), requestId: RequestIdSchema, params: ChannelIdParamsSchema }).strict(),
  z.object({ method: z.literal("channels.set-enabled"), requestId: RequestIdSchema, params: ChannelIdParamsSchema.extend({ enabled: z.boolean() }).strict() }).strict(),
  z.object({ method: z.literal("channels.test"), requestId: RequestIdSchema, params: ChannelIdParamsSchema }).strict(),
  z.object({ method: z.literal("channels.reconnect"), requestId: RequestIdSchema, params: ChannelIdParamsSchema }).strict(),
  z.object({ method: z.literal("channels.cancel"), requestId: RequestIdSchema, params: z.object({ operationRequestId: RequestIdSchema }).strict() }).strict(),
]);
export type ChannelIpcRequest = z.infer<typeof ChannelIpcRequestSchema>;

const SnapshotMethodSchema = z.enum(["channels.list-managed", "channels.create", "channels.update", "channels.remove", "channels.set-enabled"]);
const OperationMethodSchema = z.enum(["channels.test", "channels.reconnect"]);
export const ChannelIpcResponseSchema = z.union([
  z.object({ method: SnapshotMethodSchema, requestId: RequestIdSchema, ok: z.literal(true), result: ChannelSnapshotSchema }).strict(),
  z.object({ method: OperationMethodSchema, requestId: RequestIdSchema, ok: z.literal(true), result: ChannelOperationResultSchema }).strict(),
  z.object({ method: z.literal("channels.cancel"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
  z.object({ method: z.enum(["channels.list-managed", "channels.create", "channels.update", "channels.remove", "channels.set-enabled", "channels.test", "channels.reconnect", "channels.cancel"]), requestId: RequestIdSchema, ok: z.literal(false), error: UClawErrorSchema }).strict(),
]);
export type ChannelIpcResponse = z.infer<typeof ChannelIpcResponseSchema>;
