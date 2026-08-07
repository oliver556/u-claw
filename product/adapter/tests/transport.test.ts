import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { GatewayWebSocket, type WebSocketLike } from "../src/transport/gateway-websocket.js";
import { UClawErrorSchema } from "@uclaw/shared";

import { RpcClosedError, RpcRemoteError, RpcRouter, RpcTimeoutError, type JsonValue } from "../src/transport/rpc-router.js";

class FakeSocket implements WebSocketLike {
  readonly sent: string[] = [];
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
  close(): void { this.emit("close"); }
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

  it("routes events and diagnoses unknown frames without throwing", () => {
    const socket = new FakeSocket();
    const diagnostics: string[] = [];
    const router = new RpcRouter(socket, { onDiagnostic: (message) => diagnostics.push(message) });
    const events: string[] = [];
    router.onEvent("chat", (event) => events.push(event.event));

    socket.emit("message", JSON.stringify({ type: "event", event: "chat", payload: { state: "delta" }, seq: 1 }));
    socket.emit("message", JSON.stringify({ type: "mystery", secret: "sk-proj-abcdefghijk" }));

    expect(events).toEqual(["chat"]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).not.toContain("sk-proj");
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
    router.close();
    await expect(request).rejects.toBeInstanceOf(RpcClosedError);
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
    expect(request.params).toMatchObject({ minProtocol: 4, maxProtocol: 4 });
    socket.emit("message", JSON.stringify({
      type: "res", id: request.id, ok: true, payload: {
        type: "hello-ok", protocol: 4,
        server: { version: "2026.7.1-2" },
        features: { methods: ["chat.send"], events: ["chat"] },
        auth: { deviceToken: "device-secret" },
        policy: { maxPayload: 65536, maxBufferedBytes: 131072 },
      },
    }));

    const hello = await connection;
    expect(hello).toMatchObject({ protocol: 4 });
    expect(hello).not.toHaveProperty("auth");
    expect(gateway.state).toBe("ready");
    socket.emit("close");
    expect(gateway.state).toBe("closed");
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
