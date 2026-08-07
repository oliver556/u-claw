import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

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
      createWindow: vi.fn(async () => ({
        isDestroyed: () => false,
        isMinimized: () => false,
        restore: vi.fn(),
        focus: vi.fn(),
      })),
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
      createWindow: vi.fn(async () => window),
      registerIpc,
    });

    expect(buildGatewayLaunchOptions).toHaveBeenCalledWith(18791);
    expect(probeCapabilities).toHaveBeenCalledWith(18791);
    expect(show).toHaveBeenCalledOnce();
    expect(registerIpc).toHaveBeenCalledWith(window, expect.any(Function));

    listeners.get("before-quit")?.({ preventDefault: vi.fn() });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.exitCode = 0;
    child.emit("exit", 0, null);
  });
});
