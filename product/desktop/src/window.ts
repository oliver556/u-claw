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
  minWidth: number;
  minHeight: number;
  webPreferences: {
    preload: string;
    contextIsolation: boolean;
    sandbox: boolean;
    nodeIntegration: boolean;
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
  showWhenReady?: boolean;
  beforeLoad?(window: DesktopWindow): (() => void) | void;
}

export async function createMainWindow({
  BrowserWindow,
  preloadPath,
  rendererUrl,
  rendererFile,
  openExternal,
  showWhenReady = true,
  beforeLoad,
}: CreateMainWindowOptions): Promise<DesktopWindow> {
  const window = new BrowserWindow({
    frame: false,
    show: false,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
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

  if (rendererUrl) {
    await window.loadURL(rendererUrl);
  } else if (rendererFile && window.loadFile) {
    await window.loadFile(rendererFile);
  } else {
    throw new Error("A renderer URL or file is required.");
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
