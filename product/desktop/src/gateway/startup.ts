import type { GatewayLaunchOptions, GatewayProcessIdentity } from "./gateway-process.js";
import type { GatewayHealthStatus } from "./health-check.js";
import { GATEWAY_PORT_MAX, GATEWAY_PORT_MIN } from "./port-selector.js";

export interface GatewayProcessController {
  start(options: GatewayLaunchOptions): GatewayProcessIdentity;
  stop(): Promise<void>;
}

export interface ShowableWindow {
  show(): void;
}

export interface GatewayStartupDependencies<TWindow extends ShowableWindow> {
  selectPort(excludedPorts: readonly number[], signal: AbortSignal): Promise<number>;
  gatewayProcess: GatewayProcessController;
  buildLaunchOptions(port: number): unknown;
  checkHealth(
    port: number,
    deadlineMs: number,
    identity: GatewayProcessIdentity,
    signal: AbortSignal,
  ): Promise<GatewayHealthStatus>;
  now(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
  timeoutMs: number;
  pollIntervalMs: number;
  createWindow(signal: AbortSignal): Promise<TWindow>;
  signal: AbortSignal;
}

export interface GatewayStartupResult<TWindow extends ShowableWindow> {
  window: TWindow;
  port: number;
  pid: number;
  instanceId: number;
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

export async function waitForGatewayReadiness(
  options: Pick<GatewayStartupDependencies<ShowableWindow>,
    "checkHealth" | "now" | "sleep" | "timeoutMs" | "pollIntervalMs" | "signal">,
  port: number,
  identity: GatewayProcessIdentity,
): Promise<void> {
  if (options.timeoutMs <= 0 || options.pollIntervalMs < 0) {
    throw new Error("Invalid gateway readiness timing options.");
  }
  const deadline = options.now() + options.timeoutMs;

  while (true) {
    options.signal.throwIfAborted();
    const status = await options.checkHealth(port, deadline, identity, options.signal);
    options.signal.throwIfAborted();
    if (!status.processAlive) throw new Error("Gateway process exited before readiness.");
    if (status.serviceReady && status.businessAvailable) return;
    if (options.now() >= deadline) throw new Error("Gateway readiness timed out.");
    await raceWithAbort(options.sleep(options.pollIntervalMs, options.signal), options.signal);
  }
}

export async function startGatewayAndCreateWindow<TWindow extends ShowableWindow>(
  options: GatewayStartupDependencies<TWindow>,
): Promise<GatewayStartupResult<TWindow>> {
  const excludedPorts: number[] = [];
  let lastPortRaceError: unknown;

  while (excludedPorts.length <= GATEWAY_PORT_MAX - GATEWAY_PORT_MIN) {
    options.signal.throwIfAborted();
    let port: number;
    try {
      port = await raceWithAbort(
        options.selectPort([...excludedPorts], options.signal),
        options.signal,
      );
    } catch (error) {
      if (options.signal.aborted) throw options.signal.reason;
      throw lastPortRaceError ?? error;
    }
    if (excludedPorts.includes(port)) throw lastPortRaceError;
    if (!Number.isInteger(port) || port < GATEWAY_PORT_MIN || port > GATEWAY_PORT_MAX) {
      throw new Error(`Gateway port must be within ${GATEWAY_PORT_MIN}-${GATEWAY_PORT_MAX}.`);
    }
    const launchOptions = validateGatewayLaunchOptions(options.buildLaunchOptions(port));
    options.signal.throwIfAborted();
    let identity: GatewayProcessIdentity;
    try {
      identity = options.gatewayProcess.start(launchOptions);
    } catch (error) {
      if (options.signal.aborted || !isAddressInUseError(error)) throw error;
      excludedPorts.push(port);
      lastPortRaceError = error;
      continue;
    }

    try {
      await waitForGatewayReadiness(options, port, identity);
      options.signal.throwIfAborted();
      const window = await options.createWindow(options.signal);
      options.signal.throwIfAborted();
      window.show();
      return { window, port, ...identity };
    } catch (error) {
      await rollbackOrThrow(error, () => options.gatewayProcess.stop());
      throw error;
    }
  }

  throw lastPortRaceError ?? new Error("Gateway startup failed.");
}

function isAddressInUseError(error: unknown, seen = new Set<object>()): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (seen.has(error)) return false;
  seen.add(error);
  if ("code" in error && (error as { code?: unknown }).code === "EADDRINUSE") return true;
  return "cause" in error && isAddressInUseError((error as { cause?: unknown }).cause, seen);
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function rollbackOrThrow(error: unknown, stop: () => Promise<void>): Promise<void> {
  try {
    await stop();
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      "Gateway startup failed and cleanup failed.",
      { cause: error },
    );
  }
}
