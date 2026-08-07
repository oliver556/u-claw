import { describe, expect, it, vi } from "vitest";

import { startGatewayAndCreateWindow } from "../src/gateway/startup.js";

describe("startGatewayAndCreateWindow", () => {
  it("selects a port, starts the owned gateway, waits for business readiness, then shows the window", async () => {
    const order: string[] = [];
    const show = vi.fn(() => order.push("show"));
    const start = vi.fn((launch) => {
      order.push(`start:${launch.args.at(-1)}`);
      return 4321;
    });
    const health = [
      { processAlive: true, serviceReady: true, businessAvailable: false, checkedAtMs: 1 },
      { processAlive: true, serviceReady: true, businessAvailable: true, checkedAtMs: 2 },
    ];

    const result = await startGatewayAndCreateWindow({
      selectPort: vi.fn(async () => {
        order.push("port");
        return 18790;
      }),
      gatewayProcess: { start, stop: vi.fn(async () => undefined) },
      buildLaunchOptions: (port) => ({
        executable: "/runtime/node.exe",
        args: ["openclaw.js", "gateway", "--port", String(port)],
        cwd: "/runtime",
        env: { UCLAW_DATA_DIR: "D:\\uclaw", UCLAW_GATEWAY_PORT: String(port) },
      }),
      checkHealth: vi.fn(async () => health.shift()!),
      now: () => 0,
      sleep: vi.fn(async () => { order.push("poll"); }),
      timeoutMs: 1_000,
      pollIntervalMs: 10,
      createWindow: vi.fn(async () => {
        order.push("window");
        return { show };
      }),
    });

    expect(result).toMatchObject({ port: 18790, pid: 4321 });
    expect(start).toHaveBeenCalledWith({
      executable: "/runtime/node.exe",
      args: ["openclaw.js", "gateway", "--port", "18790"],
      cwd: "/runtime",
      env: { UCLAW_DATA_DIR: "D:\\uclaw", UCLAW_GATEWAY_PORT: "18790" },
    });
    expect(order).toEqual(["port", "start:18790", "poll", "window", "show"]);
  });

  it("rejects invalid injected launch parameters before spawning", async () => {
    const start = vi.fn();
    await expect(startGatewayAndCreateWindow({
      selectPort: vi.fn(async () => 18789),
      gatewayProcess: { start, stop: vi.fn(async () => undefined) },
      buildLaunchOptions: () => ({
        executable: " ",
        args: ["gateway"],
        env: { UCLAW_DATA_DIR: 42 },
      }),
      checkHealth: vi.fn(),
      now: () => 0,
      sleep: vi.fn(),
      timeoutMs: 1_000,
      pollIntervalMs: 10,
      createWindow: vi.fn(),
    })).rejects.toThrow("launch options");
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects an injected port outside the fixed gateway range", async () => {
    const start = vi.fn();
    await expect(startGatewayAndCreateWindow({
      selectPort: vi.fn(async () => 18000),
      gatewayProcess: { start, stop: vi.fn(async () => undefined) },
      buildLaunchOptions: () => ({ executable: "node", args: ["gateway"] }),
      checkHealth: vi.fn(),
      now: () => 0,
      sleep: vi.fn(),
      timeoutMs: 1_000,
      pollIntervalMs: 10,
      createWindow: vi.fn(),
    })).rejects.toThrow("18789-18799");
    expect(start).not.toHaveBeenCalled();
  });

  it("stops the owned gateway when readiness fails and never shows a window", async () => {
    const stop = vi.fn(async () => undefined);
    const createWindow = vi.fn();
    await expect(startGatewayAndCreateWindow({
      selectPort: vi.fn(async () => 18789),
      gatewayProcess: { start: vi.fn(() => 4321), stop },
      buildLaunchOptions: () => ({ executable: "node", args: ["gateway"] }),
      checkHealth: vi.fn(async () => ({
        processAlive: false,
        serviceReady: false,
        businessAvailable: false,
        checkedAtMs: 1,
      })),
      now: () => 0,
      sleep: vi.fn(),
      timeoutMs: 1_000,
      pollIntervalMs: 10,
      createWindow,
    })).rejects.toThrow("exited");
    expect(stop).toHaveBeenCalledOnce();
    expect(createWindow).not.toHaveBeenCalled();
  });
});
