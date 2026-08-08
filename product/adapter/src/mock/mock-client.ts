import {
  ApprovalRequestSchema,
  CapabilitySetWireSchema,
  MessageEventSchema,
  MessageSchema,
  SessionSchema,
  ToolCallSchema,
  UClawErrorSchema,
  capabilitySetFromWire,
  type ApprovalRequest,
  type GatewayStatus,
  type Message,
  type MessageEvent,
  type Page,
  type PageRequest,
  type SendMessageInput,
  type Session,
  type ToolCall,
  type UClawClient,
} from "@uclaw/shared";

import type { Clock } from "../reconnect.js";
import { AsyncEventQueue, ModelUnavailableError, UClawUnsupportedError } from "../openclaw-client.js";
import { AdapterServiceError } from "../transport/rpc-router.js";

interface ScheduledSleep {
  at: number;
  resolve(): void;
}

interface MessageSubscriber {
  sessionId: string;
  queue: AsyncEventQueue<MessageEvent>;
}

export class ManualClock implements Clock {
  private currentMs: number;
  private readonly sleeps: ScheduledSleep[] = [];

  constructor(start: string | number = 0) {
    this.currentMs = typeof start === "string" ? Date.parse(start) : start;
  }

  now(): string {
    return new Date(this.currentMs).toISOString();
  }

  sleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.sleeps.push({ at: this.currentMs + Math.max(0, delayMs), resolve });
      this.sleeps.sort((left, right) => left.at - right.at);
    });
  }

  async advance(delayMs: number): Promise<void> {
    const target = this.currentMs + Math.max(0, delayMs);
    await Promise.resolve();
    while ((this.sleeps[0]?.at ?? Number.POSITIVE_INFINITY) <= target) {
      const sleep = this.sleeps.shift();
      if (sleep === undefined) break;
      this.currentMs = sleep.at;
      sleep.resolve();
      await Promise.resolve();
    }
    this.currentMs = target;
    await Promise.resolve();
  }

  async runAll(): Promise<void> {
    let idleRounds = 0;
    while (idleRounds < 10) {
      await Promise.resolve();
      const next = this.sleeps[0];
      if (next === undefined) {
        idleRounds += 1;
        continue;
      }
      idleRounds = 0;
      await this.advance(next.at - this.currentMs);
      await Promise.resolve();
    }
  }
}

export interface MockUClawClientOptions {
  clock?: ManualClock;
  streamDelayMs?: number;
  historySize?: number;
}

function page<T>(items: T[], request?: PageRequest): Page<T> {
  const offset = decodeCursor(request?.cursor);
  const limit = request?.limit ?? items.length;
  const selected = items.slice(offset, offset + limit);
  const nextOffset = offset + selected.length;
  return { items: selected, nextCursor: nextOffset < items.length ? String(nextOffset) : null, hasMore: nextOffset < items.length };
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const offset = /^(?:0|[1-9]\d*)$/.test(cursor) ? Number(cursor) : Number.NaN;
  if (!Number.isSafeInteger(offset)) {
    const message = "Invalid pagination cursor";
    throw new AdapterServiceError(message, UClawErrorSchema.parse({
      code: "INVALID_ARGUMENT", message, retryable: false,
      recoveryActions: [], causeDetails: { field: "cursor" },
    }));
  }
  return offset;
}

export class MockUClawClient implements UClawClient {
  private readonly clock: ManualClock;
  private readonly streamDelayMs: number;
  private readonly sessionItems: Session[];
  private readonly messages = new Map<string, Message[]>();
  private readonly toolCalls: ToolCall[];
  private readonly approvalRequests: ApprovalRequest[];
  private readonly abortedRuns = new Set<string>();
  private readonly statusSubscribers = new Set<AsyncEventQueue<GatewayStatus>>();
  private readonly messageSubscribers = new Set<MessageSubscriber>();
  private status: GatewayStatus;
  private runCounter = 0;
  private sessionCounter = 1;
  private messageCounter = 1;

  constructor(options: MockUClawClientOptions = {}) {
    this.clock = options.clock ?? new ManualClock("2026-01-01T00:00:00.000Z");
    this.streamDelayMs = options.streamDelayMs ?? 1;
    const capabilities = capabilitySetFromWire(CapabilitySetWireSchema.parse({
      protocolVersion: 4,
      methods: [
        "sessions.list", "sessions.describe", "sessions.create", "sessions.delete",
        "sessions.patch",
        "chat.history", "chat.message.get", "chat.send", "chat.abort",
        "tools.catalog", "session.tool.get", "exec.approval.list", "plugin.approval.list",
        "sessions.patch",
      ],
      events: ["chat"],
      features: { attachments: false, approvalResolve: false },
    }));
    this.status = {
      connectionState: "ready", protocolVersion: 4, phase: "available",
      processAlive: true, serviceReady: true, businessAvailable: true,
      since: this.clock.now(), attempt: 0,
      openClawVersion: "2026.7.1-2", usb: { state: "available", dataWritable: true, displayName: "U-Claw Data" },
      capabilities,
    };
    const session = SessionSchema.parse({ id: "session-1", title: "Welcome", createdAt: this.clock.now(), updatedAt: this.clock.now(), pinned: false, status: "idle" });
    this.sessionItems = [session];
    const historySize = Math.max(1, Math.floor(options.historySize ?? 1));
    this.messages.set(session.id, Array.from({ length: historySize }, (_, index) => MessageSchema.parse({
      id: `message-${index + 1}`, sessionId: session.id, role: "assistant", status: "completed",
      blocks: [{ id: `block-${index + 1}`, type: "text", text: index === 0 ? "Ready" : `History ${index + 1}`, format: "plain" }],
      createdAt: this.clock.now(),
    })));
    this.messageCounter = historySize;
    this.toolCalls = [ToolCallSchema.parse({
      id: "tool-call-1", sessionId: session.id, runId: "run-pending", toolId: "exec", displayName: "Execute command",
      state: "waiting-authorization", risk: "high", inputSummary: { command: "echo fixture" },
    })];
    this.approvalRequests = [
      ApprovalRequestSchema.parse({
        id: "approval-exec-1", family: "exec", sessionId: session.id, toolCallId: "tool-call-1",
        subject: { kind: "toolCall", id: "tool-call-1" }, title: "Run command", description: "Execute fixture command",
        risk: "high", permissions: [{ kind: "process", scope: "fixture", description: "Run fixture process" }],
        choices: ["allow-once", "deny"], status: "pending",
      }),
      ApprovalRequestSchema.parse({
        id: "approval-plugin-1", family: "plugin", subject: { kind: "plugin", id: "plugin-fixture" },
        title: "Enable plugin", description: "Enable fixture plugin", risk: "medium",
        permissions: [{ kind: "other", scope: "plugin", description: "Enable fixture plugin" }],
        choices: ["allow-once", "deny"], status: "pending",
      }),
    ];
  }

  readonly gateway: UClawClient["gateway"] = {
    negotiate: async () => this.status.capabilities ?? capabilitySetFromWire({ protocolVersion: 4, methods: [], events: [], features: {} }),
    getStatus: async () => this.status,
    watchStatus: (signal) => this.watchGatewayStatus(signal),
    reconnect: async () => {
      this.publishStatus({
        ...this.status, connectionState: "reconnecting", phase: "degraded",
        serviceReady: false, businessAvailable: false, since: this.clock.now(), attempt: this.status.attempt + 1,
      });
      await this.clock.sleep(800);
      this.publishStatus({
        ...this.status, connectionState: "ready", phase: "available",
        serviceReady: true, businessAvailable: true, since: this.clock.now(), attempt: 0,
      });
    },
  };

  readonly sessions: UClawClient["sessions"] = {
    list: async (request) => {
      const query = request?.query?.trim().toLowerCase();
      const items = query === undefined || query.length === 0 ? this.sessionItems : this.sessionItems.filter((session) => [
        session.id, session.title, session.model?.id, session.model?.label,
      ].some((value) => value?.toLowerCase().includes(query) === true));
      return page(items, request);
    },
    get: async (sessionId) => this.requireSession(sessionId),
    create: async (input) => {
      const session = SessionSchema.parse({ id: `session-${++this.sessionCounter}`, title: input?.title ?? "New session", createdAt: this.clock.now(), updatedAt: this.clock.now(), pinned: false, status: "idle", ...(input?.modelId === undefined ? {} : { model: { id: input.modelId, label: input.modelId } }) });
      this.sessionItems.push(session);
      this.messages.set(session.id, []);
      return session;
    },
    rename: async (sessionId, title, revision) => {
      if (revision !== undefined) throw new UClawUnsupportedError("sessions.patch.revision");
      const index = this.sessionItems.findIndex((session) => session.id === sessionId);
      if (index < 0) throw this.notFound("Session");
      const current = this.sessionItems[index];
      const renamed = SessionSchema.parse({ ...current, title, updatedAt: this.clock.now() });
      this.sessionItems[index] = renamed;
      return renamed;
    },
    remove: async (sessionId, revision) => {
      if (revision !== undefined) throw new UClawUnsupportedError("sessions.delete.revision");
      const index = this.sessionItems.findIndex((session) => session.id === sessionId);
      if (index < 0) throw this.notFound("Session");
      this.sessionItems.splice(index, 1);
      this.messages.delete(sessionId);
    },
  };

  readonly chat: UClawClient["chat"] = {
    list: async (sessionId, request) => page(this.requireMessages(sessionId), request),
    get: async (sessionId, messageId) => {
      const message = this.requireMessages(sessionId).find((item) => item.id === messageId);
      if (message === undefined) throw this.notFound("Message");
      return message;
    },
    watch: (sessionId, signal) => this.watchMessages(sessionId, signal),
    send: (input, signal) => this.sendMessage(input, signal),
    abort: async (runId) => { this.abortedRuns.add(runId); },
  };

  readonly tools: UClawClient["tools"] = {
    list: async () => [{ id: "exec", name: "Execute command", source: "built-in", available: true, risk: "high" }],
    getCall: async (toolCallId) => {
      const call = this.toolCalls.find((item) => item.id === toolCallId);
      if (call === undefined) throw this.notFound("Tool call");
      return call;
    },
  };

  readonly approvals: UClawClient["approvals"] = {
    listPending: async (sessionId) => this.approvalRequests.filter((request) => request.status === "pending" && (sessionId === undefined || request.sessionId === sessionId)),
    resolveExec: async () => this.unsupported("exec.approval.resolve"),
    resolvePlugin: async () => this.unsupported("plugin.approval.resolve"),
  };

  readonly models: UClawClient["models"] = {
    list: async () => this.unsupported("models.list"),
    selectForSession: async (sessionId, modelId) => {
      const sessionIndex = this.sessionItems.findIndex((session) => session.id === sessionId);
      const session = this.requireSession(sessionId);
      const separator = modelId.indexOf("/");
      if (separator <= 0 || separator === modelId.length - 1) throw new ModelUnavailableError();
      const providerId = modelId.slice(0, separator);
      const label = modelId.slice(separator + 1);
      this.sessionItems[sessionIndex] = SessionSchema.parse({
        ...session,
        model: { id: modelId, label, providerId },
        updatedAt: this.clock.now(),
      });
    },
  };
  readonly skills: UClawClient["skills"] = { list: async () => this.unsupported("skills.status") };
  readonly channels: UClawClient["channels"] = { list: async () => this.unsupported("channels.status") };
  readonly files: UClawClient["files"] = { list: async () => this.unsupported("files.list"), readText: async () => this.unsupported("files.readText") };
  readonly diagnostics: UClawClient["diagnostics"] = { list: async () => this.unsupported("diagnostics.list"), listLogs: async () => this.unsupported("logs.tail") };

  setConnectionAvailable(available: boolean): void {
    this.publishStatus({
      ...this.status,
      connectionState: available ? "ready" : "failed",
      phase: available ? "available" : "failed",
      processAlive: available,
      serviceReady: available,
      businessAvailable: available,
      since: this.clock.now(),
      attempt: 0,
    });
  }

  private async *watchGatewayStatus(signal?: AbortSignal): AsyncIterable<GatewayStatus> {
    if (signal?.aborted === true) return;
    const queue = new AsyncEventQueue<GatewayStatus>();
    this.statusSubscribers.add(queue);
    try {
      yield this.status;
      while (true) {
        const item = await queue.next(signal);
        if (item.done) return;
        yield item.value;
      }
    } finally {
      this.statusSubscribers.delete(queue);
    }
  }

  private async *watchMessages(sessionId: string, signal?: AbortSignal): AsyncIterable<MessageEvent> {
    this.requireSession(sessionId);
    if (signal?.aborted === true) return;
    const subscriber: MessageSubscriber = { sessionId, queue: new AsyncEventQueue<MessageEvent>() };
    this.messageSubscribers.add(subscriber);
    try {
      while (true) {
        const item = await subscriber.queue.next(signal);
        if (item.done) return;
        yield item.value;
      }
    } finally {
      this.messageSubscribers.delete(subscriber);
    }
  }

  private async *sendMessage(input: SendMessageInput, signal?: AbortSignal): AsyncIterable<MessageEvent> {
    this.requireSession(input.sessionId);
    if (input.blocks.some((block) => block.type === "attachment")) throw new UClawUnsupportedError("chat.send.attachments");
    const text = input.blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
    const userMessage = MessageSchema.parse({
      id: `message-${++this.messageCounter}`, sessionId: input.sessionId, role: "user", status: "completed",
      blocks: [{ id: `block-${this.messageCounter}`, type: "text", text, format: "plain" }], createdAt: this.clock.now(),
    });
    this.requireMessages(input.sessionId).push(userMessage);
    const runId = `run-${++this.runCounter}`;
    yield this.publishMessage(input.sessionId, MessageEventSchema.parse({ type: "started", runId, sessionId: input.sessionId }));
    if (this.isRunAborted(runId, signal)) {
      yield this.publishMessage(input.sessionId, MessageEventSchema.parse({ type: "aborted", runId, reason: "Cancelled" }));
      return;
    }
    await this.clock.sleep(this.streamDelayMs);
    if (this.isRunAborted(runId, signal)) {
      yield this.publishMessage(input.sessionId, MessageEventSchema.parse({ type: "aborted", runId, reason: "Cancelled" }));
      return;
    }
    yield this.publishMessage(input.sessionId, MessageEventSchema.parse({ type: "delta", runId, mode: "append", text: "Fixture " }));
    const tool = ToolCallSchema.parse({
      id: `tool-call-${runId}`, sessionId: input.sessionId, runId, toolId: "exec", displayName: "Inspect workspace",
      state: "waiting-authorization", risk: "high", inputSummary: { command: "fixture inspect" },
    });
    const approval = ApprovalRequestSchema.parse({
      id: `approval-${runId}`, family: "exec", sessionId: input.sessionId, toolCallId: tool.id,
      subject: { kind: "toolCall", id: tool.id }, title: "Inspect workspace", description: "Allow fixture workspace inspection",
      risk: "high", permissions: [{ kind: "file-read", scope: "fixture", description: "Read fixture workspace" }],
      choices: ["allow-once", "deny"], status: "pending",
    });
    this.toolCalls.push(tool);
    this.approvalRequests.push(approval);
    yield this.publishMessage(input.sessionId, MessageEventSchema.parse({ type: "tool", runId, tool }));
    yield this.publishMessage(input.sessionId, MessageEventSchema.parse({ type: "approval", runId, approval }));
    await this.clock.sleep(this.streamDelayMs);
    if (this.isRunAborted(runId, signal)) {
      yield this.publishMessage(input.sessionId, MessageEventSchema.parse({ type: "aborted", runId, reason: "Cancelled" }));
      return;
    }
    yield this.publishMessage(input.sessionId, MessageEventSchema.parse({ type: "delta", runId, mode: "replace", text: "Fixture response" }));
    const message = MessageSchema.parse({
      id: `message-${++this.messageCounter}`, sessionId: input.sessionId, runId, role: "assistant", status: "completed",
      blocks: [{ id: `block-${this.messageCounter}`, type: "text", text: "Fixture response", format: "plain" }], createdAt: this.clock.now(),
    });
    this.requireMessages(input.sessionId).push(message);
    const sessionIndex = this.sessionItems.findIndex((session) => session.id === input.sessionId);
    const session = this.sessionItems[sessionIndex];
    this.sessionItems[sessionIndex] = SessionSchema.parse({
      ...session,
      title: text.trim().slice(0, 48) || session.title,
      lastMessagePreview: "Fixture response",
      updatedAt: this.clock.now(),
      status: "idle",
    });
    yield this.publishMessage(input.sessionId, MessageEventSchema.parse({ type: "final", runId, message }));
  }

  private requireSession(sessionId: string): Session {
    const session = this.sessionItems.find((item) => item.id === sessionId);
    if (session === undefined) throw this.notFound("Session");
    return session;
  }

  private isRunAborted(runId: string, signal?: AbortSignal): boolean {
    return Boolean(signal?.aborted) || this.abortedRuns.has(runId);
  }

  private requireMessages(sessionId: string): Message[] {
    this.requireSession(sessionId);
    return this.messages.get(sessionId) ?? [];
  }

  private unsupported(capability: string): never {
    throw new UClawUnsupportedError(capability);
  }

  private publishStatus(status: GatewayStatus): void {
    this.status = status;
    for (const subscriber of this.statusSubscribers) subscriber.push(status);
  }

  private publishMessage(sessionId: string, event: MessageEvent): MessageEvent {
    for (const subscriber of this.messageSubscribers) {
      if (subscriber.sessionId === sessionId) subscriber.queue.push(event);
    }
    return event;
  }

  private notFound(subject: string): AdapterServiceError {
    const message = `${subject} not found`;
    return new AdapterServiceError(message, UClawErrorSchema.parse({
      code: "NOT_FOUND", message, retryable: false,
      recoveryActions: [], causeDetails: {},
    }));
  }
}
