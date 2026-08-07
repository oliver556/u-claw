import { EventEmitter } from "node:events";

export type GatewayProcessPhase = "starting" | "running" | "stopping" | "stopped" | "failed";

export type GatewayProcessState =
  | { phase: "starting" | "stopped" }
  | { phase: "running" | "stopping"; pid: number }
  | { phase: "failed"; message: string };

export interface GatewayChildProcess {
  pid?: number;
  exitCode: number | null;
  killed: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell: false;
  stdio: "ignore";
  windowsHide: true;
}

export type SpawnGateway = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => GatewayChildProcess;

export interface GatewayLaunchOptions {
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface GatewayProcessIdentity {
  pid: number;
  instanceId: number;
}

export interface GatewayProcessManagerOptions {
  spawn: SpawnGateway;
  stopTimeoutMs?: number;
  killTimeoutMs?: number;
}

type GatewayCompletion =
  | { kind: "exit" | "close"; code: number | null }
  | { kind: "error"; error: Error };

interface OwnedGatewayProcess {
  child: GatewayChildProcess;
  pid: number;
  instanceId: number;
  completion: Promise<GatewayCompletion>;
  outcome: GatewayCompletion | null;
  settle(outcome: GatewayCompletion): void;
  stopPromise: Promise<void> | null;
}

export class GatewayProcessManager extends EventEmitter {
  private owned: OwnedGatewayProcess | null = null;
  private nextInstanceId = 1;
  private state: GatewayProcessState = { phase: "stopped" };
  private readonly stopTimeoutMs: number;
  private readonly killTimeoutMs: number;

  constructor(private readonly options: GatewayProcessManagerOptions) {
    super();
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
    this.killTimeoutMs = options.killTimeoutMs ?? 2_000;
  }

  getState(): GatewayProcessState {
    return this.state;
  }

  getOwnedPid(): number | null {
    return this.owned?.pid ?? null;
  }

  getOwnedInstanceId(): number | null {
    return this.owned?.instanceId ?? null;
  }

  private setState(state: GatewayProcessState): void {
    this.state = state;
    this.emit("state", state);
  }

  start({ executable, args, cwd, env }: GatewayLaunchOptions): GatewayProcessIdentity {
    if (this.owned) throw new Error("Gateway process is already owned.");
    this.setState({ phase: "starting" });

    try {
      const child = this.options.spawn(executable, [...args], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
        ...(cwd === undefined ? {} : { cwd }),
        ...(env === undefined ? {} : { env }),
      });
      if (!child.pid) throw new Error("Gateway process did not provide a PID.");

      let resolveCompletion!: (outcome: GatewayCompletion) => void;
      const owned: OwnedGatewayProcess = {
        child,
        pid: child.pid,
        instanceId: this.nextInstanceId++,
        completion: new Promise((resolve) => { resolveCompletion = resolve; }),
        outcome: null,
        settle: (outcome) => {
          if (owned.outcome) return;
          owned.outcome = outcome;
          resolveCompletion(outcome);
          if (this.owned !== owned) return;
          const wasStopping = this.state.phase === "stopping";
          this.owned = null;
          if (outcome.kind === "error") {
            this.setState({ phase: "failed", message: outcome.error.message });
            return;
          }
          this.setState(outcome.code === 0 || wasStopping
            ? { phase: "stopped" }
            : { phase: "failed", message: `Gateway exited with code ${outcome.code ?? "unknown"}.` });
        },
        stopPromise: null,
      };
      this.owned = owned;
      child.once("exit", (code) => owned.settle({ kind: "exit", code }));
      child.once("error", (error) => owned.settle({ kind: "error", error }));
      child.once("close", (code) => owned.settle({ kind: "close", code }));
      this.setState({ phase: "running", pid: child.pid });
      return { pid: child.pid, instanceId: owned.instanceId };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Gateway spawn failed.";
      this.setState({ phase: "failed", message });
      throw error;
    }
  }

  async stop(): Promise<void> {
    const owned = this.owned;
    if (!owned) return;
    owned.stopPromise ??= this.stopOwned(owned).finally(() => {
      owned.stopPromise = null;
    });
    return owned.stopPromise;
  }

  private async stopOwned(owned: OwnedGatewayProcess): Promise<void> {
    const { child, pid } = owned;
    this.setState({ phase: "stopping", pid });
    if (child.exitCode !== null) owned.settle({ kind: "exit", code: child.exitCode });
    else if (!child.killed) child.kill("SIGTERM");

    let outcome = await this.waitForCompletion(owned, this.stopTimeoutMs);
    if (outcome) return this.finishStop(outcome);
    if (child.exitCode !== null) {
      owned.settle({ kind: "exit", code: child.exitCode });
      return;
    }
    if (this.owned !== owned || child.pid !== pid) {
      const message = "Gateway process ownership changed before SIGKILL.";
      this.setState({ phase: "failed", message });
      throw new Error(message);
    }

    child.kill("SIGKILL");
    outcome = await this.waitForCompletion(owned, this.killTimeoutMs);
    if (outcome) return this.finishStop(outcome);
    if (child.exitCode !== null) {
      owned.settle({ kind: "exit", code: child.exitCode });
      return;
    }

    const message = "Gateway process did not exit after SIGKILL.";
    this.setState({ phase: "failed", message });
    throw new Error(message);
  }

  private async waitForCompletion(
    owned: OwnedGatewayProcess,
    timeoutMs: number,
  ): Promise<GatewayCompletion | null> {
    if (owned.outcome) return owned.outcome;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        owned.completion,
        new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), timeoutMs); }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private finishStop(outcome: GatewayCompletion): void {
    if (outcome.kind === "error") throw outcome.error;
  }
}
