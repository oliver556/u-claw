import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { bootstrapDesktopApp, runDesktopMain, validateRendererUrl } from "../src/main.js";

describe("bootstrapDesktopApp", () => {
  it("quits immediately when another instance owns the lock", async () => {
    const quit = vi.fn();
    const createWindow = vi.fn();

    const result = await bootstrapDesktopApp({
      app: {
        requestSingleInstanceLock: () => false,
        quit,
        whenReady: vi.fn(async () => undefined),
        on: vi.fn(),
      },
      createWindow,
      registerIpc: vi.fn(),
      stopGateway: vi.fn(),
    });

    expect(result).toBeNull();
    expect(quit).toHaveBeenCalledOnce();
    expect(createWindow).not.toHaveBeenCalled();
  });

  it("restores and focuses its window on a second-instance event", async () => {
    const listeners = new Map<string, () => void>();
    const restore = vi.fn();
    const focus = vi.fn();
    const window = {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore,
      focus,
    };

    await bootstrapDesktopApp({
      app: {
        requestSingleInstanceLock: () => true,
        quit: vi.fn(),
        whenReady: vi.fn(async () => undefined),
        on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
      },
      createWindow: vi.fn(async () => window),
      registerIpc: vi.fn(),
      stopGateway: vi.fn(),
    });

    listeners.get("second-instance")?.();
    expect(restore).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
  });

  it("holds the first quit until gateway cleanup completes", async () => {
    const listeners = new Map<string, (event?: { preventDefault(): void }) => void>();
    const quit = vi.fn();
    const preventDefault = vi.fn();
    let finishStop: (() => void) | undefined;
    const stopGateway = vi.fn(() => new Promise<void>((resolve) => { finishStop = resolve; }));

    await bootstrapDesktopApp({
      app: {
        requestSingleInstanceLock: () => true,
        quit,
        whenReady: vi.fn(async () => undefined),
        on: vi.fn((event: string, listener: (event?: { preventDefault(): void }) => void) => {
          listeners.set(event, listener);
        }),
      },
      createWindow: vi.fn(async (registerIpc) => {
        const window = {
          isDestroyed: () => false,
          isMinimized: () => false,
          restore: vi.fn(),
          focus: vi.fn(),
        };
        registerIpc(window);
        return window;
      }),
      registerIpc: vi.fn(),
      stopGateway,
    });

    listeners.get("before-quit")?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopGateway).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();

    finishStop?.();
    await Promise.resolve();
    expect(quit).toHaveBeenCalledOnce();
  });

  it("prevents every quit attempt until cleanup completes", async () => {
    const listeners = new Map<string, (event?: { preventDefault(): void }) => void>();
    const quit = vi.fn();
    let finishStop: (() => void) | undefined;
    const stopGateway = vi.fn(() => new Promise<void>((resolve) => { finishStop = resolve; }));
    await bootstrapDesktopApp({
      app: {
        requestSingleInstanceLock: () => true,
        quit,
        whenReady: vi.fn(async () => undefined),
        on: vi.fn((event: string, listener: (event?: { preventDefault(): void }) => void) => {
          listeners.set(event, listener);
        }),
      },
      createWindow: vi.fn(async () => ({
        isDestroyed: () => false,
        isMinimized: () => false,
        restore: vi.fn(),
        focus: vi.fn(),
      })),
      registerIpc: vi.fn(),
      stopGateway,
    });
    const first = { preventDefault: vi.fn() };
    const second = { preventDefault: vi.fn() };

    listeners.get("before-quit")?.(first);
    listeners.get("before-quit")?.(second);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(stopGateway).toHaveBeenCalledOnce();

    finishStop?.();
    await Promise.resolve();
    listeners.get("before-quit")?.({ preventDefault: vi.fn() });
    expect(quit).toHaveBeenCalledOnce();
  });

  it("rolls back the gateway once when window creation fails", async () => {
    const stopGateway = vi.fn(async () => undefined);
    await expect(bootstrapDesktopApp({
      app: {
        requestSingleInstanceLock: () => true,
        quit: vi.fn(),
        whenReady: vi.fn(async () => undefined),
        on: vi.fn(),
      },
      createWindow: vi.fn(async () => { throw new Error("window failed"); }),
      registerIpc: vi.fn(),
      stopGateway,
    })).rejects.toThrow("window failed");
    expect(stopGateway).toHaveBeenCalledOnce();
  });

  it("rolls back the gateway once when IPC registration fails", async () => {
    const stopGateway = vi.fn(async () => undefined);
    await expect(bootstrapDesktopApp({
      app: {
        requestSingleInstanceLock: () => true,
        quit: vi.fn(),
        whenReady: vi.fn(async () => undefined),
        on: vi.fn(),
      },
      createWindow: vi.fn(async (registerIpc) => {
        const window = {
          isDestroyed: () => false,
          isMinimized: () => false,
          restore: vi.fn(),
          focus: vi.fn(),
        };
        registerIpc(window);
        return window;
      }),
      registerIpc: vi.fn(() => { throw new Error("IPC failed"); }),
      stopGateway,
    })).rejects.toThrow("IPC failed");
    expect(stopGateway).toHaveBeenCalledOnce();
  });

  it("preserves a window startup error when gateway cleanup also fails", async () => {
    const startupError = new Error("window startup failed");
    const cleanupError = new Error("gateway cleanup failed");
    const caught = await bootstrapDesktopApp({
      app: {
        requestSingleInstanceLock: () => true,
        quit: vi.fn(),
        whenReady: vi.fn(async () => undefined),
        on: vi.fn(),
      },
      createWindow: vi.fn(async () => { throw startupError; }),
      registerIpc: vi.fn(),
      stopGateway: vi.fn(async () => { throw cleanupError; }),
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([startupError, cleanupError]);
    expect((caught as Error & { cause?: unknown }).cause).toBe(startupError);
  });
});

describe("validateRendererUrl", () => {
  it("allows loopback development URLs", () => {
    expect(validateRendererUrl("http://127.0.0.1:5173")).toBe("http://127.0.0.1:5173");
    expect(validateRendererUrl("http://localhost:5173/app")).toBe("http://localhost:5173/app");
  });

  it("rejects remote, credential-bearing, and non-HTTP renderer URLs", () => {
    expect(() => validateRendererUrl("https://example.com/app")).toThrow("loopback");
    expect(() => validateRendererUrl("http://user:pass@localhost:5173")).toThrow("loopback");
    expect(() => validateRendererUrl("file:///tmp/renderer.html")).toThrow("loopback");
  });
});

describe("runDesktopMain", () => {
  afterEach(() => vi.useRealTimers());

  it("wires the injected gateway lifecycle through readiness and app shutdown", async () => {
    class FakeChild extends EventEmitter {
      pid = 8123;
      exitCode: number | null = null;
      killed = false;
      kill = vi.fn(() => true);
    }
    const child = new FakeChild();
    const listeners = new Map<string, (event?: { preventDefault(): void }) => void>();
    const show = vi.fn();
    const window = {
      show,
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      focus: vi.fn(),
    };
    const buildGatewayLaunchOptions = vi.fn((port: number) => ({
      executable: "/runtime/node.exe",
      args: ["openclaw.js", "gateway", "--port", String(port)],
      env: { UCLAW_GATEWAY_PORT: String(port) },
    }));
    const probeCapabilities = vi.fn(async () => ({
      helloOk: true,
      methods: ["chat.send", "sessions.list"],
    }));
    const registerIpc = vi.fn();

    await runDesktopMain({
      spawn: vi.fn(() => child),
      buildGatewayLaunchOptions,
      requiredMethods: ["chat.send", "sessions.list"],
      probeCapabilities,
      dispatchClient: vi.fn(),
      selectPort: vi.fn(async () => 18791),
      fetch: vi.fn(async () => ({ ok: true })),
      now: () => 0,
      sleep: vi.fn(async () => undefined),
    }, {
      app: {
        requestSingleInstanceLock: () => true,
        quit: vi.fn(),
        whenReady: vi.fn(async () => undefined),
        on: vi.fn((event: string, listener: (event?: { preventDefault(): void }) => void) => {
          listeners.set(event, listener);
        }),
      },
      createWindow: vi.fn(async (registerIpc) => {
        registerIpc(window);
        return window;
      }),
      registerIpc,
    });

    expect(buildGatewayLaunchOptions).toHaveBeenCalledWith(18791);
    expect(probeCapabilities).toHaveBeenCalledWith(18791, expect.any(AbortSignal));
    expect(show).toHaveBeenCalledOnce();
    expect(registerIpc).toHaveBeenCalledWith(window, expect.any(Function));

    listeners.get("before-quit")?.({ preventDefault: vi.fn() });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.exitCode = 0;
    child.emit("exit", 0, null);
  });

  it("times out a hanging health request and rolls back the gateway", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    class FakeChild extends EventEmitter {
      pid = 8124;
      exitCode: number | null = null;
      killed = false;
      kill = vi.fn((signal?: NodeJS.Signals | number) => {
        if (signal === "SIGTERM") {
          setTimeout(() => {
            this.exitCode = 0;
            this.emit("exit", 0, null);
          }, 1);
        }
        return true;
      });
    }
    const child = new FakeChild();
    const pending = runDesktopMain({
      spawn: () => child,
      buildGatewayLaunchOptions: () => ({ executable: "node", args: [] }),
      requiredMethods: [],
      probeCapabilities: vi.fn(),
      dispatchClient: vi.fn(),
      selectPort: async () => 18792,
      fetch: () => new Promise<never>(() => undefined),
      now: Date.now,
      sleep: vi.fn(async () => undefined),
      readinessTimeoutMs: 100,
    }, {
      app: {
        requestSingleInstanceLock: () => true,
        quit: vi.fn(),
        whenReady: vi.fn(async () => undefined),
        on: vi.fn(),
      },
      createWindow: vi.fn(),
      registerIpc: vi.fn(),
    });
    const rejected = expect(pending).rejects.toThrow("readiness timed out");

    await vi.advanceTimersByTimeAsync(101);
    await rejected;
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not create a window when the owned gateway exits during health fetch", async () => {
    class FakeChild extends EventEmitter {
      pid = 8125;
      exitCode: number | null = null;
      killed = false;
      kill = vi.fn(() => true);
    }
    const child = new FakeChild();
    const selectPort = vi.fn(async (excluded: readonly number[]) => {
      if (excluded.length > 0) throw new Error("no other candidate");
      return 18793;
    });
    const createWindow = vi.fn();

    await expect(runDesktopMain({
      spawn: vi.fn(() => child),
      buildGatewayLaunchOptions: () => ({ executable: "node", args: [] }),
      requiredMethods: [],
      probeCapabilities: vi.fn(),
      dispatchClient: vi.fn(),
      selectPort,
      fetch: vi.fn(async () => {
        child.exitCode = 1;
        child.emit("exit", 1, null);
        return { ok: true };
      }),
      now: () => 0,
      sleep: vi.fn(),
    }, {
      app: {
        requestSingleInstanceLock: () => true,
        quit: vi.fn(),
        whenReady: vi.fn(async () => undefined),
        on: vi.fn(),
      },
      createWindow,
      registerIpc: vi.fn(),
    })).rejects.toThrow("exited before readiness");

    expect(createWindow).not.toHaveBeenCalled();
    expect(selectPort.mock.calls).toEqual([[[]], [[18793]]]);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
