import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { GatewayWebSocket, type WebSocketLike } from "../src/transport/gateway-websocket.js";
import { UClawErrorSchema } from "@uclaw/shared";

import { RpcCancelledError, RpcClosedError, RpcProtocolError, RpcRemoteError, RpcRouter, RpcTimeoutError, type JsonValue } from "../src/transport/rpc-router.js";

class FakeSocket implements WebSocketLike {
  readonly sent: string[] = [];
  readonly close = vi.fn((_code?: number, _reason?: string) => { this.emit("close"); });
  sendError: Error | undefined;
  private readonly listeners = new Map<string, Set<(event: { data?: string }) => void>>();

  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: string }) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: string }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    if (this.sendError !== undefined) throw this.sendError;
    this.sent.push(data);
  }
  emit(type: "open" | "close" | "error"): void;
  emit(type: "message", data: string): void;
  emit(type: "open" | "message" | "close" | "error", data?: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

describe("RpcRouter", () => {
  it("correlates successful and failed responses by request id", async () => {
    const socket = new FakeSocket();
    const router = new RpcRouter(socket, { requestTimeoutMs: 100 });
    const first = router.request("one", {}, z.object({ value: z.number() }));
    const second = router.request("two", {}, z.object({ value: z.number() }));
    const [firstFrame, secondFrame] = socket.sent.map((raw) => JSON.parse(raw) as { id: string });

    socket.emit("message", JSON.stringify({ type: "res", id: secondFrame.id, ok: true, payload: { value: 2 } }));
    socket.emit("message", JSON.stringify({ type: "res", id: firstFrame.id, ok: false, error: { code: "NOPE", message: "denied" } }));

    await expect(second).resolves.toEqual({ value: 2 });
    const remoteError = await first.catch((error: unknown) => error);
    expect(remoteError).toBeInstanceOf(RpcRemoteError);
    expect(() => UClawErrorSchema.parse((remoteError as RpcRemoteError).uclawError)).not.toThrow();
  });

  it("rejects timed out requests and all pending requests on close", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const router = new RpcRouter(socket, { requestTimeoutMs: 25 });
    const timedOut = router.request("slow", {}, z.object({}));
    const timeoutAssertion = expect(timedOut).rejects.toBeInstanceOf(RpcTimeoutError);
    await vi.advanceTimersByTimeAsync(25);
    const timeoutError = await timedOut.catch((error: unknown) => error);
    await timeoutAssertion;
    expect(UClawErrorSchema.parse((timeoutError as RpcTimeoutError).uclawError).code).toBe("TIMEOUT");

    const pending = router.request("pending", {}, z.object({}));
    socket.emit("close");
    const closedError = await pending.catch((error: unknown) => error);
    expect(closedError).toBeInstanceOf(RpcClosedError);
    expect(UClawErrorSchema.parse((closedError as RpcClosedError).uclawError).code).toBe("GATEWAY_DISCONNECTED");
    vi.useRealTimers();
  });

  it("cancels a pending request immediately without waiting for timeout", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const router = new RpcRouter(socket, { requestTimeoutMs: 10_000 });
    const controller = new AbortController();
    const request = router.request("chat.send", {}, z.object({ runId: z.string() }), controller.signal);

    controller.abort();

    const error = await request.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RpcCancelledError);
    expect(UClawErrorSchema.parse((error as RpcCancelledError).uclawError).code).toBe("CANCELLED");
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("routes events and diagnoses unknown frames without throwing", () => {
    const socket = new FakeSocket();
    const diagnostics: string[] = [];
    const router = new RpcRouter(socket, { onDiagnostic: (message) => diagnostics.push(message) });
    const events: string[] = [];
    router.onEvent("chat", (event) => events.push(event.event));

    socket.emit("message", JSON.stringify({ type: "event", event: "chat", payload: { state: "delta" }, seq: 1 }));
    socket.emit("message", JSON.stringify({ type: "mystery", secret: ["sk", "proj", "abcdefghijk"].join("-") }));

    expect(events).toEqual(["chat"]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).not.toContain("sk-proj");
  });

  it("does not copy malformed Gateway payloads into diagnostics", () => {
    const socket = new FakeSocket();
    const diagnostics: string[] = [];
    const router = new RpcRouter(socket, { onDiagnostic: (message) => diagnostics.push(message) });
    const payload = {
      type: "mystery",
      headers: { Authorization: "Bearer gateway-secret", Cookie: "session=gateway-cookie" },
      body: [{ content: "private conversation body" }, { token: 987654321 }],
      path: "C:\\Users\\alice\\private\\chat.txt",
    };

    socket.emit("message", JSON.stringify(payload));

    expect(diagnostics).toEqual(["Ignored unknown Gateway frame"]);
    expect(JSON.stringify(diagnostics)).not.toMatch(/gateway-secret|gateway-cookie|private conversation body|987654321|alice|chat\.txt/);
    router.close();
  });

  it("accepts locked Gateway state-version objects without failing pending RPC", async () => {
    const socket = new FakeSocket();
    const router = new RpcRouter(socket, { requestTimeoutMs: 1_000 });
    const request = router.request("sessions.list", {}, z.object({ sessions: z.array(z.unknown()) }));
    const frame = JSON.parse(socket.sent[0] ?? "{}") as { id: string };

    socket.emit("message", JSON.stringify({
      type: "event",
      event: "health",
      payload: { ok: true },
      seq: 1,
      stateVersion: { presence: 0, health: 1 },
    }));
    socket.emit("message", JSON.stringify({
      type: "res",
      id: frame.id,
      ok: true,
      payload: { sessions: [] },
    }));

    await expect(request).resolves.toEqual({ sessions: [] });
  });

  it("suppresses a duplicate before one subscriber receives it", () => {
    const socket = new FakeSocket();
    const router = new RpcRouter(socket);
    const received: number[] = [];
    router.onEvent("chat", (frame) => received.push(frame.seq ?? -1));
    const frame = JSON.stringify({ type: "event", event: "chat", payload: {}, seq: 4 });
    socket.emit("message", frame);
    socket.emit("message", frame);
    expect(received).toEqual([4]);
  });

  it("observes a duplicate once before broadcasting to two subscribers", () => {
    const socket = new FakeSocket();
    const router = new RpcRouter(socket);
    const first: number[] = [];
    const second: number[] = [];
    router.onEvent("chat", (frame) => first.push(frame.seq ?? -1));
    router.onEvent("chat", (frame) => second.push(frame.seq ?? -1));
    const frame = JSON.stringify({ type: "event", event: "chat", payload: {}, seq: 8 });
    socket.emit("message", frame);
    socket.emit("message", frame);
    expect(first).toEqual([8]);
    expect(second).toEqual([8]);
  });

  it("suppresses one gap frame for two subscribers and requests one resync", () => {
    const socket = new FakeSocket();
    const router = new RpcRouter(socket);
    const first: number[] = [];
    const second: number[] = [];
    const gaps: Array<{ expected: number; received: number }> = [];
    router.onEvent("chat", (frame) => first.push(frame.seq ?? -1));
    router.onEvent("chat", (frame) => second.push(frame.seq ?? -1));
    router.onSequenceGap((gap) => gaps.push(gap));
    socket.emit("message", JSON.stringify({ type: "event", event: "chat", payload: {}, seq: 10 }));
    socket.emit("message", JSON.stringify({ type: "event", event: "chat", payload: {}, seq: 12 }));
    socket.emit("message", JSON.stringify({ type: "event", event: "chat", payload: {}, seq: 13 }));
    expect(first).toEqual([10]);
    expect(second).toEqual([10]);
    expect(gaps).toEqual([{ expected: 11, received: 12 }]);
  });

  it("accepts events again only after sequence state is explicitly seeded", () => {
    const socket = new FakeSocket();
    const router = new RpcRouter(socket);
    const received: number[] = [];
    router.onEvent("chat", (frame) => received.push(frame.seq ?? -1));
    socket.emit("message", JSON.stringify({ type: "event", event: "chat", payload: {}, seq: 10 }));
    socket.emit("message", JSON.stringify({ type: "event", event: "chat", payload: {}, seq: 12 }));
    router.resetSequence(12);
    socket.emit("message", JSON.stringify({ type: "event", event: "chat", payload: {}, seq: 13 }));
    expect(received).toEqual([10, 13]);
  });

  it("blocks unsequenced business events while desynced without blocking RPC responses", async () => {
    const socket = new FakeSocket();
    const router = new RpcRouter(socket);
    const received: string[] = [];
    for (const event of ["chat", "session.tool", "exec.approval.requested", "plugin.approval.requested"]) {
      router.onEvent(event, () => received.push(event));
    }
    socket.emit("message", JSON.stringify({ type: "event", event: "chat", payload: {}, seq: 10 }));
    socket.emit("message", JSON.stringify({ type: "event", event: "chat", payload: {}, seq: 12 }));
    socket.emit("message", JSON.stringify({ type: "event", event: "chat", payload: {} }));
    socket.emit("message", JSON.stringify({ type: "event", event: "session.tool", payload: {} }));
    socket.emit("message", JSON.stringify({ type: "event", event: "exec.approval.requested", payload: {} }));
    socket.emit("message", JSON.stringify({ type: "event", event: "plugin.approval.requested", payload: {} }));

    const request = router.request("still-responsive", {}, z.object({ value: z.number() }).strict());
    const frame = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    socket.emit("message", JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { value: 1 } }));

    expect(received).toEqual(["chat"]);
    await expect(request).resolves.toEqual({ value: 1 });
    router.resetSequence(12);
    socket.emit("message", JSON.stringify({ type: "event", event: "session.tool", payload: {} }));
    expect(received).toEqual(["chat", "session.tool"]);
  });

  it("cleans a pending request when socket.send throws synchronously", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    socket.sendError = new Error("send failed");
    const router = new RpcRouter(socket, { requestTimeoutMs: 25 });
    await expect(router.request("broken", {}, z.object({}))).rejects.toMatchObject({
      uclawError: { code: "GATEWAY_DISCONNECTED" },
    });
    await vi.advanceTimersByTimeAsync(25);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("notifies close subscribers once", () => {
    const socket = new FakeSocket();
    const router = new RpcRouter(socket);
    const listener = vi.fn();
    router.onClose(listener);
    socket.emit("close");
    socket.emit("close");
    expect(listener).toHaveBeenCalledOnce();
  });

  it("rejects extra fields in known envelopes and nested errors", async () => {
    const socket = new FakeSocket();
    const diagnostics: string[] = [];
    const router = new RpcRouter(socket, { requestTimeoutMs: 20, onDiagnostic: (message) => diagnostics.push(message) });
    const request = router.request("strict", {}, z.object({}).strict());
    const frame = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    socket.emit("message", JSON.stringify({ type: "res", id: frame.id, ok: false, error: { code: "NOPE", message: "denied", extra: true } }));
    expect(diagnostics).toEqual(["Ignored unknown Gateway frame"]);
    await expect(request).rejects.toBeInstanceOf(RpcProtocolError);
    router.close();
  });

  it("normalizes response schema failures", async () => {
    const socket = new FakeSocket();
    const router = new RpcRouter(socket);
    const request = router.request("strict", {}, z.object({ value: z.number() }).strict());
    const frame = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    socket.emit("message", JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { value: "wrong" } }));
    const error = await request.catch((reason: unknown) => reason) as { uclawError: unknown };
    expect(UClawErrorSchema.parse(error.uclawError)).toMatchObject({
      code: "PROTOCOL_MAPPING_FAILED",
      retryable: false,
      recoveryActions: ["open-diagnostics"],
    });
  });
});

describe("GatewayWebSocket", () => {
  it("normalizes WebSocket factory failures", async () => {
    const gateway = new GatewayWebSocket({
      url: "ws://gateway.test",
      webSocketFactory: () => { throw new Error("factory failed"); },
      connectParams: () => ({ client: { id: "u-claw-desktop", mode: "desktop" }, role: "operator", scopes: ["operator.read"] }),
    });
    const error = await Promise.resolve().then(() => gateway.connect()).catch((reason: unknown) => reason) as { uclawError: unknown };
    expect(UClawErrorSchema.parse(error.uclawError).code).toBe("GATEWAY_DISCONNECTED");
  });

  it("performs challenge, protocol v4 connect, then parses hello-ok", async () => {
    const socket = new FakeSocket();
    const gateway = new GatewayWebSocket({
      url: "ws://gateway.test",
      webSocketFactory: () => socket,
      connectParams: () => ({
        client: { id: "u-claw-desktop", mode: "desktop" },
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        caps: ["tool-events"],
      }),
    });
    const connection = gateway.connect();
    socket.emit("open");
    socket.emit("message", JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n-1", ts: 1 }, seq: 1 }));
    const request = JSON.parse(socket.sent[0] ?? "{}") as { id: string; method: string; params: Record<string, JsonValue> };
    expect(request.method).toBe("connect");
    expect(request.params).toMatchObject({
      minProtocol: 4,
      maxProtocol: 4,
      client: {
        id: "gateway-client",
        version: "0.1.0",
        platform: "uclaw-desktop",
        mode: "backend",
      },
    });
    expect(request.params).not.toHaveProperty("challenge");
    socket.emit("message", JSON.stringify({
      type: "res", id: request.id, ok: true, payload: {
        type: "hello-ok", protocol: 4,
        server: { version: "2026.7.1-2", connId: "connection-1" },
        features: { methods: ["chat.send"], events: ["chat"], capabilities: ["tool-events"] },
        snapshot: { presence: [], health: {}, stateVersion: 1, uptimeMs: 100 },
        auth: { deviceToken: "device-secret", role: "operator", scopes: ["operator.read"] },
        policy: { maxPayload: 65536, maxBufferedBytes: 131072, tickIntervalMs: 30_000 },
      },
    }));

    const hello = await connection;
    expect(hello).toMatchObject({ protocol: 4 });
    expect(hello).not.toHaveProperty("auth");
    expect(gateway.state).toBe("ready");
    socket.emit("close");
    expect(gateway.state).toBe("closed");
  });

  it("fails ready state and pending RPC immediately on a malformed frame", async () => {
    const socket = new FakeSocket();
    const gateway = new GatewayWebSocket({
      url: "ws://gateway.test",
      webSocketFactory: () => socket,
      connectParams: () => ({ client: { id: "u-claw-desktop", mode: "desktop" }, role: "operator", scopes: ["operator.read"] }),
      requestTimeoutMs: 10_000,
    });
    const connection = gateway.connect();
    socket.emit("open");
    socket.emit("message", JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n-1", ts: 1 } }));
    const connectRequest = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    socket.emit("message", JSON.stringify({
      type: "res", id: connectRequest.id, ok: true, payload: {
        type: "hello-ok", protocol: 4,
        server: { version: "2026.7.1-2" },
        features: { methods: ["sessions.list"], events: [] },
        policy: { maxPayload: 65536, maxBufferedBytes: 131072 },
      },
    }));
    await connection;
    const pending = gateway.router.request("sessions.list", {}, z.object({ sessions: z.array(z.unknown()) }));

    socket.emit("message", "{");

    const error = await pending.catch((reason: unknown) => reason) as { uclawError: unknown };
    expect(UClawErrorSchema.parse(error.uclawError).code).toBe("PROTOCOL_MAPPING_FAILED");
    expect(gateway.state).toBe("failed");
    expect(socket.close).toHaveBeenCalledWith(1002, "protocol violation");
  });

  it("rejects extra fields in known challenge payloads", async () => {
    const socket = new FakeSocket();
    const gateway = new GatewayWebSocket({
      url: "ws://gateway.test",
      webSocketFactory: () => socket,
      connectParams: () => ({ client: { id: "u-claw-desktop", mode: "desktop" }, role: "operator", scopes: ["operator.read"] }),
    });
    const connection = gateway.connect();
    socket.emit("open");
    socket.emit("message", JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n-1", ts: 1, extra: true }, seq: 1 }));
    await expect(connection).rejects.toThrow("challenge failed validation");
  });

  it.each([
    ["malformed JSON", "{"],
    ["unknown frame", JSON.stringify({ type: "mystery", payload: {} })],
  ])("rejects %s immediately during the handshake", async (_label, frame) => {
    const socket = new FakeSocket();
    const gateway = new GatewayWebSocket({
      url: "ws://gateway.test",
      webSocketFactory: () => socket,
      connectParams: () => ({ client: { id: "u-claw-desktop", mode: "desktop" }, role: "operator", scopes: ["operator.read"] }),
      challengeTimeoutMs: 10_000,
    });
    const connection = gateway.connect();
    socket.emit("open");
    socket.emit("message", frame);

    const error = await connection.catch((reason: unknown) => reason) as { uclawError: unknown };
    expect(UClawErrorSchema.parse(error.uclawError).code).toBe("PROTOCOL_MAPPING_FAILED");
    expect(gateway.state).toBe("failed");
  });

  it("rejects when connect params fail instead of leaving handshake pending", async () => {
    const socket = new FakeSocket();
    const gateway = new GatewayWebSocket({
      url: "ws://gateway.test",
      webSocketFactory: () => socket,
      connectParams: () => { throw new Error("signature unavailable"); },
    });
    const connection = gateway.connect();
    socket.emit("open");
    socket.emit("message", JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n-1", ts: 1 }, seq: 1 }));
    const error = await connection.catch((reason: unknown) => reason) as { uclawError: unknown };
    expect(UClawErrorSchema.parse(error.uclawError).code).toBe("INVALID_ARGUMENT");
    expect(gateway.state).toBe("failed");
  });

  it("times out when challenge never arrives", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const gateway = new GatewayWebSocket({
      url: "ws://gateway.test",
      webSocketFactory: () => socket,
      connectParams: () => ({ client: { id: "u-claw-desktop", mode: "desktop" }, role: "operator", scopes: ["operator.read"] }),
      challengeTimeoutMs: 20,
    });
    const connection = gateway.connect();
    const assertion = expect(connection).rejects.toThrow("challenge timed out");
    socket.emit("open");
    await vi.advanceTimersByTimeAsync(20);
    const error = await connection.catch((reason: unknown) => reason) as { uclawError: unknown };
    await assertion;
    expect(UClawErrorSchema.parse(error.uclawError).code).toBe("TIMEOUT");
    vi.useRealTimers();
  });
});
