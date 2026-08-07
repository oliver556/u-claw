import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ClientIpcRequest } from "@uclaw/shared";

import { GatewayProcessManager, type SpawnGateway } from "./gateway/gateway-process.js";
import {
  checkGatewayHealth,
  type GatewayCapabilityProbeResult,
  type GatewayHealthDependencies,
} from "./gateway/health-check.js";
import { selectGatewayPort } from "./gateway/port-selector.js";
import { startGatewayAndCreateWindow, type ShowableWindow } from "./gateway/startup.js";
import type { IpcMainLike } from "./ipc/register-ipc.js";
import { registerIpc as registerDesktopIpc } from "./ipc/register-ipc.js";
import {
  createMainWindow,
  createWindowControls,
  type BrowserWindowConstructor,
  type DesktopWindow,
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
  createWindow(registerIpc: (window: TWindow) => (() => void) | void): Promise<TWindow>;
  registerIpc(window: TWindow): (() => void) | void;
  stopGateway(): Promise<void> | void;
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
  let cleanupDone = false;
  app.on("before-quit", (event) => {
    if (cleanupDone) return;
    event?.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    try {
      void Promise.resolve(stopGateway()).then(
        () => {
          cleanupDone = true;
          app.quit();
        },
        () => {
          cleanupDone = true;
          app.quit();
        },
      );
    } catch {
      cleanupDone = true;
      app.quit();
    }
  });
  app.on("window-all-closed", () => app.quit());

  try {
    await app.whenReady();
    window = await createWindow(registerIpc);
    return window;
  } catch (error) {
    try {
      await stopGateway();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Desktop startup failed and gateway cleanup failed.",
        { cause: error },
      );
    }
    throw error;
  }
}

export interface DesktopMainOptions {
  spawn: SpawnGateway;
  buildGatewayLaunchOptions(port: number): unknown;
  requiredMethods: readonly string[];
  probeCapabilities(port: number, signal: AbortSignal): Promise<GatewayCapabilityProbeResult>;
  dispatchClient(request: ClientIpcRequest): Promise<unknown>;
  selectPort?(excludedPorts: readonly number[]): Promise<number>;
  fetch?: GatewayHealthDependencies["fetch"];
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  readinessTimeoutMs?: number;
  readinessPollIntervalMs?: number;
  gatewayStopTimeoutMs?: number;
  gatewayKillTimeoutMs?: number;
}

export interface DesktopMainRuntime<TWindow extends AppWindowLike & ShowableWindow> {
  app: DesktopAppLike;
  createWindow(registerIpc: (window: TWindow) => (() => void) | void): Promise<TWindow>;
  registerIpc(window: TWindow, dispatchClient: DesktopMainOptions["dispatchClient"]): () => void;
}

const defaultSleep = (milliseconds: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

export async function runDesktopMain<TWindow extends AppWindowLike & ShowableWindow>(
  options: DesktopMainOptions,
  runtime: DesktopMainRuntime<TWindow>,
): Promise<TWindow | null> {
  const gatewayProcess = new GatewayProcessManager({
    spawn: options.spawn,
    stopTimeoutMs: options.gatewayStopTimeoutMs,
    killTimeoutMs: options.gatewayKillTimeoutMs,
  });
  const fetchHealth = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const now = options.now ?? Date.now;
  const stopGateway = (): Promise<void> => gatewayProcess.stop();

  return bootstrapDesktopApp({
    app: runtime.app,
    stopGateway,
    createWindow: async (registerIpc) => {
      const started = await startGatewayAndCreateWindow({
        selectPort: options.selectPort ?? ((excludedPorts) => selectGatewayPort({ excludedPorts })),
        gatewayProcess: {
          start: (launchOptions) => gatewayProcess.start(launchOptions),
          stop: stopGateway,
        },
        buildLaunchOptions: options.buildGatewayLaunchOptions,
        checkHealth: (port, deadlineMs, identity) => checkGatewayHealth({
          isProcessAlive: () =>
            gatewayProcess.getOwnedPid() === identity.pid &&
            gatewayProcess.getOwnedInstanceId() === identity.instanceId,
          baseUrl: `http://127.0.0.1:${port}`,
          fetch: fetchHealth,
          now,
          deadlineMs,
          requiredMethods: options.requiredMethods,
          probeCapabilities: (signal) => options.probeCapabilities(port, signal),
        }),
        now,
        sleep: options.sleep ?? defaultSleep,
        timeoutMs: options.readinessTimeoutMs ?? 30_000,
        pollIntervalMs: options.readinessPollIntervalMs ?? 250,
        createWindow: () => runtime.createWindow(registerIpc),
      });
      return started.window;
    },
    registerIpc: (window) => runtime.registerIpc(window, options.dispatchClient),
  });
}

export function resolvePreloadPath(moduleDir: string): string {
  return join(moduleDir, "preload.cjs");
}

export async function startElectronMain(options: DesktopMainOptions): Promise<void> {
  const { app, BrowserWindow, ipcMain, shell } = await import("electron");
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  await runDesktopMain<DesktopWindow>(options, {
    app,
    createWindow: (registerIpc) => createMainWindow({
      BrowserWindow: BrowserWindow as unknown as BrowserWindowConstructor,
      preloadPath: resolvePreloadPath(moduleDir),
      rendererUrl: validateRendererUrl(process.env.UCLAW_RENDERER_URL),
      rendererFile: join(moduleDir, "../../frontend/dist/index.html"),
      openExternal: (url) => shell.openExternal(url),
      showWhenReady: false,
      beforeLoad: registerIpc,
    }),
    registerIpc: (window, dispatchClient) => registerDesktopIpc({
      ipcMain: ipcMain as unknown as IpcMainLike,
      authorizedWebContents: window.webContents,
      windowControls: createWindowControls(window),
      dispatchClient,
    }),
  });
}
