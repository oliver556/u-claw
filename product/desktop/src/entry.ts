import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { startElectronMain, type DesktopMainOptions } from "./main.js";

const WIRING_MODULE_ENV = "UCLAW_DESKTOP_WIRING_MODULE";

interface ProductionWiringModule {
  createDesktopMainOptions?: () => DesktopMainOptions | Promise<DesktopMainOptions>;
}

export async function loadProductionDesktopOptions(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DesktopMainOptions> {
  const modulePath = environment[WIRING_MODULE_ENV];
  if (!modulePath || !isAbsolute(modulePath)) {
    throw new Error(`${WIRING_MODULE_ENV} must contain an absolute module path.`);
  }
  const wiring = await import(pathToFileURL(modulePath).href) as ProductionWiringModule;
  if (typeof wiring.createDesktopMainOptions !== "function") {
    throw new Error("Desktop wiring module must export createDesktopMainOptions().");
  }
  return wiring.createDesktopMainOptions();
}

export interface ElectronEntryDependencies {
  loadOptions(): Promise<DesktopMainOptions>;
  startElectronMain(options: DesktopMainOptions): Promise<void>;
}

export async function runElectronEntry(
  dependencies: ElectronEntryDependencies = {
    loadOptions: loadProductionDesktopOptions,
    startElectronMain,
  },
): Promise<void> {
  const options = await dependencies.loadOptions();
  await dependencies.startElectronMain(options);
}

async function reportStartupFailure(): Promise<void> {
  process.exitCode = 1;
  console.error("U-Claw desktop startup failed.");
  try {
    const { app } = await import("electron");
    app.quit();
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
  void runElectronEntry().catch(() => reportStartupFailure());
}
