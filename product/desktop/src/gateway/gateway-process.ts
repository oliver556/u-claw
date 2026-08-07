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
}

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell: false;
  stdio: "pipe";
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

export interface GatewayProcessManagerOptions {
  spawn: SpawnGateway;
  stopTimeoutMs?: number;
}

export class GatewayProcessManager extends EventEmitter {
  private child: GatewayChildProcess | null = null;
  private ownedPid: number | null = null;
  private state: GatewayProcessState = { phase: "stopped" };
  private readonly stopTimeoutMs: number;

  constructor(private readonly options: GatewayProcessManagerOptions) {
    super();
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
  }

  getState(): GatewayProcessState {
    return this.state;
  }

  getOwnedPid(): number | null {
    return this.ownedPid;
  }

  private setState(state: GatewayProcessState): void {
    this.state = state;
    this.emit("state", state);
  }

  start({ executable, args, cwd, env }: GatewayLaunchOptions): number {
    if (this.child) throw new Error("Gateway process is already owned.");
    this.setState({ phase: "starting" });

    try {
      const child = this.options.spawn(executable, [...args], {
        shell: false,
        stdio: "pipe",
        windowsHide: true,
        ...(cwd === undefined ? {} : { cwd }),
        ...(env === undefined ? {} : { env }),
      });
      if (!child.pid) throw new Error("Gateway process did not provide a PID.");

      this.child = child;
      this.ownedPid = child.pid;
      child.once("exit", (code) => {
        if (this.child !== child) return;
        this.child = null;
        this.ownedPid = null;
        this.setState(code === 0
          ? { phase: "stopped" }
          : { phase: "failed", message: `Gateway exited with code ${code ?? "unknown"}.` });
      });
      child.once("error", (error) => {
        if (this.child !== child) return;
        this.child = null;
        this.ownedPid = null;
        this.setState({ phase: "failed", message: error.message });
      });
      this.setState({ phase: "running", pid: child.pid });
      return child.pid;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Gateway spawn failed.";
      this.setState({ phase: "failed", message });
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    const pid = this.ownedPid;
    if (!child || pid === null) return;

    this.setState({ phase: "stopping", pid });
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (
          this.child === child &&
          this.ownedPid === pid &&
          child.pid === pid &&
          child.exitCode === null
        ) {
          child.kill("SIGKILL");
        }
        resolve();
      }, this.stopTimeoutMs);

      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}
