import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const CACHE_MARKER = ".uclaw-cache.json";
const CACHE_MARKER_VALUE = {
  schemaVersion: 1,
  product: "U-Claw",
  purpose: "rebuildable-cache",
} as const;

export const LOG_OWNERSHIP_MANIFEST = {
  version: 1,
  product: "U-Claw",
  purpose: "runtime-logs",
  files: [
    "uclaw-launcher.log", "uclaw-launcher.jsonl",
    "uclaw-desktop.log", "uclaw-desktop.jsonl",
    "uclaw-adapter.log", "uclaw-adapter.jsonl",
    "uclaw-gateway.log", "uclaw-gateway.jsonl",
    "uclaw-openclaw.log", "uclaw-openclaw.jsonl",
    "uclaw-channel.log", "uclaw-channel.jsonl",
  ],
} as const;

const PREVIOUS_LOG_OWNERSHIP_MANIFEST = {
  ...LOG_OWNERSHIP_MANIFEST,
  files: [...LOG_OWNERSHIP_MANIFEST.files, "request-trace.jsonl"],
} as const;

export function isSupportedLogOwnershipManifest(value: unknown): boolean {
  const encoded = JSON.stringify(value);
  return encoded === JSON.stringify(LOG_OWNERSHIP_MANIFEST)
    || encoded === JSON.stringify(PREVIOUS_LOG_OWNERSHIP_MANIFEST);
}

export interface PortableDesktopPaths {
  dataDir: string;
  cacheDir: string;
  userData: string;
  sessionData: string;
  electronCache: string;
  temp: string;
  logs: string;
  crashDumps: string;
  openClawState: string;
  openClawConfig: string;
  workspace: string;
}

export interface PortableElectronApp {
  setPath(name: string, path: string): void;
  commandLine: {
    appendSwitch(name: string, value: string): void;
  };
}

function isWithin(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
}

function assertSafeExistingDirectoryChain(rootDir: string, targetDir: string): void {
  if (!isWithin(rootDir, targetDir)) throw new Error("Invalid portable child path.");
  const rootInfo = lstatSync(rootDir);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Invalid portable data root.");
  let current = rootDir;
  for (const part of relative(rootDir, targetDir).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    let info: ReturnType<typeof lstatSync>;
    try { info = lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid portable child path.");
  }
}

export function resolvePortableDesktopPaths(dataDir: string, cacheDir: string): PortableDesktopPaths {
  if (
    !dataDir || !cacheDir ||
    dataDir.includes("\0") || cacheDir.includes("\0") ||
    !isAbsolute(dataDir) || !isAbsolute(cacheDir)
  ) {
    throw new Error("Invalid portable path configuration.");
  }
  const normalizedData = resolve(dataDir);
  const normalizedCache = resolve(cacheDir);
  if (isWithin(normalizedData, normalizedCache) || isWithin(normalizedCache, normalizedData)) {
    throw new Error("Invalid portable path overlap.");
  }
  const openClawState = join(normalizedData, ".openclaw");
  return {
    dataDir: normalizedData,
    cacheDir: normalizedCache,
    userData: join(normalizedData, "desktop", "user-data"),
    sessionData: join(normalizedData, "desktop", "session-data"),
    electronCache: join(normalizedCache, "electron"),
    temp: join(normalizedCache, "temp"),
    logs: join(normalizedData, "diagnostics", "desktop-logs"),
    crashDumps: join(normalizedData, "diagnostics", "crash-dumps"),
    openClawState,
    openClawConfig: join(openClawState, "openclaw.json"),
    workspace: join(normalizedData, "workspace"),
  };
}

function portableEnvironment(paths: PortableDesktopPaths): NodeJS.ProcessEnv {
  return {
    UCLAW_DATA_DIR: paths.dataDir,
    UCLAW_CACHE_DIR: paths.cacheDir,
    OPENCLAW_HOME: paths.dataDir,
    OPENCLAW_STATE_DIR: paths.openClawState,
    OPENCLAW_CONFIG_PATH: paths.openClawConfig,
    OPENCLAW_WORKSPACE_DIR: paths.workspace,
    NODE_COMPILE_CACHE: join(paths.cacheDir, "node-compile"),
    TEMP: paths.temp,
    TMP: paths.temp,
  };
}

export function applyPortableEnvironmentToLaunchOptions(
  value: unknown,
  paths: PortableDesktopPaths,
): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const launchOptions = value as Record<string, unknown>;
  const existingEnv = typeof launchOptions.env === "object" && launchOptions.env !== null && !Array.isArray(launchOptions.env)
    ? launchOptions.env as NodeJS.ProcessEnv
    : {};
  return {
    ...launchOptions,
    env: { ...existingEnv, ...portableEnvironment(paths) },
  };
}

function ensureCacheOwnership(cacheDir: string): void {
  const cacheRoot = dirname(cacheDir);
  const markerPath = join(cacheRoot, CACHE_MARKER);
  let cacheInfo: ReturnType<typeof lstatSync> | null = null;
  try {
    cacheInfo = lstatSync(cacheRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (cacheInfo === null) {
    mkdirSync(cacheRoot, { recursive: true });
    cacheInfo = lstatSync(cacheRoot);
  }
  if (!cacheInfo.isDirectory() || cacheInfo.isSymbolicLink()) {
    throw new Error("Invalid host cache root.");
  }
  let markerInfo: ReturnType<typeof lstatSync> | null = null;
  try {
    markerInfo = lstatSync(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (markerInfo !== null) {
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) throw new Error("Invalid host cache ownership marker.");
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as unknown;
    if (JSON.stringify(marker) !== JSON.stringify(CACHE_MARKER_VALUE)) {
      throw new Error("Invalid host cache ownership marker.");
    }
    return;
  }
  const descriptor = openSync(markerPath, "wx", 0o600);
  let complete = false;
  try {
    writeFileSync(descriptor, `${JSON.stringify(CACHE_MARKER_VALUE)}\n`, "utf8");
    fsyncSync(descriptor);
    complete = true;
  } finally {
    closeSync(descriptor);
    if (!complete) {
      try { unlinkSync(markerPath); } catch { /* best-effort partial marker cleanup */ }
    }
  }
}

function ensureLogOwnership(logsDir: string, dataDir: string): void {
  const logsInfo = lstatSync(logsDir);
  if (!logsInfo.isDirectory() || logsInfo.isSymbolicLink() || !isWithin(realpathSync(dataDir), realpathSync(logsDir))) throw new Error("Invalid log ownership root.");
  const markerPath = join(logsDir, ".uclaw-log-ownership.json");
  const expected = `${JSON.stringify(LOG_OWNERSHIP_MANIFEST)}\n`;
  let markerInfo: ReturnType<typeof lstatSync> | null = null;
  try { markerInfo = lstatSync(markerPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (markerInfo !== null) {
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.nlink !== 1) throw new Error("Invalid log ownership marker.");
    let marker: unknown;
    try { marker = JSON.parse(readFileSync(markerPath, "utf8")) as unknown; } catch { throw new Error("Invalid log ownership marker."); }
    if (!isSupportedLogOwnershipManifest(marker)) throw new Error("Invalid log ownership marker.");
    return;
  }
  const descriptor = openSync(markerPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  let complete = false;
  try {
    writeFileSync(descriptor, expected, "utf8");
    fsyncSync(descriptor);
    complete = true;
  } finally {
    closeSync(descriptor);
    if (!complete) try { unlinkSync(markerPath); } catch { /* best-effort partial marker cleanup */ }
  }
}

export function configurePortableDesktopPaths(
  app: PortableElectronApp,
  environment: NodeJS.ProcessEnv = process.env,
): PortableDesktopPaths {
  const paths = resolvePortableDesktopPaths(
    environment.UCLAW_DATA_DIR ?? "",
    environment.UCLAW_CACHE_DIR ?? "",
  );
  ensureCacheOwnership(paths.cacheDir);
  mkdirSync(paths.dataDir, { recursive: true });
  for (const path of [
    paths.userData,
    paths.sessionData,
    paths.electronCache,
    paths.temp,
    join(paths.cacheDir, "node-compile"),
    paths.logs,
    paths.crashDumps,
    paths.openClawState,
    paths.workspace,
  ]) {
    if (isWithin(paths.dataDir, path)) assertSafeExistingDirectoryChain(paths.dataDir, path);
    mkdirSync(path, { recursive: true });
  }
  ensureLogOwnership(paths.logs, paths.dataDir);

  for (const [name, path] of [
    ["userData", paths.userData],
    ["sessionData", paths.sessionData],
    ["temp", paths.temp],
    ["logs", paths.logs],
    ["crashDumps", paths.crashDumps],
  ] as const) {
    app.setPath(name, path);
  }
  app.commandLine.appendSwitch("disk-cache-dir", paths.electronCache);
  Object.assign(environment, portableEnvironment(paths));
  return paths;
}
