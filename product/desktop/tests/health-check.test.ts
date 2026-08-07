import { describe, expect, it, vi } from "vitest";

import { checkGatewayHealth } from "../src/gateway/health-check.js";

describe("checkGatewayHealth", () => {
  it("does not probe HTTP when the process is dead", async () => {
    const fetch = vi.fn();
    const status = await checkGatewayHealth({
      isProcessAlive: () => false,
      baseUrl: "http://127.0.0.1:18789",
      fetch,
      now: () => 1234,
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
});
