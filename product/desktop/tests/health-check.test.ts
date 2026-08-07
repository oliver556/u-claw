import { afterEach, describe, expect, it, vi } from "vitest";

import { checkGatewayHealth } from "../src/gateway/health-check.js";

describe("checkGatewayHealth", () => {
  afterEach(() => vi.useRealTimers());

  it("does not probe HTTP when the process is dead", async () => {
    const fetch = vi.fn();
    const status = await checkGatewayHealth({
      isProcessAlive: () => false,
      baseUrl: "http://127.0.0.1:18789",
      fetch,
      now: () => 1234,
      deadlineMs: 1334,
    });

    expect(status).toEqual({
      processAlive: false,
      serviceReady: false,
      businessAvailable: false,
      checkedAtMs: 1234,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not infer business availability from an HTTP 2xx response", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });

    const status = await checkGatewayHealth({
      isProcessAlive: () => true,
      baseUrl: "http://127.0.0.1:18789/",
      fetch,
      now: () => 2345,
      deadlineMs: 2445,
    });

    expect(status).toEqual({
      processAlive: true,
      serviceReady: true,
      businessAvailable: false,
      checkedAtMs: 2345,
    });
    expect(fetch).toHaveBeenNthCalledWith(1, "http://127.0.0.1:18789/ready", expect.any(Object));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("requires hello-ok and every required method for business availability", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    await expect(checkGatewayHealth({
      isProcessAlive: () => true,
      baseUrl: "http://127.0.0.1:18789",
      fetch,
      now: () => 3456,
      deadlineMs: 3556,
      requiredMethods: ["chat.send", "sessions.list"],
      probeCapabilities: async () => ({
        helloOk: true,
        methods: ["chat.send", "sessions.list", "chat.abort"],
      }),
    })).resolves.toEqual({
      processAlive: true,
      serviceReady: true,
      businessAvailable: true,
      checkedAtMs: 3456,
    });
  });

  it("keeps business unavailable when hello-ok is missing or a required method is absent", async () => {
    const base = {
      isProcessAlive: () => true,
      baseUrl: "http://127.0.0.1:18789",
      fetch: vi.fn().mockResolvedValue({ ok: true }),
      now: () => 4567,
      deadlineMs: 4667,
      requiredMethods: ["chat.send", "sessions.list"],
    };

    await expect(checkGatewayHealth({
      ...base,
      probeCapabilities: async () => ({ helloOk: false, methods: ["chat.send", "sessions.list"] }),
    })).resolves.toMatchObject({ businessAvailable: false });
    await expect(checkGatewayHealth({
      ...base,
      probeCapabilities: async () => ({ helloOk: true, methods: ["chat.send"] }),
    })).resolves.toMatchObject({ businessAvailable: false });
  });

  it("hard-times out a hanging fetch and aborts its signal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let signal: AbortSignal | undefined;
    const pending = checkGatewayHealth({
      isProcessAlive: () => true,
      baseUrl: "http://127.0.0.1:18789",
      fetch: vi.fn((_url, init) => {
        signal = (init as { signal?: AbortSignal }).signal;
        return new Promise<never>(() => undefined);
      }),
      now: Date.now,
      deadlineMs: 1_100,
    });
    let settled = false;
    void pending.finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(true);
    expect(signal?.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ serviceReady: false, businessAvailable: false });
  });

  it("hard-times out a hanging capability probe", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    let signal: AbortSignal | undefined;
    const pending = checkGatewayHealth({
      isProcessAlive: () => true,
      baseUrl: "http://127.0.0.1:18789",
      fetch: vi.fn(async () => ({ ok: true })),
      probeCapabilities: (receivedSignal) => {
        signal = receivedSignal;
        return new Promise(() => undefined);
      },
      requiredMethods: ["chat.send"],
      now: Date.now,
      deadlineMs: 2_100,
    });
    let settled = false;
    void pending.finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(true);
    expect(signal?.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ serviceReady: true, businessAvailable: false });
  });
});
