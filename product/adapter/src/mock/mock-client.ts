import {
  ApprovalRequestSchema,
  CapabilitySetWireSchema,
  MessageEventSchema,
  MessageSchema,
  SessionSchema,
  ToolCallSchema,
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
import { UClawUnsupportedError } from "../openclaw-client.js";

interface ScheduledSleep {
  at: number;
  resolve(): void;
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
}

function page<T>(items: T[], request?: PageRequest): Page<T> {
  const offset = request?.cursor === undefined ? 0 : Number.parseInt(request.cursor, 10);
  const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;
  const limit = request?.limit ?? items.length;
  const selected = items.slice(safeOffset, safeOffset + limit);
  const nextOffset = safeOffset + selected.length;
  return { items: selected, nextCursor: nextOffset < items.length ? String(nextOffset) : null, hasMore: nextOffset < items.length };
}

export class MockUClawClient implements UClawClient {
  private readonly clock: ManualClock;
  private readonly streamDelayMs: number;
  private readonly sessionItems: Session[];
  private readonly messages = new Map<string, Message[]>();
  private readonly toolCalls: ToolCall[];
  private readonly approvalRequests: ApprovalRequest[];
  private readonly abortedRuns = new Set<string>();
  private status: GatewayStatus;
  private runCounter = 0;
  private sessionCounter = 1;
  private messageCounter = 1;

  constructor(options: MockUClawClientOptions = {}) {
    this.clock = options.clock ?? new ManualClock("2026-01-01T00:00:00.000Z");
    this.streamDelayMs = options.streamDelayMs ?? 1;
    const capabilities = capabilitySetFromWire(CapabilitySetWireSchema.parse({
      protocolVersion: 4,
      methods: ["sessions.list", "chat.history", "chat.send", "chat.abort", "tools.catalog", "exec.approval.list", "plugin.approval.list"],
      events: ["chat", "session.tool", "exec.approval.requested", "plugin.approval.requested"],
      features: { attachments: false },
    }));
    this.status = {
      connectionState: "ready", protocolVersion: 4, phase: "available",
      processAlive: true, serviceReady: true, businessAvailable: true,
      since: this.clock.now(), attempt: 0,
      openClawVersion: "2026.7.1-2", usb: { state: "available", dataWritable: true, displayName: "U-Claw Data" },
      capabilities,
    };
    const session = SessionSchema.parse({ id: "session-1", title: "Welcome", createdAt: this.clock.now(), updatedAt: this.clock.now(), pinned: false, status: "idle", revision: "1" });
    this.sessionItems = [session];
    this.messages.set(session.id, [MessageSchema.parse({
      id: "message-1", sessionId: session.id, role: "assistant", status: "completed",
      blocks: [{ id: "block-1", type: "text", text: "Ready", format: "plain" }], createdAt: this.clock.now(),
    })]);
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
      this.status = { ...this.status, connectionState: "reconnecting", phase: "degraded", businessAvailable: false, attempt: this.status.attempt + 1 };
      await this.clock.sleep(800);
      this.status = { ...this.status, connectionState: "ready", phase: "available", businessAvailable: true, since: this.clock.now() };
    },
  };

  readonly sessions: UClawClient["sessions"] = {
    list: async (request) => page(this.sessionItems, request),
    get: async (sessionId) => this.requireSession(sessionId),
    create: async (input) => {
      const session = SessionSchema.parse({ id: `session-${++this.sessionCounter}`, title: input?.title ?? "New session", createdAt: this.clock.now(), updatedAt: this.clock.now(), pinned: false, status: "idle", revision: "1", ...(input?.modelId === undefined ? {} : { model: { id: input.modelId, label: input.modelId } }) });
      this.sessionItems.push(session);
      this.messages.set(session.id, []);
      return session;
    },
    remove: async (sessionId) => {
      const index = this.sessionItems.findIndex((session) => session.id === sessionId);
      if (index < 0) throw new Error("Session not found");
      this.sessionItems.splice(index, 1);
      this.messages.delete(sessionId);
    },
  };

  readonly chat: UClawClient["chat"] = {
    list: async (sessionId, request) => page(this.requireMessages(sessionId), request),
    get: async (sessionId, messageId) => {
      const message = this.requireMessages(sessionId).find((item) => item.id === messageId);
      if (message === undefined) throw new Error("Message not found");
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
      if (call === undefined) throw new Error("Tool call not found");
      return call;
    },
  };

  readonly approvals: UClawClient["approvals"] = {
    listPending: async (sessionId) => this.approvalRequests.filter((request) => request.status === "pending" && (sessionId === undefined || request.sessionId === sessionId)),
    resolveExec: async (input) => this.resolveApproval("exec", input.ref.id),
    resolvePlugin: async (input) => this.resolveApproval("plugin", input.ref.id),
  };

  readonly models: UClawClient["models"] = { list: async () => this.unsupported("models.list"), selectForSession: async () => this.unsupported("sessions.patch.model") };
  readonly skills: UClawClient["skills"] = { list: async () => this.unsupported("skills.status") };
  readonly channels: UClawClient["channels"] = { list: async () => this.unsupported("channels.status") };
  readonly files: UClawClient["files"] = { list: async () => this.unsupported("files.list"), readText: async () => this.unsupported("files.readText") };
  readonly diagnostics: UClawClient["diagnostics"] = { list: async () => this.unsupported("diagnostics.list"), listLogs: async () => this.unsupported("logs.tail") };

  private async *watchGatewayStatus(signal?: AbortSignal): AsyncIterable<GatewayStatus> {
    if (signal?.aborted === true) return;
    yield this.status;
  }

  private async *watchMessages(sessionId: string, signal?: AbortSignal): AsyncIterable<MessageEvent> {
    this.requireSession(sessionId);
    if (signal?.aborted === true) return;
  }

  private async *sendMessage(input: SendMessageInput, signal?: AbortSignal): AsyncIterable<MessageEvent> {
    this.requireSession(input.sessionId);
    if (input.blocks.some((block) => block.type === "attachment")) throw new UClawUnsupportedError("chat.send.attachments");
    const runId = `run-${++this.runCounter}`;
    yield MessageEventSchema.parse({ type: "started", runId, sessionId: input.sessionId });
    if (this.isRunAborted(runId, signal)) {
      yield MessageEventSchema.parse({ type: "aborted", runId, reason: "Cancelled" });
      return;
    }
    await this.clock.sleep(this.streamDelayMs);
    if (this.isRunAborted(runId, signal)) {
      yield MessageEventSchema.parse({ type: "aborted", runId, reason: "Cancelled" });
      return;
    }
    yield MessageEventSchema.parse({ type: "delta", runId, mode: "append", text: "Fixture " });
    await this.clock.sleep(this.streamDelayMs);
    if (this.isRunAborted(runId, signal)) {
      yield MessageEventSchema.parse({ type: "aborted", runId, reason: "Cancelled" });
      return;
    }
    yield MessageEventSchema.parse({ type: "delta", runId, mode: "replace", text: "Fixture response" });
    const message = MessageSchema.parse({
      id: `message-${++this.messageCounter}`, sessionId: input.sessionId, runId, role: "assistant", status: "completed",
      blocks: [{ id: `block-${this.messageCounter}`, type: "text", text: "Fixture response", format: "plain" }], createdAt: this.clock.now(),
    });
    this.requireMessages(input.sessionId).push(message);
    yield MessageEventSchema.parse({ type: "final", runId, message });
  }

  private requireSession(sessionId: string): Session {
    const session = this.sessionItems.find((item) => item.id === sessionId);
    if (session === undefined) throw new Error("Session not found");
    return session;
  }

  private isRunAborted(runId: string, signal?: AbortSignal): boolean {
    return Boolean(signal?.aborted) || this.abortedRuns.has(runId);
  }

  private requireMessages(sessionId: string): Message[] {
    this.requireSession(sessionId);
    return this.messages.get(sessionId) ?? [];
  }

  private resolveApproval(family: ApprovalRequest["family"], id: string): void {
    const index = this.approvalRequests.findIndex((request) => request.family === family && request.id === id);
    if (index < 0) throw new Error("Approval not found");
    this.approvalRequests[index] = ApprovalRequestSchema.parse({ ...this.approvalRequests[index], status: "resolved" });
  }

  private unsupported(capability: string): never {
    throw new UClawUnsupportedError(capability);
  }
}
