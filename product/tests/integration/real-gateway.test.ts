import { describe, expect, it, vi } from "vitest";

import { GatewayWebSocket, OpenClawClient, type WebSocketLike } from "@uclaw/adapter";
import type { ClientIpcEvent, ClientIpcRequest, UClawClient } from "@uclaw/shared";
import { createClientDispatcher } from "../../desktop/src/ipc/client-dispatcher.js";
import { createRendererClient, type RendererClientBridge } from "../../frontend/src/app/renderer-client.js";

class ScriptedGatewaySocket implements WebSocketLike {
  private readonly listeners = new Map<string, Set<(event: { data?: string }) => void>>();
  readonly requests: Array<{ id: string; method: string; params: Record<string, unknown> }> = [];

  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: string }) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: string }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    const request = JSON.parse(data) as { id: string; method: string; params: Record<string, unknown> };
    this.requests.push(request);
    if (request.method === "connect") {
      this.respond(request.id, {
        type: "hello-ok", protocol: 4, server: { version: "2026.7.1-2" },
        features: {
          methods: ["sessions.list", "sessions.get", "chat.history", "chat.send", "chat.abort", "exec.approval.list", "plugin.approval.list"],
          events: ["chat"],
        },
        policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000 },
      });
      return;
    }
    if (request.method === "sessions.list") {
      this.respond(request.id, { sessions: [rawSession], nextCursor: null, hasMore: false });
      return;
    }
    if (request.method === "sessions.get") {
      this.respond(request.id, rawSession);
      return;
    }
    if (request.method === "chat.history") {
      this.respond(request.id, { sessionKey: "session-real", sessionId: "session-real-id", messages: [] });
      return;
    }
    if (request.method === "chat.send") {
      this.respond(request.id, { runId: "run-real", status: "accepted" });
      queueMicrotask(() => {
        this.event("chat", { runId: "run-real", sessionKey: "session-real", state: "delta", deltaText: "真实链路响应" }, 1);
        this.event("chat", {
          runId: "run-real", sessionKey: "session-real", state: "final",
          message: {
            id: "message-real", sessionKey: "session-real", runId: "run-real", role: "assistant", status: "completed",
            blocks: [{ id: "block-real", type: "text", text: "真实链路响应", format: "plain" }], createdAt: "2026-08-08T08:01:00.000Z",
          },
        }, 2);
      });
      return;
    }
    if (request.method === "chat.abort") {
      this.respond(request.id, {});
      return;
    }
    if (request.method.endsWith("approval.list")) {
      this.respond(request.id, []);
    }
  }

  close(): void {
    this.emit("close");
  }

  open(): void {
    this.emit("open");
    this.event("connect.challenge", { nonce: "nonce-real", ts: 1 });
  }

  fail(): void {
    this.emit("close");
  }

  private respond(id: string, payload: unknown): void {
    queueMicrotask(() => this.emit("message", JSON.stringify({ type: "res", id, ok: true, payload })));
  }

  private event(event: string, payload: unknown, seq?: number): void {
    this.emit("message", JSON.stringify({ type: "event", event, payload, ...(seq === undefined ? {} : { seq }) }));
  }

  private emit(type: "open" | "message" | "close" | "error", data?: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

const rawSession = {
  sessionKey: "session-real", title: "真实会话", createdAt: "2026-08-08T08:00:00.000Z",
  updatedAt: "2026-08-08T08:00:00.000Z", pinned: false, status: "idle" as const,
  model: { id: "openai/gpt-5", label: "GPT-5", providerId: "openai" },
};

function connectRealEquivalentGateway() {
  const socket = new ScriptedGatewaySocket();
  const transport = new GatewayWebSocket({
    url: "ws://127.0.0.1:18789",
    webSocketFactory: () => socket,
    connectParams: () => ({ client: { id: "u-claw-desktop", mode: "desktop" }, role: "operator", scopes: ["operator.read", "operator.write"] }),
    requestTimeoutMs: 100,
  });
  const client = new OpenClawClient({ transport });
  const negotiation = client.gateway.negotiate();
  socket.open();
  return { socket, client, negotiation };
}

function bridgeFor(client: UClawClient) {
  const listeners = new Set<(event: ClientIpcEvent) => void>();
  const dispatch = createClientDispatcher({ client, sendEvent: (event) => listeners.forEach((listener) => listener(event)) });
  const bridge: RendererClientBridge = {
    invoke: (request: ClientIpcRequest) => dispatch(request),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return createRendererClient(bridge);
}

describe("real OpenClaw gateway mainline", () => {
  it("negotiates v4 and carries sessions, history, model and streaming chat through typed IPC", async () => {
    const { client, negotiation } = connectRealEquivalentGateway();
    await expect(negotiation).resolves.toMatchObject({ protocolVersion: 4, features: { attachments: false } });
    const rendererClient = bridgeFor(client);

    await expect(rendererClient.sessions.list()).resolves.toMatchObject({ items: [{ id: "session-real", model: { label: "GPT-5" } }] });
    await expect(rendererClient.sessions.get("session-real")).resolves.toMatchObject({ title: "真实会话" });
    await expect(rendererClient.chat.list("session-real")).resolves.toEqual({ items: [], nextCursor: null, hasMore: false });

    const events = [];
    for await (const event of rendererClient.chat.send({
      sessionId: "session-real", clientRequestId: "client-real", blocks: [{ type: "text", text: "测试真实主链", format: "plain" }],
    })) events.push(event);
    expect(events.map((event) => event.type)).toEqual(["started", "delta", "final"]);
    expect(events.at(-1)).toMatchObject({ type: "final", message: { sessionId: "session-real" } });
  });

  it("normalizes a closed v4 gateway without leaking connection details to renderer", async () => {
    const { socket, client, negotiation } = connectRealEquivalentGateway();
    await negotiation;
    const rendererClient = bridgeFor(client);
    socket.fail();

    const error = await rendererClient.sessions.list().catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "GATEWAY_DISCONNECTED", retryable: true });
    expect(JSON.stringify(error)).not.toContain("ws://");
  });

  it("routes abort, tool lookup and approvals only through fixed client methods", async () => {
    const client = {
      gateway: { negotiate: vi.fn(), getStatus: vi.fn(), watchStatus: vi.fn(), reconnect: vi.fn() },
      sessions: { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn() },
      chat: { list: vi.fn(), get: vi.fn(), watch: vi.fn(), send: vi.fn(), abort: vi.fn(async () => undefined) },
      tools: { list: vi.fn(), getCall: vi.fn(async () => ({ id: "tool-1" })) },
      approvals: { listPending: vi.fn(async () => []), resolveExec: vi.fn(async () => undefined), resolvePlugin: vi.fn(async () => undefined) },
      models: { list: vi.fn(), selectForSession: vi.fn() }, skills: { list: vi.fn() }, channels: { list: vi.fn() },
      files: { list: vi.fn(), readText: vi.fn() }, diagnostics: { list: vi.fn(), listLogs: vi.fn() },
    } as unknown as UClawClient;
    const rendererClient = bridgeFor(client);

    await rendererClient.chat.abort("run-1");
    await rendererClient.approvals.resolveExec({ ref: { family: "exec", id: "approval-1" }, decision: "deny" });
    expect(client.chat.abort).toHaveBeenCalledWith("run-1");
    expect(client.approvals.resolveExec).toHaveBeenCalledWith({ ref: { family: "exec", id: "approval-1" }, decision: "deny" });
  });

  it("closes failed subscriptions and cancels send streams across IPC", async () => {
    const sendAborted = vi.fn();
    const abort = vi.fn(async () => undefined);
    const client = {
      gateway: {
        negotiate: vi.fn(), getStatus: vi.fn(), reconnect: vi.fn(),
        watchStatus: async function* () {
          await new Promise((resolve) => setTimeout(resolve, 0));
          throw { code: "GATEWAY_DISCONNECTED", message: "Disconnected", retryable: true, recoveryActions: ["reconnect"], causeDetails: {} };
        },
      },
      sessions: { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn() },
      chat: {
        list: vi.fn(), get: vi.fn(), watch: vi.fn(), abort,
        send: async function* (_input: unknown, signal?: AbortSignal) {
          try {
            yield { type: "started" as const, runId: "run-cancel", sessionId: "session-1" };
            await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
          } finally {
            sendAborted();
          }
        },
      },
      tools: { list: vi.fn(), getCall: vi.fn() }, approvals: { listPending: vi.fn(), resolveExec: vi.fn(), resolvePlugin: vi.fn() },
      models: { list: vi.fn(), selectForSession: vi.fn() }, skills: { list: vi.fn() }, channels: { list: vi.fn() },
      files: { list: vi.fn(), readText: vi.fn() }, diagnostics: { list: vi.fn(), listLogs: vi.fn() },
    } as unknown as UClawClient;
    const rendererClient = bridgeFor(client);

    await expect(rendererClient.gateway.watchStatus()[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "GATEWAY_DISCONNECTED" });

    const controller = new AbortController();
    const stream = rendererClient.chat.send({
      sessionId: "session-1", clientRequestId: "client-cancel", blocks: [{ type: "text", text: "cancel", format: "plain" }],
    }, controller.signal)[Symbol.asyncIterator]();
    await expect(stream.next()).resolves.toMatchObject({ value: { type: "started", runId: "run-cancel" } });
    controller.abort();
    await expect(stream.next()).resolves.toMatchObject({ done: true });
    await vi.waitFor(() => expect(sendAborted).toHaveBeenCalledOnce());
    expect(abort).toHaveBeenCalledWith("run-cancel");
  });

  it("cancels a send before the started event arrives", async () => {
    const sendAborted = vi.fn();
    const client = {
      gateway: { negotiate: vi.fn(), getStatus: vi.fn(), watchStatus: vi.fn(), reconnect: vi.fn() },
      sessions: { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn() },
      chat: {
        list: vi.fn(), get: vi.fn(), watch: vi.fn(), abort: vi.fn(),
        send: async function* (_input: unknown, signal?: AbortSignal) {
          try {
            await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
          } finally {
            sendAborted();
          }
        },
      },
      tools: { list: vi.fn(), getCall: vi.fn() }, approvals: { listPending: vi.fn(), resolveExec: vi.fn(), resolvePlugin: vi.fn() },
      models: { list: vi.fn(), selectForSession: vi.fn() }, skills: { list: vi.fn() }, channels: { list: vi.fn() },
      files: { list: vi.fn(), readText: vi.fn() }, diagnostics: { list: vi.fn(), listLogs: vi.fn() },
    } as unknown as UClawClient;
    const rendererClient = bridgeFor(client);
    const controller = new AbortController();
    const first = rendererClient.chat.send({
      sessionId: "session-1", clientRequestId: "client-prestart", blocks: [{ type: "text", text: "cancel", format: "plain" }],
    }, controller.signal)[Symbol.asyncIterator]().next();

    controller.abort();
    await expect(first).resolves.toMatchObject({ done: true });
    expect(sendAborted).toHaveBeenCalledOnce();
  });

  it("redacts command and cwd from approval responses", async () => {
    const sensitiveApproval = {
      id: "approval-1", family: "exec" as const, subject: { kind: "operation" as const, id: "approval-1" },
      title: "Approve command", description: "rm -rf /private/data", risk: "high" as const,
      permissions: [{ kind: "process" as const, scope: "/private/data", description: "Execute command" }],
      choices: ["deny" as const], status: "pending" as const,
    };
    const client = {
      gateway: { negotiate: vi.fn(), getStatus: vi.fn(), watchStatus: vi.fn(), reconnect: vi.fn() },
      sessions: { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn() },
      chat: { list: vi.fn(), get: vi.fn(), watch: vi.fn(), send: vi.fn(), abort: vi.fn() },
      tools: { list: vi.fn(), getCall: vi.fn(async () => ({
        id: "tool-1", sessionId: "session-1", toolId: "exec", displayName: "Execute", state: "running", risk: "high",
        inputSummary: { command: "rm -rf /private/data", cwd: "/private/data" },
      })) },
      approvals: { listPending: vi.fn(async () => [sensitiveApproval]), resolveExec: vi.fn(), resolvePlugin: vi.fn() },
      models: { list: vi.fn(), selectForSession: vi.fn() }, skills: { list: vi.fn() }, channels: { list: vi.fn() },
      files: { list: vi.fn(), readText: vi.fn() }, diagnostics: { list: vi.fn(), listLogs: vi.fn() },
    } as unknown as UClawClient;
    const rendererClient = bridgeFor(client);

    const approvals = await rendererClient.approvals.listPending();
    expect(approvals).toMatchObject([{ id: "approval-1", family: "exec", choices: ["deny"] }]);
    expect(JSON.stringify(approvals)).not.toContain("rm -rf");
    expect(JSON.stringify(approvals)).not.toContain("/private/data");
    const tool = await rendererClient.tools.getCall("tool-1");
    expect(tool).toMatchObject({ id: "tool-1", state: "running" });
    expect(JSON.stringify(tool)).not.toContain("rm -rf");
    expect(JSON.stringify(tool)).not.toContain("/private/data");
  });

  it("projects session details without renderer-visible metadata", async () => {
    const session = {
      id: "session-sensitive", title: "Safe title", createdAt: "2026-08-08T08:00:00.000Z", updatedAt: "2026-08-08T08:00:00.000Z",
      pinned: false, status: "idle" as const, revision: "7",
      metadata: {
        token: "sk-secret-token", cwd: "/private/work", path: "C:\\Users\\secret", endpoint: "http://127.0.0.1:18789/private",
      },
    };
    const client = {
      gateway: { negotiate: vi.fn(), getStatus: vi.fn(), watchStatus: vi.fn(), reconnect: vi.fn() },
      sessions: { list: vi.fn(), get: vi.fn(async () => session), create: vi.fn(async () => session), remove: vi.fn() },
      chat: { list: vi.fn(), get: vi.fn(), watch: vi.fn(), send: vi.fn(), abort: vi.fn() },
      tools: { list: vi.fn(), getCall: vi.fn() }, approvals: { listPending: vi.fn(), resolveExec: vi.fn(), resolvePlugin: vi.fn() },
      models: { list: vi.fn(), selectForSession: vi.fn() }, skills: { list: vi.fn() }, channels: { list: vi.fn() },
      files: { list: vi.fn(), readText: vi.fn() }, diagnostics: { list: vi.fn(), listLogs: vi.fn() },
    } as unknown as UClawClient;
    const rendererClient = bridgeFor(client);

    const received = [await rendererClient.sessions.get(session.id), await rendererClient.sessions.create({ title: "Safe title" })];
    expect(received).toMatchObject([{ id: session.id, revision: "7" }, { id: session.id, revision: "7" }]);
    expect(received.every((item) => item.metadata === undefined)).toBe(true);
    const serialized = JSON.stringify(received);
    for (const secret of ["sk-secret-token", "/private/work", "C:\\Users\\secret", "http://127.0.0.1:18789/private"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("projects every legal UClawError to an opaque renderer-safe error", async () => {
    const unsafeError = {
      code: "OPERATION_FAILED" as const,
      message: "Run rm -rf /private/work at http://127.0.0.1:18789 with sk-secret-token",
      retryable: true,
      recoveryActions: ["retry" as const],
      causeDetails: { operation: "cwd=/private/work command=rm -rf" },
      correlationId: "http://127.0.0.1:18789/private",
    };
    const client = {
      gateway: { negotiate: vi.fn(), getStatus: vi.fn(), watchStatus: vi.fn(), reconnect: vi.fn() },
      sessions: { list: vi.fn(), get: vi.fn(async () => { throw unsafeError; }), create: vi.fn(), remove: vi.fn() },
      chat: { list: vi.fn(), get: vi.fn(), watch: vi.fn(), send: vi.fn(), abort: vi.fn() },
      tools: { list: vi.fn(), getCall: vi.fn() }, approvals: { listPending: vi.fn(), resolveExec: vi.fn(), resolvePlugin: vi.fn() },
      models: { list: vi.fn(), selectForSession: vi.fn() }, skills: { list: vi.fn() }, channels: { list: vi.fn() },
      files: { list: vi.fn(), readText: vi.fn() }, diagnostics: { list: vi.fn(), listLogs: vi.fn() },
    } as unknown as UClawClient;
    const rendererClient = bridgeFor(client);

    const error = await rendererClient.sessions.get("session-1").catch((reason: unknown) => reason) as Error & Record<string, unknown>;
    expect(error).toMatchObject({ code: "OPERATION_FAILED", retryable: true, recoveryActions: ["retry"], causeDetails: {} });
    expect(error.message).toBe("Client operation failed.");
    expect(error.correlationId).toBeUndefined();
    const serialized = `${error.message} ${JSON.stringify(error)}`;
    for (const secret of ["rm -rf", "/private/work", "http://127.0.0.1:18789", "sk-secret-token"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("projects nested error fields across renderer-facing management DTOs", async () => {
    const unsafeSummary = {
      code: "OPERATION_FAILED" as const,
      message: "Run rm -rf /private/work at http://127.0.0.1:18789 with sk-secret-token",
      retryable: true,
    };
    const unsafeError = {
      ...unsafeSummary,
      recoveryActions: ["retry" as const],
      causeDetails: { operation: "cwd=/private/work command=rm -rf" },
      correlationId: "http://127.0.0.1:18789/private",
    };
    const gatewayStatus = {
      connectionState: "failed" as const, protocolVersion: 4 as const, phase: "failed" as const,
      processAlive: false, serviceReady: false, businessAvailable: false,
      since: "2026-08-08T08:00:00.000Z", attempt: 1,
      usb: { state: "available" as const, dataWritable: true }, error: unsafeError,
    };
    const client = {
      gateway: {
        negotiate: vi.fn(), getStatus: vi.fn(async () => gatewayStatus), reconnect: vi.fn(),
        watchStatus: async function* () { yield gatewayStatus; },
      },
      sessions: { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn() },
      chat: { list: vi.fn(), get: vi.fn(), watch: vi.fn(), send: vi.fn(), abort: vi.fn() },
      tools: { list: vi.fn(), getCall: vi.fn() }, approvals: { listPending: vi.fn(), resolveExec: vi.fn(), resolvePlugin: vi.fn() },
      models: { list: vi.fn(async () => [{ id: "model-1", label: "Model", providerId: "provider-1", available: false, locality: "cloud", capabilities: ["text"], unavailableReason: unsafeSummary }]), selectForSession: vi.fn() },
      skills: { list: vi.fn() },
      channels: { list: vi.fn(async () => [{ id: "channel-1", kind: "telegram", name: "Telegram", configured: true, enabled: true, state: "error", error: unsafeSummary }]) },
      files: { list: vi.fn(), readText: vi.fn() },
      diagnostics: { list: vi.fn(async () => [{ id: "diagnostic-1", label: "Gateway", state: "failed", repairable: true, error: unsafeSummary }]), listLogs: vi.fn() },
    } as unknown as UClawClient;
    const rendererClient = bridgeFor(client);

    const watched = await rendererClient.gateway.watchStatus()[Symbol.asyncIterator]().next();
    const received = [
      await rendererClient.gateway.getStatus(), watched.value,
      ...(await rendererClient.models.list()), ...(await rendererClient.channels.list()), ...(await rendererClient.diagnostics.list()),
    ];
    expect(received.map((item) => item?.error ?? item?.unavailableReason)).toEqual([
      expect.objectContaining({ code: "OPERATION_FAILED", message: "Client operation failed.", retryable: true }),
      expect.objectContaining({ code: "OPERATION_FAILED", message: "Client operation failed.", retryable: true }),
      expect.objectContaining({ code: "OPERATION_FAILED", message: "Client operation failed.", retryable: true }),
      expect.objectContaining({ code: "OPERATION_FAILED", message: "Client operation failed.", retryable: true }),
      expect.objectContaining({ code: "OPERATION_FAILED", message: "Client operation failed.", retryable: true }),
    ]);
    const serialized = JSON.stringify(received);
    for (const secret of ["rm -rf", "/private/work", "http://127.0.0.1:18789", "sk-secret-token"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("keeps chat.watch open across terminal events from multiple runs", async () => {
    const message = (runId: string) => ({
      type: "final" as const, runId,
      message: {
        id: `message-${runId}`, sessionId: "session-1", runId, role: "assistant" as const, status: "completed" as const,
        blocks: [], createdAt: "2026-08-08T08:00:00.000Z",
      },
    });
    const client = {
      gateway: { negotiate: vi.fn(), getStatus: vi.fn(), watchStatus: vi.fn(), reconnect: vi.fn() },
      sessions: { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn() },
      chat: {
        list: vi.fn(), get: vi.fn(), send: vi.fn(), abort: vi.fn(),
        watch: async function* () { yield message("run-1"); yield message("run-2"); },
      },
      tools: { list: vi.fn(), getCall: vi.fn() }, approvals: { listPending: vi.fn(), resolveExec: vi.fn(), resolvePlugin: vi.fn() },
      models: { list: vi.fn(), selectForSession: vi.fn() }, skills: { list: vi.fn() }, channels: { list: vi.fn() },
      files: { list: vi.fn(), readText: vi.fn() }, diagnostics: { list: vi.fn(), listLogs: vi.fn() },
    } as unknown as UClawClient;
    const rendererClient = bridgeFor(client);
    const events = [];
    for await (const event of rendererClient.chat.watch("session-1")) events.push(event);

    expect(events.map((event) => event.runId)).toEqual(["run-1", "run-2"]);
  });
});
