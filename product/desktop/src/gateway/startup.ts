import type { GatewayLaunchOptions, GatewayProcessIdentity, GatewayStopReason } from "./gateway-process.js";
import type { GatewayHealthStatus } from "./health-check.js";
import { GATEWAY_PORT_MAX, GATEWAY_PORT_MIN } from "./port-selector.js";

export interface GatewayProcessController {
  start(options: GatewayLaunchOptions): GatewayProcessIdentity;
  stop(reason?: GatewayStopReason): Promise<void>;
  setPort?(port: number): void;
  markHealthReady?(identity: GatewayProcessIdentity): void;
  markCapabilityReady?(identity: GatewayProcessIdentity): void;
  markStartupFailed?(identity: GatewayProcessIdentity): void;
}

export interface ShowableWindow {
  show(): void;
}

export interface GatewayStartupDependencies<TWindow extends ShowableWindow> {
  attemptId?: string;
  releaseId?: string;
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
  onCapabilityState?(state: GatewayCapabilityState): void;
  keepShellOnGatewayFailure?: boolean;
}

export type GatewayCapabilityState = "full" | "partial" | "local-only" | "blocked";

export interface GatewayStartupResult<TWindow extends ShowableWindow> {
  window: TWindow;
  port: number;
  pid?: number;
  instanceId?: number;
  attemptId?: string;
  releaseId?: string;
  capabilityState: GatewayCapabilityState;
}

interface ActiveGatewayAttempt {
  attemptId: string;
  shell: ActiveShell;
  result: Promise<GatewayStartupResult<ShowableWindow>>;
}

interface ActiveShell {
  window?: Promise<ShowableWindow>;
}

const activeAttempts = new WeakMap<GatewayProcessController, ActiveGatewayAttempt>();

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
  onHealthReady?: () => void,
): Promise<void> {
  if (options.timeoutMs <= 0 || options.pollIntervalMs < 0) {
    throw new Error("Invalid gateway readiness timing options.");
  }
  const deadline = options.now() + options.timeoutMs;
  let healthReady = false;

  while (true) {
    options.signal.throwIfAborted();
    const status = await options.checkHealth(port, deadline, identity, options.signal);
    options.signal.throwIfAborted();
    if (!status.processAlive) throw new Error("Gateway process exited before readiness.");
    if (status.serviceReady && !healthReady) {
      healthReady = true;
      onHealthReady?.();
    }
    if (status.serviceReady && status.businessAvailable) return;
    if (options.now() >= deadline) throw new Error("Gateway readiness timed out.");
    await raceWithAbort(options.sleep(options.pollIntervalMs, options.signal), options.signal);
  }
}

export async function startGatewayAndCreateWindow<TWindow extends ShowableWindow>(
  options: GatewayStartupDependencies<TWindow>,
): Promise<GatewayStartupResult<TWindow>> {
  if (options.attemptId === undefined) {
    return startGatewayAttempt(options, {});
  }

  const active = activeAttempts.get(options.gatewayProcess);
  if (active?.attemptId === options.attemptId) {
    return active.result as Promise<GatewayStartupResult<TWindow>>;
  }

  const shell = active?.shell ?? {};
  const result: Promise<GatewayStartupResult<TWindow>> = (async () => {
    if (active) {
      await active.result.catch(() => undefined);
      await options.gatewayProcess.stop("manual-restart");
    }
    return startGatewayAttempt(options, shell);
  })();
  activeAttempts.set(options.gatewayProcess, {
    attemptId: options.attemptId,
    shell,
    result: result as Promise<GatewayStartupResult<ShowableWindow>>,
  });
  return result;
}

async function startGatewayAttempt<TWindow extends ShowableWindow>(
  options: GatewayStartupDependencies<TWindow>,
  shell: ActiveShell,
): Promise<GatewayStartupResult<TWindow>> {
  options.signal.throwIfAborted();

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
    shell.window ??= createAndShowShell(options);
    const window = await shell.window as TWindow;
    options.onCapabilityState?.("local-only");
    options.gatewayProcess.setPort?.(port);
    options.signal.throwIfAborted();
    let identity: GatewayProcessIdentity;
    try {
      identity = options.gatewayProcess.start({
        ...launchOptions,
        ...(options.attemptId === undefined ? {} : { attemptId: options.attemptId }),
        ...(options.releaseId === undefined ? {} : { releaseId: options.releaseId }),
      });
    } catch (error) {
      if (options.signal.aborted || !isAddressInUseError(error)) {
        if (!options.keepShellOnGatewayFailure) throw error;
        options.onCapabilityState?.("local-only");
        return {
          window,
          port,
          attemptId: options.attemptId,
          releaseId: options.releaseId,
          capabilityState: "local-only",
        };
      }
      excludedPorts.push(port);
      lastPortRaceError = error;
      continue;
    }

    try {
      await waitForGatewayReadiness(options, port, identity, () => {
        options.gatewayProcess.markHealthReady?.(identity);
        options.onCapabilityState?.("partial");
      });
      options.gatewayProcess.markCapabilityReady?.(identity);
      options.onCapabilityState?.("full");
      return {
        window,
        port,
        ...identity,
        attemptId: options.attemptId ?? identity.attemptId,
        releaseId: options.releaseId ?? identity.releaseId,
        capabilityState: "full",
      };
    } catch (error) {
      options.gatewayProcess.markStartupFailed?.(identity);
      options.onCapabilityState?.("local-only");
      await rollbackOrThrow(error, () => options.gatewayProcess.stop("startup-rollback"));
      if (options.signal.aborted) throw options.signal.reason ?? error;
      if (options.keepShellOnGatewayFailure) {
        return {
          window,
          port,
          ...identity,
          attemptId: options.attemptId ?? identity.attemptId,
          releaseId: options.releaseId ?? identity.releaseId,
          capabilityState: "local-only",
        };
      }
      throw error;
    }
  }

  throw lastPortRaceError ?? new Error("Gateway startup failed.");
}

async function createAndShowShell<TWindow extends ShowableWindow>(
  options: GatewayStartupDependencies<TWindow>,
): Promise<TWindow> {
  options.signal.throwIfAborted();
  const window = await options.createWindow(options.signal);
  options.signal.throwIfAborted();
  window.show();
  return window;
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
