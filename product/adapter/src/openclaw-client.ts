import {
  capabilitySetFromWire,
  type CapabilitySet,
  type GatewayConnectionState,
  type GatewayStatus,
  type MessageEvent,
  type Page,
  MessageEventSchema,
  type UClawClient,
} from "@uclaw/shared";
import { z } from "zod";

import { mapChatEvent, mapMessage, RawChatEventSchema, RawMessageSchema } from "./mappers/chat.js";
import { mapSession, mapSessionSummary, RawSessionSchema } from "./mappers/session.js";
import {
  mapExecApproval,
  mapPluginApproval,
  mapToolCall,
  RawExecApprovalSchema,
  RawPluginApprovalSchema,
  RawToolCallSchema,
} from "./mappers/tool.js";
import type { GatewayWebSocketState, HelloOk } from "./transport/gateway-websocket.js";
import { ReconnectPolicy, type SequenceGap } from "./reconnect.js";
import { RpcRemoteError, type EventFrame, type JsonValue } from "./transport/rpc-router.js";

interface OpenClawRouter {
  request<T>(method: string, params: JsonValue, schema: z.ZodType<T>): Promise<T>;
  onEvent(event: string, listener: (frame: EventFrame) => void): () => void;
  onSequenceGap(listener: (gap: SequenceGap) => void): () => void;
}

export interface OpenClawTransport {
  readonly state: GatewayWebSocketState;
  readonly router: OpenClawRouter;
  connect(): Promise<HelloOk>;
  close(): void;
}

export class UClawUnsupportedError extends Error {
  readonly code = "UNSUPPORTED";
  readonly retryable = false;

  constructor(capability: string) {
    super(`Capability is not supported: ${capability}`);
    this.name = "UClawUnsupportedError";
  }
}

const SessionPageSchema = z.object({
  sessions: z.array(RawSessionSchema),
  nextCursor: z.string().nullable().default(null),
  hasMore: z.boolean().default(false),
});

const MessagePageSchema = z.object({
  messages: z.array(RawMessageSchema),
  nextCursor: z.string().nullable().default(null),
  hasMore: z.boolean().default(false),
});

const SendResponseSchema = z.object({ runId: z.string().min(1), status: z.string().min(1) });
const EmptyResponseSchema = z.union([z.object({}), z.null()]);
const ToolCatalogSchema = z.object({
  tools: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    source: z.enum(["built-in", "skill", "plugin", "mcp", "unknown"]),
    sourceId: z.string().optional(),
    available: z.boolean(),
    risk: z.enum(["low", "medium", "high", "critical", "unknown"]),
  })),
});

const ToolCallResponseSchema = z.object({ toolCall: RawToolCallSchema });
const ExecApprovalPageSchema = z.object({ requests: z.array(RawExecApprovalSchema) });
const PluginApprovalPageSchema = z.object({ requests: z.array(RawPluginApprovalSchema) });
const ExecApprovalEventSchema = z.object({ runId: z.string().min(1), request: RawExecApprovalSchema });
const PluginApprovalEventSchema = z.object({ runId: z.string().min(1), request: RawPluginApprovalSchema });

class AsyncEventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(value);
    else waiter({ value, done: false });
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  async next(signal?: AbortSignal): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return { value, done: false };
    if (this.ended || signal?.aborted === true) return { value: undefined, done: true };
    return new Promise((resolve) => {
      const waiter = (result: IteratorResult<T>): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        waiter({ value: undefined, done: true });
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export interface OpenClawClientOptions {
  transport: OpenClawTransport;
  now?: () => string;
  reconnectPolicy?: ReconnectPolicy;
  maxStartupRetries?: number;
  onResyncRequired?: (gap: SequenceGap) => void;
}

export class OpenClawClient implements UClawClient {
  private capabilities: CapabilitySet | undefined;
  private hello: HelloOk | undefined;
  private readonly now: () => string;
  private readonly reconnectPolicy: ReconnectPolicy;
  private readonly onResyncRequired: (gap: SequenceGap) => void;
  private removeSequenceGapListener: (() => void) | undefined;
  private negotiation: Promise<CapabilitySet> | undefined;
  private reconnectAttempt = 0;

  constructor(private readonly options: OpenClawClientOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.reconnectPolicy = options.reconnectPolicy ?? new ReconnectPolicy();
    this.onResyncRequired = options.onResyncRequired ?? (() => undefined);
  }

  readonly gateway: UClawClient["gateway"] = {
    negotiate: () => this.negotiate(),
    getStatus: async () => this.gatewayStatus(),
    watchStatus: (signal) => this.watchGatewayStatus(signal),
    reconnect: async () => {
      await this.reconnectPolicy.wait(this.reconnectAttempt);
      this.removeSequenceGapListener?.();
      this.removeSequenceGapListener = undefined;
      this.options.transport.close();
      this.capabilities = undefined;
      this.hello = undefined;
      try {
        await this.gateway.negotiate();
        this.reconnectAttempt = 0;
      } catch (error) {
        this.reconnectAttempt += 1;
        throw error;
      }
    },
  };

  readonly sessions: UClawClient["sessions"] = {
    list: async (request) => {
      this.requireMethod("sessions.list");
      const raw = await this.options.transport.router.request("sessions.list", request ?? {}, SessionPageSchema);
      return { items: raw.sessions.map(mapSessionSummary), nextCursor: raw.nextCursor, hasMore: raw.hasMore };
    },
    get: async (sessionId) => {
      this.requireMethod("sessions.get");
      return mapSession(await this.options.transport.router.request("sessions.get", { sessionKey: sessionId }, RawSessionSchema));
    },
    create: async (input) => {
      this.requireMethod("sessions.create");
      return mapSession(await this.options.transport.router.request("sessions.create", input ?? {}, RawSessionSchema));
    },
    remove: async (sessionId, revision) => {
      this.requireMethod("sessions.delete");
      await this.options.transport.router.request("sessions.delete", { sessionKey: sessionId, ...(revision === undefined ? {} : { revision }) }, EmptyResponseSchema);
    },
  };

  readonly chat: UClawClient["chat"] = {
    list: async (sessionId, request) => {
      this.requireMethod("chat.history");
      const raw = await this.options.transport.router.request("chat.history", { sessionKey: sessionId, ...(request ?? {}) }, MessagePageSchema);
      return { items: raw.messages.map(mapMessage), nextCursor: raw.nextCursor, hasMore: raw.hasMore };
    },
    get: async (sessionId, messageId) => {
      this.requireMethod("chat.message.get");
      return mapMessage(await this.options.transport.router.request("chat.message.get", { sessionKey: sessionId, messageId }, RawMessageSchema));
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
        this.options.transport.router.request("exec.approval.list", params, ExecApprovalPageSchema),
        this.options.transport.router.request("plugin.approval.list", params, PluginApprovalPageSchema),
      ]);
      return [...exec.requests.map(mapExecApproval), ...plugin.requests.map(mapPluginApproval)];
    },
    resolveExec: async () => { throw new UClawUnsupportedError("exec.approval.resolve"); },
    resolvePlugin: async () => { throw new UClawUnsupportedError("plugin.approval.resolve"); },
  };

  readonly models: UClawClient["models"] = { list: async () => this.unsupported("models.list"), selectForSession: async () => this.unsupported("sessions.patch.model") };
  readonly skills: UClawClient["skills"] = { list: async () => this.unsupported("skills.status") };
  readonly channels: UClawClient["channels"] = { list: async () => this.unsupported("channels.status") };
  readonly files: UClawClient["files"] = { list: async () => this.unsupported("files.list"), readText: async () => this.unsupported("files.readText") };
  readonly diagnostics: UClawClient["diagnostics"] = { list: async () => this.unsupported("diagnostics.list"), listLogs: async () => this.unsupported("logs.tail") };

  private async *sendChat(input: Parameters<UClawClient["chat"]["send"]>[0], signal?: AbortSignal): AsyncIterable<MessageEvent> {
    this.requireMethod("chat.send");
    if (input.blocks.some((block) => block.type === "attachment")) throw new UClawUnsupportedError("chat.send.attachments");
    const text = input.blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const queue = new AsyncEventQueue<MessageEvent>();
    let expectedRunId: string | undefined;
    const buffered: MessageEvent[] = [];
    const enqueue = (mapped: MessageEvent): void => {
      if (expectedRunId === undefined) {
        buffered.push(mapped);
        return;
      }
      if (mapped.runId !== expectedRunId) return;
      queue.push(mapped);
      if (mapped.type === "final" || mapped.type === "aborted" || mapped.type === "error") queue.end();
    };
    const removers = [this.options.transport.router.onEvent("chat", (frame) => {
      const raw = RawChatEventSchema.safeParse(frame.payload);
      if (raw.success) enqueue(mapChatEvent(raw.data));
    }), this.options.transport.router.onEvent("session.tool", (frame) => {
      const raw = RawToolCallSchema.safeParse(frame.payload);
      if (raw.success && raw.data.runId !== undefined) enqueue(MessageEventSchema.parse({ type: "tool", runId: raw.data.runId, tool: mapToolCall(raw.data) }));
    }), this.options.transport.router.onEvent("exec.approval.requested", (frame) => {
      const raw = ExecApprovalEventSchema.safeParse(frame.payload);
      if (raw.success) enqueue(MessageEventSchema.parse({ type: "approval", runId: raw.data.runId, approval: mapExecApproval(raw.data.request) }));
    }), this.options.transport.router.onEvent("plugin.approval.requested", (frame) => {
      const raw = PluginApprovalEventSchema.safeParse(frame.payload);
      if (raw.success) enqueue(MessageEventSchema.parse({ type: "approval", runId: raw.data.runId, approval: mapPluginApproval(raw.data.request) }));
    })];
    try {
      const accepted = await this.options.transport.router.request("chat.send", {
        sessionKey: input.sessionId,
        message: text,
        idempotencyKey: input.clientRequestId,
        ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      }, SendResponseSchema);
      expectedRunId = accepted.runId;
      for (const mapped of buffered.splice(0)) enqueue(mapped);
      yield { type: "started", runId: accepted.runId, sessionId: input.sessionId };
      while (signal?.aborted !== true) {
        const item = await queue.next(signal);
        if (item.done) return;
        yield item.value;
      }
    } finally {
      for (const remove of removers) remove();
    }
  }

  private async *watchChat(sessionId: string, signal?: AbortSignal): AsyncIterable<MessageEvent> {
    const queue = new AsyncEventQueue<MessageEvent>();
    const removers = [this.options.transport.router.onEvent("chat", (frame) => {
      const raw = RawChatEventSchema.safeParse(frame.payload);
      if (raw.success && raw.data.sessionKey === sessionId) queue.push(mapChatEvent(raw.data));
    }), this.options.transport.router.onEvent("session.tool", (frame) => {
      const raw = RawToolCallSchema.safeParse(frame.payload);
      if (raw.success && raw.data.sessionKey === sessionId && raw.data.runId !== undefined) queue.push(MessageEventSchema.parse({ type: "tool", runId: raw.data.runId, tool: mapToolCall(raw.data) }));
    }), this.options.transport.router.onEvent("exec.approval.requested", (frame) => {
      const raw = ExecApprovalEventSchema.safeParse(frame.payload);
      if (raw.success && raw.data.request.sessionKey === sessionId) queue.push(MessageEventSchema.parse({ type: "approval", runId: raw.data.runId, approval: mapExecApproval(raw.data.request) }));
    }), this.options.transport.router.onEvent("plugin.approval.requested", (frame) => {
      const raw = PluginApprovalEventSchema.safeParse(frame.payload);
      if (raw.success && (raw.data.request.sessionKey === undefined || raw.data.request.sessionKey === sessionId)) queue.push(MessageEventSchema.parse({ type: "approval", runId: raw.data.runId, approval: mapPluginApproval(raw.data.request) }));
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
    yield this.gatewayStatus();
  }

  private gatewayStatus(): GatewayStatus {
    const stateMap: Record<GatewayWebSocketState, GatewayConnectionState> = {
      idle: "idle", connecting: "connecting", authenticating: "authenticating", ready: "ready", failed: "failed", closed: "closed",
    };
    const ready = this.options.transport.state === "ready";
    return {
      connectionState: stateMap[this.options.transport.state], protocolVersion: 4,
      phase: ready ? "available" : this.options.transport.state === "failed" ? "failed" : "starting",
      processAlive: this.options.transport.state !== "closed", serviceReady: ready, businessAvailable: ready,
      since: this.now(), attempt: 0, ...(this.hello === undefined ? {} : { openClawVersion: this.hello.server.version }),
      usb: { state: "available", dataWritable: true }, ...(this.capabilities === undefined ? {} : { capabilities: this.capabilities }),
    };
  }

  private requireMethod(method: string): void {
    if (this.capabilities?.methods.has(method) !== true) throw new UClawUnsupportedError(method);
  }

  private negotiate(): Promise<CapabilitySet> {
    if (this.capabilities !== undefined) return Promise.resolve(this.capabilities);
    if (this.negotiation !== undefined) return this.negotiation;
    this.negotiation = this.connectWithStartupRetry().then((hello) => {
      this.ensureSequenceGapListener();
      this.hello = hello;
      this.capabilities = capabilitySetFromWire({
        protocolVersion: 4,
        methods: hello.features.methods,
        events: hello.features.events,
        features: { attachments: false, approvalResolve: false },
      });
      return this.capabilities;
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

  private ensureSequenceGapListener(): void {
    if (this.removeSequenceGapListener !== undefined) return;
    this.removeSequenceGapListener = this.options.transport.router.onSequenceGap(this.onResyncRequired);
  }

  private unsupported(capability: string): never {
    throw new UClawUnsupportedError(capability);
  }
}
