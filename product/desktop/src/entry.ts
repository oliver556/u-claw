import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

import { startActivationMain, startElectronMain, type DesktopMainOptions } from "./main.js";
import { parseStartupMode } from "./startup/mode.js";
import {
  configurePortableDesktopPaths,
  type PortableDesktopPaths,
} from "./portable-paths.js";

const WIRING_MODULE_ENV = "UCLAW_DESKTOP_WIRING_MODULE";
const DEVELOPMENT_ENV_KEYS = [
  "UCLAW_TEST_PROVIDER_BASE_URL",
  "UCLAW_TEST_PROVIDER_API_KEY",
  "UCLAW_TEST_PROVIDER_MODEL",
] as const;

export async function loadDevelopmentEnvironment(
  environment: NodeJS.ProcessEnv,
  repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
): Promise<NodeJS.ProcessEnv> {
  let parsed: NodeJS.ProcessEnv;
  try {
    parsed = parseEnv(await readFile(join(repositoryRoot, ".env"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...environment };
    throw new Error("Development environment could not be loaded.");
  }
  const selected = Object.fromEntries(DEVELOPMENT_ENV_KEYS.flatMap((key) =>
    environment[key] !== undefined ? [[key, environment[key]]] : parsed[key] === undefined ? [] : [[key, parsed[key]]]));
  return { ...environment, ...selected };
}

interface ProductionWiringModule {
  createDesktopMainOptions?: (env: NodeJS.ProcessEnv) => DesktopMainOptions | Promise<DesktopMainOptions>;
}

export async function loadProductionDesktopOptions(
  environment?: NodeJS.ProcessEnv,
): Promise<DesktopMainOptions> {
  const effectiveEnvironment = environment ?? await loadDevelopmentEnvironment(process.env);
  const modulePath = effectiveEnvironment[WIRING_MODULE_ENV];
  if (!modulePath) {
    const { createDesktopMainOptions } = await import("./wiring/create-desktop-main-options.js");
    return createDesktopMainOptions(effectiveEnvironment);
  }
  if (!isAbsolute(modulePath)) {
    throw new Error("Desktop production wiring must use an absolute path within controlled runtime roots.");
  }

  const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const allowedRoots = [desktopRoot, ...(resourcesPath ? [resourcesPath] : [])];
  const [resolvedModulePath, ...resolvedRoots] = await Promise.all([
    realpath(modulePath),
    ...allowedRoots.map((root) => realpath(root)),
  ]);
  const allowed = resolvedRoots.some((root) => {
    const childPath = relative(root, resolvedModulePath);
    return childPath !== "" && !childPath.startsWith("..") && !isAbsolute(childPath);
  });
  if (!allowed) {
    throw new Error("Desktop production wiring is outside controlled runtime roots.");
  }

  const wiring = await import(pathToFileURL(resolvedModulePath).href) as ProductionWiringModule;
  if (typeof wiring.createDesktopMainOptions !== "function") {
    throw new Error("Desktop wiring module must export createDesktopMainOptions().");
  }
  return wiring.createDesktopMainOptions(effectiveEnvironment);
}

export interface ElectronEntryDependencies {
  argv: readonly string[];
  preparePortableDesktop(): Promise<PortableDesktopPaths>;
  loadOptions(): Promise<DesktopMainOptions>;
  startActivationMain(paths: PortableDesktopPaths): Promise<void>;
  startElectronMain(options: DesktopMainOptions, paths: PortableDesktopPaths): Promise<void>;
}

export async function prepareProductionPortableDesktop(): Promise<PortableDesktopPaths> {
  const { app } = await import("electron");
  return configurePortableDesktopPaths(app, process.env);
}

export async function runElectronEntry(
  dependencies: ElectronEntryDependencies = {
    argv: process.argv,
    preparePortableDesktop: prepareProductionPortableDesktop,
    loadOptions: loadProductionDesktopOptions,
    startActivationMain,
    startElectronMain,
  },
): Promise<void> {
  const mode = parseStartupMode(dependencies.argv);
  const paths = await dependencies.preparePortableDesktop();
  if (mode === "activation-only") {
    await dependencies.startActivationMain(paths);
    return;
  }
  const options = await dependencies.loadOptions();
  await dependencies.startElectronMain(options, paths);
}

export type StartupDiagnosticCode =
  | "UNCONFIGURED"
  | "AUTH_FAILED"
  | "PROTOCOL_ERROR"
  | "UNSUPPORTED"
  | "OFFLINE";

const STARTUP_DIAGNOSTIC_CODES = new Set<StartupDiagnosticCode>([
  "UNCONFIGURED",
  "AUTH_FAILED",
  "PROTOCOL_ERROR",
  "UNSUPPORTED",
  "OFFLINE",
]);

export function startupDiagnosticCode(error: unknown): StartupDiagnosticCode {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && STARTUP_DIAGNOSTIC_CODES.has(code as StartupDiagnosticCode)) {
      return code as StartupDiagnosticCode;
    }
  }
  return "OFFLINE";
}

export interface StartupFailureDependencies {
  stderr(line: string): void;
  showErrorBox(title: string, message: string): void | Promise<void>;
  quit(): Promise<void>;
}

const STARTUP_DIAGNOSTIC_MESSAGES: Record<StartupDiagnosticCode, string> = {
  UNCONFIGURED: "桌面运行环境未配置，请检查安装与数据目录。",
  AUTH_FAILED: "OpenClaw 鉴权失败，请检查桌面运行配置。",
  PROTOCOL_ERROR: "OpenClaw 通信协议异常，请检查运行时版本。",
  UNSUPPORTED: "当前 OpenClaw 版本缺少 U-Claw 所需能力。",
  OFFLINE: "无法连接 OpenClaw 服务，请检查运行环境后重试。",
};

export async function reportStartupFailure(
  error: unknown,
  dependencies: StartupFailureDependencies = {
    stderr: (line) => console.error(line),
    showErrorBox: async (title, message) => {
      const { dialog } = await import("electron");
      dialog.showErrorBox(title, message);
    },
    quit: async () => {
      const { app } = await import("electron");
      app.quit();
    },
  },
): Promise<void> {
  process.exitCode = 1;
  const code = startupDiagnosticCode(error);
  dependencies.stderr(JSON.stringify({
    event: "desktop-startup-failed",
    code,
  }));
  try {
    await dependencies.showErrorBox(
      "U-Claw 启动失败",
      `${STARTUP_DIAGNOSTIC_MESSAGES[code]}（错误代码：${code}）`,
    );
  } catch {
    // Electron may not have initialized far enough to show a dialog.
  }
  try {
    await dependencies.quit();
  } catch {
    // Electron may not have initialized far enough to expose app.
  }
}

export function isElectronMainProcess(runtime: {
  versions: { electron?: string };
  type?: string;
}): boolean {
  return typeof runtime.versions.electron === "string" && runtime.type === "browser";
}

if (isElectronMainProcess(process as NodeJS.Process & { type?: string })) {
  void runElectronEntry().catch((error: unknown) => reportStartupFailure(error));
}
