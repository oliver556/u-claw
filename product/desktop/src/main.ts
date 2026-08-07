import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ClientIpcRequest } from "@uclaw/shared";

import { registerIpc as registerDesktopIpc } from "./ipc/register-ipc.js";
import {
  createMainWindow,
  createWindowControls,
  type BrowserWindowConstructor,
} from "./window.js";

export interface DesktopAppLike {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  whenReady(): Promise<void>;
  on(event: string, listener: (event?: { preventDefault(): void }) => void): void;
}

export interface AppWindowLike {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
}

const LOOPBACK_RENDERER_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function validateRendererUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !LOOPBACK_RENDERER_HOSTS.has(url.hostname) ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new Error();
    }
  } catch {
    throw new Error("Renderer URL must be a credential-free loopback HTTP URL.");
  }
  return value;
}

export interface BootstrapDesktopDependencies<TWindow extends AppWindowLike> {
  app: DesktopAppLike;
  createWindow(): Promise<TWindow>;
  registerIpc(window: TWindow): void;
  stopGateway?(): Promise<void> | void;
}

export async function bootstrapDesktopApp<TWindow extends AppWindowLike>({
  app,
  createWindow,
  registerIpc,
  stopGateway,
}: BootstrapDesktopDependencies<TWindow>): Promise<TWindow | null> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return null;
  }

  let window: TWindow | null = null;
  app.on("second-instance", () => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  let shutdownStarted = false;
  app.on("before-quit", (event) => {
    if (!stopGateway || shutdownStarted) return;
    event?.preventDefault();
    shutdownStarted = true;
    try {
      void Promise.resolve(stopGateway()).finally(() => app.quit());
    } catch {
      app.quit();
    }
  });
  app.on("window-all-closed", () => app.quit());

  await app.whenReady();
  window = await createWindow();
  registerIpc(window);
  return window;
}

export async function startElectronMain(): Promise<void> {
  const { app, BrowserWindow, ipcMain, shell } = await import("electron");
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  await bootstrapDesktopApp({
    app,
    createWindow: () => createMainWindow({
      BrowserWindow: BrowserWindow as unknown as BrowserWindowConstructor,
      preloadPath: join(moduleDir, "preload.js"),
      rendererUrl: validateRendererUrl(process.env.UCLAW_RENDERER_URL),
      rendererFile: join(moduleDir, "../../frontend/dist/index.html"),
      openExternal: (url) => shell.openExternal(url),
    }),
    registerIpc: (window) => registerDesktopIpc({
      ipcMain,
      windowControls: createWindowControls(window),
      dispatchClient: async (_request: ClientIpcRequest) => {
        throw {
          code: "UNAVAILABLE",
          message: "Client transport is not configured.",
          retryable: true,
          recoveryActions: ["retry"],
          causeDetails: {},
        };
      },
    }),
  });
}

if (process.versions.electron) {
  void startElectronMain().catch(() => {
    process.exitCode = 1;
  });
}
