import {
  capabilitySetFromWire,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BASE64_TOTAL_LENGTH,
  MAX_ATTACHMENT_TOTAL_BYTES,
  UClawErrorSchema,
  type CapabilitySet,
  type GatewayConnectionState,
  type GatewayStatus,
  type MessageEvent,
  type Page,
  type ToolCall,
  MessageEventSchema,
  type UClawClient,
} from "@uclaw/shared";
import { z } from "zod";

import { mapChatEvent, RawChatEventSchema } from "./mappers/chat.js";
import { mapSession, mapSessionSummary, RawSessionSchema } from "./mappers/session.js";
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

export const OPENCLAW_IMPLEMENTED_METHODS = [
  "sessions.list", "sessions.describe", "sessions.create", "sessions.delete",
  "chat.history", "chat.message.get", "chat.send", "chat.abort",
  "tools.catalog", "session.tool.get", "exec.approval.list", "plugin.approval.list",
  "exec.approval.resolve", "plugin.approval.resolve", "sessions.patch",
] as const;

const implementedMethods = new Set<string>(OPENCLAW_IMPLEMENTED_METHODS);
const implementedEvents = new Set([
  "chat", "session.tool", "exec.approval.requested", "plugin.approval.requested",
]);

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
  now?: () => string;
  reconnectPolicy?: ReconnectPolicy;
  maxStartupRetries?: number;
  onResyncRequired?: (gap: SequenceGap) => void | Promise<void>;
  onApprovalsChanged?: (sessionId: string) => void | Promise<void>;
}

export class OpenClawClient implements UClawClient {
  readonly attachments: AttachmentManager | undefined;
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
  private readonly toolCallRuns = new Map<string, Map<string, { runId: string; tool: ToolCall }>>();
  private readonly notifiedApprovalFrames = new WeakSet<object>();
  private readonly sessionMutations = new Map<string, Promise<unknown>>();
  private resyncing = false;

  constructor(private readonly options: OpenClawClientOptions) {
    this.attachments = options.attachments;
    this.now = options.now ?? (() => new Date().toISOString());
    this.statusSince = this.now();
    this.reconnectPolicy = options.reconnectPolicy ?? new ReconnectPolicy();
    this.onResyncRequired = options.onResyncRequired;
  }

  readonly gateway: UClawClient["gateway"] = {
    negotiate: () => this.negotiate(),
    getStatus: async () => this.gatewayStatus(),
    watchStatus: (signal) => this.watchGatewayStatus(signal),
    reconnect: async () => {
      this.toolCallRuns.clear();
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
      this.requireMethod("exec.approval.list");
      this.requireMethod("plugin.approval.list");
      const params: JsonValue = sessionId === undefined ? {} : { sessionKey: sessionId };
      const [exec, plugin] = await Promise.all([
        this.options.transport.router.request("exec.approval.list", params, ExecApprovalListSchema),
        this.options.transport.router.request("plugin.approval.list", params, PluginApprovalListSchema),
      ]);
      const pending = [...exec.map(mapOpenClawExecApproval), ...plugin.map(mapOpenClawPluginApproval)];
      return sessionId === undefined ? pending : pending.filter((request) => request.sessionId === sessionId);
    },
    resolveExec: async (input) => {
      if (input.decision === "allow-session") throw new UClawUnsupportedError("exec.approval.resolve.allow-session");
      this.requireMethod("exec.approval.resolve");
      await this.options.transport.router.request("exec.approval.resolve", { id: input.ref.id, decision: input.decision }, ResolveApprovalResponseSchema);
    },
    resolvePlugin: async (input) => {
      if (input.decision === "allow-session") throw new UClawUnsupportedError("plugin.approval.resolve.allow-session");
      this.requireMethod("plugin.approval.resolve");
      await this.options.transport.router.request("plugin.approval.resolve", { id: input.ref.id, decision: input.decision }, ResolveApprovalResponseSchema);
    },
  };

  readonly models: UClawClient["models"] = {
    list: async () => this.unsupported("models.list"),
    selectForSession: async (sessionId, modelId) => {
      this.requireMethod("sessions.patch");
      await this.options.transport.router.request("sessions.patch", { key: sessionId, model: modelId }, SessionsPatchResponseSchema);
    },
  };
  readonly skills: UClawClient["skills"] = { list: async () => this.unsupported("skills.status") };
  readonly channels: UClawClient["channels"] = { list: async () => this.unsupported("channels.status") };
  readonly files: UClawClient["files"] = { list: async () => this.unsupported("files.list"), readText: async () => this.unsupported("files.readText") };
  readonly diagnostics: UClawClient["diagnostics"] = { list: async () => this.unsupported("diagnostics.list"), listLogs: async () => this.unsupported("logs.tail") };

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
    const removers = [this.options.transport.router.onClose((error) => queue.fail(this.disconnectedError(error))), this.options.transport.router.onEvent("chat", (frame) => {
      const raw = RawChatEventSchema.safeParse(frame.payload);
      if (raw.success) enqueue(mapChatEvent(raw.data));
    }), this.options.transport.router.onEvent("session.tool", (frame) => {
      const raw = OpenClawSessionToolPayloadSchema.safeParse(frame.payload);
      if (raw.success) {
        this.recordToolRun(raw.data);
        enqueue(MessageEventSchema.parse({ type: "tool", runId: raw.data.runId, tool: mapOpenClawSessionToolEvent(raw.data) }));
      }
    }), this.options.transport.router.onEvent("exec.approval.requested", (frame) => {
      const raw = OpenClawExecApprovalEventSchema.safeParse(frame.payload);
      if (!raw.success || raw.data.request.sessionKey !== input.sessionId) return;
      const waiting = this.waitingToolEvent(raw.data.request.sessionKey, raw.data.request.toolCallId);
      if (waiting === undefined) this.notifyApprovalsChanged(frame, input.sessionId);
      else {
        enqueue(waiting);
        enqueue(MessageEventSchema.parse({ type: "approval", runId: waiting.runId, approval: mapOpenClawExecApproval(raw.data) }));
      }
    }), this.options.transport.router.onEvent("plugin.approval.requested", (frame) => {
      const raw = OpenClawPluginApprovalEventSchema.safeParse(frame.payload);
      if (!raw.success || raw.data.request.sessionKey !== input.sessionId) return;
      const waiting = this.waitingToolEvent(raw.data.request.sessionKey, raw.data.request.toolCallId);
      if (waiting === undefined) this.notifyApprovalsChanged(frame, input.sessionId);
      else {
        enqueue(waiting);
        enqueue(MessageEventSchema.parse({ type: "approval", runId: waiting.runId, approval: mapOpenClawPluginApproval(raw.data) }));
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
    const removers = [this.options.transport.router.onClose((error) => queue.fail(this.disconnectedError(error))), this.options.transport.router.onEvent("chat", (frame) => {
      const raw = RawChatEventSchema.safeParse(frame.payload);
      if (raw.success && raw.data.sessionKey === sessionId) {
        const mapped = mapChatEvent(raw.data);
        if (mapped.type === "final" || mapped.type === "aborted" || mapped.type === "error") {
          this.clearToolRunsForRun(sessionId, mapped.runId);
        }
        queue.push(mapped);
      }
    }), this.options.transport.router.onEvent("session.tool", (frame) => {
      const raw = OpenClawSessionToolPayloadSchema.safeParse(frame.payload);
      if (raw.success) {
        this.recordToolRun(raw.data);
        if (raw.data.sessionKey === sessionId) queue.push(MessageEventSchema.parse({ type: "tool", runId: raw.data.runId, tool: mapOpenClawSessionToolEvent(raw.data) }));
      }
    }), this.options.transport.router.onEvent("exec.approval.requested", (frame) => {
      const raw = OpenClawExecApprovalEventSchema.safeParse(frame.payload);
      if (!raw.success || raw.data.request.sessionKey !== sessionId) return;
      const waiting = this.waitingToolEvent(raw.data.request.sessionKey, raw.data.request.toolCallId);
      if (waiting === undefined) this.notifyApprovalsChanged(frame, sessionId);
      else {
        queue.push(waiting);
        queue.push(MessageEventSchema.parse({ type: "approval", runId: waiting.runId, approval: mapOpenClawExecApproval(raw.data) }));
      }
    }), this.options.transport.router.onEvent("plugin.approval.requested", (frame) => {
      const raw = OpenClawPluginApprovalEventSchema.safeParse(frame.payload);
      if (!raw.success || raw.data.request.sessionKey !== sessionId) return;
      const waiting = this.waitingToolEvent(raw.data.request.sessionKey, raw.data.request.toolCallId);
      if (waiting === undefined) this.notifyApprovalsChanged(frame, sessionId);
      else {
        queue.push(waiting);
        queue.push(MessageEventSchema.parse({ type: "approval", runId: waiting.runId, approval: mapOpenClawPluginApproval(raw.data) }));
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
    return {
      connectionState: this.statusState, protocolVersion: 4,
      phase: ready ? "available" : this.statusState === "failed" ? "failed" : this.statusState === "closed" ? "stopped" : this.statusState === "idle" ? "idle" : "starting",
      processAlive: this.statusState !== "closed", serviceReady: ready, businessAvailable: ready,
      since: this.statusSince, attempt: this.statusAttempt, ...(this.hello === undefined ? {} : { openClawVersion: this.hello.server.version }),
      usb: { state: "available", dataWritable: true }, ...(this.capabilities === undefined ? {} : { capabilities: this.capabilities }),
    };
  }

  private requireMethod(method: string): void {
    if (this.capabilities?.methods.has(method) !== true) throw new UClawUnsupportedError(method);
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
        && (hasDescribe || (method !== "sessions.create" && method !== "sessions.patch")));
      this.capabilities = capabilitySetFromWire({
        protocolVersion: 4,
        methods,
        events: hello.features.events.filter((event) => implementedEvents.has(event)),
        features: {
          attachments: this.options.attachments !== undefined && hello.features.methods.includes("chat.send"),
          approvalResolve: hello.features.methods.includes("exec.approval.resolve") && hello.features.methods.includes("plugin.approval.resolve"),
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

  private recordToolRun(event: z.infer<typeof OpenClawSessionToolPayloadSchema>): void {
    const sessionRuns = this.toolCallRuns.get(event.sessionKey);
    if (event.data.phase === "start") {
      const runs = sessionRuns ?? new Map<string, { runId: string; tool: ToolCall }>();
      runs.set(event.data.toolCallId, { runId: event.runId, tool: mapOpenClawSessionToolEvent(event) });
      this.toolCallRuns.set(event.sessionKey, runs);
      return;
    }
    sessionRuns?.delete(event.data.toolCallId);
    if (sessionRuns?.size === 0) this.toolCallRuns.delete(event.sessionKey);
  }

  private waitingToolEvent(sessionId: string | null | undefined, toolCallId: string | null | undefined): MessageEvent | undefined {
    if (!sessionId || !toolCallId) return undefined;
    const correlated = this.toolCallRuns.get(sessionId)?.get(toolCallId);
    if (correlated === undefined) return undefined;
    correlated.tool = { ...correlated.tool, state: "waiting-authorization" };
    return MessageEventSchema.parse({ type: "tool", runId: correlated.runId, tool: correlated.tool });
  }

  private clearToolRunsForRun(sessionId: string, runId: string): void {
    const sessionRuns = this.toolCallRuns.get(sessionId);
    if (sessionRuns === undefined) return;
    for (const [toolCallId, mapped] of sessionRuns) {
      if (mapped.runId === runId) sessionRuns.delete(toolCallId);
    }
    if (sessionRuns.size === 0) this.toolCallRuns.delete(sessionId);
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
