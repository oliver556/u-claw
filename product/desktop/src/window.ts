import { installNavigationPolicy, type WebContentsLike } from "./security/navigation-policy.js";
import { WINDOW_MAXIMIZED_EVENT_CHANNEL } from "./ipc/channels.js";

export interface DesktopWebContents extends WebContentsLike {
  mainFrame: unknown;
  on(event: "will-navigate", listener: Parameters<WebContentsLike["on"]>[1]): void;
  on(event: "did-finish-load", listener: () => void): void;
  send(channel: string, payload: unknown): void;
}

export interface DesktopWindow {
  webContents: DesktopWebContents;
  loadURL(url: string): Promise<unknown>;
  loadFile?(path: string): Promise<unknown>;
  once(event: "ready-to-show", listener: () => void): void;
  once(event: "closed", listener: () => void): void;
  on(event: "maximize" | "unmaximize", listener: () => void): void;
  show(): void;
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  isMaximized(): boolean;
  close(): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
}

export interface BrowserWindowOptionsLike {
  frame: boolean;
  show: boolean;
  width?: number;
  height?: number;
  minWidth: number;
  minHeight: number;
  backgroundColor?: string;
  webPreferences: {
    preload?: string;
    contextIsolation: boolean;
    sandbox: boolean;
    nodeIntegration: boolean;
    devTools: boolean;
  };
}

export interface BrowserWindowConstructor {
  new(options: BrowserWindowOptionsLike): DesktopWindow;
}

export interface CreateMainWindowOptions {
  BrowserWindow: BrowserWindowConstructor;
  preloadPath: string;
  rendererUrl?: string;
  rendererFile?: string;
  openExternal(url: string): Promise<unknown>;
  devTools?: boolean;
  showWhenReady?: boolean;
  beforeLoad?(window: DesktopWindow): (() => void) | void;
}

export interface CreateAdvancedConsoleWindowOptions {
  BrowserWindow: BrowserWindowConstructor;
  gatewayPort: number;
  openExternal(url: string): Promise<unknown>;
  devTools?: boolean;
}

export interface CreateAdvancedConsoleControllerOptions {
  BrowserWindow: BrowserWindowConstructor;
  getGatewayPort(): number;
  openExternal(url: string): Promise<unknown>;
  devTools?: boolean;
}

export function createAdvancedConsoleController({
  BrowserWindow,
  getGatewayPort,
  openExternal,
  devTools = true,
}: CreateAdvancedConsoleControllerOptions): () => Promise<void> {
  let current: DesktopWindow | undefined;
  let pending: Promise<DesktopWindow> | undefined;
  return async () => {
    if (current && !current.isDestroyed()) {
      if (current.isMinimized()) current.restore();
      current.focus();
      return;
    }
    if (pending) {
      const created = await pending;
      if (!created.isDestroyed()) created.focus();
      return;
    }
    const creating = createAdvancedConsoleWindow({ BrowserWindow, gatewayPort: getGatewayPort(), openExternal, devTools });
    pending = creating;
    let created: DesktopWindow;
    try {
      created = await creating;
    } finally {
      if (pending === creating) pending = undefined;
    }
    current = created;
    created.once("closed", () => {
      if (current === created) current = undefined;
    });
  };
}

export async function createAdvancedConsoleWindow({
  BrowserWindow,
  gatewayPort,
  openExternal,
  devTools = true,
}: CreateAdvancedConsoleWindowOptions): Promise<DesktopWindow> {
  if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65_535) {
    throw new Error("Advanced console Gateway port is invalid.");
  }
  const url = new URL(`http://127.0.0.1:${gatewayPort}/`);
  const window = new BrowserWindow({
    frame: true,
    show: false,
    minWidth: 800,
    minHeight: 600,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, devTools },
  });
  installNavigationPolicy({
    webContents: window.webContents,
    openExternal,
    allowedNavigationOrigins: [url.origin],
  });
  window.once("ready-to-show", () => window.show());
  try {
    await window.loadURL(url.href);
  } catch (error) {
    window.close();
    throw error;
  }
  return window;
}

export async function createMainWindow({
  BrowserWindow,
  preloadPath,
  rendererUrl,
  rendererFile,
  openExternal,
  devTools = true,
  showWhenReady = true,
  beforeLoad,
}: CreateMainWindowOptions): Promise<DesktopWindow> {
  const window = new BrowserWindow({
    frame: false,
    show: false,
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#141414",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools,
    },
  });

  installNavigationPolicy({ webContents: window.webContents, openExternal });
  const sendMaximized = (maximized: boolean): void => {
    window.webContents.send(WINDOW_MAXIMIZED_EVENT_CHANNEL, maximized);
  };
  window.webContents.on("did-finish-load", () => sendMaximized(window.isMaximized()));
  window.on("maximize", () => sendMaximized(true));
  window.on("unmaximize", () => sendMaximized(false));
  if (showWhenReady) window.once("ready-to-show", () => window.show());
  const dispose = beforeLoad?.(window);
  if (dispose) window.once("closed", dispose);

  try {
    if (rendererUrl) {
      await window.loadURL(rendererUrl);
    } else if (rendererFile && window.loadFile) {
      await window.loadFile(rendererFile);
    } else {
      throw new Error("A renderer URL or file is required.");
    }
  } catch (error) {
    if (!window.isDestroyed()) window.close();
    throw error;
  }

  return window;
}

export function createWindowControls(window: DesktopWindow) {
  return {
    minimize: () => window.minimize(),
    toggleMaximize: () => {
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
    },
    close: () => window.close(),
  };
}
