import { describe, expect, it, vi } from "vitest";
import type { ClientIpcEvent, ClientIpcRequest, GatewayStatus, MessageEvent, UClawClient } from "@uclaw/shared";

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
    sessions: { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn() },
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
