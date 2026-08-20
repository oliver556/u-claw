import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { GatewayProcessManager } from "../src/gateway/gateway-process.js";
import {
  startGatewayAndCreateWindow as startGatewayAndCreateWindowRaw,
  type GatewayStartupDependencies,
  type ShowableWindow,
} from "../src/gateway/startup.js";
import { bootstrapDesktopApp } from "../src/main.js";

function startGatewayAndCreateWindow<TWindow extends ShowableWindow>(
  options: Omit<GatewayStartupDependencies<TWindow>, "signal"> & { signal?: AbortSignal },
) {
  return startGatewayAndCreateWindowRaw({
    signal: new AbortController().signal,
    ...options,
  });
}

function readyDependencies(overrides: Record<string, unknown> = {}) {
  return {
    selectPort: vi.fn(async () => 18789),
    gatewayProcess: {
      start: vi.fn(() => ({ pid: 4321, instanceId: 1 })),
      stop: vi.fn(async () => undefined),
    },
    buildLaunchOptions: () => ({ executable: "node", args: ["gateway"] }),
    checkHealth: vi.fn(async () => ({
      processAlive: true,
      serviceReady: true,
      businessAvailable: true,
      checkedAtMs: 0,
    })),
    now: () => 0,
    sleep: vi.fn(async () => undefined),
    timeoutMs: 1_000,
    pollIntervalMs: 10,
    createWindow: vi.fn(async () => ({ show: vi.fn() })),
    ...overrides,
  };
}

class FakeChild extends EventEmitter {
  pid: number | undefined;
  exitCode: number | null = null;
  killed = false;
  stderr = new PassThrough();
  kill = vi.fn(() => true);

  constructor(pid: number) {
    super();
    this.pid = pid;
  }
}

describe("phase 0 Shell/Gateway failure contracts", () => {
  it("shows a diagnosable Shell before Gateway readiness times out", async () => {
    const show = vi.fn();
    const createWindow = vi.fn(async () => ({ show }));
    let now = 0;

    const failure = await startGatewayAndCreateWindow({
      ...readyDependencies(),
      checkHealth: vi.fn(async () => ({
        processAlive: true,
        serviceReady: false,
        businessAvailable: false,
        checkedAtMs: now,
      })),
      now: () => now,
      sleep: vi.fn(async () => { now = 1_001; }),
      timeoutMs: 1_000,
      createWindow,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(createWindow).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledOnce();
  });

  it("deduplicates concurrent starts that carry the same attemptId", async () => {
    const start = vi.fn()
      .mockReturnValueOnce({ pid: 4321, instanceId: 1 })
      .mockReturnValueOnce({ pid: 4322, instanceId: 2 });
    const dependencies = readyDependencies({
      attemptId: "attempt-001",
      gatewayProcess: { start, stop: vi.fn(async () => undefined) },
    });

    const [first, second] = await Promise.all([
      startGatewayAndCreateWindow(dependencies),
      startGatewayAndCreateWindow(dependencies),
    ]);

    expect(start).toHaveBeenCalledOnce();
    expect(second).toEqual(first);
  });

  it("keeps a new attempt authoritative when an old process emits late events", async () => {
    const first = new FakeChild(4321);
    const second = new FakeChild(4322);
    const events: Array<Record<string, unknown>> = [];
    const manager = new GatewayProcessManager({
      spawn: vi.fn()
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second),
      diagnostics: { append: (event) => { events.push(event); } },
    });

    const oldIdentity = manager.start({ executable: "node", args: ["gateway"] });
    first.kill.mockImplementation(() => {
      queueMicrotask(() => {
        first.exitCode = 0;
        first.emit("exit", 0, null);
        first.emit("close", 0, null);
      });
      return true;
    });
    await manager.stop("manual-restart");
    const newIdentity = manager.start({ executable: "node", args: ["gateway"] });

    first.emit("error", new Error("late old-attempt error"));
    first.emit("close", 1, null);

    expect(manager.getOwnedPid()).toBe(4322);
    expect(manager.getState()).toEqual({ phase: "running", pid: 4322 });
    expect(oldIdentity).toEqual(expect.objectContaining({ attemptId: expect.any(String) }));
    expect(newIdentity).toEqual(expect.objectContaining({ attemptId: expect.any(String) }));
    expect((newIdentity as { attemptId?: string }).attemptId)
      .not.toBe((oldIdentity as { attemptId?: string }).attemptId);
    expect(events.every((event) => typeof event.attemptId === "string")).toBe(true);
  });

  it("stops the old attempt before spawning a Gateway retry", async () => {
    const order: string[] = [];
    let instanceId = 0;
    const dependencies = readyDependencies({
      gatewayProcess: {
        start: vi.fn(() => {
          instanceId += 1;
          order.push(`start:${instanceId}`);
          return { pid: 4_320 + instanceId, instanceId };
        }),
        stop: vi.fn(async () => { order.push("stop"); }),
      },
    });

    const firstAttempt = { ...dependencies, attemptId: "attempt-001" };
    const secondAttempt = { ...dependencies, attemptId: "attempt-002" };
    await startGatewayAndCreateWindow(firstAttempt);
    await startGatewayAndCreateWindow(secondAttempt);

    expect(order).toEqual(["start:1", "stop", "start:2"]);
  });

  it("acquires a host-global lock before any second USB enters app startup", async () => {
    const order: string[] = [];
    const acquireHostGlobalLock = vi.fn(async () => {
      order.push("host-lock");
      return false;
    });
    const dependencies = {
      app: {
        requestSingleInstanceLock: vi.fn(() => {
          order.push("electron-lock");
          return true;
        }),
        quit: vi.fn(),
        whenReady: vi.fn(async () => { order.push("shell"); }),
        on: vi.fn(),
      },
      acquireHostGlobalLock,
      createWindow: vi.fn(async () => {
        order.push("window");
        return { isDestroyed: () => false, isMinimized: () => false, restore: vi.fn(), focus: vi.fn() };
      }),
      registerIpc: vi.fn(),
      stopGateway: vi.fn(),
    };

    await bootstrapDesktopApp(dependencies);

    expect(acquireHostGlobalLock).toHaveBeenCalledOnce();
    expect(order).toEqual(["host-lock"]);
  });

  it("keeps history, settings, current model and diagnostics available after Gateway failure", async () => {
    const state = {
      history: [{ id: "message-1", text: "existing conversation" }],
      settings: { theme: "dark" },
      currentModel: "provider/model-a",
      diagnostics: [{ id: "diagnostic-1", state: "failed" }],
    };
    const snapshot = structuredClone(state);
    const show = vi.fn();
    const createWindow = vi.fn(async () => ({ show, state }));

    await startGatewayAndCreateWindow({
      ...readyDependencies(),
      checkHealth: vi.fn(async () => ({
        processAlive: false,
        serviceReady: false,
        businessAvailable: false,
        checkedAtMs: 1,
      })),
      createWindow,
    }).catch(() => undefined);

    expect(state).toEqual(snapshot);
    expect(createWindow).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledOnce();
  });
});
