import { describe, expect, it, vi } from "vitest";

import * as desktop from "../src/index.js";

const qrValues = {
  A: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==",
  B: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
} as const;
const qr = (value: keyof typeof qrValues = "A") => ({ kind: "data-url" as const, value: qrValues[value] });

function runtime(overrides: Record<string, unknown> = {}) {
  return {
    capability: vi.fn(async () => ({ available: true, pluginStatus: "installed" as const })),
    status: vi.fn(async () => ({ status: "disconnected" as const, loginState: "idle" as const })),
    start: vi.fn(async () => ({ flowId: "flow-1", qrImage: qr(), qrExpiresAt: "2026-08-09T09:05:00.000Z" })),
    poll: vi.fn(async () => ({ status: "pending-verification" as const, loginState: "awaiting-confirmation" as const })),
    refresh: vi.fn(async () => ({ qrImage: qr("B"), qrExpiresAt: "2026-08-09T09:06:00.000Z" })),
    cancel: vi.fn(async () => undefined),
    reconnect: vi.fn(async () => ({ status: "connected" as const, loginState: "connected" as const, account: { displayName: "微信账号", accountIdHint: "...7a2f" } })),
    logout: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createCoordinator(candidate: ReturnType<typeof runtime>, options: Record<string, unknown> = {}) {
  return (desktop as any).createWechatLoginCoordinator(candidate, { createFlowId: () => "flow-1", ...options });
}

describe("personal WeChat login coordinator", () => {
  it("reports missing plugin without calling a login API", async () => {
    const unavailable = runtime({ capability: vi.fn(async () => ({ available: false, pluginStatus: "missing", reason: "需要安装个人微信插件。" })) });
    const coordinator = createCoordinator(unavailable, { now: () => new Date("2026-08-09T09:00:00.000Z") });

    const snapshot = await coordinator.status();

    expect(snapshot).toMatchObject({ capability: "unavailable", plugin: { id: "openclaw-weixin", requiredVersion: "2.4.6", status: "missing" }, error: { code: "WECHAT_PLUGIN_MISSING" } });
    expect(unavailable.start).not.toHaveBeenCalled();
  });

  it("moves from fresh QR to scanned confirmation and connected account", async () => {
    const candidate = runtime({
      poll: vi.fn()
        .mockResolvedValueOnce({ status: "pending-verification", loginState: "awaiting-confirmation" })
        .mockResolvedValueOnce({ status: "connected", loginState: "connected", account: { displayName: "微信账号", accountIdHint: "...7a2f" } }),
    });
    const coordinator = createCoordinator(candidate, { now: () => new Date("2026-08-09T09:00:00.000Z") });

    const started = await coordinator.start(false);
    expect(started).toMatchObject({ status: "pending-verification", loginState: "awaiting-scan", flowId: "flow-1", qrGeneration: 1, qrImage: qr() });
    const scanned = await coordinator.poll("flow-1", 1);
    expect(scanned.loginState).toBe("awaiting-confirmation");
    const connected = await coordinator.poll("flow-1", 1);
    expect(connected).toMatchObject({ status: "connected", loginState: "connected", account: { accountIdHint: "...7a2f" } });
    expect(connected).not.toHaveProperty("qrImage");
    expect(connected).not.toHaveProperty("flowId");
  });

  it("clears QR state but keeps account actions when confirmed startup fails", async () => {
    const candidate = runtime({
      poll: vi.fn(async () => ({ status: "disconnected", loginState: "error", account: { accountIdHint: "...7a2f" } })),
    });
    const coordinator = createCoordinator(candidate, { now: () => new Date("2026-08-09T09:00:00.000Z") });
    await coordinator.start(false);

    const failed = await coordinator.poll("flow-1", 1);

    expect(failed).toMatchObject({ status: "disconnected", loginState: "error", account: { accountIdHint: "...7a2f" } });
    expect(failed).not.toHaveProperty("flowId");
    expect(failed).not.toHaveProperty("qrImage");
  });

  it("maps an upstream login handle to a renderer-safe local flow id", async () => {
    const candidate = runtime({ start: vi.fn(async () => ({ flowId: "runtime-session-handle-secret", qrImage: qr(), qrExpiresAt: "2026-08-09T09:05:00.000Z" })) });
    const coordinator = createCoordinator(candidate, {
      now: () => new Date("2026-08-09T09:00:00.000Z"),
      createFlowId: () => "local-flow-1",
    });

    const started = await coordinator.start(false);
    await coordinator.poll("local-flow-1", 1);

    expect(started).toMatchObject({ flowId: "local-flow-1" });
    expect(JSON.stringify(started)).not.toContain("runtime-session-handle-secret");
    expect(candidate.poll).toHaveBeenCalledWith("runtime-session-handle-secret", expect.any(AbortSignal));
  });

  it("deduplicates normal start and cancels the old runtime flow before forced restart", async () => {
    const candidate = runtime({
      start: vi.fn()
        .mockResolvedValueOnce({ flowId: "runtime-flow-1", qrImage: qr(), qrExpiresAt: "2026-08-09T09:05:00.000Z" })
        .mockResolvedValueOnce({ flowId: "runtime-flow-2", qrImage: qr("B"), qrExpiresAt: "2026-08-09T09:06:00.000Z" }),
    });
    let flow = 0;
    const coordinator = createCoordinator(candidate, {
      now: () => new Date("2026-08-09T09:00:00.000Z"),
      createFlowId: () => `local-flow-${++flow}`,
    });

    const first = await coordinator.start(false);
    const duplicate = await coordinator.start(false);
    const forced = await coordinator.start(true);

    expect(duplicate).toEqual(first);
    expect(candidate.start).toHaveBeenCalledTimes(2);
    expect(candidate.cancel).toHaveBeenCalledWith("runtime-flow-1", expect.any(AbortSignal));
    expect(forced).toMatchObject({ flowId: "local-flow-2", qrGeneration: 1, qrImage: qr("B") });
  });

  it("blocks an expired QR before runtime polling", async () => {
    let now = new Date("2026-08-09T09:00:00.000Z");
    const candidate = runtime();
    const coordinator = createCoordinator(candidate, { now: () => now });
    await coordinator.start(false);
    now = new Date("2026-08-09T09:05:00.000Z");

    const expired = await coordinator.poll("flow-1", 1);

    expect(expired).toMatchObject({ loginState: "expired", status: "needs-action", error: { code: "WECHAT_QR_EXPIRED" } });
    expect(candidate.poll).not.toHaveBeenCalled();
  });

  it("allows refresh after expiry while preventing the expired QR from polling", async () => {
    let now = new Date("2026-08-09T09:00:00.000Z");
    const candidate = runtime();
    const coordinator = createCoordinator(candidate, { now: () => now });
    await coordinator.start(false);
    now = new Date("2026-08-09T09:05:00.000Z");
    const expired = await coordinator.poll("flow-1", 1);

    const refreshed = await coordinator.refresh("flow-1", 1);

    expect(expired).toMatchObject({ flowId: "flow-1", qrGeneration: 1, loginState: "expired" });
    expect(candidate.poll).not.toHaveBeenCalled();
    expect(candidate.refresh).toHaveBeenCalledOnce();
    expect(refreshed).toMatchObject({ flowId: "flow-1", qrGeneration: 2, loginState: "awaiting-scan" });
  });

  it("deduplicates concurrent refresh for the same QR generation", async () => {
    const candidate = runtime();
    const coordinator = createCoordinator(candidate, { now: () => new Date("2026-08-09T09:00:00.000Z") });
    await coordinator.start(false);

    const [first, second] = await Promise.all([coordinator.refresh("flow-1", 1), coordinator.refresh("flow-1", 1)]);

    expect(candidate.refresh).toHaveBeenCalledOnce();
    expect(first.qrGeneration).toBe(2);
    expect(second.qrGeneration).toBe(2);
    expect(first.qrImage).toEqual(qr("B"));
  });

  it("keeps the latest QR active when an old generation polls", async () => {
    const candidate = runtime();
    const coordinator = createCoordinator(candidate, { now: () => new Date("2026-08-09T09:00:00.000Z") });
    await coordinator.start(false);
    await coordinator.refresh("flow-1", 1);

    const stale = await coordinator.poll("flow-1", 1);

    expect(stale).toMatchObject({ loginState: "awaiting-scan", flowId: "flow-1", qrGeneration: 2, qrImage: qr("B") });
    expect(stale).not.toHaveProperty("error");
    expect(candidate.poll).not.toHaveBeenCalled();
  });

  it("bounds a hanging capability check with the same deadline", async () => {
    const candidate = runtime({ capability: vi.fn(() => new Promise(() => undefined)) });
    const coordinator = createCoordinator(candidate, { timeoutMs: 10 });

    const timedOut = await coordinator.status();

    expect(timedOut).toMatchObject({ status: "network-error", loginState: "error", error: { code: "WECHAT_TIMEOUT" } });
  });

  it("bounds a hanging runtime poll with a deadline", async () => {
    let signal: AbortSignal | undefined;
    const candidate = runtime({ poll: vi.fn((_flowId: string, candidateSignal: AbortSignal) => {
      signal = candidateSignal;
      return new Promise((_resolve, reject) => candidateSignal.addEventListener("abort", () => reject(candidateSignal.reason), { once: true }));
    }) });
    const coordinator = createCoordinator(candidate, {
      now: () => new Date("2026-08-09T09:00:00.000Z"),
      timeoutMs: 10,
    });
    await coordinator.start(false);

    const timedOut = await coordinator.poll("flow-1", 1);

    expect(signal?.aborted).toBe(true);
    expect(timedOut).toMatchObject({ status: "network-error", loginState: "error", error: { code: "WECHAT_TIMEOUT" } });
  });

  it("cancels a retained upstream flow before restarting after poll failure", async () => {
    const candidate = runtime({
      start: vi.fn()
        .mockResolvedValueOnce({ flowId: "runtime-flow-1", qrImage: qr(), qrExpiresAt: "2026-08-09T09:05:00.000Z" })
        .mockResolvedValueOnce({ flowId: "runtime-flow-2", qrImage: qr("B"), qrExpiresAt: "2026-08-09T09:06:00.000Z" }),
      poll: vi.fn(async () => { throw new Error("network disconnected"); }),
    });
    let flow = 0;
    const coordinator = createCoordinator(candidate, {
      now: () => new Date("2026-08-09T09:00:00.000Z"),
      createFlowId: () => `local-flow-${++flow}`,
    });
    await coordinator.start(false);
    const failed = await coordinator.poll("local-flow-1", 1);

    const restarted = await coordinator.start(false);

    expect(failed).toMatchObject({ status: "network-error", error: { code: "WECHAT_NETWORK_ERROR" } });
    expect(candidate.cancel).toHaveBeenCalledWith("runtime-flow-1", expect.any(AbortSignal));
    expect(restarted).toMatchObject({ flowId: "local-flow-2", loginState: "awaiting-scan" });
  });

  it("cancels an in-flight poll and clears QR state", async () => {
    let signal: AbortSignal | undefined;
    const candidate = runtime({ poll: vi.fn((_flowId: string, candidateSignal: AbortSignal) => {
      signal = candidateSignal;
      return new Promise((_resolve, reject) => candidateSignal.addEventListener("abort", () => reject(candidateSignal.reason), { once: true }));
    }) });
    const coordinator = createCoordinator(candidate, { now: () => new Date("2026-08-09T09:00:00.000Z") });
    await coordinator.start(false);
    const pending = coordinator.poll("flow-1", 1);
    await vi.waitFor(() => expect(signal).toBeDefined());

    const cancelled = await coordinator.cancel("flow-1");

    await pending;
    expect(signal?.aborted).toBe(true);
    expect(candidate.cancel).toHaveBeenCalledWith("flow-1", expect.any(AbortSignal));
    expect(cancelled).toMatchObject({ status: "disconnected", loginState: "cancelled" });
    expect(cancelled).not.toHaveProperty("qrImage");
    expect(cancelled).not.toHaveProperty("flowId");
  });

  it("cancels an in-flight poll even when polling ignores abort", async () => {
    const candidate = runtime({ poll: vi.fn(() => new Promise(() => undefined)) });
    const coordinator = createCoordinator(candidate, { now: () => new Date("2026-08-09T09:00:00.000Z"), timeoutMs: 60_000 });
    await coordinator.start(false);
    const pending = coordinator.poll("flow-1", 1);
    await vi.waitFor(() => expect(candidate.poll).toHaveBeenCalledOnce());

    const cancelled = await coordinator.cancel("flow-1");
    const polling = await pending;

    expect(candidate.cancel).toHaveBeenCalledWith("flow-1", expect.any(AbortSignal));
    expect(cancelled).toMatchObject({ status: "disconnected", loginState: "cancelled" });
    expect(polling).toMatchObject({ status: "disconnected", loginState: "cancelled" });
  });

  it("clears account and QR state after logout", async () => {
    const candidate = runtime({ poll: vi.fn(async () => ({ status: "connected", loginState: "connected", account: { accountIdHint: "...7a2f" } })) });
    const coordinator = createCoordinator(candidate, { now: () => new Date("2026-08-09T09:00:00.000Z") });
    await coordinator.start(false);
    await coordinator.poll("flow-1", 1);

    const loggedOut = await coordinator.logout();

    expect(candidate.logout).toHaveBeenCalledOnce();
    expect(loggedOut).toMatchObject({ status: "not-configured", loginState: "logged-out" });
    expect(loggedOut).not.toHaveProperty("account");
    expect(loggedOut).not.toHaveProperty("qrImage");
  });

  it("attempts logout even when capability probing would be unavailable", async () => {
    const candidate = runtime({ capability: vi.fn(async () => ({ available: false, pluginStatus: "missing" as const })) });
    const coordinator = createCoordinator(candidate, { now: () => new Date("2026-08-09T09:00:00.000Z") });

    const loggedOut = await coordinator.logout();

    expect(candidate.capability).not.toHaveBeenCalled();
    expect(candidate.logout).toHaveBeenCalledOnce();
    expect(loggedOut).toMatchObject({ status: "not-configured", loginState: "logged-out" });
  });

  it("aborts a non-poll operation and prevents queued runtime work after dispose", async () => {
    const candidate = runtime({ status: vi.fn((signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))) });
    const coordinator = createCoordinator(candidate, { timeoutMs: 60_000 });
    const pending = coordinator.status();
    await vi.waitFor(() => expect(candidate.status).toHaveBeenCalledOnce());
    const queued = coordinator.start(false);

    coordinator.dispose();
    await Promise.all([pending, queued]);

    expect(candidate.start).not.toHaveBeenCalled();
  });
});
