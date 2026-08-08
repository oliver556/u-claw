import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { UClawErrorSchema, type AttachmentImportInput, type AttachmentService, type ClientIpcRequest, type UClawClient } from "@uclaw/shared";

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
  createAdvancedConsoleController,
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
  abortStartup?(): void;
  startupSignal?: AbortSignal;
}

export async function bootstrapDesktopApp<TWindow extends AppWindowLike>({
  app,
  createWindow,
  registerIpc,
  stopGateway,
  abortStartup,
  startupSignal,
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
    abortStartup?.();
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
    if (startupSignal?.aborted) return null;
    throw error;
  }
}

export interface DesktopMainOptions {
  spawn: SpawnGateway;
  buildGatewayLaunchOptions(port: number): unknown;
  requiredMethods: readonly string[];
  probeCapabilities(port: number, signal: AbortSignal): Promise<GatewayCapabilityProbeResult>;
  dispatchClient(request: ClientIpcRequest): Promise<unknown>;
  client?: UClawClient;
  attachments?: AttachmentService;
  selectAttachments?(): Promise<AttachmentImportInput[]>;
  selectPort?(excludedPorts: readonly number[], signal: AbortSignal): Promise<number>;
  fetch?: GatewayHealthDependencies["fetch"];
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readinessTimeoutMs?: number;
  readinessPollIntervalMs?: number;
  gatewayStopTimeoutMs?: number;
  gatewayKillTimeoutMs?: number;
}

export interface DesktopMainRuntime<TWindow extends AppWindowLike & ShowableWindow> {
  app: DesktopAppLike;
  createWindow(
    registerIpc: (window: TWindow) => (() => void) | void,
    signal: AbortSignal,
  ): Promise<TWindow>;
  registerIpc(window: TWindow, dispatchClient: DesktopMainOptions["dispatchClient"]): () => void;
}

const defaultSleep = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      cleanup();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
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
  const startupController = new AbortController();
  const stopGateway = (): Promise<void> => gatewayProcess.stop();

  return bootstrapDesktopApp({
    app: runtime.app,
    stopGateway,
    abortStartup: () => startupController.abort(new DOMException("Desktop shutdown requested.", "AbortError")),
    startupSignal: startupController.signal,
    createWindow: async (registerIpc) => {
      const started = await startGatewayAndCreateWindow({
        selectPort: options.selectPort ?? ((excludedPorts) => selectGatewayPort({ excludedPorts })),
        gatewayProcess: {
          start: (launchOptions) => gatewayProcess.start(launchOptions),
          stop: stopGateway,
        },
        buildLaunchOptions: options.buildGatewayLaunchOptions,
        checkHealth: (port, deadlineMs, identity, signal) => checkGatewayHealth({
          isProcessAlive: () =>
            gatewayProcess.getOwnedPid() === identity.pid &&
            gatewayProcess.getOwnedInstanceId() === identity.instanceId,
          baseUrl: `http://127.0.0.1:${port}`,
          fetch: fetchHealth,
          now,
          deadlineMs,
          signal,
          requiredMethods: options.requiredMethods,
          probeCapabilities: (signal) => options.probeCapabilities(port, signal),
        }),
        now,
        sleep: options.sleep ?? defaultSleep,
        timeoutMs: options.readinessTimeoutMs ?? 30_000,
        pollIntervalMs: options.readinessPollIntervalMs ?? 250,
        createWindow: (signal) => runtime.createWindow(registerIpc, signal),
        signal: startupController.signal,
      });
      return started.window;
    },
    registerIpc: (window) => runtime.registerIpc(window, options.dispatchClient),
  });
}

export function resolvePreloadPath(moduleDir: string): string {
  return join(moduleDir, "preload.cjs");
}

export function requireElectronClient(client: UClawClient | undefined): UClawClient {
  if (!client) throw new Error("Desktop production wiring must provide a real UClawClient.");
  return client;
}

const ATTACHMENT_MEDIA_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain",
  ".webp": "image/webp",
};

export async function readSelectedAttachments(
  paths: readonly string[],
  maxBytes = 10 * 1024 * 1024,
): Promise<AttachmentImportInput[]> {
  return Promise.all(paths.map(async (path) => {
    const info = await stat(path);
    if (!info.isFile()) throw UClawErrorSchema.parse({ code: "INVALID_ARGUMENT", message: "选择项不是文件。", retryable: false });
    if (info.size > maxBytes) throw UClawErrorSchema.parse({ code: "FILE_TOO_LARGE", message: `附件超过大小限制（${info.size} > ${maxBytes} bytes）。`, retryable: false });
    const content = await readFile(path);
    return {
      name: basename(path),
      mediaType: ATTACHMENT_MEDIA_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
      size: content.byteLength,
      contentBase64: content.toString("base64"),
    };
  }));
}

export async function startElectronMain(options: DesktopMainOptions): Promise<void> {
  const { app, BrowserWindow, dialog, ipcMain, shell } = await import("electron");
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const client = requireElectronClient(options.client);
  const attachments = options.attachments ?? client.attachments;
  let gatewayPort: number | undefined;
  const openAdvancedConsole = createAdvancedConsoleController({
    BrowserWindow: BrowserWindow as unknown as BrowserWindowConstructor,
    getGatewayPort: () => {
      if (gatewayPort === undefined) throw new Error("Gateway port is unavailable.");
      return gatewayPort;
    },
    openExternal: (url) => shell.openExternal(url),
  });
  const runtimeOptions: DesktopMainOptions = {
    ...options,
    buildGatewayLaunchOptions: (port) => {
      gatewayPort = port;
      return options.buildGatewayLaunchOptions(port);
    },
  };
  await runDesktopMain<DesktopWindow>(runtimeOptions, {
    app,
    createWindow: (registerIpc, signal) => {
      signal.throwIfAborted();
      return createMainWindow({
        BrowserWindow: BrowserWindow as unknown as BrowserWindowConstructor,
        preloadPath: resolvePreloadPath(moduleDir),
        rendererUrl: validateRendererUrl(process.env.UCLAW_RENDERER_URL),
        rendererFile: join(moduleDir, "../../frontend/dist/index.html"),
        openExternal: (url) => shell.openExternal(url),
        showWhenReady: false,
        beforeLoad: registerIpc,
      });
    },
    registerIpc: (window, dispatchClient) => registerDesktopIpc({
      ipcMain: ipcMain as unknown as IpcMainLike,
      authorizedWebContents: window.webContents,
      windowControls: {
        ...createWindowControls(window),
        openAdvancedConsole,
      },
      dispatchClient,
      client,
      attachments,
      selectAttachments: options.selectAttachments ?? (attachments === undefined ? undefined : async () => {
        const selected = await dialog.showOpenDialog({
          properties: ["openFile", "multiSelections"],
          filters: [{ name: "Supported attachments", extensions: ["png", "jpg", "jpeg", "gif", "webp", "txt", "pdf"] }],
        });
        return selected.canceled ? [] : readSelectedAttachments(selected.filePaths);
      }),
    }),
  });
}
