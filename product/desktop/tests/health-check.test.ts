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

  it("distinguishes service readiness from business availability", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false });

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
    expect(fetch).toHaveBeenNthCalledWith(2, "http://127.0.0.1:18789/status", expect.any(Object));
  });

  it("reports all three levels when the gateway is usable", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    await expect(checkGatewayHealth({
      isProcessAlive: () => true,
      baseUrl: "http://127.0.0.1:18789",
      fetch,
      now: () => 3456,
    })).resolves.toEqual({
      processAlive: true,
      serviceReady: true,
      businessAvailable: true,
      checkedAtMs: 3456,
    });
  });
});
