import { installNavigationPolicy, type WebContentsLike } from "./security/navigation-policy.js";

export interface DesktopWindow {
  webContents: WebContentsLike;
  loadURL(url: string): Promise<unknown>;
  loadFile?(path: string): Promise<unknown>;
  once(event: "ready-to-show", listener: () => void): void;
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
}

export async function createMainWindow({
  BrowserWindow,
  preloadPath,
  rendererUrl,
  rendererFile,
  openExternal,
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
  window.once("ready-to-show", () => window.show());

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
