import { z } from "zod";

import { ISODateTimeSchema } from "./common.js";
import { RendererSafeTextSchema, UClawErrorSchema } from "./errors.js";

export const CHANNEL_CONFIG_VERSION = 1 as const;
export const ChannelKindSchema = z.enum(["telegram", "qq-bot", "feishu", "wecom", "discord", "wechat-personal"]);
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
const QqBotDraftSchema = DraftBaseSchema.extend({
  kind: z.literal("qq-bot"),
  mode: z.literal("app"),
  allowFrom: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
  credentials: z.object({ appId: z.string().trim().min(1).max(128), clientSecret: SecretSchema }).strict(),
}).strict();
const FeishuWebsocketDraftSchema = DraftBaseSchema.extend({ kind: z.literal("feishu"), mode: z.literal("websocket"), credentials: z.object({ appId: z.string().trim().min(1).max(256), appSecret: SecretSchema }).strict() }).strict();
const FeishuWebhookDraftSchema = DraftBaseSchema.extend({ kind: z.literal("feishu"), mode: z.literal("webhook"), credentials: z.object({ appId: z.string().trim().min(1).max(256), appSecret: SecretSchema, verificationToken: SecretSchema, encryptKey: SecretSchema }).strict() }).strict();
const WecomWebsocketDraftSchema = DraftBaseSchema.extend({ kind: z.literal("wecom"), mode: z.literal("websocket"), credentials: z.object({ botId: z.string().trim().min(1).max(256), secret: SecretSchema }).strict() }).strict();
const WecomWebhookDraftSchema = DraftBaseSchema.extend({ kind: z.literal("wecom"), mode: z.literal("webhook"), credentials: z.object({ token: SecretSchema, encodingAESKey: SecretSchema, receiveId: z.string().trim().min(1).max(256).optional() }).strict() }).strict();
const DiscordDraftSchema = DraftBaseSchema.extend({ kind: z.literal("discord"), mode: z.literal("bot"), credentials: z.object({ botToken: SecretSchema }).strict() }).strict();

export const ChannelDraftSchema = z.union([
  TelegramDraftSchema, QqBotDraftSchema, FeishuWebsocketDraftSchema,
  FeishuWebhookDraftSchema, WecomWebsocketDraftSchema, WecomWebhookDraftSchema, DiscordDraftSchema,
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
  DiscordDraftSchema.extend(runtimeStateShape).strict(),
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
  mode: z.enum(["bot", "app", "websocket", "webhook", "qr"]),
  configured: z.boolean(),
  enabled: z.boolean(),
  status: ChannelStatusSchema,
  capability: z.enum(["available", "unavailable"]),
  capabilityReason: RendererSafeTextSchema.optional(),
  credentialHints: z.record(z.string(), HintSchema),
  lastCheckedAt: ISODateTimeSchema.optional(),
  error: ChannelErrorSummarySchema.optional(),
  runtimeAuthoritative: z.boolean().optional(),
  pendingAction: z.enum(["none", "configure", "update-credentials", "install-plugin", "reconnect", "external-account"]).optional(),
  lastInboundAt: ISODateTimeSchema.optional(),
  lastOutboundAt: ISODateTimeSchema.optional(),
  allowFrom: z.array(z.string().min(1).max(128)).max(100).optional(),
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

export const WechatLoginStateSchema = z.enum([
  "idle", "preparing", "awaiting-scan", "awaiting-confirmation", "connected",
  "expired", "cancelled", "logged-out", "error",
]);
export type WechatLoginState = z.infer<typeof WechatLoginStateSchema>;

const QrImageSchema = z.object({
  kind: z.literal("data-url"),
  value: z.string().max(16_384).regex(/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/u),
}).strict();

export const WechatConnectionSnapshotSchema = z.object({
  channelId: z.literal("wechat-personal"),
  status: ChannelStatusSchema,
  loginState: WechatLoginStateSchema,
  capability: z.enum(["available", "unavailable"]),
  capabilityReason: RendererSafeTextSchema.optional(),
  plugin: z.object({
    id: z.literal("openclaw-weixin"),
    requiredVersion: z.literal("2.4.6"),
    status: z.enum(["installed", "missing", "unknown"]),
  }).strict(),
  flowId: IdSchema.optional(),
  qrGeneration: z.number().int().positive().optional(),
  qrImage: QrImageSchema.optional(),
  qrExpiresAt: ISODateTimeSchema.optional(),
  account: z.object({
    displayName: RendererSafeTextSchema.optional(),
    accountIdHint: HintSchema,
  }).strict().optional(),
  lastCheckedAt: ISODateTimeSchema.optional(),
  error: ChannelErrorSummarySchema.optional(),
}).strict();
export type WechatConnectionSnapshot = z.infer<typeof WechatConnectionSnapshotSchema>;

const RequestIdSchema = z.string().min(1);
const ChannelIdParamsSchema = z.object({ channelId: IdSchema }).strict();
const TargetSchema = z.string().trim().min(1).max(512);
const MessageSchema = z.string().trim().min(1).max(10_000);
const MessageIdSchema = z.string().trim().min(1).max(512);
const EmojiSchema = z.string().trim().min(1).max(64);
export const ChannelIpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("channels.list-managed"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("channels.create"), requestId: RequestIdSchema, params: z.object({ channel: ChannelDraftSchema }).strict() }).strict(),
  z.object({ method: z.literal("channels.update"), requestId: RequestIdSchema, params: z.object({ channelId: IdSchema, channel: ChannelDraftSchema }).strict() }).strict(),
  z.object({ method: z.literal("channels.remove"), requestId: RequestIdSchema, params: ChannelIdParamsSchema }).strict(),
  z.object({ method: z.literal("channels.set-enabled"), requestId: RequestIdSchema, params: ChannelIdParamsSchema.extend({ enabled: z.boolean() }).strict() }).strict(),
  z.object({ method: z.literal("channels.test"), requestId: RequestIdSchema, params: ChannelIdParamsSchema }).strict(),
  z.object({ method: z.literal("channels.reconnect"), requestId: RequestIdSchema, params: ChannelIdParamsSchema }).strict(),
  z.object({ method: z.literal("channels.logout"), requestId: RequestIdSchema, params: ChannelIdParamsSchema }).strict(),
  z.object({ method: z.literal("channels.send"), requestId: RequestIdSchema, params: ChannelIdParamsSchema.extend({ target: TargetSchema, message: MessageSchema }).strict() }).strict(),
  z.object({ method: z.literal("channels.action"), requestId: RequestIdSchema, params: ChannelIdParamsSchema.extend({ target: TargetSchema, action: z.literal("react"), messageId: MessageIdSchema, emoji: EmojiSchema }).strict() }).strict(),
  z.object({ method: z.literal("channels.poll"), requestId: RequestIdSchema, params: ChannelIdParamsSchema.extend({
    target: TargetSchema,
    question: z.string().trim().min(1).max(300),
    options: z.array(z.string().trim().min(1).max(100)).min(2).max(10).refine((options) => new Set(options).size === options.length),
    multiple: z.boolean(),
  }).strict() }).strict(),
  z.object({ method: z.literal("channels.cancel"), requestId: RequestIdSchema, params: z.object({ operationRequestId: RequestIdSchema }).strict() }).strict(),
  z.object({ method: z.literal("channels.wechat-status"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("channels.wechat-login-start"), requestId: RequestIdSchema, params: z.object({ force: z.boolean().optional() }).strict() }).strict(),
  z.object({ method: z.literal("channels.wechat-login-poll"), requestId: RequestIdSchema, params: z.object({ flowId: IdSchema, qrGeneration: z.number().int().positive() }).strict() }).strict(),
  z.object({ method: z.literal("channels.wechat-login-refresh"), requestId: RequestIdSchema, params: z.object({ flowId: IdSchema, qrGeneration: z.number().int().positive() }).strict() }).strict(),
  z.object({ method: z.literal("channels.wechat-login-cancel"), requestId: RequestIdSchema, params: z.object({ flowId: IdSchema }).strict() }).strict(),
  z.object({ method: z.literal("channels.wechat-reconnect"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("channels.wechat-logout"), requestId: RequestIdSchema, params: z.object({}).strict() }).strict(),
]);
export type ChannelIpcRequest = z.infer<typeof ChannelIpcRequestSchema>;

const SnapshotMethodSchema = z.enum(["channels.list-managed", "channels.create", "channels.update", "channels.remove", "channels.set-enabled"]);
const OperationMethodSchema = z.enum(["channels.test", "channels.reconnect"]);
const CommandMethodSchema = z.enum(["channels.logout", "channels.send", "channels.action", "channels.poll"]);
export const ChannelCommandResultSchema = z.object({
  channelId: IdSchema,
  operation: z.enum(["logout", "send", "action", "poll"]),
  completedAt: ISODateTimeSchema,
}).strict();
export type ChannelCommandResult = z.infer<typeof ChannelCommandResultSchema>;
const WechatMethodSchema = z.enum([
  "channels.wechat-status", "channels.wechat-login-start", "channels.wechat-login-poll",
  "channels.wechat-login-refresh", "channels.wechat-login-cancel", "channels.wechat-reconnect",
  "channels.wechat-logout",
]);
const ChannelMethodSchema = z.enum([
  "channels.list-managed", "channels.create", "channels.update", "channels.remove",
  "channels.set-enabled", "channels.test", "channels.reconnect", "channels.cancel",
  "channels.logout", "channels.send", "channels.action", "channels.poll",
  "channels.wechat-status", "channels.wechat-login-start", "channels.wechat-login-poll",
  "channels.wechat-login-refresh", "channels.wechat-login-cancel", "channels.wechat-reconnect",
  "channels.wechat-logout",
]);
export const ChannelIpcResponseSchema = z.union([
  z.object({ method: SnapshotMethodSchema, requestId: RequestIdSchema, ok: z.literal(true), result: ChannelSnapshotSchema }).strict(),
  z.object({ method: OperationMethodSchema, requestId: RequestIdSchema, ok: z.literal(true), result: ChannelOperationResultSchema }).strict(),
  z.object({ method: CommandMethodSchema, requestId: RequestIdSchema, ok: z.literal(true), result: ChannelCommandResultSchema }).strict(),
  z.object({ method: z.literal("channels.cancel"), requestId: RequestIdSchema, ok: z.literal(true), result: z.null() }).strict(),
  z.object({ method: WechatMethodSchema, requestId: RequestIdSchema, ok: z.literal(true), result: WechatConnectionSnapshotSchema }).strict(),
  z.object({ method: ChannelMethodSchema, requestId: RequestIdSchema, ok: z.literal(false), error: UClawErrorSchema }).strict(),
]);
export type ChannelIpcResponse = z.infer<typeof ChannelIpcResponseSchema>;
