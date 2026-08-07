import { describe, expect, it } from "vitest";
import { type z } from "zod";

import { OpenClawClient, UClawUnsupportedError, type OpenClawTransport } from "../src/openclaw-client.js";
import { ManualClock } from "../src/mock/mock-client.js";
import { ReconnectPolicy } from "../src/reconnect.js";
import type { HelloOk } from "../src/transport/gateway-websocket.js";
import { RpcRemoteError, type EventFrame, type JsonValue } from "../src/transport/rpc-router.js";

class FakeTransport implements OpenClawTransport {
  state = "idle" as const;
  readonly calls: string[] = [];
  readonly fixtures = new Map<string, JsonValue>();
  readonly eventListeners = new Set<(frame: EventFrame) => void>();
  readonly connectFailures: Error[] = [];
  connectCalls = 0;

  async connect(): Promise<HelloOk> {
    this.connectCalls += 1;
    const failure = this.connectFailures.shift();
    if (failure !== undefined) throw failure;
    return {
      type: "hello-ok" as const,
      protocol: 4 as const,
      server: { version: "2026.7.1-2" },
      features: { methods: ["sessions.list", "chat.send", "chat.abort", "exec.approval.list", "plugin.approval.list"], events: ["chat"] },
      policy: { maxPayload: 65_536, maxBufferedBytes: 131_072 },
    };
  }

  close(): void {}

  emit(event: string, payload: JsonValue, seq: number): void {
    const frame = { type: "event" as const, event, payload, seq };
    for (const listener of this.eventListeners) listener(frame);
  }

  readonly router = {
    request: async <T>(method: string, _params: JsonValue, schema: z.ZodType<T>): Promise<T> => {
      this.calls.push(method);
      return schema.parse(this.fixtures.get(method));
    },
    onEvent: (_event: string, listener: (frame: EventFrame) => void) => {
      this.eventListeners.add(listener);
      return () => this.eventListeners.delete(listener);
    },
  };
}

describe("OpenClawClient", () => {
  it("negotiates hello capabilities and maps session list", async () => {
    const transport = new FakeTransport();
    transport.fixtures.set("sessions.list", {
      sessions: [{ sessionKey: "session-1", title: "Chat", createdAt: "2026-08-07T12:00:00.000Z", updatedAt: "2026-08-07T12:00:00.000Z", pinned: false, status: "idle" }],
      nextCursor: null,
      hasMore: false,
    });
    const client = new OpenClawClient({ transport });

    const capabilities = await client.gateway.negotiate();
    expect(capabilities.methods.has("sessions.list")).toBe(true);
    await client.gateway.negotiate();
    expect(transport.connectCalls).toBe(1);
    await expect(client.sessions.list()).resolves.toMatchObject({ items: [{ id: "session-1" }] });
  });

  it("shares an in-flight negotiation", async () => {
    const transport = new FakeTransport();
    const client = new OpenClawClient({ transport });
    await Promise.all([client.gateway.negotiate(), client.gateway.negotiate()]);
    expect(transport.connectCalls).toBe(1);
  });

  it("keeps unsupported attachment and approval resolve capabilities closed", async () => {
    const transport = new FakeTransport();
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    const sessionId = "session-1";

    const stream = client.chat.send({ sessionId, clientRequestId: "request-1", blocks: [{ type: "attachment", attachmentId: "attachment-1" }] });
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(UClawUnsupportedError);
    await expect(client.approvals.resolveExec({ ref: { family: "exec", id: "approval-1" }, decision: "deny" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(transport.calls).toEqual([]);
  });

  it("stops local stream waiting when AbortSignal aborts", async () => {
    const transport = new FakeTransport();
    transport.fixtures.set("chat.send", { runId: "run-1", status: "accepted" });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    const controller = new AbortController();
    const iterator = client.chat.send({ sessionId: "session-1", clientRequestId: "request-1", blocks: [{ type: "text", text: "hello", format: "plain" }] }, controller.signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "started" } });
    const waiting = iterator.next();
    controller.abort();
    await expect(waiting).resolves.toEqual({ value: undefined, done: true });
  });

  it("removes chat listener when send RPC rejects", async () => {
    const transport = new FakeTransport();
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    const iterator = client.chat.send({ sessionId: "session-1", clientRequestId: "request-fail", blocks: [{ type: "text", text: "hello", format: "plain" }] })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow();
    expect(transport.eventListeners.size).toBe(0);
  });

  it("routes tool and separate approval families into message watch", async () => {
    const transport = new FakeTransport();
    const client = new OpenClawClient({ transport });
    const iterator = client.chat.watch("session-1")[Symbol.asyncIterator]();
    const tool = iterator.next();
    transport.emit("session.tool", { toolCallId: "tool-1", sessionKey: "session-1", runId: "run-1", toolId: "exec", displayName: "Execute", state: "running", risk: "high" }, 1);
    await expect(tool).resolves.toMatchObject({ value: { type: "tool", runId: "run-1" } });
    const exec = iterator.next();
    transport.emit("exec.approval.requested", { runId: "run-1", request: { id: "exec-1", sessionKey: "session-1", title: "Confirm", description: "Run", risk: "high", permissions: [{ kind: "process", scope: "fixture", description: "Run" }], choices: ["deny"], status: "pending", toolCallId: "tool-1" } }, 2);
    await expect(exec).resolves.toMatchObject({ value: { type: "approval", approval: { family: "exec" } } });
    const plugin = iterator.next();
    transport.emit("plugin.approval.requested", { runId: "run-1", request: { id: "plugin-1", title: "Confirm", description: "Enable", risk: "medium", permissions: [{ kind: "other", scope: "fixture", description: "Enable" }], choices: ["deny"], status: "pending", pluginId: "fixture" } }, 3);
    await expect(plugin).resolves.toMatchObject({ value: { type: "approval", approval: { family: "plugin" } } });
    await iterator.return?.();
  });

  it("triggers resync instead of mapping a source sequence gap", async () => {
    const transport = new FakeTransport();
    const gaps: Array<{ expected: number; received: number }> = [];
    const controller = new AbortController();
    const client = new OpenClawClient({ transport, onResyncRequired: (gap) => gaps.push(gap) });
    const iterator = client.chat.watch("session-1", controller.signal)[Symbol.asyncIterator]();
    const first = iterator.next();
    transport.emit("chat", { state: "delta", runId: "run-1", sessionKey: "session-1", deltaText: "A" }, 7);
    await first;
    const waiting = iterator.next();
    transport.emit("chat", { state: "delta", runId: "run-1", sessionKey: "session-1", deltaText: "C" }, 9);
    expect(gaps).toEqual([{ expected: 8, received: 9 }]);
    controller.abort();
    await waiting;
  });

  it("uses injected backoff before reconnecting", async () => {
    const transport = new FakeTransport();
    const clock = new ManualClock();
    const client = new OpenClawClient({ transport, reconnectPolicy: new ReconnectPolicy({ clock, random: () => 0.5 }) });
    await client.gateway.negotiate();
    const reconnect = client.gateway.reconnect();
    expect(transport.connectCalls).toBe(1);
    await clock.advance(800);
    await reconnect;
    expect(transport.connectCalls).toBe(2);
  });

  it("honors bounded startup retryAfterMs before negotiating again", async () => {
    const transport = new FakeTransport();
    transport.connectFailures.push(new RpcRemoteError("UNAVAILABLE", "starting", true, 20));
    const clock = new ManualClock();
    const client = new OpenClawClient({ transport, reconnectPolicy: new ReconnectPolicy({ clock, random: () => 0.5 }) });
    const negotiation = client.gateway.negotiate();
    await Promise.resolve();
    expect(transport.connectCalls).toBe(1);
    await clock.advance(100);
    await negotiation;
    expect(transport.connectCalls).toBe(2);
  });
});
