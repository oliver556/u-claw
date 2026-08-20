import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import type { GatewayDiagnosticRecord, GatewayDiagnosticSink } from "../diagnostics/gateway-log-sink.js";

export type GatewayProcessPhase = "starting" | "running" | "stopping" | "stopped" | "failed";

export type GatewayProcessState =
  | { phase: "starting" | "stopped" }
  | { phase: "running" | "stopping"; pid: number }
  | { phase: "failed"; message: string };

export interface GatewayChildProcess {
  pid?: number;
  exitCode: number | null;
  killed: boolean;
  stderr?: Readable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell: false;
  stdio: ["ignore", "ignore", "pipe"];
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
  attemptId?: string;
  releaseId?: string;
}

export interface GatewayProcessIdentity {
  pid: number;
  instanceId: number;
  attemptId?: string;
  port?: number;
  releaseId?: string;
}

export interface GatewayProcessManagerOptions {
  spawn: SpawnGateway;
  stopTimeoutMs?: number;
  killTimeoutMs?: number;
  diagnostics?: GatewayDiagnosticSink;
  now?: () => number;
  releaseId?: string;
  createAttemptId?: () => string;
}

export type GatewayStopReason = "application-quit" | "startup-rollback" | "consistency-restart" | "manual-restart" | "unspecified";

type GatewayCompletion = {
  kind: "exit" | "close";
  code: number | null;
  signal: NodeJS.Signals | null;
};

interface OwnedGatewayProcess {
  child: GatewayChildProcess;
  pid: number;
  instanceId: number;
  attemptId: string;
  releaseId: string;
  completion: Promise<GatewayCompletion>;
  diagnosticsComplete: Promise<void>;
  outcome: GatewayCompletion | null;
  settle(outcome: GatewayCompletion): void;
  finalize(outcome: GatewayCompletion): void;
  stopPromise: Promise<void> | null;
  stopRequested: boolean;
  stopReason?: GatewayStopReason;
  lastError: Error | null;
  port?: number;
  startedAt: number;
  readinessComplete: boolean;
  startupFailureRecorded: boolean;
  startupFailureRequested: boolean;
  diagnosticPhase: "starting" | "health-ready" | "ready" | "stopping";
  stderrTail: Buffer;
  stderrDecoder: StringDecoder;
  stderrPending: string;
  stderrLineTruncated: boolean;
}

const STDERR_TAIL_BYTES = 64 * 1024;

export function redactGatewayStderr(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/authorization\s*:[^\r\n]+/gi, (header) =>
      /:\s*bearer\b/i.test(header) ? header : "Authorization: [REDACTED]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|apikey)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(--token(?:=|\s+))[^\s]+/gi, "$1[REDACTED]");
}

function appendBoundedTail(current: Buffer, text: string): Buffer {
  const next = Buffer.concat([current, Buffer.from(redactGatewayStderr(text), "utf8")]);
  return next.length <= STDERR_TAIL_BYTES ? next : next.subarray(next.length - STDERR_TAIL_BYTES);
}

function consumeCompleteStderrLines(owned: OwnedGatewayProcess, text: string): void {
  owned.stderrPending += text;
  let newline = owned.stderrPending.indexOf("\n");
  while (newline >= 0) {
    const line = owned.stderrPending.slice(0, newline + 1);
    owned.stderrPending = owned.stderrPending.slice(newline + 1);
    owned.stderrTail = appendBoundedTail(
      owned.stderrTail,
      owned.stderrLineTruncated || Buffer.byteLength(line, "utf8") > STDERR_TAIL_BYTES
        ? "[stderr line truncated]\n"
        : line,
    );
    owned.stderrLineTruncated = false;
    newline = owned.stderrPending.indexOf("\n");
  }
  if (Buffer.byteLength(owned.stderrPending, "utf8") > STDERR_TAIL_BYTES) {
    owned.stderrPending = "";
    owned.stderrLineTruncated = true;
  }
}

export class GatewayProcessManager extends EventEmitter {
  private owned: OwnedGatewayProcess | null = null;
  private nextInstanceId = 1;
  private state: GatewayProcessState = { phase: "stopped" };
  private readonly stopTimeoutMs: number;
  private readonly killTimeoutMs: number;
  private readonly now: () => number;
  private readonly createAttemptId: () => string;
  private readonly releaseId: string;
  private nextPort: number | undefined;

  constructor(private readonly options: GatewayProcessManagerOptions) {
    super();
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
    this.killTimeoutMs = options.killTimeoutMs ?? 2_000;
    this.now = options.now ?? Date.now;
    this.createAttemptId = options.createAttemptId ?? randomUUID;
    this.releaseId = options.releaseId ?? "unknown";
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

  setPort(port: number): void {
    this.nextPort = port;
  }

  markHealthReady(identity: GatewayProcessIdentity): void {
    const owned = this.getOwned(identity);
    if (!owned || owned.diagnosticPhase !== "starting") return;
    owned.diagnosticPhase = "health-ready";
    this.record(owned, { event: "gateway-health-ready", phase: "health-ready" });
  }

  markCapabilityReady(identity: GatewayProcessIdentity): void {
    const owned = this.getOwned(identity);
    if (!owned || owned.readinessComplete) return;
    owned.readinessComplete = true;
    owned.diagnosticPhase = "ready";
    this.record(owned, { event: "gateway-capability-ready", phase: "ready" });
    this.record(owned, { event: "gateway-started", phase: "ready" });
  }

  markStartupFailed(identity: GatewayProcessIdentity): void {
    const owned = this.getOwned(identity);
    if (!owned || owned.readinessComplete || owned.startupFailureRecorded) return;
    owned.startupFailureRequested = true;
  }

  private getOwned(identity: GatewayProcessIdentity): OwnedGatewayProcess | null {
    const owned = this.owned;
    return owned?.pid === identity.pid && owned.instanceId === identity.instanceId ? owned : null;
  }

  private record(owned: OwnedGatewayProcess, record: GatewayDiagnosticRecord): void {
    try {
      const result = this.options.diagnostics?.append({
        pid: owned.pid,
        instanceId: owned.instanceId,
        attemptId: owned.attemptId,
        releaseId: owned.releaseId,
        timestamp: new Date(this.now()).toISOString(),
        ...(owned.port === undefined ? {} : { port: owned.port }),
        startedAt: new Date(owned.startedAt).toISOString(),
        uptimeMs: Math.max(0, this.now() - owned.startedAt),
        ...record,
      });
      if (result && "catch" in result) void result.catch(() => undefined);
    } catch {
      // Diagnostics must never change Gateway lifecycle behavior.
    }
  }

  private stderrTail(owned: OwnedGatewayProcess): string | undefined {
    const pending = owned.stderrLineTruncated ? "[stderr line truncated]" : redactGatewayStderr(owned.stderrPending);
    const tail = appendBoundedTail(owned.stderrTail, pending).toString("utf8").replace(/^\uFFFD+/, "");
    return tail === "" ? undefined : tail;
  }

  start({
    executable,
    args,
    cwd,
    env,
    attemptId = this.createAttemptId(),
    releaseId = this.releaseId,
  }: GatewayLaunchOptions): GatewayProcessIdentity {
    if (this.owned) throw new Error("Gateway process is already owned.");
    this.setState({ phase: "starting" });

    try {
      const child = this.options.spawn(executable, [...args], {
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        ...(cwd === undefined ? {} : { cwd }),
        ...(env === undefined ? {} : { env }),
      });
      let owned: OwnedGatewayProcess | null = null;
      child.on("error", (error) => {
        if (!owned) {
          this.setState({ phase: "failed", message: "Gateway process failed to start." });
          return;
        }
        owned.lastError = error;
        if (this.owned === owned) {
          this.setState({ phase: "failed", message: "Gateway process reported an error." });
        }
      });

      const pid = child.pid;
      if (!pid) throw new Error("Gateway process failed to start.");

      let resolveCompletion!: (outcome: GatewayCompletion) => void;
      let resolveDiagnostics!: () => void;
      const completion = new Promise<GatewayCompletion>((resolve) => {
        resolveCompletion = resolve;
      });
      const diagnosticsComplete = new Promise<void>((resolve) => {
        resolveDiagnostics = resolve;
      });
      const ownedRecord: OwnedGatewayProcess = {
        child,
        pid,
        instanceId: this.nextInstanceId++,
        attemptId,
        releaseId,
        completion,
        diagnosticsComplete,
        outcome: null,
        settle: (outcome) => {
          if (ownedRecord.outcome) return;
          ownedRecord.outcome = outcome;
          resolveCompletion(outcome);
        },
        finalize: (outcome) => {
          const phase = ownedRecord.diagnosticPhase;
          if (!ownedRecord.readinessComplete && !ownedRecord.startupFailureRecorded
            && (ownedRecord.startupFailureRequested || !ownedRecord.stopRequested)) {
            ownedRecord.startupFailureRecorded = true;
            this.record(ownedRecord, {
              event: "gateway-startup-failed",
              phase,
              exitCode: outcome.code,
              signal: outcome.signal,
              stderrTail: this.stderrTail(ownedRecord),
            });
          }
          this.record(ownedRecord, {
            event: "gateway-exited",
            phase,
            exitCode: outcome.code,
            signal: outcome.signal,
            stopRequested: ownedRecord.stopRequested,
            ...(ownedRecord.stopReason === undefined ? {} : { stopReason: ownedRecord.stopReason }),
            classification: ownedRecord.stopRequested
              ? "requested-stop"
              : ownedRecord.readinessComplete ? "unexpected-exit" : "startup-failure",
            stderrTail: this.stderrTail(ownedRecord),
          });
          resolveDiagnostics();
          if (this.owned !== ownedRecord) return;
          const wasStopping = ownedRecord.stopRequested;
          this.owned = null;
          this.setState(outcome.code === 0 || wasStopping
            ? { phase: "stopped" }
            : { phase: "failed", message: `Gateway exited with code ${outcome.code ?? "unknown"}.` });
        },
        stopPromise: null,
        stopRequested: false,
        lastError: null,
        port: this.nextPort,
        startedAt: this.now(),
        readinessComplete: false,
        startupFailureRecorded: false,
        startupFailureRequested: false,
        diagnosticPhase: "starting",
        stderrTail: Buffer.alloc(0),
        stderrDecoder: new StringDecoder("utf8"),
        stderrPending: "",
        stderrLineTruncated: false,
      };
      owned = ownedRecord;
      this.owned = ownedRecord;
      child.stderr?.on("data", (chunk: Buffer | string) => {
        const text = ownedRecord.stderrDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        consumeCompleteStderrLines(ownedRecord, text);
      });
      let exitOutcome: GatewayCompletion | null = null;
      child.once("exit", (code, signal) => {
        exitOutcome = { kind: "exit", code, signal };
        ownedRecord.settle(exitOutcome);
      });
      child.once("close", (code, signal) => {
        consumeCompleteStderrLines(ownedRecord, ownedRecord.stderrDecoder.end());
        const outcome = exitOutcome ?? { kind: "close" as const, code, signal };
        ownedRecord.settle(outcome);
        ownedRecord.finalize(outcome);
      });
      this.record(ownedRecord, { event: "gateway-spawned", phase: "starting" });
      this.setState({ phase: "running", pid });
      return {
        pid,
        instanceId: ownedRecord.instanceId,
        attemptId: ownedRecord.attemptId,
        ...(ownedRecord.port === undefined ? {} : { port: ownedRecord.port }),
        releaseId: ownedRecord.releaseId,
      };
    } catch (error) {
      const message = "Gateway process failed to start.";
      this.setState({ phase: "failed", message });
      const stableError = new Error(message, { cause: error });
      if (typeof error === "object" && error !== null && "code" in error) {
        Object.assign(stableError, { code: (error as { code?: unknown }).code });
      }
      throw stableError;
    }
  }

  async stop(reason: GatewayStopReason = "unspecified"): Promise<void> {
    const owned = this.owned;
    if (!owned) {
      await this.flushDiagnostics();
      return;
    }
    if (!owned.stopRequested) {
      owned.stopRequested = true;
      owned.stopReason = reason;
      owned.diagnosticPhase = "stopping";
      this.record(owned, {
        event: "gateway-stop-requested",
        phase: "stopping",
        stopRequested: true,
        stopReason: reason,
      });
    }
    owned.stopPromise ??= this.stopOwned(owned).finally(() => {
      owned.stopPromise = null;
    });
    await owned.stopPromise;
    await owned.diagnosticsComplete;
    await this.flushDiagnostics();
  }

  private async flushDiagnostics(): Promise<void> {
    try {
      await this.options.diagnostics?.flush?.();
    } catch {
      // Diagnostics must never change Gateway lifecycle behavior.
    }
  }

  private async stopOwned(owned: OwnedGatewayProcess): Promise<void> {
    const { child, pid } = owned;
    this.setState({ phase: "stopping", pid });
    if (child.exitCode !== null) owned.settle({ kind: "exit", code: child.exitCode, signal: null });
    else if (!child.killed) child.kill("SIGTERM");

    let outcome = await this.waitForCompletion(owned, this.stopTimeoutMs);
    if (outcome) return;
    if (child.exitCode !== null) {
      owned.settle({ kind: "exit", code: child.exitCode, signal: null });
      return;
    }
    if (this.owned !== owned || child.pid !== pid) {
      const message = "Gateway process ownership changed before SIGKILL.";
      this.setState({ phase: "failed", message });
      throw new Error(message);
    }

    child.kill("SIGKILL");
    outcome = await this.waitForCompletion(owned, this.killTimeoutMs);
    if (outcome) return;
    if (child.exitCode !== null) {
      owned.settle({ kind: "exit", code: child.exitCode, signal: null });
      return;
    }

    const message = "Gateway process did not exit after SIGKILL.";
    this.setState({ phase: "failed", message });
    throw new Error(message, { cause: owned.lastError ?? undefined });
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
}
