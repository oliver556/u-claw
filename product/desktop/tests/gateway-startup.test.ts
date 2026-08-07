import { describe, expect, it, vi } from "vitest";

import { startGatewayAndCreateWindow } from "../src/gateway/startup.js";

describe("startGatewayAndCreateWindow", () => {
  it("selects a port, starts the owned gateway, waits for business readiness, then shows the window", async () => {
    const order: string[] = [];
    const show = vi.fn(() => order.push("show"));
    const start = vi.fn((launch) => {
      order.push(`start:${launch.args.at(-1)}`);
      return { pid: 4321, instanceId: 1 };
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
      gatewayProcess: { start: vi.fn(() => ({ pid: 4321, instanceId: 1 })), stop },
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

  it("excludes a raced port and retries when that gateway instance exits before readiness", async () => {
    const selectPort = vi.fn(async (excluded: readonly number[]) => excluded.length === 0 ? 18789 : 18790);
    const start = vi.fn()
      .mockReturnValueOnce({ pid: 4321, instanceId: 1 })
      .mockReturnValueOnce({ pid: 4321, instanceId: 2 });
    const stop = vi.fn(async () => undefined);
    const checkHealth = vi.fn(async (
      port: number,
      _deadline: number,
      identity: { pid: number; instanceId: number },
    ) => ({
      processAlive: identity.instanceId === 2,
      serviceReady: identity.instanceId === 2,
      businessAvailable: identity.instanceId === 2,
      checkedAtMs: port,
    }));

    const result = await startGatewayAndCreateWindow({
      selectPort,
      gatewayProcess: { start, stop },
      buildLaunchOptions: (port) => ({ executable: "node", args: [String(port)] }),
      checkHealth,
      now: () => 0,
      sleep: vi.fn(),
      timeoutMs: 1_000,
      pollIntervalMs: 10,
      createWindow: async () => ({ show: vi.fn() }),
    });

    expect(result).toMatchObject({ port: 18790, pid: 4321, instanceId: 2 });
    expect(selectPort.mock.calls).toEqual([[[]], [[18789]]]);
    expect(stop).toHaveBeenCalledOnce();
    expect(checkHealth.mock.calls.map(([port, , identity]) => [port, identity.instanceId]))
      .toEqual([[18789, 1], [18790, 2]]);
  });

  it("retries the next candidate after a synchronous EADDRINUSE start failure", async () => {
    const addressInUse = Object.assign(new Error("bind failed"), { code: "EADDRINUSE" });
    const selectPort = vi.fn(async (excluded: readonly number[]) => excluded.length === 0 ? 18789 : 18790);
    const start = vi.fn()
      .mockImplementationOnce(() => { throw addressInUse; })
      .mockReturnValueOnce({ pid: 4330, instanceId: 2 });
    const stop = vi.fn(async () => undefined);

    const result = await startGatewayAndCreateWindow({
      selectPort,
      gatewayProcess: { start, stop },
      buildLaunchOptions: (port) => ({ executable: "node", args: [String(port)] }),
      checkHealth: vi.fn(async () => ({
        processAlive: true,
        serviceReady: true,
        businessAvailable: true,
        checkedAtMs: 0,
      })),
      now: () => 0,
      sleep: vi.fn(),
      timeoutMs: 1_000,
      pollIntervalMs: 10,
      createWindow: async () => ({ show: vi.fn() }),
    });

    expect(result).toMatchObject({ port: 18790, pid: 4330, instanceId: 2 });
    expect(selectPort.mock.calls).toEqual([[[]], [[18789]]]);
    expect(stop).not.toHaveBeenCalled();
  });

  it("preserves the startup error when rollback also fails", async () => {
    const startupError = new Error("readiness root cause");
    const cleanupError = new Error("cleanup failed");
    const caught = await startGatewayAndCreateWindow({
      selectPort: async () => 18789,
      gatewayProcess: {
        start: vi.fn(() => ({ pid: 4321, instanceId: 1 })),
        stop: vi.fn(async () => { throw cleanupError; }),
      },
      buildLaunchOptions: () => ({ executable: "node", args: ["gateway"] }),
      checkHealth: vi.fn(async () => { throw startupError; }),
      now: () => 0,
      sleep: vi.fn(),
      timeoutMs: 1_000,
      pollIntervalMs: 10,
      createWindow: vi.fn(),
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([startupError, cleanupError]);
    expect((caught as Error & { cause?: unknown }).cause).toBe(startupError);
  });
});
