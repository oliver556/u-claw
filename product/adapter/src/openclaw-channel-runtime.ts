import {
  type ChannelConfigEntry,
  type ChannelErrorSummary,
  type ChannelKind,
  type ChannelStatus,
} from "@uclaw/shared";
import { z } from "zod";

import type { JsonValue } from "./transport/rpc-router.js";

export interface OpenClawChannelRouter {
  request<T>(method: string, params: JsonValue, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T>;
}

export type ChannelPendingAction = "none" | "configure" | "update-credentials" | "install-plugin" | "reconnect" | "external-account";

export interface ChannelRuntimeReadback {
  configured: boolean;
  enabled: boolean;
  status: ChannelStatus;
  runtimeAuthoritative: true;
  pendingAction: ChannelPendingAction;
  lastCheckedAt: string;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  error?: ChannelErrorSummary;
}

export interface ChannelMessageInput {
  target: string;
  message: string;
}

export interface ChannelActionInput {
  target: string;
  action: "react";
  messageId: string;
  emoji: string;
}

export interface ChannelPollInput {
  target: string;
  question: string;
  options: string[];
  multiple: boolean;
}

export interface OpenClawManagedChannelRuntime {
  capability(kind: ChannelKind): boolean;
  configure(channel: ChannelConfigEntry, signal: AbortSignal): Promise<void>;
  remove(channel: ChannelConfigEntry, signal: AbortSignal): Promise<void>;
  status(channel: ChannelConfigEntry, probe: boolean, signal: AbortSignal): Promise<ChannelRuntimeReadback>;
  test(channel: ChannelConfigEntry, signal: AbortSignal): Promise<{ status: ChannelStatus; error?: ChannelErrorSummary }>;
  start(channel: ChannelConfigEntry, signal: AbortSignal): Promise<void>;
  stop(channel: ChannelConfigEntry, signal: AbortSignal): Promise<void>;
  logout(channel: ChannelConfigEntry, signal: AbortSignal): Promise<void>;
  send(channel: ChannelConfigEntry, input: ChannelMessageInput, signal: AbortSignal): Promise<void>;
  action(channel: ChannelConfigEntry, input: ChannelActionInput, signal: AbortSignal): Promise<void>;
  poll(channel: ChannelConfigEntry, input: ChannelPollInput, signal: AbortSignal): Promise<void>;
}

const ConfigGetResponseSchema = z.object({ hash: z.string().min(1).optional(), valid: z.boolean() }).passthrough();
const ConfigPatchResponseSchema = z.object({ ok: z.literal(true) }).passthrough();
const ChannelAccountSchema = z.object({
  accountId: z.string().min(1),
  enabled: z.boolean().nullable().optional(),
  configured: z.boolean().nullable().optional(),
  running: z.boolean().nullable().optional(),
  connected: z.boolean().nullable().optional(),
  lastError: z.string().nullable().optional(),
  healthState: z.string().nullable().optional(),
  lastInboundAt: z.number().int().nonnegative().nullable().optional(),
  lastOutboundAt: z.number().int().nonnegative().nullable().optional(),
}).passthrough();
const ChannelsStatusResponseSchema = z.object({
  ts: z.number().int().nonnegative(),
  channelOrder: z.array(z.string().min(1)),
  channelLabels: z.record(z.string(), z.string()),
  channels: z.record(z.string(), z.unknown()),
  channelAccounts: z.record(z.string(), z.array(ChannelAccountSchema)),
  channelDefaultAccountId: z.record(z.string(), z.string()),
}).passthrough();
const ChannelOperationResponseSchema = z.object({
  channel: z.string().min(1),
  accountId: z.string().min(1),
  started: z.boolean().optional(),
  stopped: z.boolean().optional(),
  loggedOut: z.boolean().optional(),
  cleared: z.boolean().optional(),
}).passthrough();
const ToolInvokeResponseSchema = z.object({
  ok: z.boolean(),
  toolName: z.string().min(1),
  output: z.unknown().optional(),
  source: z.string().optional(),
  requiresApproval: z.boolean().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
}).passthrough();

const OPENCLAW_CHANNEL_IDS: Record<Exclude<ChannelKind, "wechat-personal">, string> = {
  telegram: "telegram",
  "qq-bot": "qqbot",
  feishu: "feishu",
  wecom: "wecom",
  discord: "discord",
};
const REQUIRED_CHANNEL_METHODS = [
  "config.get", "config.patch", "channels.status", "channels.start", "channels.stop", "channels.logout", "tools.invoke",
] as const;

const authenticationError: ChannelErrorSummary = { category: "authentication", code: "AUTHENTICATION_FAILED", message: "渠道鉴权失败。", retryable: false };

function safeError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|403|unauthor|forbidden|token|secret|credential/iu.test(message)) return new Error("Channel authentication failed");
  if (/429|rate.?limit/iu.test(message)) return new Error("Channel request rate limited");
  if (/timeout|timed out/iu.test(message)) return new Error("Channel operation timed out");
  if (/network|fetch|socket|connect|dns|econn/iu.test(message)) return new Error("Channel network connection failed");
  return new Error("Channel operation failed");
}

function runtimeError(message: string): ChannelErrorSummary {
  if (/401|403|unauthor|forbidden|token|secret|credential/iu.test(message)) return authenticationError;
  if (/429|rate.?limit/iu.test(message)) return { category: "rate-limit", code: "RATE_LIMITED", message: "渠道请求被限流。", retryable: true };
  if (/timeout|timed out/iu.test(message)) return { category: "timeout", code: "TIMEOUT", message: "渠道操作超时。", retryable: true };
  if (/network|fetch|socket|connect|dns|econn/iu.test(message)) return { category: "network", code: "NETWORK_ERROR", message: "渠道网络连接失败。", retryable: true };
  return { category: "operation", code: "OPERATION_FAILED", message: "渠道运行状态异常。", retryable: true };
}

function statusForError(error: ChannelErrorSummary): ChannelStatus {
  if (error.category === "authentication") return "auth-failed";
  if (error.category === "rate-limit") return "rate-limited";
  if (error.category === "network" || error.category === "timeout") return "network-error";
  return "needs-action";
}

function openClawChannelId(channel: ChannelConfigEntry): string {
  return OPENCLAW_CHANNEL_IDS[channel.kind];
}

function accountConfig(channel: ChannelConfigEntry): Record<string, JsonValue> {
  switch (channel.kind) {
    case "telegram": return { enabled: channel.enabled, botToken: channel.credentials.botToken };
    case "qq-bot": return {
      enabled: channel.enabled,
      appId: channel.credentials.appId,
      clientSecret: channel.credentials.clientSecret,
      allowFrom: channel.allowFrom ?? [],
    };
    case "feishu": return {
      enabled: channel.enabled,
      appId: channel.credentials.appId,
      appSecret: channel.credentials.appSecret,
      connectionMode: channel.mode,
      ...(channel.mode === "webhook" ? { verificationToken: channel.credentials.verificationToken, encryptKey: channel.credentials.encryptKey } : {}),
    };
    case "wecom": return { enabled: channel.enabled, connectionMode: channel.mode, ...channel.credentials };
    case "discord": return { enabled: channel.enabled, token: channel.credentials.botToken };
  }
}

function requireMethod(methods: ReadonlySet<string>, method: string): void {
  if (!methods.has(method)) throw new Error(`OpenClaw capability unavailable: ${method}`);
}

export function createOpenClawChannelRuntime(options: {
  router: OpenClawChannelRouter;
  methods: ReadonlySet<string>;
  reconnect?: (signal: AbortSignal) => Promise<void>;
}): OpenClawManagedChannelRuntime {
  const { router, methods, reconnect } = options;
  const request = async <T>(method: string, params: JsonValue, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> => {
    requireMethod(methods, method);
    try { return await router.request(method, params, schema, signal); }
    catch (error) { throw safeError(error); }
  };
  const status = async (channel: ChannelConfigEntry, probe: boolean, signal: AbortSignal): Promise<ChannelRuntimeReadback> => {
    const id = openClawChannelId(channel);
    let result: z.infer<typeof ChannelsStatusResponseSchema>;
    try {
      result = await request("channels.status", { channel: id, probe, ...(probe ? { timeoutMs: 10_000 } : {}) }, ChannelsStatusResponseSchema, signal);
    } catch (error) {
      const fallback = await request("channels.status", { probe: false }, ChannelsStatusResponseSchema, signal);
      const pluginPresent = fallback.channelOrder.includes(id) || Object.hasOwn(fallback.channels, id) || Object.hasOwn(fallback.channelAccounts, id);
      if (pluginPresent) throw error;
      result = fallback;
    }
    const pluginPresent = result.channelOrder.includes(id) || Object.hasOwn(result.channels, id) || Object.hasOwn(result.channelAccounts, id);
    const lastCheckedAt = new Date(result.ts).toISOString();
    if (!pluginPresent) return { configured: false, enabled: false, status: "needs-action", runtimeAuthoritative: true, pendingAction: "install-plugin", lastCheckedAt };
    const accounts = result.channelAccounts[id] ?? [];
    const account = accounts.find((candidate) => candidate.accountId === channel.id);
    if (!account) return { configured: false, enabled: false, status: "not-configured", runtimeAuthoritative: true, pendingAction: "configure", lastCheckedAt };
    const configured = account.configured === true;
    const enabled = account.enabled !== false;
    let mappedStatus: ChannelStatus;
    let error: ChannelErrorSummary | undefined;
    let pendingAction: ChannelPendingAction = "none";
    if (!configured) { mappedStatus = "not-configured"; pendingAction = "configure"; }
    else if (account.connected === true) mappedStatus = "connected";
    else if (account.lastError) {
      error = runtimeError(account.lastError);
      mappedStatus = statusForError(error);
      pendingAction = error.category === "authentication" ? "update-credentials" : "reconnect";
    } else if (account.running === true) mappedStatus = "connecting";
    else { mappedStatus = "disconnected"; pendingAction = enabled ? "reconnect" : "none"; }
    return {
      configured, enabled, status: mappedStatus, runtimeAuthoritative: true, pendingAction, lastCheckedAt,
      ...(typeof account.lastInboundAt === "number" ? { lastInboundAt: new Date(account.lastInboundAt).toISOString() } : {}),
      ...(typeof account.lastOutboundAt === "number" ? { lastOutboundAt: new Date(account.lastOutboundAt).toISOString() } : {}),
      ...(error ? { error } : {}),
    };
  };
  const patch = async (channel: ChannelConfigEntry, config: Record<string, JsonValue> | null, signal: AbortSignal): Promise<void> => {
    const id = openClawChannelId(channel);
    const snapshot = await request("config.get", {}, ConfigGetResponseSchema, signal);
    if (snapshot.hash === undefined || !snapshot.valid) throw new Error("OpenClaw config readback failed");
    let patchFailure: unknown;
    try {
      await request("config.patch", {
        raw: JSON.stringify({ channels: { [id]: { accounts: { [channel.id]: config } } } }),
        baseHash: snapshot.hash,
      }, ConfigPatchResponseSchema, signal);
    } catch (error) {
      patchFailure = error;
    }
    let readback: ChannelRuntimeReadback;
    try {
      readback = await status(channel, false, signal);
    } catch (error) {
      if (!reconnect) throw patchFailure ?? error;
      await reconnect(signal);
      readback = await status(channel, false, signal);
    }
    const matches = config === null ? !readback.configured : readback.configured && readback.enabled === channel.enabled;
    if (!matches) throw patchFailure ?? new Error("OpenClaw channel config readback failed");
  };
  const lifecycle = async (method: "channels.start" | "channels.stop" | "channels.logout", channel: ChannelConfigEntry, signal: AbortSignal): Promise<void> => {
    const id = openClawChannelId(channel);
    const result = await request(method, { channel: id, accountId: channel.id }, ChannelOperationResponseSchema, signal);
    const success = method === "channels.start" ? result.started === true
      : method === "channels.stop" ? result.stopped === true
        : result.loggedOut === true || result.cleared === true;
    if (!success || result.channel !== id || result.accountId !== channel.id) throw new Error("OpenClaw channel lifecycle readback failed");
    const readback = await status(channel, false, signal);
    if (method === "channels.logout" && readback.configured) throw new Error("OpenClaw channel logout readback failed");
  };
  const invokeMessage = async (channel: ChannelConfigEntry, args: Record<string, JsonValue>, signal: AbortSignal): Promise<void> => {
    const result = await request("tools.invoke", {
      name: "message",
      args: { ...args, channel: openClawChannelId(channel), accountId: channel.id },
    }, ToolInvokeResponseSchema, signal);
    if (!result.ok || result.toolName !== "message") throw new Error("OpenClaw message tool operation failed");
    await status(channel, false, signal);
  };
  return {
    capability: (kind) => kind !== "wechat-personal" && REQUIRED_CHANNEL_METHODS.every((method) => methods.has(method)),
    configure: (channel, signal) => patch(channel, accountConfig(channel), signal),
    remove: (channel, signal) => patch(channel, null, signal),
    status,
    test: async (channel, signal) => {
      const readback = await status(channel, true, signal);
      return { status: readback.status, ...(readback.error ? { error: readback.error } : {}) };
    },
    start: (channel, signal) => lifecycle("channels.start", channel, signal),
    stop: (channel, signal) => lifecycle("channels.stop", channel, signal),
    logout: (channel, signal) => lifecycle("channels.logout", channel, signal),
    send: (channel, input, signal) => invokeMessage(channel, { action: "send", target: input.target, message: input.message }, signal),
    action: (channel, input, signal) => invokeMessage(channel, { action: input.action, target: input.target, messageId: input.messageId, emoji: input.emoji }, signal),
    poll: (channel, input, signal) => invokeMessage(channel, { action: "poll", target: input.target, pollQuestion: input.question, pollOption: input.options, pollMulti: input.multiple }, signal),
  };
}
