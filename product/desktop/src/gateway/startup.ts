import type { GatewayLaunchOptions } from "./gateway-process.js";
import type { GatewayHealthStatus } from "./health-check.js";
import { GATEWAY_PORT_MAX, GATEWAY_PORT_MIN } from "./port-selector.js";

export interface GatewayProcessController {
  start(options: GatewayLaunchOptions): number;
  stop(): Promise<void>;
}

export interface ShowableWindow {
  show(): void;
}

export interface GatewayStartupDependencies<TWindow extends ShowableWindow> {
  selectPort(): Promise<number>;
  gatewayProcess: GatewayProcessController;
  buildLaunchOptions(port: number): unknown;
  checkHealth(port: number): Promise<GatewayHealthStatus>;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  timeoutMs: number;
  pollIntervalMs: number;
  createWindow(): Promise<TWindow>;
}

export interface GatewayStartupResult<TWindow extends ShowableWindow> {
  window: TWindow;
  port: number;
  pid: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateGatewayLaunchOptions(value: unknown): GatewayLaunchOptions {
  if (!isRecord(value)) throw new Error("Invalid gateway launch options.");
  const { executable, args, cwd, env } = value;
  if (typeof executable !== "string" || executable.trim() === "") {
    throw new Error("Invalid gateway launch options: executable is required.");
  }
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string" && arg.length > 0)) {
    throw new Error("Invalid gateway launch options: args must be a string array.");
  }
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.trim() === "")) {
    throw new Error("Invalid gateway launch options: cwd must be a non-empty string.");
  }
  if (env !== undefined && (
    !isRecord(env) ||
    !Object.entries(env).every(([key, entry]) => key.trim() !== "" && typeof entry === "string")
  )) {
    throw new Error("Invalid gateway launch options: env must contain string values.");
  }

  return {
    executable,
    args: [...args] as string[],
    ...(cwd === undefined ? {} : { cwd: cwd as string }),
    ...(env === undefined ? {} : { env: { ...env } as NodeJS.ProcessEnv }),
  };
}

async function waitForGatewayReadiness(
  options: Pick<GatewayStartupDependencies<ShowableWindow>,
    "checkHealth" | "now" | "sleep" | "timeoutMs" | "pollIntervalMs">,
  port: number,
): Promise<void> {
  if (options.timeoutMs <= 0 || options.pollIntervalMs < 0) {
    throw new Error("Invalid gateway readiness timing options.");
  }
  const deadline = options.now() + options.timeoutMs;

  while (true) {
    const status = await options.checkHealth(port);
    if (!status.processAlive) throw new Error("Gateway process exited before readiness.");
    if (status.serviceReady && status.businessAvailable) return;
    if (options.now() >= deadline) throw new Error("Gateway readiness timed out.");
    await options.sleep(options.pollIntervalMs);
  }
}

export async function startGatewayAndCreateWindow<TWindow extends ShowableWindow>(
  options: GatewayStartupDependencies<TWindow>,
): Promise<GatewayStartupResult<TWindow>> {
  const port = await options.selectPort();
  if (!Number.isInteger(port) || port < GATEWAY_PORT_MIN || port > GATEWAY_PORT_MAX) {
    throw new Error(`Gateway port must be within ${GATEWAY_PORT_MIN}-${GATEWAY_PORT_MAX}.`);
  }
  const launchOptions = validateGatewayLaunchOptions(options.buildLaunchOptions(port));
  const pid = options.gatewayProcess.start(launchOptions);

  try {
    await waitForGatewayReadiness(options, port);
    const window = await options.createWindow();
    window.show();
    return { window, port, pid };
  } catch (error) {
    await options.gatewayProcess.stop();
    throw error;
  }
}
