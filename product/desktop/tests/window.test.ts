import { describe, expect, it, vi } from "vitest";

import { createMainWindow, type BrowserWindowOptionsLike } from "../src/window.js";

describe("createMainWindow", () => {
  it("creates a hidden frameless window with an isolated sandboxed renderer", async () => {
    const loadURL = vi.fn(async () => undefined);
    const show = vi.fn();
    const once = vi.fn((event: string, listener: () => void) => {
      if (event === "ready-to-show") listener();
    });
    let options: BrowserWindowOptionsLike | undefined;

    class FakeBrowserWindow {
      webContents = { on: vi.fn(), setWindowOpenHandler: vi.fn() };
      constructor(received: BrowserWindowOptionsLike) {
        options = received;
      }
      loadURL = loadURL;
      once = once;
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

    await createMainWindow({
      BrowserWindow: FakeBrowserWindow,
      preloadPath: "/runtime/preload.js",
      rendererUrl: "http://127.0.0.1:5173",
      openExternal: vi.fn(async () => undefined),
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
  });
});
