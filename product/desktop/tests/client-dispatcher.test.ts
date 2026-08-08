import { describe, expect, it, vi } from "vitest";
import type { ClientIpcEvent, ClientIpcRequest, GatewayStatus, MessageEvent, ToolCall, UClawClient } from "@uclaw/shared";

import { createClientDispatcher } from "../src/ipc/client-dispatcher.js";

class ControlledIterator<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly waiting: Array<{ resolve(value: IteratorResult<T>): void; reject(error: unknown): void }> = [];
  readonly return = vi.fn(async (): Promise<IteratorResult<T>> => ({ value: undefined, done: true }));

  [Symbol.asyncIterator](): AsyncIterator<T> { return this; }
  next(): Promise<IteratorResult<T>> {
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }
  push(value: T): void { this.waiting.shift()?.resolve({ value, done: false }); }
  fail(error: unknown): void { this.waiting.shift()?.reject(error); }
}

function clientWith(overrides: Partial<UClawClient>): UClawClient {
  return {
    gateway: { negotiate: vi.fn(), getStatus: vi.fn(), watchStatus: vi.fn(), reconnect: vi.fn() },
    sessions: { list: vi.fn(), get: vi.fn(), create: vi.fn(), rename: vi.fn(), remove: vi.fn() },
    chat: { list: vi.fn(), get: vi.fn(), watch: vi.fn(), send: vi.fn(), abort: vi.fn() },
    tools: { list: vi.fn(), getCall: vi.fn() }, approvals: { listPending: vi.fn(), resolveExec: vi.fn(), resolvePlugin: vi.fn() },
    models: { list: vi.fn(), selectForSession: vi.fn() }, skills: { list: vi.fn() }, channels: { list: vi.fn() },
    files: { list: vi.fn(), readText: vi.fn() }, diagnostics: { list: vi.fn(), listLogs: vi.fn() },
    ...overrides,
  } as UClawClient;
}

const request = (method: ClientIpcRequest["method"], requestId: string, params: object) => ({ method, requestId, params } as ClientIpcRequest);
const status = (attempt: number): GatewayStatus => ({
  connectionState: "ready", protocolVersion: 4, phase: "available", processAlive: true, serviceReady: true,
  businessAvailable: true, since: "2026-08-08T08:00:00.000Z", attempt,
  usb: { state: "available", dataWritable: true },
});

describe("createClientDispatcher stream ownership", () => {
  it("preserves bounded benign tool summaries while redacting renderer-sensitive values", async () => {
    const unsafeTool = {
      id: "tool-summary", sessionId: "session-1", toolId: "exec", displayName: "Run tests",
      state: "failed", risk: "high",
      inputSummary: {
        command: "rm -rf /private/data",
        cwd: "/private/data",
        argv: ["rm", "-rf", "../../private"],
        script: "cat ~/.ssh/id_rsa",
        path: "../secret",
        embeddedPath: "cwd:/private/embedded",
        windowsPath: "C:\\Users\\private\\project",
        tokenCount: 42,
        status: "tests failed",
        outcome: "wrote /Users/private/secret",
        longText: "x".repeat(10_000),
        nested: { deeper: { secret: "must-not-cross" } },
        "Authorization Bearer sk-proj-secretvalue": "failed",
        state: 123456,
        configured: [123456],
        count: true,
      },
      outputSummary: { configured: true, token: "secret-value", apiKey: 123456 },
      error: { code: "OPERATION_FAILED", message: "process failed", retryable: true },
    } as unknown as ToolCall;
    const dispatcher = createClientDispatcher({
      client: clientWith({ tools: {
        list: vi.fn(),
        getCall: vi.fn(async () => unsafeTool),
      } }),
      sendEvent: vi.fn(),
    });

    const response = await dispatcher(request("tools.get-call", "tool-1", { toolCallId: "tool-summary" }));

    expect(response).toMatchObject({ ok: true, result: {
      inputSummary: {
        field_1: "[REDACTED]", field_3: "[REDACTED]",
        tokenCount: 42, status: "tests failed", outcome: "[REDACTED]", field_13: "[REDACTED]",
        state: "[REDACTED]", configured: "[REDACTED]", count: "[REDACTED]",
      },
      outputSummary: { configured: true, field_2: "[REDACTED]", field_3: "[REDACTED]" },
      error: { code: "OPERATION_FAILED", message: "Tool operation failed.", retryable: true },
    } });
    const serialized = JSON.stringify(response);
    expect(serialized).not.toMatch(/rm -rf|\.\.\/private|~\/\.ssh|\.\.\/secret|\/Users\/private|\/private\/(?:data|embedded)|C:\\\\Users|must-not-cross|secret-value|123456|Authorization Bearer|sk-proj-secretvalue/);
    expect(serialized.length).toBeLessThanOrEqual(4_096);
    dispatcher.dispose();
  });

  it("routes session rename without a revision pseudo-CAS", async () => {
    const rename = vi.fn(async () => ({ id: "session-1", title: "重命名后", updatedAt: "2026-08-08T08:00:00.000Z", pinned: false, status: "idle" as const }));
    const dispatcher = createClientDispatcher({ client: clientWith({ sessions: { list: vi.fn(), get: vi.fn(), create: vi.fn(), rename, remove: vi.fn() } }), sendEvent: vi.fn() });

    await expect(dispatcher(request("sessions.rename", "rename-1", { sessionId: "session-1", title: "重命名后" }))).resolves.toMatchObject({ ok: true, result: { title: "重命名后" } });
    expect(rename).toHaveBeenCalledWith("session-1", "重命名后");
    dispatcher.dispose();
  });
  it("drops late send frames from an older generation with the same clientRequestId", async () => {
    const oldStream = new ControlledIterator<MessageEvent>();
    const newStream = new ControlledIterator<MessageEvent>();
    let calls = 0;
    const events: ClientIpcEvent[] = [];
    const dispatcher = createClientDispatcher({
      client: clientWith({ chat: {
        list: vi.fn(), get: vi.fn(), watch: vi.fn(), abort: vi.fn(),
        send: vi.fn(() => calls++ === 0 ? oldStream : newStream),
      } }),
      sendEvent: (event) => events.push(event),
    });
    const first = dispatcher(request("chat.send", "request-old", { sessionId: "session-1", clientRequestId: "same", blocks: [{ type: "text", text: "old", format: "plain" }] }));
    oldStream.push({ type: "started", runId: "run-old", sessionId: "session-1" });
    await first;
    events.length = 0;

    const second = dispatcher(request("chat.send", "request-new", { sessionId: "session-1", clientRequestId: "same", blocks: [{ type: "text", text: "new", format: "plain" }] }));
    newStream.push({ type: "started", runId: "run-new", sessionId: "session-1" });
    await second;
    oldStream.push({ type: "delta", runId: "run-old", mode: "append", text: "late-old" });
    await Promise.resolve();

    expect(events).toEqual([{ event: "chat.send-event", clientRequestId: "same", payload: { type: "started", runId: "run-new", sessionId: "session-1" } }]);
    dispatcher.dispose();
  });

  it("drops late subscription frames from an older generation with the same subscriptionId", async () => {
    const oldStream = new ControlledIterator<GatewayStatus>();
    const newStream = new ControlledIterator<GatewayStatus>();
    let calls = 0;
    const events: ClientIpcEvent[] = [];
    const dispatcher = createClientDispatcher({
      client: clientWith({ gateway: { negotiate: vi.fn(), getStatus: vi.fn(), reconnect: vi.fn(), watchStatus: vi.fn(() => calls++ === 0 ? oldStream : newStream) } }),
      sendEvent: (event) => events.push(event),
    });
    await dispatcher(request("gateway.watch-status", "watch-old", { subscriptionId: "same" }));
    await dispatcher(request("gateway.watch-status", "watch-new", { subscriptionId: "same" }));
    oldStream.push(status(1));
    newStream.push(status(2));
    await Promise.resolve();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "gateway.status", subscriptionId: "same", payload: { attempt: 2 } });
    dispatcher.dispose();
  });

  it("does not emit after dispose when a background stream rejects", async () => {
    const stream = new ControlledIterator<MessageEvent>();
    stream.return.mockRejectedValue(new Error("return failed"));
    const events: ClientIpcEvent[] = [];
    const dispatcher = createClientDispatcher({
      client: clientWith({ chat: { list: vi.fn(), get: vi.fn(), watch: vi.fn(), abort: vi.fn(), send: vi.fn(() => stream) } }),
      sendEvent: (event) => events.push(event),
    });
    const started = dispatcher(request("chat.send", "send-1", { sessionId: "session-1", clientRequestId: "client-1", blocks: [{ type: "text", text: "hello", format: "plain" }] }));
    stream.push({ type: "started", runId: "run-1", sessionId: "session-1" });
    await started;
    events.length = 0;

    dispatcher.dispose();
    stream.fail(new Error("late failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([]);
  });
});
