import { UClawErrorSchema } from "@uclaw/shared";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type z } from "zod";

import { AsyncEventQueue, OpenClawClient, UClawUnsupportedError, type OpenClawTransport } from "../src/openclaw-client.js";
import { ManualClock } from "../src/mock/mock-client.js";
import { ReconnectPolicy } from "../src/reconnect.js";
import type { HelloOk } from "../src/transport/gateway-websocket.js";
import { RpcRemoteError, type EventFrame, type JsonValue } from "../src/transport/rpc-router.js";

class FakeTransport implements OpenClawTransport {
  state = "idle" as const;
  readonly calls: string[] = [];
  readonly requests: Array<{ method: string; params: JsonValue }> = [];
  readonly fixtures = new Map<string, JsonValue>();
  readonly fixtureQueues = new Map<string, JsonValue[]>();
  readonly requestGates = new Map<string, Promise<JsonValue>>();
  readonly eventListeners = new Set<(frame: EventFrame) => void>();
  readonly sequenceGapListeners = new Set<(gap: { expected: number; received: number }) => void>();
  readonly closeListeners = new Set<(error: Error) => void>();
  readonly connectFailures: Error[] = [];
  helloMethods = ["sessions.list", "chat.send", "chat.abort", "exec.approval.list", "plugin.approval.list"];
  resetSequences: Array<number | undefined> = [];
  connectCalls = 0;
  private lastSequence: number | undefined;

  async connect(): Promise<HelloOk> {
    this.connectCalls += 1;
    const failure = this.connectFailures.shift();
    if (failure !== undefined) throw failure;
    return {
      type: "hello-ok" as const,
      protocol: 4 as const,
      server: { version: "2026.7.1-2" },
      features: { methods: this.helloMethods, events: ["chat"] },
      policy: { maxPayload: 65_536, maxBufferedBytes: 131_072 },
    };
  }

  close(): void {
    this.lastSequence = undefined;
    for (const listener of [...this.closeListeners]) listener(new Error("closed"));
  }

  emit(event: string, payload: JsonValue, seq: number): void {
    if (this.lastSequence !== undefined) {
      if (seq <= this.lastSequence) return;
      const expected = this.lastSequence + 1;
      this.lastSequence = seq;
      if (seq !== expected) {
        for (const listener of this.sequenceGapListeners) listener({ expected, received: seq });
        return;
      }
    } else {
      this.lastSequence = seq;
    }
    const frame = { type: "event" as const, event, payload, seq };
    for (const listener of this.eventListeners) listener(frame);
  }

  readonly router = {
    request: async <T>(method: string, params: JsonValue, schema: z.ZodType<T>): Promise<T> => {
      this.calls.push(method);
      this.requests.push({ method, params });
      const queued = this.fixtureQueues.get(method)?.shift();
      return schema.parse(await (this.requestGates.get(method) ?? Promise.resolve(queued ?? this.fixtures.get(method))));
    },
    onEvent: (_event: string, listener: (frame: EventFrame) => void) => {
      this.eventListeners.add(listener);
      return () => this.eventListeners.delete(listener);
    },
    onSequenceGap: (listener: (gap: { expected: number; received: number }) => void) => {
      this.sequenceGapListeners.add(listener);
      return () => this.sequenceGapListeners.delete(listener);
    },
    onClose: (listener: (error: Error) => void) => {
      this.closeListeners.add(listener);
      return () => this.closeListeners.delete(listener);
    },
    resetSequence: (sourceSequence?: number) => {
      this.lastSequence = sourceSequence;
      this.resetSequences.push(sourceSequence);
    },
  };
}

describe("OpenClawClient", () => {
  const contractFixture = (name: string): any => JSON.parse(readFileSync(resolve(import.meta.dirname, `../fixtures/openclaw-2026.7.1-2/${name}`), "utf8"));
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

  it("keeps unsupported attachment and unimplemented management capabilities closed", async () => {
    const transport = new FakeTransport();
    transport.helloMethods.push(
      "models.list",
      "skills.status", "channels.status", "files.list", "files.readText", "diagnostics.list", "logs.tail",
    );
    const client = new OpenClawClient({ transport });
    const capabilities = await client.gateway.negotiate();
    const sessionId = "session-1";

    const stream = client.chat.send({ sessionId, clientRequestId: "request-1", blocks: [{ type: "attachment", attachmentId: "attachment-1" }] });
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(UClawUnsupportedError);
    expect(capabilities.methods.has("exec.approval.resolve")).toBe(false);
    expect(capabilities.methods.has("plugin.approval.resolve")).toBe(false);
    expect([...capabilities.methods]).toEqual(["sessions.list", "chat.send", "chat.abort", "exec.approval.list", "plugin.approval.list"]);
    expect(transport.calls).toEqual([]);
  });

  it("maps real history and chat.message.get envelopes", async () => {
    const history = contractFixture("chat.history.json");
    const messageGet = contractFixture("chat.message.get.json");
    const transport = new FakeTransport();
    transport.helloMethods.push("chat.history", "chat.message.get");
    transport.fixtures.set("chat.history", history.responseFrame.payload);
    transport.fixtures.set("chat.message.get", messageGet.success.responseFrame.payload);
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    const page = await client.chat.list("agent:dev:main");
    expect(page.items.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(page).toMatchObject({ nextCursor: null, hasMore: false });
    const messageId = messageGet.success.requestFrame.params.messageId;
    await expect(client.chat.get("agent:dev:main", messageId)).resolves.toMatchObject({
      id: messageId,
      sessionId: "agent:dev:main",
      role: "user",
    });
    transport.fixtures.set("chat.message.get", messageGet.unavailable.responseFrame.payload);
    const unavailable = await client.chat.get("agent:dev:main", "message-contract-missing").catch((error: unknown) => error);
    expect(UClawErrorSchema.parse((unavailable as { uclawError: unknown }).uclawError).code).toBe("NOT_FOUND");
  });

  it("resolves observed approval decisions, rejects allow-session, and selects a model", async () => {
    const approvals = contractFixture("approvals.json");
    const transport = new FakeTransport();
    transport.helloMethods.push("exec.approval.resolve", "plugin.approval.resolve", "sessions.patch");
    transport.fixtures.set("exec.approval.resolve", { ok: true });
    transport.fixtures.set("plugin.approval.resolve", { ok: true });
    transport.fixtures.set("sessions.patch", { ok: true, key: "session-1" });
    const execOther = structuredClone(approvals.exec.allowOnce.event.payload);
    execOther.id = "exec-other-session";
    execOther.request.sessionKey = "agent:dev:other";
    const pluginOther = structuredClone(approvals.plugin.allowOnce.event.payload);
    pluginOther.id = "plugin-other-session";
    pluginOther.request.sessionKey = "agent:dev:other";
    transport.fixtures.set("exec.approval.list", [...approvals.exec.allowOnce.listing.responseFrame.payload, execOther]);
    transport.fixtures.set("plugin.approval.list", [...approvals.plugin.allowOnce.listing.responseFrame.payload, pluginOther]);
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    await expect(client.approvals.listPending("agent:dev:main")).resolves.toMatchObject([
      { family: "exec", choices: ["allow-once", "deny"] },
      { family: "plugin", choices: ["allow-once", "deny"] },
    ]);
    await expect(client.approvals.listPending("agent:dev:other")).resolves.toMatchObject([
      { id: "exec-other-session", family: "exec" },
      { id: "plugin-other-session", family: "plugin" },
    ]);
    await client.approvals.resolveExec({ ref: { family: "exec", id: "exec-1" }, decision: "allow-once" });
    await client.approvals.resolvePlugin({ ref: { family: "plugin", id: "plugin-1" }, decision: "deny" });
    await client.models.selectForSession("session-1", "provider/model-1");
    const unsupported = await client.approvals.resolveExec({ ref: { family: "exec", id: "exec-1" }, decision: "allow-session" }).catch((error: unknown) => error);
    expect(unsupported).toBeInstanceOf(UClawUnsupportedError);
    expect((unsupported as UClawUnsupportedError).uclawError.code).toBe("UNSUPPORTED");
    expect(transport.requests.slice(4)).toEqual([
      { method: "exec.approval.resolve", params: { id: "exec-1", decision: "allow-once" } },
      { method: "plugin.approval.resolve", params: { id: "plugin-1", decision: "deny" } },
      { method: "sessions.patch", params: { key: "session-1", model: "provider/model-1" } },
    ]);
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

  it("fails active watch and send streams when their router closes", async () => {
    const transport = new FakeTransport();
    transport.fixtures.set("chat.send", { runId: "run-1", status: "accepted" });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    const watch = client.chat.watch("session-1")[Symbol.asyncIterator]();
    const watchWaiting = watch.next();
    const send = client.chat.send({ sessionId: "session-1", clientRequestId: "request-1", blocks: [{ type: "text", text: "hello", format: "plain" }] })[Symbol.asyncIterator]();
    await send.next();
    const sendWaiting = send.next();
    transport.close();
    const watchError = await watchWaiting.catch((error: unknown) => error);
    const sendError = await sendWaiting.catch((error: unknown) => error);
    expect(UClawErrorSchema.parse((watchError as { uclawError: unknown }).uclawError).code).toBe("GATEWAY_DISCONNECTED");
    expect(UClawErrorSchema.parse((sendError as { uclawError: unknown }).uclawError).code).toBe("GATEWAY_DISCONNECTED");
  });

  it("allows a new watch subscription after reconnect", async () => {
    const transport = new FakeTransport();
    const clock = new ManualClock();
    const client = new OpenClawClient({ transport, reconnectPolicy: new ReconnectPolicy({ clock, random: () => 0.5 }) });
    await client.gateway.negotiate();
    const reconnect = client.gateway.reconnect();
    await clock.advance(800);
    await reconnect;
    const iterator = client.chat.watch("session-1")[Symbol.asyncIterator]();
    const event = iterator.next();
    transport.emit("chat", { state: "delta", runId: "run-1", sessionKey: "session-1", deltaText: "A" }, 1);
    await expect(event).resolves.toMatchObject({ value: { type: "delta", text: "A" } });
    await iterator.return?.();
  });

  it("streams shared gateway status changes with stable since values", async () => {
    const transport = new FakeTransport();
    const times = ["2026-08-07T12:00:00.000Z", "2026-08-07T12:00:01.000Z", "2026-08-07T12:00:02.000Z"];
    const client = new OpenClawClient({ transport, now: () => times.shift() ?? "2026-08-07T12:00:02.000Z" });
    const first = client.gateway.watchStatus()[Symbol.asyncIterator]();
    const second = client.gateway.watchStatus()[Symbol.asyncIterator]();
    expect((await first.next()).value?.connectionState).toBe("idle");
    expect((await second.next()).value?.connectionState).toBe("idle");
    const negotiation = client.gateway.negotiate();
    expect((await first.next()).value?.connectionState).toBe("connecting");
    expect((await second.next()).value?.connectionState).toBe("connecting");
    await negotiation;
    const ready = (await first.next()).value;
    expect(ready?.connectionState).toBe("ready");
    expect((await client.gateway.getStatus()).since).toBe(ready?.since);
    await first.return?.();
    await second.return?.();
  });

  it("routes tool and separate approval families into message watch", async () => {
    const tools = contractFixture("session.tool.json");
    const approvals = contractFixture("approvals.json");
    const transport = new FakeTransport();
    transport.fixtures.set("chat.send", { runId: "run-approval-1", status: "accepted" });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    const send = client.chat.send({
      sessionId: "agent:dev:main",
      clientRequestId: "request-approval-1",
      blocks: [{ type: "text", text: "approve", format: "plain" }],
    })[Symbol.asyncIterator]();
    await expect(send.next()).resolves.toMatchObject({ value: { type: "started", runId: "run-approval-1" } });
    const iterator = client.chat.watch("agent:dev:main")[Symbol.asyncIterator]();
    const tool = iterator.next();
    transport.emit("session.tool", tools.start.payload, 1);
    await expect(tool).resolves.toMatchObject({ value: { type: "tool", runId: "contract-tool-run-1", tool: { toolId: "sessions_list", state: "running" } } });
    const exec = iterator.next();
    const sentExec = send.next();
    const otherSessionExec = structuredClone(approvals.exec.allowOnce.event.payload);
    otherSessionExec.id = "exec-other-session-event";
    otherSessionExec.request.sessionKey = "agent:dev:other";
    transport.emit("exec.approval.requested", otherSessionExec, 2);
    transport.emit("exec.approval.requested", approvals.exec.allowOnce.event.payload, 3);
    await expect(exec).resolves.toMatchObject({ value: { type: "approval", runId: "run-approval-1", approval: { id: approvals.exec.allowOnce.event.payload.id, family: "exec" } } });
    await expect(sentExec).resolves.toMatchObject({ value: { type: "approval", runId: "run-approval-1", approval: { id: approvals.exec.allowOnce.event.payload.id, family: "exec" } } });
    const plugin = iterator.next();
    const sentPlugin = send.next();
    transport.emit("plugin.approval.requested", approvals.plugin.allowOnce.event.payload, 4);
    await expect(plugin).resolves.toMatchObject({ value: { type: "approval", runId: "run-approval-1", approval: { family: "plugin" } } });
    await expect(sentPlugin).resolves.toMatchObject({ value: { type: "approval", runId: "run-approval-1", approval: { family: "plugin" } } });
    await send.return?.();
    await iterator.return?.();
  });

  it("does not guess approval ownership for concurrent sends in one session", async () => {
    const approvals = contractFixture("approvals.json");
    const transport = new FakeTransport();
    transport.fixtureQueues.set("chat.send", [
      { runId: "run-concurrent-1", status: "accepted" },
      { runId: "run-concurrent-2", status: "accepted" },
    ]);
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    const input = (clientRequestId: string) => ({
      sessionId: "agent:dev:main",
      clientRequestId,
      blocks: [{ type: "text" as const, text: "concurrent", format: "plain" as const }],
    });
    const first = client.chat.send(input("concurrent-1"))[Symbol.asyncIterator]();
    const second = client.chat.send(input("concurrent-2"))[Symbol.asyncIterator]();
    await first.next();
    await second.next();

    transport.emit("exec.approval.requested", approvals.exec.allowOnce.event.payload, 1);
    const finalMessage = (runId: string) => ({
      state: "final",
      runId,
      sessionKey: "agent:dev:main",
      message: {
        id: `message-${runId}`,
        sessionKey: "agent:dev:main",
        runId,
        role: "assistant",
        status: "completed",
        blocks: [],
        createdAt: "2026-08-08T00:00:00.000Z",
      },
    });
    transport.emit("chat", finalMessage("run-concurrent-1"), 2);
    transport.emit("chat", finalMessage("run-concurrent-2"), 3);
    await expect(first.next()).resolves.toMatchObject({ value: { type: "final", runId: "run-concurrent-1" } });
    await expect(second.next()).resolves.toMatchObject({ value: { type: "final", runId: "run-concurrent-2" } });
    await first.return?.();
    await second.return?.();
  });

  it("triggers resync instead of mapping a source sequence gap", async () => {
    const transport = new FakeTransport();
    const gaps: Array<{ expected: number; received: number }> = [];
    const controller = new AbortController();
    const client = new OpenClawClient({ transport, onResyncRequired: (gap) => { gaps.push(gap); } });
    await client.gateway.negotiate();
    const iterator = client.chat.watch("session-1", controller.signal)[Symbol.asyncIterator]();
    const first = iterator.next();
    transport.emit("chat", { state: "delta", runId: "run-1", sessionKey: "session-1", deltaText: "A" }, 7);
    await first;
    const waiting = iterator.next();
    transport.emit("chat", { state: "delta", runId: "run-1", sessionKey: "session-1", deltaText: "C" }, 9);
    await Promise.resolve();
    expect(gaps).toEqual([{ expected: 8, received: 9 }]);
    await Promise.resolve();
    expect(transport.resetSequences).toEqual([9]);
    controller.abort();
    await waiting;
  });

  it("reconnects when sequence resync rejects", async () => {
    const transport = new FakeTransport();
    const clock = new ManualClock();
    const client = new OpenClawClient({
      transport,
      reconnectPolicy: new ReconnectPolicy({ clock, random: () => 0.5 }),
      onResyncRequired: () => { throw new Error("resync failed"); },
    });
    await client.gateway.negotiate();
    transport.emit("chat", { state: "delta", runId: "run-1", sessionKey: "session-1", deltaText: "A" }, 10);
    transport.emit("chat", { state: "delta", runId: "run-1", sessionKey: "session-1", deltaText: "C" }, 12);
    await Promise.resolve();
    await clock.advance(800);
    await Promise.resolve();
    expect(transport.connectCalls).toBe(2);
  });

  it("drops buffered events after a terminal event", async () => {
    const transport = new FakeTransport();
    let acceptSend: (value: JsonValue) => void = () => undefined;
    transport.requestGates.set("chat.send", new Promise((resolve) => { acceptSend = resolve; }));
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    const iterator = client.chat.send({ sessionId: "session-1", clientRequestId: "request-1", blocks: [{ type: "text", text: "hello", format: "plain" }] })[Symbol.asyncIterator]();
    const started = iterator.next();
    await Promise.resolve();
    transport.emit("chat", {
      state: "final", runId: "run-1", sessionKey: "session-1",
      message: { id: "message-1", sessionKey: "session-1", runId: "run-1", role: "assistant", status: "completed", blocks: [], createdAt: "2026-08-07T12:00:00.000Z" },
    }, 1);
    transport.emit("chat", { state: "delta", runId: "run-1", sessionKey: "session-1", deltaText: "late" }, 2);
    acceptSend({ runId: "run-1", status: "accepted" });
    await expect(started).resolves.toMatchObject({ value: { type: "started" } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "final" } });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it("settles every pending queue waiter when a terminal value arrives", async () => {
    const queue = new AsyncEventQueue<number>();
    const first = queue.next();
    const second = queue.next();
    queue.push(1, true);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { value: 1, done: false },
      { value: undefined, done: true },
    ]);
  });

  it("rejects extra fields in known page responses", async () => {
    const transport = new FakeTransport();
    transport.fixtures.set("sessions.list", { sessions: [], nextCursor: null, hasMore: false, extra: true });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    await expect(client.sessions.list()).rejects.toThrow();
  });

  it("uses injected backoff before reconnecting", async () => {
    const transport = new FakeTransport();
    const clock = new ManualClock();
    const client = new OpenClawClient({ transport, reconnectPolicy: new ReconnectPolicy({ clock, random: () => 0.5 }) });
    await client.gateway.negotiate();
    const statuses = client.gateway.watchStatus()[Symbol.asyncIterator]();
    await statuses.next();
    const reconnect = client.gateway.reconnect();
    await expect(statuses.next()).resolves.toMatchObject({ value: { connectionState: "reconnecting", attempt: 1 } });
    expect(transport.connectCalls).toBe(1);
    await clock.advance(800);
    await reconnect;
    expect(transport.connectCalls).toBe(2);
    await expect(statuses.next()).resolves.toMatchObject({ value: { connectionState: "connecting", attempt: 1 } });
    const ready = (await statuses.next()).value;
    expect(ready).toMatchObject({ connectionState: "ready", attempt: 0 });
    expect(await client.gateway.getStatus()).toEqual(ready);
    await statuses.return?.();
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
