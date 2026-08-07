import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { GatewayWebSocket, type WebSocketLike } from "../src/transport/gateway-websocket.js";
import { RpcClosedError, RpcRemoteError, RpcRouter, RpcTimeoutError, type JsonValue } from "../src/transport/rpc-router.js";

class FakeSocket implements WebSocketLike {
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: { data?: string }) => void>>();

  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: string }) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: string }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void { this.sent.push(data); }
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
    await expect(first).rejects.toBeInstanceOf(RpcRemoteError);
  });

  it("rejects timed out requests and all pending requests on close", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const router = new RpcRouter(socket, { requestTimeoutMs: 25 });
    const timedOut = router.request("slow", {}, z.object({}));
    const timeoutAssertion = expect(timedOut).rejects.toBeInstanceOf(RpcTimeoutError);
    await vi.advanceTimersByTimeAsync(25);
    await timeoutAssertion;

    const pending = router.request("pending", {}, z.object({}));
    socket.emit("close");
    await expect(pending).rejects.toBeInstanceOf(RpcClosedError);
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
    expect(first).toEqual([10]);
    expect(second).toEqual([10]);
    expect(gaps).toEqual([{ expected: 11, received: 12 }]);
  });
});

describe("GatewayWebSocket", () => {
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
    await expect(connection).rejects.toThrow("signature unavailable");
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
    await assertion;
    vi.useRealTimers();
  });
});
