import { describe, expect, it, vi } from "vitest";

import * as desktop from "../src/index.js";

describe("channel dispatcher", () => {
  it("serializes lifecycle operations for one channel", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const store = {
      getForRuntime: vi.fn(async () => ({ id: "telegram-main", kind: "telegram", name: "Telegram", mode: "bot", enabled: true, credentials: { botToken: "secret" } })),
      record: vi.fn(async () => ({ schemaVersion: 1, channels: [] })),
    };
    const runtime = {
      capability: () => true,
      test: vi.fn(async () => { order.push("first-start"); await firstGate; order.push("first-end"); return { status: "connected" as const }; }),
      stop: vi.fn(async () => { order.push("second-stop"); }),
      start: vi.fn(async () => { order.push("second-start"); }),
    };
    const dispatch = (desktop as any).createChannelDispatcher(store, runtime);
    const first = dispatch({ method: "channels.test", requestId: "test-serial", params: { channelId: "telegram-main" } });
    const second = dispatch({ method: "channels.reconnect", requestId: "reconnect-serial", params: { channelId: "telegram-main" } });
    await vi.waitFor(() => expect(order).toEqual(["first-start"]));
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second-stop", "second-start"]);
  });

  it("reports unavailable adapters without pretending to connect", async () => {
    const store = {
      getForRuntime: vi.fn(async () => ({ id: "qq-main", kind: "qq-bot", name: "QQ Bot", mode: "app", enabled: true, credentials: { appId: "1024", clientSecret: "secret" } })),
      record: vi.fn(async () => ({ schemaVersion: 1, channels: [] })),
    };
    const dispatch = (desktop as any).createChannelDispatcher(store, { capability: vi.fn(() => false) });
    const response = await dispatch({ method: "channels.test", requestId: "test-1", params: { channelId: "qq-main" } });
    expect(response.ok).toBe(true);
    expect(response.result.status).toBe("needs-action");
    expect(response.result.error.code).toBe("CAPABILITY_UNAVAILABLE");
  });

  it("cancels an in-flight connection test", async () => {
    let signal: AbortSignal | undefined;
    const store = {
      getForRuntime: vi.fn(async () => ({ id: "telegram-main", kind: "telegram", name: "Telegram", mode: "bot", enabled: true, credentials: { botToken: "secret" } })),
      record: vi.fn(async () => ({ schemaVersion: 1, channels: [] })),
    };
    const runtime = { capability: vi.fn(() => true), test: vi.fn((_channel: unknown, candidate: AbortSignal) => { signal = candidate; return new Promise(() => undefined); }) };
    const dispatch = (desktop as any).createChannelDispatcher(store, runtime, { timeoutMs: 60_000 });
    void dispatch({ method: "channels.test", requestId: "test-1", params: { channelId: "telegram-main" } });
    await vi.waitFor(() => expect(signal).toBeDefined());
    await dispatch({ method: "channels.cancel", requestId: "cancel-1", params: { operationRequestId: "test-1" } });
    expect(signal?.aborted).toBe(true);
  });

  it("settles a hanging runtime operation at its timeout even when runtime ignores abort", async () => {
    let signal: AbortSignal | undefined;
    const store = {
      getForRuntime: vi.fn(async () => ({ id: "telegram-main", kind: "telegram", name: "Telegram", mode: "bot", enabled: true, credentials: { botToken: "secret" } })),
      record: vi.fn(async () => ({ schemaVersion: 1, channels: [] })),
    };
    const runtime = {
      capability: () => true,
      test: vi.fn((_channel: unknown, candidate: AbortSignal) => { signal = candidate; return new Promise<never>(() => undefined); }),
    };
    const dispatch = (desktop as any).createChannelDispatcher(store, runtime, { timeoutMs: 10 });
    const response = await dispatch({ method: "channels.test", requestId: "timeout-test", params: { channelId: "telegram-main" } });
    expect(signal?.aborted).toBe(true);
    expect(response.result).toMatchObject({ status: "network-error", error: { category: "timeout", code: "TIMEOUT" } });
  });

  it("keeps local configuration unchanged when runtime lifecycle fails", async () => {
    const before = { schemaVersion: 1, channels: [{ id: "telegram-main", enabled: false }] };
    const store = {
      list: vi.fn(async () => before),
      create: vi.fn(), update: vi.fn(), remove: vi.fn(), setEnabled: vi.fn(),
      getForRuntime: vi.fn(async () => ({ id: "telegram-main", kind: "telegram", name: "Telegram", mode: "bot", enabled: false, credentials: { botToken: "secret" } })),
      record: vi.fn(),
    };
    const runtime = { capability: () => true, start: vi.fn(async () => { throw new Error("network failed"); }) };
    const dispatch = (desktop as any).createChannelDispatcher(store, runtime);
    await expect(dispatch({ method: "channels.set-enabled", requestId: "enable-fail", params: { channelId: "telegram-main", enabled: true } })).rejects.toThrow("network failed");
    expect(store.setEnabled).not.toHaveBeenCalled();
  });

  it("cancels a queued operation before runtime starts it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = {
      getForRuntime: vi.fn(async () => ({ id: "telegram-main", kind: "telegram", name: "Telegram", mode: "bot", enabled: true, credentials: { botToken: "secret" } })),
      record: vi.fn(async () => ({ schemaVersion: 1, channels: [] })),
    };
    const runtime = {
      capability: () => true,
      test: vi.fn(async () => { await gate; return { status: "connected" as const }; }),
      stop: vi.fn(), start: vi.fn(),
    };
    const dispatch = (desktop as any).createChannelDispatcher(store, runtime, { timeoutMs: 60_000 });
    const first = dispatch({ method: "channels.test", requestId: "first", params: { channelId: "telegram-main" } });
    await vi.waitFor(() => expect(runtime.test).toHaveBeenCalledOnce());
    const queued = dispatch({ method: "channels.reconnect", requestId: "queued", params: { channelId: "telegram-main" } });
    await dispatch({ method: "channels.cancel", requestId: "cancel-queued", params: { operationRequestId: "queued" } });
    await queued;
    release();
    await first;
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it("does not overlap a timed-out runtime with the next operation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = {
      getForRuntime: vi.fn(async () => ({ id: "telegram-main", kind: "telegram", name: "Telegram", mode: "bot", enabled: true, credentials: { botToken: "secret" } })),
      record: vi.fn(async () => ({ schemaVersion: 1, channels: [] })),
    };
    const runtime = {
      capability: () => true,
      test: vi.fn(async () => { await gate; return { status: "connected" as const }; }),
      stop: vi.fn(async () => undefined), start: vi.fn(async () => undefined),
    };
    const dispatch = (desktop as any).createChannelDispatcher(store, runtime, { timeoutMs: 10 });
    await dispatch({ method: "channels.test", requestId: "timed-out", params: { channelId: "telegram-main" } });
    const reconnect = dispatch({ method: "channels.reconnect", requestId: "after-timeout", params: { channelId: "telegram-main" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.stop).not.toHaveBeenCalled();
    release();
    await reconnect;
    expect(runtime.stop).toHaveBeenCalledOnce();
  });

  it("aborts active and queued operations when disposed", async () => {
    let activeSignal: AbortSignal | undefined;
    const store = {
      getForRuntime: vi.fn(async () => ({ id: "telegram-main", kind: "telegram", name: "Telegram", mode: "bot", enabled: true, credentials: { botToken: "secret" } })),
      record: vi.fn(async () => ({ schemaVersion: 1, channels: [] })),
    };
    const runtime = {
      capability: () => true,
      test: vi.fn((_channel: unknown, signal: AbortSignal) => { activeSignal = signal; return new Promise<never>(() => undefined); }),
      stop: vi.fn(), start: vi.fn(),
    };
    const dispatch = (desktop as any).createChannelDispatcher(store, runtime, { timeoutMs: 60_000 });
    void dispatch({ method: "channels.test", requestId: "active-dispose", params: { channelId: "telegram-main" } });
    await vi.waitFor(() => expect(activeSignal).toBeDefined());
    const queued = dispatch({ method: "channels.reconnect", requestId: "queued-dispose", params: { channelId: "telegram-main" } });
    dispatch.dispose();
    await queued;
    expect(activeSignal?.aborted).toBe(true);
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it("compensates runtime changes when portable persistence fails", async () => {
    const channel = { id: "telegram-new", kind: "telegram" as const, name: "Telegram", mode: "bot" as const, enabled: true, credentials: { botToken: "secret" } };
    const store = {
      list: vi.fn(async () => ({ schemaVersion: 1, channels: [] })),
      create: vi.fn(async () => { throw new Error("USB write failed"); }),
      getForRuntime: vi.fn(), record: vi.fn(), update: vi.fn(), remove: vi.fn(), setEnabled: vi.fn(),
    };
    const runtime = { capability: () => true, configure: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) };
    const dispatch = (desktop as any).createChannelDispatcher(store, runtime);
    await expect(dispatch({ method: "channels.create", requestId: "create-write-fail", params: { channel } })).rejects.toThrow("USB write failed");
    expect(runtime.configure).toHaveBeenCalledWith(channel, expect.any(AbortSignal));
    expect(runtime.remove).toHaveBeenCalledWith(channel, expect.any(AbortSignal));
  });
});
