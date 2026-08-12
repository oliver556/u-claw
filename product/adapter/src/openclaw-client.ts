import { createHash } from "node:crypto";

import {
  capabilitySetFromWire,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BASE64_TOTAL_LENGTH,
  MAX_ATTACHMENT_TOTAL_BYTES,
  DoctorRepairActionIdSchema,
  DiagnosticLogEntrySchema,
  UClawErrorSchema,
  type CapabilitySet,
  type GatewayConnectionState,
  type GatewayStatus,
  type MessageEvent,
  type Page,
  type ToolCall,
  type ApprovalRequest,
  type ChannelErrorSummary,
  type ChannelSummary,
  type ChannelStatus,
  type WechatConnectionSnapshot,
  type WechatLoginState,
  type McpServerConfigEntry,
  MessageEventSchema,
  type UClawClient,
} from "@uclaw/shared";
import { z } from "zod";

import { mapChatEvent, RawChatEventSchema } from "./mappers/chat.js";
import { mapSession, mapSessionSummary, RawSessionSchema } from "./mappers/session.js";
import { mapOpenClawModel, RuntimeOpenClawModelsListResponseSchema } from "./mappers/model.js";
import {
  OpenClawExecApprovalEventSchema,
  OpenClawHistoryResponseSchema,
  OpenClawMessageGetResponseSchema,
  OpenClawPluginApprovalEventSchema,
  OpenClawSessionToolPayloadSchema,
  mapOpenClawExecApproval,
  mapOpenClawHistoryResponse,
  mapOpenClawMessageGetResponse,
  mapOpenClawPluginApproval,
  mapOpenClawSessionToolEvent,
} from "./openclaw-v4-contract.js";
import {
  mapToolCall,
  RawToolCallSchema,
} from "./mappers/tool.js";
import type { GatewayWebSocketState, HelloOk } from "./transport/gateway-websocket.js";
import { ReconnectPolicy, type SequenceGap } from "./reconnect.js";
import { AdapterServiceError, RpcClosedError, RpcProtocolError, RpcRemoteError, type EventFrame, type JsonValue } from "./transport/rpc-router.js";
import { AttachmentServiceError, type AttachmentManager } from "./attachments.js";
import { createOpenClawSessionAdvancedService } from "./session-advanced.js";
import { createOpenClawChannelRuntime, type OpenClawManagedChannelRuntime } from "./openclaw-channel-runtime.js";

interface OpenClawRouter {
  request<T>(method: string, params: JsonValue, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T>;
  onEvent(event: string, listener: (frame: EventFrame) => void): () => void;
  onSequenceGap(listener: (gap: SequenceGap) => void): () => void;
  onClose(listener: (error: Error) => void): () => void;
  resetSequence(sourceSequence?: number): void;
}

export interface OpenClawTransport {
  readonly state: GatewayWebSocketState;
  readonly router: OpenClawRouter;
  connect(): Promise<HelloOk>;
  close(): void;
}

export class UClawUnsupportedError extends AdapterServiceError {
  readonly code = "UNSUPPORTED";
  readonly retryable = false;

  constructor(capability: string) {
    const message = `Capability is not supported: ${capability}`;
    super(message, UClawErrorSchema.parse({
      code: "UNSUPPORTED", message, retryable: false,
      recoveryActions: [], causeDetails: { capability },
    }));
    this.name = "UClawUnsupportedError";
  }
}

export class ModelUnavailableError extends AdapterServiceError {
  constructor() {
    const message = "Selected model is unavailable or did not become active in this session";
    super(message, UClawErrorSchema.parse({
      code: "MODEL_UNAVAILABLE", message, retryable: false,
      recoveryActions: ["open-settings"], causeDetails: { operation: "sessions.patch" },
    }));
    this.name = "ModelUnavailableError";
  }
}

function isInvalidModelError(error: RpcRemoteError): boolean {
  if (error.code !== "INVALID_REQUEST") return false;
  const message = error.uclawError.message;
  return /\bmodel(?:\s+["'`]?[A-Za-z0-9._:/-]+["'`]?)?\s+(?:is\s+)?unavailable\b/i.test(message) ||
    /\binvalid\s+model\b/i.test(message) ||
    /\bmodel(?:\s+["'`]?[A-Za-z0-9._:/-]+["'`]?)?\s+(?:was\s+)?not\s+found\b/i.test(message) ||
    /\bnot\s+found\s+model\b/i.test(message);
}

export const OPENCLAW_IMPLEMENTED_METHODS = [
  "sessions.list", "sessions.describe", "sessions.create", "sessions.delete",
  "chat.history", "chat.message.get", "chat.send", "chat.abort",
  "tools.catalog", "session.tool.get", "exec.approval.list", "plugin.approval.list",
  "exec.approval.resolve", "plugin.approval.resolve", "sessions.patch", "models.list",
  "config.get", "config.patch", "channels.status", "channels.start", "channels.stop", "channels.logout", "tools.invoke",
  "diagnostics.doctor",
  "logs.tail", "health", "status", "system.info", "diagnostics.stability", "audit.list",
  "sessions.files.list", "sessions.files.get", "sessions.compaction.list", "sessions.reset",
  "sessions.compact", "sessions.compaction.branch", "sessions.compaction.restore",
  "sessions.compaction.get", "sessions.steer",
  "agents.list", "agent.identity.get", "agents.create", "agents.update", "agents.delete",
  "agents.files.list", "agents.files.get", "agents.files.set",
  "agents.workspace.list", "agents.workspace.get",
  "cron.list", "cron.status", "cron.get", "cron.add", "cron.update", "cron.remove", "cron.run", "cron.runs",
] as const;

const implementedMethods = new Set<string>(OPENCLAW_IMPLEMENTED_METHODS);
const implementedEvents = new Set([
  "chat", "session.tool", "exec.approval.requested", "plugin.approval.requested",
]);
const MAX_TRACKED_TRACES = 256;

function approvalToolKey(sessionId: string, toolCallId: string): string {
  return `${sessionId.length}:${sessionId}${toolCallId.length}:${toolCallId}`;
}

const SessionPageSchema = z.object({
  sessions: z.array(RawSessionSchema),
  ts: z.number().optional(),
  path: z.string().optional(),
  count: z.number().int().nonnegative().optional(),
  totalCount: z.number().int().nonnegative().optional(),
  limitApplied: z.number().int().positive().nullable().optional(),
  offset: z.number().int().nonnegative().optional(),
  nextOffset: z.number().nonnegative().refine(Number.isInteger).nullable().optional(),
  hasMore: z.boolean().default(false),
  defaults: z.unknown().optional(),
}).strict();

const SendResponseSchema = z.object({ runId: z.string().min(1), status: z.string().min(1) }).passthrough();
const EmptyResponseSchema = z.union([z.object({}).strict(), z.null()]);
const SessionDescribeResponseSchema = z.object({ session: RawSessionSchema.nullable() }).strict();
const SessionsCreateResponseSchema = z.object({
  ok: z.literal(true), key: z.string().min(1), sessionId: z.string().min(1).optional(), entry: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
const SessionsDeleteResponseSchema = z.object({
  ok: z.literal(true), key: z.string().min(1), deleted: z.boolean(), archived: z.array(z.string()),
}).strict();
const ResolveApprovalResponseSchema = z.object({ ok: z.literal(true) }).passthrough();
const SessionsPatchResponseSchema = z.object({ ok: z.literal(true), key: z.string().min(1) }).passthrough();
const SessionModelReadbackSchema = z.object({
  sessions: z.array(z.object({
    key: z.string().min(1),
    modelProvider: z.string().min(1),
    model: z.string().min(1),
  }).passthrough()),
  nextCursor: z.string().min(1).nullable().optional(),
  hasMore: z.boolean().optional(),
}).passthrough();
const ToolCatalogSchema = z.object({
  tools: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    source: z.enum(["built-in", "skill", "plugin", "mcp", "unknown"]),
    sourceId: z.string().optional(),
    available: z.boolean(),
    risk: z.enum(["low", "medium", "high", "critical", "unknown"]),
  }).strict()),
}).strict();

const ToolCallResponseSchema = z.object({ toolCall: RawToolCallSchema }).strict();
const ExecApprovalListSchema = z.array(OpenClawExecApprovalEventSchema);
const PluginApprovalListSchema = z.array(OpenClawPluginApprovalEventSchema);
const ConfigGetResponseSchema = z.object({
  hash: z.string().min(1).optional(),
  valid: z.boolean(),
  config: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
const ConfigPatchResponseSchema = z.object({ ok: z.literal(true) }).passthrough();
const ChannelAccountSnapshotSchema = z.object({
  accountId: z.string().min(1),
  enabled: z.boolean().optional(),
  configured: z.boolean().optional(),
  running: z.boolean().optional(),
  connected: z.boolean().optional(),
  lastError: z.string().optional(),
  healthState: z.string().optional(),
}).passthrough();
const ChannelsStatusResponseSchema = z.object({
  ts: z.number().int().nonnegative(),
  channelOrder: z.array(z.string().min(1)),
  channelLabels: z.record(z.string(), z.string()),
  channels: z.record(z.string(), z.unknown()),
  channelAccounts: z.record(z.string(), z.array(ChannelAccountSnapshotSchema)),
  channelDefaultAccountId: z.record(z.string(), z.string()),
}).passthrough();
const DoctorActionIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,63}$/);
const RawDoctorResponseSchema = z.object({
  status: z.enum(["ok", "issues"]),
  checks: z.array(z.object({
    id: DoctorActionIdSchema,
    title: z.string().min(1).max(80),
    severity: z.enum(["info", "warning", "error"]),
    status: z.enum(["pass", "warn", "fail"]),
    summary: z.string().min(1).max(240),
    suggestion: z.string().min(1).max(240).optional(),
    repair: z.object({ actionId: DoctorActionIdSchema, label: z.string().min(1).max(80) }).strict().optional(),
  })).max(100),
});
const RawLogsTailResponseSchema = z.object({
  lines: z.array(z.string().max(100_000)).max(500),
  cursor: z.number().int().nonnegative(), reset: z.boolean(), truncated: z.boolean(), size: z.number().int().nonnegative(),
}).passthrough();
const RawHealthResponseSchema = z.object({ ok: z.boolean() }).passthrough();
const RawStatusResponseSchema = z.object({ runtimeVersion: z.string().min(1).max(80) }).passthrough();
const RawSystemInfoResponseSchema = z.object({ platform: z.string().min(1).max(32), arch: z.string().min(1).max(32), uptimeMs: z.number().int().nonnegative() }).passthrough();
const RawStabilityResponseSchema = z.object({
  count: z.number().int().nonnegative(), dropped: z.number().int().nonnegative(),
  summary: z.object({ byType: z.record(z.string().min(1).max(80), z.number().int().nonnegative()) }).passthrough(),
  events: z.array(z.object({ type: z.string().min(1).max(80) }).passthrough()).max(500),
}).passthrough();
const RawAuditResponseSchema = z.object({
  events: z.array(z.object({
    eventId: z.string().min(1).max(80), action: z.string().min(1).max(120),
    status: z.enum(["started", "succeeded", "failed", "cancelled", "timed_out", "blocked", "unknown"]),
    errorCode: z.string().min(1).max(80).optional(), redaction: z.literal("metadata_only"),
  }).passthrough()).max(100),
  nextCursor: z.string().min(1).max(128).optional(),
}).passthrough();

function projectGatewayLog(line: string, cursor: number, index: number) {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const meta = value._meta;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
    const record = meta as Record<string, unknown>;
    if (typeof record.date !== "string" || !Number.isFinite(Date.parse(record.date))) return undefined;
    const rawLevel = typeof record.logLevelName === "string" ? record.logLevelName.toLocaleLowerCase() : "info";
    const level = rawLevel === "warn" ? "warning" : ["debug", "info", "warning", "error"].includes(rawLevel) ? rawLevel as "debug" | "info" | "warning" | "error" : "info";
    return DiagnosticLogEntrySchema.parse({
      id: createHash("sha256").update(`${cursor}:${index}:${line}`).digest("hex").slice(0, 20),
      timestamp: new Date(record.date).toISOString(), level, source: "gateway", message: `Gateway ${level} event.`,
    });
  } catch { return undefined; }
}
type OpenClawWechatState = {
  status: ChannelStatus;
  loginState: WechatLoginState;
  account?: { displayName?: string; accountIdHint: string };
};

export interface OpenClawWechatRuntime {
  capability(signal: AbortSignal): Promise<{ available: boolean; pluginStatus: "installed" | "missing" | "unknown"; reason?: string }>;
  status(signal: AbortSignal): Promise<OpenClawWechatState>;
  start(force: boolean, signal: AbortSignal): Promise<{
    flowId: string;
    qrImage: NonNullable<WechatConnectionSnapshot["qrImage"]>;
    qrExpiresAt: string;
  }>;
  poll(flowId: string, signal: AbortSignal): Promise<OpenClawWechatState>;
  refresh(flowId: string, signal: AbortSignal): Promise<{
    qrImage: NonNullable<WechatConnectionSnapshot["qrImage"]>;
    qrExpiresAt: string;
  }>;
  cancel(flowId: string, signal: AbortSignal): Promise<void>;
  reconnect(signal: AbortSignal): Promise<OpenClawWechatState>;
  logout(signal: AbortSignal): Promise<void>;
}

export interface OpenClawChannelRuntime extends OpenClawManagedChannelRuntime {
  wechat: OpenClawWechatRuntime;
}

const authenticationError: ChannelErrorSummary = {
  category: "authentication",
  code: "AUTHENTICATION_FAILED",
  message: "渠道鉴权失败。",
  retryable: false,
};
const rateLimitError: ChannelErrorSummary = {
  category: "rate-limit",
  code: "RATE_LIMITED",
  message: "渠道请求被限流。",
  retryable: true,
};
const networkError: ChannelErrorSummary = {
  category: "network",
  code: "NETWORK_ERROR",
  message: "渠道网络连接失败。",
  retryable: true,
};
const operationError: ChannelErrorSummary = {
  category: "operation",
  code: "OPERATION_FAILED",
  message: "渠道操作失败。",
  retryable: true,
};

function channelErrorSummary(message: string): ChannelErrorSummary {
  if (/401|403|unauthor|forbidden|token|secret|credential/iu.test(message)) return authenticationError;
  if (/429|rate.?limit/iu.test(message)) return rateLimitError;
  if (/network|fetch|socket|connect|dns|econn|timeout|timed out/iu.test(message)) return networkError;
  return operationError;
}

function decodeOffsetCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^(?:0|[1-9]\d*)$/.test(cursor)) {
    const message = "Invalid pagination cursor";
    throw new AdapterServiceError(message, UClawErrorSchema.parse({
      code: "INVALID_ARGUMENT", message, retryable: false,
      recoveryActions: [], causeDetails: { field: "cursor" },
    }));
  }
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) {
    const message = "Invalid pagination cursor";
    throw new AdapterServiceError(message, UClawErrorSchema.parse({
      code: "INVALID_ARGUMENT", message, retryable: false,
      recoveryActions: [], causeDetails: { field: "cursor" },
    }));
  }
  return offset;
}

function encodeNextOffset(method: string, hasMore: boolean, nextOffset: number | null | undefined, currentOffset: number): string | null {
  if (!hasMore) return null;
  if (nextOffset === null || nextOffset === undefined || !Number.isSafeInteger(nextOffset) || nextOffset <= currentOffset) {
    throw new RpcProtocolError(method);
  }
  return String(nextOffset);
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

interface QueueWaiter<T> {
  resolve(result: IteratorResult<T>): void;
  reject(error: Error): void;
}

export class AsyncEventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<QueueWaiter<T>> = [];
  private ended = false;
  private failure: Error | undefined;

  push(value: T, terminal = false): void {
    if (this.ended) return;
    if (terminal) this.ended = true;
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(value);
    else waiter.resolve({ value, done: false });
    if (terminal) {
      for (const pending of this.waiters.splice(0)) pending.resolve({ value: undefined, done: true });
    }
  }

  fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  async next(signal?: AbortSignal): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return { value, done: false };
    if (this.failure !== undefined) throw this.failure;
    if (this.ended || signal?.aborted === true) return { value: undefined, done: true };
    return new Promise((resolve, reject) => {
      const waiter = (result: IteratorResult<T>): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const queuedWaiter: QueueWaiter<T> = {
        resolve: waiter,
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      const onAbort = (): void => {
        const index = this.waiters.indexOf(queuedWaiter);
        if (index >= 0) this.waiters.splice(index, 1);
        waiter({ value: undefined, done: true });
      };
      this.waiters.push(queuedWaiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export interface OpenClawClientOptions {
  transport: OpenClawTransport;
  attachments?: AttachmentManager;
  statusProjection?: () => Pick<GatewayStatus, "processAlive" | "usb">;
  now?: () => string;
  reconnectPolicy?: ReconnectPolicy;
  maxStartupRetries?: number;
  onResyncRequired?: (gap: SequenceGap) => void | Promise<void>;
  onApprovalsChanged?: (sessionId: string) => void | Promise<void>;
  onToolCallChanged?: (toolCall: ToolCall) => void | Promise<void>;
  wechatRuntime?: OpenClawWechatRuntime;
}

export class OpenClawClient implements UClawClient {
  readonly attachments: AttachmentManager | undefined;
  readonly sessionAdvanced: NonNullable<UClawClient["sessionAdvanced"]>;
  private readonly managedChannelRuntime: OpenClawManagedChannelRuntime;
  private capabilities: CapabilitySet | undefined;
  private hello: HelloOk | undefined;
  private readonly now: () => string;
  private readonly reconnectPolicy: ReconnectPolicy;
  private readonly onResyncRequired: ((gap: SequenceGap) => void | Promise<void>) | undefined;
  private removeSequenceGapListener: (() => void) | undefined;
  private removeCloseListener: (() => void) | undefined;
  private negotiation: Promise<CapabilitySet> | undefined;
  private reconnectAttempt = 0;
  private statusState: GatewayConnectionState = "idle";
  private statusSince: string;
  private statusAttempt = 0;
  private readonly statusSubscribers = new Set<AsyncEventQueue<GatewayStatus>>();
  private sessionWriteQueue: Promise<void> = Promise.resolve();
  private readonly toolCallRuns = new Map<string, Map<string, { runId: string; tool: ToolCall }>>();
  private readonly approvalRequests = new Map<string, ApprovalRequest>();
  private readonly approvalDecisions = new Map<string, "allow-once" | "deny">();
  private readonly approvalToolIndex = new Map<string, string>();
  private readonly seenRealtimeApprovals = new Set<string>();
  private readonly notifiedApprovalFrames = new WeakSet<object>();
  private readonly sessionMutations = new Map<string, Promise<unknown>>();
  private readonly processedToolFrames = new WeakMap<object, { tool: ToolCall; accepted: boolean }>();
  private readonly processedApprovalFrames = new WeakMap<object, { request: ApprovalRequest; accepted: boolean }>();
  private readonly processedChatFrames = new WeakMap<object, { event: MessageEvent; accepted: boolean }>();
  private readonly terminalRuns = new Set<string>();
  private readonly traceSubscribers = new Map<string, Set<(event: MessageEvent) => void>>();
  private resyncing = false;

  constructor(private readonly options: OpenClawClientOptions) {
    this.attachments = options.attachments;
    this.now = options.now ?? (() => new Date().toISOString());
    this.statusSince = this.now();
    this.reconnectPolicy = options.reconnectPolicy ?? new ReconnectPolicy();
    this.onResyncRequired = options.onResyncRequired;
    this.sessionAdvanced = createOpenClawSessionAdvancedService({
      router: {
        request: (method, params, schema, signal) => options.transport.router.request(method, params, schema, signal),
      },
      requireMethod: (method) => this.requireMethod(method),
    });
    this.managedChannelRuntime = createOpenClawChannelRuntime({
      router: {
        request: (method, params, schema, signal) => options.transport.router.request(method, params, schema, signal),
      },
      methods: { has: (method) => this.capabilities?.methods.has(method) === true },
      reconnect: async (signal) => {
        if (signal.aborted) throw signal.reason;
        await this.gateway.reconnect();
        if (signal.aborted) throw signal.reason;
      },
    });
  }

  readonly gateway: UClawClient["gateway"] = {
    negotiate: () => this.negotiate(),
    getStatus: async () => this.gatewayStatus(),
    watchStatus: (signal) => this.watchGatewayStatus(signal),
    reconnect: async () => {
      this.toolCallRuns.clear();
      this.approvalRequests.clear();
      this.approvalDecisions.clear();
      this.approvalToolIndex.clear();
      this.seenRealtimeApprovals.clear();
      this.terminalRuns.clear();
      this.setStatus("reconnecting", this.reconnectAttempt + 1);
      await this.reconnectPolicy.wait(this.reconnectAttempt);
      this.removeSequenceGapListener?.();
      this.removeSequenceGapListener = undefined;
      this.removeCloseListener?.();
      this.removeCloseListener = undefined;
      this.options.transport.close();
      this.capabilities = undefined;
      this.hello = undefined;
      try {
        await this.gateway.negotiate();
      } catch (error) {
        this.reconnectAttempt += 1;
        this.setStatus("failed", this.reconnectAttempt);
        throw error;
      }
    },
  };

  readonly sessions: UClawClient["sessions"] = {
    list: async (request) => {
      this.requireMethod("sessions.list");
      const offset = decodeOffsetCursor(request?.cursor);
      const raw = await this.options.transport.router.request("sessions.list", {
        ...(request?.cursor === undefined ? {} : { offset }),
        ...(request?.limit === undefined ? {} : { limit: request.limit }),
        ...(request?.query === undefined ? {} : { search: request.query }),
        includeDerivedTitles: true,
        includeLastMessage: true,
      }, SessionPageSchema);
      const items = uniqueById(raw.sessions.map(mapSessionSummary));
      const nextCursor = encodeNextOffset("sessions.list", raw.hasMore, raw.nextOffset, offset);
      return { items, nextCursor, hasMore: raw.hasMore };
    },
    get: async (sessionId) => {
      return this.readSession(sessionId);
    },
    create: async (input) => {
      this.requireMethod("sessions.create");
      this.requireMethod("sessions.describe");
      const created = await this.options.transport.router.request("sessions.create", {
        ...(input?.title === undefined ? {} : { label: input.title }),
        ...(input?.modelId === undefined ? {} : { model: input.modelId }),
      }, SessionsCreateResponseSchema);
      return this.readSession(created.key);
    },
    rename: async (sessionId, title, revision) => {
      if (revision !== undefined) throw new UClawUnsupportedError("sessions.patch.revision");
      this.requireMethod("sessions.patch");
      this.requireMethod("sessions.describe");
      return this.serializeSessionMutation(sessionId, async () => {
        const result = await this.options.transport.router.request("sessions.patch", { key: sessionId, label: title }, SessionsPatchResponseSchema);
        if (result.key !== sessionId) throw new RpcProtocolError("sessions.patch");
        return this.readSession(sessionId);
      });
    },
    remove: async (sessionId, revision) => {
      if (revision !== undefined) throw new UClawUnsupportedError("sessions.delete.revision");
      this.requireMethod("sessions.delete");
      const result = await this.serializeSessionMutation(sessionId, () => this.options.transport.router.request(
        "sessions.delete", { key: sessionId, deleteTranscript: true }, SessionsDeleteResponseSchema,
      ));
      if (result.key !== sessionId) throw new RpcProtocolError("sessions.delete");
      if (!result.deleted) throw this.notFound("sessions.delete");
    },
  };

  readonly chat: UClawClient["chat"] = {
    list: async (sessionId, request) => {
      this.requireMethod("chat.history");
      const offset = decodeOffsetCursor(request?.cursor);
      const paged = request !== undefined;
      const raw = await this.options.transport.router.request("chat.history", {
        sessionKey: sessionId,
        ...(request?.limit === undefined ? {} : { limit: request.limit }),
        ...(paged ? { offset } : {}),
      }, OpenClawHistoryResponseSchema);
      if (raw.sessionKey !== sessionId) throw new RpcProtocolError("chat.history");
      const nextCursor = encodeNextOffset("chat.history", raw.hasMore === true, raw.nextOffset, offset);
      return { items: uniqueById(mapOpenClawHistoryResponse(raw)), nextCursor, hasMore: raw.hasMore ?? false };
    },
    get: async (sessionId, messageId) => {
      this.requireMethod("chat.message.get");
      const raw = await this.options.transport.router.request("chat.message.get", { sessionKey: sessionId, messageId }, OpenClawMessageGetResponseSchema);
      const message = mapOpenClawMessageGetResponse(raw, sessionId);
      if (message === undefined) throw this.notFound("chat.message.get");
      return message;
    },
    watch: (sessionId, signal) => this.watchChat(sessionId, signal),
    send: (input, signal) => this.sendChat(input, signal),
    abort: async (runId) => {
      this.requireMethod("chat.abort");
      await this.options.transport.router.request("chat.abort", { runId }, EmptyResponseSchema);
    },
  };

  readonly tools: UClawClient["tools"] = {
    list: async () => {
      this.requireMethod("tools.catalog");
      return (await this.options.transport.router.request("tools.catalog", {}, ToolCatalogSchema)).tools;
    },
    getCall: async (toolCallId) => {
      this.requireMethod("session.tool.get");
      return mapToolCall((await this.options.transport.router.request("session.tool.get", { toolCallId }, ToolCallResponseSchema)).toolCall);
    },
  };

  readonly approvals: UClawClient["approvals"] = {
    listPending: async (sessionId) => {
      const params: JsonValue = sessionId === undefined ? {} : { sessionKey: sessionId };
      const hasExec = this.capabilities?.methods.has("exec.approval.list") === true;
      const hasPlugin = this.capabilities?.methods.has("plugin.approval.list") === true;
      if (!hasExec && !hasPlugin) throw new UClawUnsupportedError("approvals.list");
      const [exec, plugin] = await Promise.all([
        hasExec ? this.options.transport.router.request("exec.approval.list", params, ExecApprovalListSchema) : Promise.resolve([]),
        hasPlugin ? this.options.transport.router.request("plugin.approval.list", params, PluginApprovalListSchema) : Promise.resolve([]),
      ]);
      const pending = [...exec.map(mapOpenClawExecApproval), ...plugin.map(mapOpenClawPluginApproval)];
      for (const request of pending) {
        const key = `${request.family}:${request.id}`;
        if (this.approvalRequests.get(key)?.status !== "resolved") this.storeApproval(key, request);
      }
      return sessionId === undefined ? pending : pending.filter((request) => request.sessionId === sessionId);
    },
    resolveExec: async (input) => {
      if (input.decision === "allow-session") throw new UClawUnsupportedError("exec.approval.resolve.allow-session");
      this.requireMethod("exec.approval.resolve");
      await this.options.transport.router.request("exec.approval.resolve", { id: input.ref.id, decision: input.decision }, ResolveApprovalResponseSchema);
      this.resolveTrackedApproval("exec", input.ref.id, input.decision);
    },
    resolvePlugin: async (input) => {
      if (input.decision === "allow-session") throw new UClawUnsupportedError("plugin.approval.resolve.allow-session");
      this.requireMethod("plugin.approval.resolve");
      await this.options.transport.router.request("plugin.approval.resolve", { id: input.ref.id, decision: input.decision }, ResolveApprovalResponseSchema);
      this.resolveTrackedApproval("plugin", input.ref.id, input.decision);
    },
  };

  readonly models: UClawClient["models"] = {
    list: async () => {
      this.requireMethod("models.list");
      const raw = await this.options.transport.router.request(
        "models.list",
        { view: "configured" },
        RuntimeOpenClawModelsListResponseSchema,
      );
      return raw.models.map(mapOpenClawModel);
    },
    selectForSession: async (sessionId, modelId) => {
      this.requireMethod("sessions.patch");
      this.requireMethod("sessions.list");
      await this.serializeSessionWrite(async () => {
        try {
          const patched = await this.options.transport.router.request("sessions.patch", { key: sessionId, model: modelId }, SessionsPatchResponseSchema);
          if (patched.key !== sessionId) throw new RpcProtocolError("sessions.patch");
        } catch (error) {
          if (error instanceof RpcRemoteError && isInvalidModelError(error)) throw new ModelUnavailableError();
          throw error;
        }

        await this.verifySessionModelReadback(sessionId, modelId);
      });
    },
  };
  readonly skills: UClawClient["skills"] = { list: async () => this.unsupported("skills.status") };
  readonly mcp: NonNullable<UClawClient["mcp"]> = {
    configure: (server, signal) => this.patchMcpServer(server, server.enabled, signal),
    remove: (server, signal) => this.patchMcpServer(server, undefined, signal, true),
    start: (server, signal) => this.patchMcpServer(server, true, signal),
    stop: (server, signal) => this.patchMcpServer(server, false, signal),
  };
  readonly channels: UClawClient["channels"] & OpenClawChannelRuntime = {
    list: () => this.runChannelOperation(async () => {
      const { result, account } = await this.readTelegramStatus(false);
      if (account === undefined) return [];
      const state: ChannelSummary["state"] = account.lastError !== undefined ? "error"
        : account.connected === true ? "connected"
          : account.running === true ? "connecting" : "disconnected";
      return [{
        id: "telegram",
        kind: "telegram",
        name: result.channelLabels.telegram ?? "Telegram",
        configured: account.configured === true,
        enabled: account.enabled !== false,
        state,
        accountLabel: account.accountId,
        credential: { configured: account.configured === true },
      }];
    }),
    capability: (kind) => this.managedChannelRuntime.capability(kind),
    configure: (channel, signal) => this.managedChannelRuntime.configure(channel, signal),
    remove: (channel, signal) => this.managedChannelRuntime.remove(channel, signal),
    status: (channel, probe, signal) => this.managedChannelRuntime.status(channel, probe, signal),
    test: (channel, signal) => this.managedChannelRuntime.test(channel, signal),
    start: (channel, signal) => this.managedChannelRuntime.start(channel, signal),
    stop: (channel, signal) => this.managedChannelRuntime.stop(channel, signal),
    logout: (channel, signal) => this.managedChannelRuntime.logout(channel, signal),
    send: (channel, input, signal) => this.managedChannelRuntime.send(channel, input, signal),
    action: (channel, input, signal) => this.managedChannelRuntime.action(channel, input, signal),
    poll: (channel, input, signal) => this.managedChannelRuntime.poll(channel, input, signal),
    wechat: {
      capability: async (signal) => {
        if (this.options.wechatRuntime) return this.options.wechatRuntime.capability(signal);
        this.requireMethod("channels.status");
        const result = await this.options.transport.router.request(
          "channels.status",
          { channel: "openclaw-weixin", probe: false },
          ChannelsStatusResponseSchema,
          signal,
        );
        const installed = Object.hasOwn(result.channels, "openclaw-weixin")
          || Object.hasOwn(result.channelAccounts, "openclaw-weixin")
          || result.channelOrder.includes("openclaw-weixin");
        return {
          available: false,
          pluginStatus: installed ? "installed" : "missing",
          reason: installed
            ? "OpenClaw 2026.7.1-2 无法安全定向个人微信扫码，且插件 2.4.6 未提供退出 RPC。"
            : "需要安装并启用 @tencent-weixin/openclaw-weixin@2.4.6。",
        };
      },
      status: async (signal) => {
        if (this.options.wechatRuntime) return this.options.wechatRuntime.status(signal);
        throw new UClawUnsupportedError("wechat-personal.status");
      },
      start: async (force, signal) => {
        if (this.options.wechatRuntime) return this.options.wechatRuntime.start(force, signal);
        throw new UClawUnsupportedError("wechat-personal.login-start");
      },
      poll: async (flowId, signal) => {
        if (this.options.wechatRuntime) return this.options.wechatRuntime.poll(flowId, signal);
        throw new UClawUnsupportedError("wechat-personal.login-poll");
      },
      refresh: async (flowId, signal) => {
        if (this.options.wechatRuntime) return this.options.wechatRuntime.refresh(flowId, signal);
        throw new UClawUnsupportedError("wechat-personal.login-refresh");
      },
      cancel: async (flowId, signal) => {
        if (this.options.wechatRuntime) return this.options.wechatRuntime.cancel(flowId, signal);
        throw new UClawUnsupportedError("wechat-personal.login-cancel");
      },
      reconnect: async (signal) => {
        if (this.options.wechatRuntime) return this.options.wechatRuntime.reconnect(signal);
        throw new UClawUnsupportedError("wechat-personal.reconnect");
      },
      logout: async (signal) => {
        if (this.options.wechatRuntime) return this.options.wechatRuntime.logout(signal);
        throw new UClawUnsupportedError("wechat-personal.logout");
      },
    },
  };
  readonly files: UClawClient["files"] = { list: async () => this.unsupported("files.list"), readText: async () => this.unsupported("files.readText") };
  readonly diagnostics: UClawClient["diagnostics"] = {
    list: async () => this.unsupported("diagnostics.list"),
    listLogs: async (page, signal) => {
      this.requireMethod("logs.tail");
      const cursorText = page?.cursor;
      const cursor = cursorText === undefined ? undefined : Number(cursorText);
      if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0 || String(cursor) !== cursorText)) throw new RpcProtocolError("OpenClaw logs.tail cursor is invalid.");
      const raw = await this.options.transport.router.request("logs.tail", { ...(cursor === undefined ? {} : { cursor }), limit: page?.limit ?? 100 }, RawLogsTailResponseSchema, signal);
      return { items: raw.lines.map((line, index) => projectGatewayLog(line, raw.cursor, index)).filter((entry) => entry !== undefined), nextCursor: String(raw.cursor), hasMore: false };
    },
    system: async (signal) => {
      for (const method of ["health", "status", "system.info"]) this.requireMethod(method);
      const [health, status, info] = await Promise.all([
        this.options.transport.router.request("health", {}, RawHealthResponseSchema, signal),
        this.options.transport.router.request("status", {}, RawStatusResponseSchema, signal),
        this.options.transport.router.request("system.info", {}, RawSystemInfoResponseSchema, signal),
      ]);
      return { health: { state: health.ok ? "ready" as const : "degraded" as const }, status: { state: health.ok ? "ready" as const : "degraded" as const, uptimeMs: info.uptimeMs }, info: { platform: ["win32", "darwin", "linux"].includes(info.platform) ? info.platform as "win32" | "darwin" | "linux" : "other" as const, architecture: info.arch, version: status.runtimeVersion } };
    },
    stability: async (signal) => {
      this.requireMethod("diagnostics.stability");
      const raw = await this.options.transport.router.request("diagnostics.stability", {}, RawStabilityResponseSchema, signal);
      const incidents = [
        ...(raw.dropped > 0 ? [{ id: "dropped-events", level: "warning" as const, summary: `稳定性记录器丢弃 ${raw.dropped} 条事件。` }] : []),
        ...Object.entries(raw.summary.byType).slice(0, 99).map(([id, count]) => ({ id, level: "info" as const, summary: `最近记录 ${count} 次。` })),
      ].slice(0, 100);
      return { state: raw.dropped > 0 ? "degraded" as const : "stable" as const, score: null, incidents };
    },
    audit: async (signal) => {
      this.requireMethod("audit.list");
      const raw = await this.options.transport.router.request("audit.list", { limit: 100 }, RawAuditResponseSchema, signal);
      const findings = raw.events.map((event) => ({
        id: event.eventId,
        severity: (["failed", "timed_out", "blocked"].includes(event.status) ? "error" : event.status === "cancelled" || event.status === "unknown" ? "warning" : "info") as "info" | "warning" | "error",
        summary: `${event.action}：${event.errorCode ?? event.status}`,
      }));
      return { state: findings.some((finding) => finding.severity === "error") ? "failed" as const : findings.some((finding) => finding.severity === "warning") ? "warning" as const : "passed" as const, findings };
    },
    config: async (signal) => {
      this.requireMethod("config.get");
      const raw = await this.options.transport.router.request("config.get", {}, ConfigGetResponseSchema, signal);
      if (!raw.valid || raw.config === undefined) throw new RpcProtocolError("OpenClaw config.get returned no valid config.");
      return raw.config;
    },
    doctor: async (signal) => {
      this.requireMethod("diagnostics.doctor");
      const raw = await this.options.transport.router.request("diagnostics.doctor", {}, RawDoctorResponseSchema, signal);
      return {
        status: raw.status,
        checks: raw.checks.map(({ repair, ...check }) => {
          const actionId = DoctorRepairActionIdSchema.safeParse(repair?.actionId);
          return actionId.success && repair ? { ...check, repair: { actionId: actionId.data, label: repair.label } } : check;
        }),
      };
    },
  };

  private async *sendChat(input: Parameters<UClawClient["chat"]["send"]>[0], signal?: AbortSignal): AsyncIterable<MessageEvent> {
    this.requireMethod("chat.send");
    const attachmentIds = input.blocks.flatMap((block) => block.type === "attachment" ? [block.attachmentId] : []);
    if (attachmentIds.length > 0 && this.options.attachments === undefined) throw new UClawUnsupportedError("chat.send.attachments");
    if (attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new AttachmentServiceError("INVALID_ARGUMENT", `单条消息最多发送 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件。`);
    }
    const resolvedAttachments = attachmentIds.map((id) => this.options.attachments!.resolveForSend(id));
    const rawAttachmentBytes = resolvedAttachments.reduce((total, attachment) => total + attachment.byteLength, 0);
    const encodedAttachmentLength = resolvedAttachments.reduce((total, attachment) => total + attachment.content.length, 0);
    if (rawAttachmentBytes > MAX_ATTACHMENT_TOTAL_BYTES || encodedAttachmentLength > MAX_ATTACHMENT_BASE64_TOTAL_LENGTH) {
      throw new AttachmentServiceError("FILE_TOO_LARGE", "附件累计大小超过单条消息限制。");
    }
    const attachments = resolvedAttachments.map(({ byteLength: _byteLength, ...attachment }) => attachment);
    const text = input.blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const queue = new AsyncEventQueue<MessageEvent>();
    let expectedRunId: string | undefined;
    const buffered: MessageEvent[] = [];
    const enqueue = (mapped: MessageEvent): void => {
      const terminal = mapped.type === "final" || mapped.type === "aborted" || mapped.type === "error";
      if (terminal) this.clearToolRunsForRun(input.sessionId, mapped.runId);
      if (expectedRunId === undefined) {
        buffered.push(mapped);
        return;
      }
      if (mapped.runId !== expectedRunId) return;
      queue.push(mapped, terminal);
    };
    const removers = [this.subscribeTrace(input.sessionId, enqueue), this.options.transport.router.onClose((error) => queue.fail(this.disconnectedError(error))), this.options.transport.router.onEvent("chat", (frame) => {
      const raw = RawChatEventSchema.safeParse(frame.payload);
      if (raw.success) {
        const processed = this.processChatFrame(frame, raw.data);
        if (processed.accepted) enqueue(processed.event);
      }
    }), this.options.transport.router.onEvent("session.tool", (frame) => {
      const raw = OpenClawSessionToolPayloadSchema.safeParse(frame.payload);
      if (raw.success) {
        const processed = this.processToolFrame(frame, raw.data);
        if (processed.accepted) enqueue(MessageEventSchema.parse({ type: "tool", runId: raw.data.runId, tool: processed.tool }));
      }
    }), this.options.transport.router.onEvent("exec.approval.requested", (frame) => {
      const raw = OpenClawExecApprovalEventSchema.safeParse(frame.payload);
      if (!raw.success || raw.data.request.sessionKey !== input.sessionId) return;
      const processed = this.processApprovalFrame(frame, mapOpenClawExecApproval(raw.data));
      if (!processed.accepted) return;
      const approval = processed.request;
      const runId = this.approvalRunId(approval.sessionId, approval.toolCallId);
      if (runId === undefined) this.notifyApprovalsChanged(frame, input.sessionId);
      else {
        const waiting = this.pauseToolForApproval(approval.sessionId, approval.toolCallId);
        if (waiting) enqueue(waiting);
        enqueue(MessageEventSchema.parse({ type: "approval", runId, approval }));
      }
    }), this.options.transport.router.onEvent("plugin.approval.requested", (frame) => {
      const raw = OpenClawPluginApprovalEventSchema.safeParse(frame.payload);
      if (!raw.success || raw.data.request.sessionKey !== input.sessionId) return;
      const processed = this.processApprovalFrame(frame, mapOpenClawPluginApproval(raw.data));
      if (!processed.accepted) return;
      const approval = processed.request;
      const runId = this.approvalRunId(approval.sessionId, approval.toolCallId);
      if (runId === undefined) this.notifyApprovalsChanged(frame, input.sessionId);
      else {
        const waiting = this.pauseToolForApproval(approval.sessionId, approval.toolCallId);
        if (waiting) enqueue(waiting);
        enqueue(MessageEventSchema.parse({ type: "approval", runId, approval }));
      }
    })];
    try {
      if (signal?.aborted === true) return;
      const requestParams: JsonValue = {
        sessionKey: input.sessionId,
        message: text,
        ...(attachments.length === 0 ? {} : { attachments: attachments.map((attachment) => ({ ...attachment })) }),
        idempotencyKey: input.clientRequestId,
        ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      };
      const policyLimit = Math.min(
        this.hello?.policy.maxPayload ?? 64 * 1024,
        this.hello?.policy.maxBufferedBytes ?? 64 * 1024,
        64 * 1024,
      );
      const frameBytes = new TextEncoder().encode(JSON.stringify({
        type: "req", id: "x".repeat(64), method: "chat.send", params: requestParams,
      })).byteLength;
      if (frameBytes > policyLimit) {
        throw new AttachmentServiceError("FILE_TOO_LARGE", `附件发送载荷超过 Gateway 限制（${frameBytes} > ${policyLimit} bytes）。`);
      }
      for (const id of attachmentIds) this.options.attachments?.markUploading(id, 0);
      const acceptedRequest = this.options.transport.router.request("chat.send", requestParams, SendResponseSchema).then((accepted) => {
        for (const id of attachmentIds) this.options.attachments?.markAttached(id);
        return accepted;
      }, (error: unknown) => {
        const summary = error instanceof AdapterServiceError
          ? { code: error.uclawError.code, message: error.uclawError.message, retryable: error.uclawError.retryable }
          : { code: "UNAVAILABLE" as const, message: "附件发送失败。", retryable: true };
        for (const id of attachmentIds) this.options.attachments?.markFailed(id, summary);
        throw error;
      });
      let removeAbortListener = (): void => undefined;
      const cancellation = new Promise<{ kind: "cancelled" }>((resolve) => {
        const onAbort = (): void => resolve({ kind: "cancelled" });
        removeAbortListener = () => signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted === true) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
      const outcome = await Promise.race([
        acceptedRequest.then((accepted) => ({ kind: "accepted" as const, accepted })),
        cancellation,
      ]);
      removeAbortListener();
      if (outcome.kind === "cancelled") {
        void acceptedRequest
          .then((accepted) => this.chat.abort(accepted.runId))
          .catch(() => undefined);
        return;
      }
      const accepted = outcome.accepted;
      expectedRunId = accepted.runId;
      for (const mapped of buffered.splice(0)) enqueue(mapped);
      yield { type: "started", runId: accepted.runId, sessionId: input.sessionId };
      while (true) {
        const item = await queue.next(signal);
        if (item.done) return;
        yield item.value;
      }
    } finally {
      if (expectedRunId !== undefined) this.clearToolRunsForRun(input.sessionId, expectedRunId);
      for (const remove of removers) remove();
    }
  }

  private async *watchChat(sessionId: string, signal?: AbortSignal): AsyncIterable<MessageEvent> {
    const queue = new AsyncEventQueue<MessageEvent>();
    const removers = [this.subscribeTrace(sessionId, (event) => queue.push(event)), this.options.transport.router.onClose((error) => queue.fail(this.disconnectedError(error))), this.options.transport.router.onEvent("chat", (frame) => {
      const raw = RawChatEventSchema.safeParse(frame.payload);
      if (raw.success && raw.data.sessionKey === sessionId) {
        const processed = this.processChatFrame(frame, raw.data);
        if (!processed.accepted) return;
        const mapped = processed.event;
        if (mapped.type === "final" || mapped.type === "aborted" || mapped.type === "error") {
          this.clearToolRunsForRun(sessionId, mapped.runId);
        }
        queue.push(mapped);
      }
    }), this.options.transport.router.onEvent("session.tool", (frame) => {
      const raw = OpenClawSessionToolPayloadSchema.safeParse(frame.payload);
      if (raw.success) {
        const processed = this.processToolFrame(frame, raw.data);
        if (processed.accepted && raw.data.sessionKey === sessionId) queue.push(MessageEventSchema.parse({ type: "tool", runId: raw.data.runId, tool: processed.tool }));
      }
    }), this.options.transport.router.onEvent("exec.approval.requested", (frame) => {
      const raw = OpenClawExecApprovalEventSchema.safeParse(frame.payload);
      if (!raw.success || raw.data.request.sessionKey !== sessionId) return;
      const processed = this.processApprovalFrame(frame, mapOpenClawExecApproval(raw.data));
      if (!processed.accepted) return;
      const approval = processed.request;
      const runId = this.approvalRunId(approval.sessionId, approval.toolCallId);
      if (runId === undefined) this.notifyApprovalsChanged(frame, sessionId);
      else {
        const waiting = this.pauseToolForApproval(approval.sessionId, approval.toolCallId);
        if (waiting) queue.push(waiting);
        queue.push(MessageEventSchema.parse({ type: "approval", runId, approval }));
      }
    }), this.options.transport.router.onEvent("plugin.approval.requested", (frame) => {
      const raw = OpenClawPluginApprovalEventSchema.safeParse(frame.payload);
      if (!raw.success || raw.data.request.sessionKey !== sessionId) return;
      const processed = this.processApprovalFrame(frame, mapOpenClawPluginApproval(raw.data));
      if (!processed.accepted) return;
      const approval = processed.request;
      const runId = this.approvalRunId(approval.sessionId, approval.toolCallId);
      if (runId === undefined) this.notifyApprovalsChanged(frame, sessionId);
      else {
        const waiting = this.pauseToolForApproval(approval.sessionId, approval.toolCallId);
        if (waiting) queue.push(waiting);
        queue.push(MessageEventSchema.parse({ type: "approval", runId, approval }));
      }
    })];
    try {
      while (signal?.aborted !== true) {
        const item = await queue.next(signal);
        if (item.done) return;
        yield item.value;
      }
    } finally {
      for (const remove of removers) remove();
    }
  }

  private async *watchGatewayStatus(signal?: AbortSignal): AsyncIterable<GatewayStatus> {
    if (signal?.aborted === true) return;
    const queue = new AsyncEventQueue<GatewayStatus>();
    this.statusSubscribers.add(queue);
    try {
      yield this.gatewayStatus();
      while (true) {
        const item = await queue.next(signal);
        if (item.done) return;
        yield item.value;
      }
    } finally {
      this.statusSubscribers.delete(queue);
    }
  }

  private gatewayStatus(): GatewayStatus {
    const ready = this.statusState === "ready";
    const projection = this.options.statusProjection?.() ?? {
      processAlive: !["idle", "failed", "closed"].includes(this.statusState),
      usb: { state: "missing" as const, dataWritable: false },
    };
    return {
      connectionState: this.statusState, protocolVersion: 4,
      phase: ready ? "available" : this.statusState === "failed" ? "failed" : this.statusState === "closed" ? "stopped" : this.statusState === "idle" ? "idle" : "starting",
      processAlive: projection.processAlive, serviceReady: ready, businessAvailable: ready,
      since: this.statusSince, attempt: this.statusAttempt, ...(this.hello === undefined ? {} : { openClawVersion: this.hello.server.version }),
      usb: projection.usb, ...(this.capabilities === undefined ? {} : { capabilities: this.capabilities }),
    };
  }

  private requireMethod(method: string): void {
    if (this.capabilities?.methods.has(method) !== true) throw new UClawUnsupportedError(method);
  }

  private async patchMcpServer(
    server: McpServerConfigEntry,
    enabled: boolean | undefined,
    signal: AbortSignal,
    remove = false,
  ): Promise<void> {
    if (!remove && server.transport !== "stdio" && server.authentication.type !== "none" && server.authentication.secret === undefined) {
      const message = "MCP authentication secret is required";
      throw new AdapterServiceError(message, UClawErrorSchema.parse({
        code: "INVALID_ARGUMENT",
        message,
        retryable: false,
        recoveryActions: [],
        causeDetails: { field: "authentication.secret" },
      }));
    }
    this.requireMethod("config.get");
    this.requireMethod("config.patch");
    const snapshot = await this.options.transport.router.request("config.get", {}, ConfigGetResponseSchema, signal);
    if (snapshot.hash === undefined || !snapshot.valid) throw new RpcProtocolError("config.get");
    const config = remove ? null : server.transport === "stdio"
      ? {
          enabled: enabled ?? server.enabled,
          transport: server.transport,
          command: server.executableId,
          args: server.args,
          env: server.env,
        }
      : {
          enabled: enabled ?? server.enabled,
          transport: server.transport,
          url: server.url,
          ...(server.authentication.type === "none" ? {} : {
            headers: server.authentication.type === "bearer"
              ? { Authorization: `Bearer ${server.authentication.secret}` }
              : { [server.authentication.headerName]: server.authentication.secret },
          }),
        };
    const previous = this.readMcpServerConfig(snapshot.config, server.id);
    const replacePaths = this.collectRemovedArrayPaths(previous, config, `mcp.servers.${server.id}`);
    if (replacePaths.length > 0 && server.id.includes(".")) throw new RpcProtocolError("config.patch");
    await this.options.transport.router.request("config.patch", {
      raw: JSON.stringify({ mcp: { servers: { [server.id]: config } } }),
      baseHash: snapshot.hash,
      ...(replacePaths.length === 0 ? {} : { replacePaths }),
    }, ConfigPatchResponseSchema, signal);
    const readback = await this.options.transport.router.request("config.get", {}, ConfigGetResponseSchema, signal);
    if (!readback.valid || !this.matchesMcpServerReadback(this.readMcpServerConfig(readback.config, server.id), config)) {
      throw new RpcProtocolError("config.get");
    }
  }

  private readMcpServerConfig(config: Record<string, unknown> | undefined, serverId: string): unknown {
    if (!config || typeof config.mcp !== "object" || config.mcp === null || Array.isArray(config.mcp)) return undefined;
    const servers = (config.mcp as Record<string, unknown>).servers;
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return undefined;
    return (servers as Record<string, unknown>)[serverId];
  }

  private collectRemovedArrayPaths(previous: unknown, next: unknown, path: string): string[] {
    if (Array.isArray(previous)) {
      if (!Array.isArray(next) || previous.some((entry) => !next.some((candidate) => JSON.stringify(candidate) === JSON.stringify(entry)))) return [path];
      return [];
    }
    if (typeof previous !== "object" || previous === null || Array.isArray(previous)) return [];
    const nextRecord = typeof next === "object" && next !== null && !Array.isArray(next) ? next as Record<string, unknown> : {};
    return Object.entries(previous as Record<string, unknown>).flatMap(([key, value]) =>
      this.collectRemovedArrayPaths(value, nextRecord[key], `${path}.${key}`));
  }

  private matchesMcpServerReadback(actual: unknown, expected: unknown): boolean {
    if (expected === null) return actual === undefined;
    if (typeof actual !== "object" || actual === null || Array.isArray(actual) || typeof expected !== "object" || expected === null || Array.isArray(expected)) return false;
    const actualRecord = actual as Record<string, unknown>;
    const expectedRecord = expected as Record<string, unknown>;
    for (const key of ["enabled", "transport", "command", "args", "url"] as const) {
      if (key in expectedRecord && JSON.stringify(actualRecord[key]) !== JSON.stringify(expectedRecord[key])) return false;
    }
    for (const key of ["env", "headers"] as const) {
      if (!(key in expectedRecord)) continue;
      const actualSecretMap = actualRecord[key];
      const expectedSecretMap = expectedRecord[key];
      if (
        typeof actualSecretMap !== "object" || actualSecretMap === null || Array.isArray(actualSecretMap) ||
        typeof expectedSecretMap !== "object" || expectedSecretMap === null || Array.isArray(expectedSecretMap) ||
        JSON.stringify(Object.keys(actualSecretMap).sort()) !== JSON.stringify(Object.keys(expectedSecretMap).sort())
      ) return false;
    }
    return true;
  }

  private async readTelegramStatus(probe: boolean, signal?: AbortSignal, accountId?: string) {
    this.requireMethod("channels.status");
    const result = await this.options.transport.router.request(
      "channels.status",
      { channel: "telegram", probe, ...(probe ? { timeoutMs: 10_000 } : {}) },
      ChannelsStatusResponseSchema,
      signal,
    );
    const accounts = result.channelAccounts.telegram ?? [];
    const selectedAccountId = accountId ?? result.channelDefaultAccountId.telegram;
    const account = accounts.find((candidate) => candidate.accountId === selectedAccountId) ?? (accountId === undefined ? accounts[0] : undefined);
    return { result, account };
  }

  private async runChannelOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof UClawUnsupportedError || error instanceof RpcProtocolError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const summary = channelErrorSummary(message);
      if (summary.category === "authentication") throw new Error("Channel authentication failed");
      if (summary.category === "rate-limit") throw new Error("Channel request rate limited");
      if (/timeout|timed out/iu.test(message)) throw new Error("Channel operation timed out");
      if (summary.category === "network") throw new Error("Channel network connection failed");
      throw new Error("Channel operation failed");
    }
  }

  private async readSession(sessionId: string) {
    this.requireMethod("sessions.describe");
    const raw = await this.options.transport.router.request("sessions.describe", {
      key: sessionId, includeDerivedTitles: true, includeLastMessage: true,
    }, SessionDescribeResponseSchema);
    if (raw.session === null) throw this.notFound("sessions.describe");
    const session = mapSession(raw.session);
    if (session.id !== sessionId) throw new RpcProtocolError("sessions.describe");
    return session;
  }

  private async serializeSessionMutation<T>(sessionId: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.sessionMutations.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(mutation);
    this.sessionMutations.set(sessionId, current);
    try {
      return await current;
    } finally {
      if (this.sessionMutations.get(sessionId) === current) this.sessionMutations.delete(sessionId);
    }
  }

  private negotiate(): Promise<CapabilitySet> {
    if (this.capabilities !== undefined) return Promise.resolve(this.capabilities);
    if (this.negotiation !== undefined) return this.negotiation;
    this.setStatus("connecting");
    this.negotiation = this.connectWithStartupRetry().then((hello) => {
      this.ensureTransportListeners();
      this.hello = hello;
      const hasDescribe = hello.features.methods.includes("sessions.describe");
      const methods = hello.features.methods.filter((method) => implementedMethods.has(method)
        && (hasDescribe || method !== "sessions.create"));
      const execApproval = hello.features.methods.includes("exec.approval.list") &&
        hello.features.methods.includes("exec.approval.resolve") &&
        hello.features.events.includes("exec.approval.requested");
      const pluginApproval = hello.features.methods.includes("plugin.approval.list") &&
        hello.features.methods.includes("plugin.approval.resolve") &&
        hello.features.events.includes("plugin.approval.requested");
      this.capabilities = capabilitySetFromWire({
        protocolVersion: 4,
        methods,
          events: hello.features.events.filter((event) => implementedEvents.has(event)),
          features: {
            attachments: this.options.attachments !== undefined && hello.features.methods.includes("chat.send"),
            execApproval,
            pluginApproval,
            approvalResolve: execApproval && pluginApproval,
            toolTrace: hello.features.events.includes("session.tool"),
          },
      });
      this.reconnectAttempt = 0;
      this.setStatus("ready", 0);
      return this.capabilities;
    }).catch((error) => {
      this.setStatus("failed");
      throw error;
    }).finally(() => { this.negotiation = undefined; });
    return this.negotiation;
  }

  private async connectWithStartupRetry(): Promise<HelloOk> {
    const maxRetries = this.options.maxStartupRetries ?? 5;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.options.transport.connect();
      } catch (error) {
        if (!(error instanceof RpcRemoteError) || error.code !== "UNAVAILABLE" || !error.retryable || error.retryAfterMs === undefined || attempt >= maxRetries) throw error;
        this.options.transport.close();
        await this.reconnectPolicy.waitForStartup(error.retryAfterMs);
      }
    }
  }

  private ensureTransportListeners(): void {
    if (this.removeSequenceGapListener !== undefined) return;
    this.removeSequenceGapListener = this.options.transport.router.onSequenceGap((gap) => this.handleSequenceGap(gap));
    this.removeCloseListener = this.options.transport.router.onClose(() => {
      this.toolCallRuns.clear();
      this.approvalRequests.clear();
      this.approvalDecisions.clear();
      this.approvalToolIndex.clear();
      this.seenRealtimeApprovals.clear();
      this.terminalRuns.clear();
      if (this.statusState !== "reconnecting") this.setStatus("closed");
    });
  }

  private handleSequenceGap(gap: SequenceGap): void {
    if (this.resyncing) return;
    this.resyncing = true;
    const resync = this.onResyncRequired === undefined
      ? Promise.reject(new RpcClosedError())
      : Promise.resolve().then(() => this.onResyncRequired?.(gap));
    void resync.then(() => {
      this.options.transport.router.resetSequence(gap.received);
    }, () => this.gateway.reconnect()).catch(() => undefined).finally(() => {
      this.resyncing = false;
    });
  }

  private setStatus(state: GatewayConnectionState, attempt = this.statusAttempt): void {
    if (this.statusState === state && this.statusAttempt === attempt) return;
    this.statusState = state;
    this.statusAttempt = attempt;
    this.statusSince = this.now();
    const status = this.gatewayStatus();
    for (const subscriber of this.statusSubscribers) subscriber.push(status);
  }

  private disconnectedError(error: Error): AdapterServiceError {
    return error instanceof AdapterServiceError ? error : new RpcClosedError();
  }

  private unsupported(capability: string): never {
    throw new UClawUnsupportedError(capability);
  }

  private async serializeSessionWrite(operation: () => Promise<void>): Promise<void> {
    const current = this.sessionWriteQueue.catch(() => undefined).then(operation);
    this.sessionWriteQueue = current;
    await current;
  }

  private async verifySessionModelReadback(sessionId: string, modelId: string): Promise<void> {
    const separator = modelId.indexOf("/");
    if (separator <= 0 || separator === modelId.length - 1) throw new ModelUnavailableError();
    const providerId = modelId.slice(0, separator);
    const model = modelId.slice(separator + 1);
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    while (true) {
      const readback = await this.options.transport.router.request(
        "sessions.list",
        cursor === undefined ? {} : { cursor },
        SessionModelReadbackSchema,
      );
      const session = readback.sessions.find((entry) => entry.key === sessionId);
      if (session !== undefined) {
        if (session.modelProvider === providerId && session.model === model) return;
        throw new ModelUnavailableError();
      }
      if (readback.hasMore !== true) throw new ModelUnavailableError();
      const nextCursor = readback.nextCursor;
      if (nextCursor === undefined || nextCursor === null || seenCursors.has(nextCursor)) {
        throw new RpcProtocolError("sessions.list");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  private recordToolRun(tool: ToolCall): boolean {
    if (tool.state === "running") {
      const approvalKey = this.approvalToolIndex.get(approvalToolKey(tool.sessionId, tool.id));
      if (approvalKey && this.approvalDecisions.get(approvalKey) === "deny") tool = { ...tool, state: "cancelled" };
    }
    const sessionRuns = this.toolCallRuns.get(tool.sessionId);
    const existing = sessionRuns?.get(tool.id);
    if (existing !== undefined) {
      if (["succeeded", "failed", "cancelled"].includes(existing.tool.state)) return false;
      if (tool.state === existing.tool.state) return false;
    }
    if (tool.state === "running") {
      const runs = sessionRuns ?? new Map<string, { runId: string; tool: ToolCall }>();
      runs.set(tool.id, { runId: tool.runId ?? "unknown-run", tool });
      this.pruneMap(runs);
      this.toolCallRuns.set(tool.sessionId, runs);
      return true;
    }
    const runs = sessionRuns ?? new Map<string, { runId: string; tool: ToolCall }>();
    runs.set(tool.id, { runId: tool.runId ?? existing?.runId ?? "unknown-run", tool });
    this.pruneMap(runs);
    this.toolCallRuns.set(tool.sessionId, runs);
    return true;
  }

  private processToolFrame(frame: EventFrame, event: z.infer<typeof OpenClawSessionToolPayloadSchema>): { tool: ToolCall; accepted: boolean } {
    const cached = this.processedToolFrames.get(frame);
    if (cached !== undefined) return cached;
    const tool = mapOpenClawSessionToolEvent(event);
    const accepted = this.recordToolRun(tool);
    const processed = {
      tool: this.toolCallRuns.get(tool.sessionId)?.get(tool.id)?.tool ?? tool,
      accepted,
    };
    this.processedToolFrames.set(frame, processed);
    return processed;
  }

  private processChatFrame(frame: EventFrame, event: z.infer<typeof RawChatEventSchema>): { event: MessageEvent; accepted: boolean } {
    const cached = this.processedChatFrames.get(frame);
    if (cached !== undefined) return cached;
    const mapped = mapChatEvent(event);
    const terminal = mapped.type === "final" || mapped.type === "aborted" || mapped.type === "error";
    const key = `${event.sessionKey}:${mapped.runId}`;
    const accepted = !terminal || !this.terminalRuns.has(key);
    if (terminal && accepted) {
      this.terminalRuns.add(key);
      this.pruneSet(this.terminalRuns);
    }
    const processed = { event: mapped, accepted };
    this.processedChatFrames.set(frame, processed);
    return processed;
  }

  private approvalRunId(sessionId: string | null | undefined, toolCallId: string | null | undefined): string | undefined {
    if (!sessionId || !toolCallId) return undefined;
    return this.toolCallRuns.get(sessionId)?.get(toolCallId)?.runId;
  }

  private pauseToolForApproval(sessionId: string | undefined, toolCallId: string | undefined): MessageEvent | undefined {
    if (!sessionId || !toolCallId) return undefined;
    const tracked = this.toolCallRuns.get(sessionId)?.get(toolCallId);
    if (!tracked || ["succeeded", "failed", "cancelled"].includes(tracked.tool.state)) return undefined;
    tracked.tool = { ...tracked.tool, state: "waiting-authorization" };
    return MessageEventSchema.parse({ type: "tool", runId: tracked.runId, tool: tracked.tool });
  }

  private subscribeTrace(sessionId: string, subscriber: (event: MessageEvent) => void): () => void {
    const subscribers = this.traceSubscribers.get(sessionId) ?? new Set();
    subscribers.add(subscriber);
    this.traceSubscribers.set(sessionId, subscribers);
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) this.traceSubscribers.delete(sessionId);
    };
  }

  private publishTrace(sessionId: string, event: MessageEvent): void {
    for (const subscriber of this.traceSubscribers.get(sessionId) ?? []) subscriber(event);
  }

  private processApprovalFrame(frame: EventFrame, request: ApprovalRequest): { request: ApprovalRequest; accepted: boolean } {
    const cached = this.processedApprovalFrames.get(frame);
    if (cached !== undefined) return cached;
    const key = `${request.family}:${request.id}`;
    const accepted = !this.seenRealtimeApprovals.has(key);
    const processed = { request: accepted ? request : (this.approvalRequests.get(key) ?? request), accepted };
    if (accepted) {
      this.seenRealtimeApprovals.add(key);
      this.pruneSet(this.seenRealtimeApprovals);
      this.storeApproval(key, request);
    }
    this.processedApprovalFrames.set(frame, processed);
    return processed;
  }

  private resolveTrackedApproval(family: ApprovalRequest["family"], id: string, decision: "allow-once" | "deny"): void {
    const key = `${family}:${id}`;
    const request = this.approvalRequests.get(key);
    if (request === undefined || request.status === "resolved") return;
    this.approvalRequests.set(key, { ...request, status: "resolved" });
    this.approvalDecisions.set(key, decision);
    this.pruneApprovalDecisions();
    if (request.sessionId && request.toolCallId) {
      const tracked = this.toolCallRuns.get(request.sessionId)?.get(request.toolCallId);
      if (tracked && !["succeeded", "failed", "cancelled"].includes(tracked.tool.state)) {
        tracked.tool = { ...tracked.tool, state: decision === "deny" ? "cancelled" : "running" };
        this.publishTrace(request.sessionId, MessageEventSchema.parse({ type: "tool", runId: tracked.runId, tool: tracked.tool }));
        void Promise.resolve(this.options.onToolCallChanged?.(tracked.tool)).catch(() => undefined);
      }
    }
    if (request.sessionId) void Promise.resolve(this.options.onApprovalsChanged?.(request.sessionId)).catch(() => undefined);
    this.approvalRequests.delete(key);
  }

  private clearToolRunsForRun(sessionId: string, runId: string): void {
    const sessionRuns = this.toolCallRuns.get(sessionId);
    if (sessionRuns === undefined) return;
    for (const [toolCallId, mapped] of sessionRuns) {
      if (mapped.runId === runId) {
        sessionRuns.delete(toolCallId);
        const toolKey = approvalToolKey(sessionId, toolCallId);
        const approvalKey = this.approvalToolIndex.get(toolKey);
        if (approvalKey) {
          this.approvalToolIndex.delete(toolKey);
          this.approvalRequests.delete(approvalKey);
          this.approvalDecisions.delete(approvalKey);
          this.seenRealtimeApprovals.delete(approvalKey);
        }
      }
    }
    if (sessionRuns.size === 0) this.toolCallRuns.delete(sessionId);
  }

  private storeApproval(key: string, request: ApprovalRequest): void {
    const previous = this.approvalRequests.get(key);
    if (previous?.sessionId && previous.toolCallId) {
      const previousToolKey = approvalToolKey(previous.sessionId, previous.toolCallId);
      const nextToolKey = request.sessionId && request.toolCallId ? approvalToolKey(request.sessionId, request.toolCallId) : undefined;
      if (previousToolKey !== nextToolKey && this.approvalToolIndex.get(previousToolKey) === key) {
        this.approvalToolIndex.delete(previousToolKey);
      }
    }
    this.approvalRequests.set(key, request);
    if (request.sessionId && request.toolCallId) this.approvalToolIndex.set(approvalToolKey(request.sessionId, request.toolCallId), key);
    while (this.approvalRequests.size > MAX_TRACKED_TRACES) {
      const oldestKey = this.approvalRequests.keys().next().value as string;
      const oldest = this.approvalRequests.get(oldestKey);
      this.approvalRequests.delete(oldestKey);
      if (oldest?.sessionId && oldest.toolCallId) {
        const toolKey = approvalToolKey(oldest.sessionId, oldest.toolCallId);
        if (this.approvalToolIndex.get(toolKey) === oldestKey) this.approvalToolIndex.delete(toolKey);
      }
    }
    while (this.approvalToolIndex.size > MAX_TRACKED_TRACES) {
      const [toolKey, approvalKey] = this.approvalToolIndex.entries().next().value as [string, string];
      this.approvalToolIndex.delete(toolKey);
      this.approvalRequests.delete(approvalKey);
      this.approvalDecisions.delete(approvalKey);
    }
  }

  private pruneApprovalDecisions(): void {
    while (this.approvalDecisions.size > MAX_TRACKED_TRACES) {
      const approvalKey = this.approvalDecisions.keys().next().value as string;
      this.approvalDecisions.delete(approvalKey);
      for (const [toolKey, indexedApprovalKey] of this.approvalToolIndex) {
        if (indexedApprovalKey === approvalKey) this.approvalToolIndex.delete(toolKey);
      }
    }
  }

  private pruneMap<K, V>(map: Map<K, V>): void {
    while (map.size > MAX_TRACKED_TRACES) map.delete(map.keys().next().value as K);
  }

  private pruneSet<T>(set: Set<T>): void {
    while (set.size > MAX_TRACKED_TRACES) set.delete(set.values().next().value as T);
  }

  private notifyApprovalsChanged(frame: EventFrame, sessionId: string): void {
    if (this.notifiedApprovalFrames.has(frame)) return;
    this.notifiedApprovalFrames.add(frame);
    void Promise.resolve(this.options.onApprovalsChanged?.(sessionId)).catch(() => undefined);
  }

  private notFound(operation: string): AdapterServiceError {
    const message = "OpenClaw message was not found";
    return new AdapterServiceError(message, UClawErrorSchema.parse({
      code: "NOT_FOUND", message, retryable: false,
      recoveryActions: [], causeDetails: { operation },
    }));
  }
}
