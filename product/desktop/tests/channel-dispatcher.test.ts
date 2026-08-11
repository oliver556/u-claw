import { describe, expect, it, vi } from "vitest";

import * as desktop from "../src/index.js";

describe("channel dispatcher", () => {
  it("projects managed health from runtime instead of persisted UI state", async () => {
    const local = {
      schemaVersion: 1 as const,
      channels: [{
        id: "discord-main", kind: "discord" as const, name: "Discord", mode: "bot" as const,
        configured: true, enabled: true, status: "pending-verification" as const,
        capability: "available" as const, credentialHints: { botToken: "...cret" },
      }],
    };
    const stored = { id: "discord-main", kind: "discord" as const, name: "Discord", mode: "bot" as const, enabled: true, credentials: { botToken: "discord-secret" } };
    const store = { list: vi.fn(async () => local), getForRuntime: vi.fn(async () => stored) };
    const runtime = {
      capability: () => true,
      status: vi.fn(async () => ({
        configured: true, enabled: true, status: "connected" as const,
        runtimeAuthoritative: true as const, pendingAction: "none" as const,
        lastInboundAt: "2026-08-11T12:00:00.000Z", lastOutboundAt: "2026-08-11T12:01:00.000Z",
      })),
    };
    const dispatch = (desktop as any).createChannelDispatcher(store, runtime);

    const response = await dispatch({ method: "channels.list-managed", requestId: "list-runtime", params: {} });

    expect(runtime.status).toHaveBeenCalledWith(stored, false, expect.any(AbortSignal));
    expect(response.result.channels[0]).toMatchObject({
      status: "connected", runtimeAuthoritative: true, pendingAction: "none",
      lastInboundAt: "2026-08-11T12:00:00.000Z", credentialHints: { botToken: "...cret" },
    });
    expect(JSON.stringify(response)).not.toContain("discord-secret");
  });

  it("routes logout, send, action and poll through the formal runtime surface", async () => {
    const stored = { id: "discord-main", kind: "discord" as const, name: "Discord", mode: "bot" as const, enabled: true, credentials: { botToken: "discord-secret" } };
    const store = { getForRuntime: vi.fn(async () => stored), record: vi.fn(async () => ({ schemaVersion: 1, channels: [] })) };
    const runtime = {
      capability: () => true,
      logout: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      action: vi.fn(async () => undefined),
      poll: vi.fn(async () => undefined),
    };
    const dispatch = (desktop as any).createChannelDispatcher(store, runtime, { now: () => new Date("2026-08-11T12:00:00.000Z") });
    const requests = [
      { method: "channels.logout", requestId: "logout-1", params: { channelId: "discord-main" } },
      { method: "channels.send", requestId: "send-1", params: { channelId: "discord-main", target: "channel:123", message: "hello" } },
      { method: "channels.action", requestId: "action-1", params: { channelId: "discord-main", target: "channel:123", action: "react", messageId: "message-1", emoji: ":thumbsup:" } },
      { method: "channels.poll", requestId: "poll-1", params: { channelId: "discord-main", target: "channel:123", question: "Ship?", options: ["Yes", "No"], multiple: false } },
    ];

    const results = [];
    for (const request of requests) results.push(await dispatch(request));

    expect(runtime.logout).toHaveBeenCalledWith(stored, expect.any(AbortSignal));
    expect(runtime.send).toHaveBeenCalledWith(stored, { target: "channel:123", message: "hello" }, expect.any(AbortSignal));
    expect(runtime.action).toHaveBeenCalledWith(stored, { target: "channel:123", action: "react", messageId: "message-1", emoji: ":thumbsup:" }, expect.any(AbortSignal));
    expect(runtime.poll).toHaveBeenCalledWith(stored, { target: "channel:123", question: "Ship?", options: ["Yes", "No"], multiple: false }, expect.any(AbortSignal));
    expect(results.map((response: any) => response.result)).toEqual([
      { channelId: "discord-main", operation: "logout", completedAt: "2026-08-11T12:00:00.000Z" },
      { channelId: "discord-main", operation: "send", completedAt: "2026-08-11T12:00:00.000Z" },
      { channelId: "discord-main", operation: "action", completedAt: "2026-08-11T12:00:00.000Z" },
      { channelId: "discord-main", operation: "poll", completedAt: "2026-08-11T12:00:00.000Z" },
    ]);
    expect(JSON.stringify(results)).not.toContain("hello");
    expect(JSON.stringify(results)).not.toContain("discord-secret");
  });
  it("routes personal WeChat lifecycle through the managed channel contract", async () => {
    const qrImage = { kind: "data-url" as const, value: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==" };
    const wechat = {
      capability: vi.fn(async () => ({ available: true, pluginStatus: "installed" as const })),
      status: vi.fn(async () => ({ status: "not-configured" as const, loginState: "idle" as const })),
      start: vi.fn(async () => ({ flowId: "flow-1", qrImage, qrExpiresAt: "2026-08-09T09:05:00.000Z" })),
      poll: vi.fn(async () => ({ status: "pending-verification" as const, loginState: "awaiting-confirmation" as const })),
      refresh: vi.fn(), cancel: vi.fn(), reconnect: vi.fn(), logout: vi.fn(),
    };
    const dispatch = (desktop as any).createChannelDispatcher({}, { capability: () => false, wechat }, { now: () => new Date("2026-08-09T09:00:00.000Z") });

    const started = await dispatch({ method: "channels.wechat-login-start", requestId: "start-1", params: { force: false } });
    const publicFlowId = started.result.flowId;
    const polled = await dispatch({ method: "channels.wechat-login-poll", requestId: "poll-1", params: { flowId: publicFlowId, qrGeneration: 1 } });

    expect(started).toMatchObject({ ok: true, result: { loginState: "awaiting-scan", qrGeneration: 1 } });
    expect(polled).toMatchObject({ ok: true, result: { loginState: "awaiting-confirmation" } });
    expect(wechat.start).toHaveBeenCalledWith(false, expect.any(AbortSignal));
    expect(wechat.poll).toHaveBeenCalledWith("flow-1", expect.any(AbortSignal));
  });

  it("reports personal WeChat unavailable when production runtime has no safe adapter", async () => {
    const dispatch = (desktop as any).createChannelDispatcher({}, { capability: () => false });

    const response = await dispatch({ method: "channels.wechat-status", requestId: "status-1", params: {} });

    expect(response).toMatchObject({
      ok: true,
      result: { capability: "unavailable", plugin: { id: "openclaw-weixin", requiredVersion: "2.4.6", status: "unknown" }, error: { code: "WECHAT_CAPABILITY_UNAVAILABLE" } },
    });
  });

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
