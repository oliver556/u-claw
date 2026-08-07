import { describe, expect, it, vi } from "vitest";

import { WINDOW_MAXIMIZED_EVENT_CHANNEL } from "../src/ipc/channels.js";
import { createAdvancedConsoleController, createAdvancedConsoleWindow, createMainWindow, type BrowserWindowOptionsLike } from "../src/window.js";

describe("createMainWindow", () => {
  it("opens advanced console in a separate isolated window at a fixed loopback URL", async () => {
    const loadURL = vi.fn(async () => undefined);
    let options: BrowserWindowOptionsLike | undefined;
    class ConsoleWindow {
      webContents = { mainFrame: {}, on: vi.fn(), setWindowOpenHandler: vi.fn(), send: vi.fn() };
      constructor(received: BrowserWindowOptionsLike) { options = received; }
      loadURL = loadURL; once = vi.fn((event: string, listener: () => void) => { if (event === "ready-to-show") listener(); });
      on = vi.fn(); show = vi.fn(); minimize = vi.fn(); maximize = vi.fn(); unmaximize = vi.fn(); isMaximized = vi.fn(() => false);
      close = vi.fn(); isDestroyed = vi.fn(() => false); isMinimized = vi.fn(() => false); restore = vi.fn(); focus = vi.fn();
    }

    await createAdvancedConsoleWindow({ BrowserWindow: ConsoleWindow, gatewayPort: 18789, openExternal: vi.fn(async () => undefined) });

    expect(loadURL).toHaveBeenCalledWith("http://127.0.0.1:18789/");
    expect(options).toMatchObject({ frame: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
    await expect(createAdvancedConsoleWindow({ BrowserWindow: ConsoleWindow, gatewayPort: 0, openExternal: vi.fn() })).rejects.toThrow();
  });
  it("holds and reuses the advanced console window until it closes", async () => {
    const instances: Array<{ closed?: () => void; focus: ReturnType<typeof vi.fn>; destroyed: boolean }> = [];
    class ConsoleWindow {
      state: { closed?: () => void; focus: ReturnType<typeof vi.fn>; destroyed: boolean } = { focus: vi.fn(), destroyed: false };
      webContents = { mainFrame: {}, on: vi.fn(), setWindowOpenHandler: vi.fn(), send: vi.fn() };
      constructor(_options: BrowserWindowOptionsLike) { instances.push(this.state); }
      loadURL = vi.fn(async () => undefined);
      once = vi.fn((event: string, listener: () => void) => { if (event === "ready-to-show") listener(); else this.state.closed = listener; });
      on = vi.fn(); show = vi.fn(); minimize = vi.fn(); maximize = vi.fn(); unmaximize = vi.fn(); isMaximized = vi.fn(() => false);
      close = vi.fn(); isDestroyed = () => this.state.destroyed; isMinimized = vi.fn(() => false); restore = vi.fn(); focus = this.state.focus;
    }
    const open = createAdvancedConsoleController({
      BrowserWindow: ConsoleWindow,
      getGatewayPort: () => 18789,
      openExternal: vi.fn(async () => undefined),
    });

    await open();
    await open();
    expect(instances).toHaveLength(1);
    expect(instances[0]?.focus).toHaveBeenCalledOnce();
    instances[0]!.destroyed = true;
    instances[0]?.closed?.();
    await open();
    expect(instances).toHaveLength(2);
  });
  it("creates a hidden frameless window with an isolated sandboxed renderer", async () => {
    const loadURL = vi.fn(async (_url: string) => undefined);
    const show = vi.fn();
    const send = vi.fn();
    const windowListeners = new Map<string, () => void>();
    const order: string[] = [];
    const webContentsListeners = new Map<string, (...args: unknown[]) => void>();
    const once = vi.fn((event: string, listener: () => void) => {
      if (event === "ready-to-show") listener();
      else windowListeners.set(event, listener);
    });
    let options: BrowserWindowOptionsLike | undefined;

    class FakeBrowserWindow {
      webContents = {
        mainFrame: {},
        on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
          webContentsListeners.set(event, listener);
        }),
        setWindowOpenHandler: vi.fn(),
        send,
      };
      constructor(received: BrowserWindowOptionsLike) {
        options = received;
      }
      loadURL = vi.fn(async (url: string) => {
        order.push(`load:${url}`);
        return loadURL(url);
      });
      once = once;
      on = vi.fn((event: string, listener: () => void) => windowListeners.set(event, listener));
      show = show;
      minimize = vi.fn();
      maximize = vi.fn();
      unmaximize = vi.fn();
      isMaximized = vi.fn(() => false);
      close = vi.fn();
      isDestroyed = vi.fn(() => false);
      isMinimized = vi.fn(() => false);
      restore = vi.fn();
      focus = vi.fn();
    }

    const disposeIpc = vi.fn();
    await createMainWindow({
      BrowserWindow: FakeBrowserWindow,
      preloadPath: "/runtime/preload.js",
      rendererUrl: "http://127.0.0.1:5173",
      openExternal: vi.fn(async () => undefined),
      beforeLoad: (window) => {
        order.push("register-ipc");
        expect(window.webContents).toBeDefined();
        return disposeIpc;
      },
    });

    expect(options).toMatchObject({
      frame: false,
      show: false,
      minWidth: 960,
      minHeight: 640,
      webPreferences: {
        preload: "/runtime/preload.js",
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    expect(loadURL).toHaveBeenCalledWith("http://127.0.0.1:5173");
    expect(show).toHaveBeenCalledOnce();
    expect(order).toEqual(["register-ipc", "load:http://127.0.0.1:5173"]);

    windowListeners.get("closed")?.();
    expect(disposeIpc).toHaveBeenCalledOnce();

    webContentsListeners.get("did-finish-load")?.();
    windowListeners.get("maximize")?.();
    windowListeners.get("unmaximize")?.();
    expect(send.mock.calls).toEqual([
      [WINDOW_MAXIMIZED_EVENT_CHANNEL, false],
      [WINDOW_MAXIMIZED_EVENT_CHANNEL, true],
      [WINDOW_MAXIMIZED_EVENT_CHANNEL, false],
    ]);
  });
});
