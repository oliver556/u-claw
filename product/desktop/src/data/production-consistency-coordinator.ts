import { UClawErrorSchema } from "@uclaw/shared";

import type { DataMutationContext, DataMutationCoordinator } from "./data-service.js";

export interface ManagedGatewayLifecycle {
  stop(signal?: AbortSignal): Promise<void>;
  start(signal?: AbortSignal): Promise<void>;
}

export type RuntimeConsistencyState =
  | { phase: "idle" | "draining" | "stopping" | "quiesced" | "starting" }
  | { phase: "failed"; stage: "stopping" | "starting"; message: string };

interface ConsistencyLease {
  release(): Promise<void>;
}

function unavailable(message: string) {
  return UClawErrorSchema.parse({
    code: "UNAVAILABLE",
    message,
    retryable: true,
    recoveryActions: ["retry"],
    causeDetails: {},
  });
}

function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class ProductionRuntimeConsistencyCoordinator implements DataMutationCoordinator {
  private state: RuntimeConsistencyState = { phase: "idle" };
  private activeWrites = 0;
  private pendingLeases = 0;
  private writesBlocked = false;
  private terminalFailure = false;
  private writableWaiters = new Set<() => void>();
  private drainedWaiters = new Set<() => void>();
  private leaseTail = Promise.resolve();

  private lifecycle: ManagedGatewayLifecycle | undefined;

  constructor(lifecycle?: ManagedGatewayLifecycle) {
    this.lifecycle = lifecycle;
  }

  bindLifecycle(lifecycle: ManagedGatewayLifecycle): void {
    if (this.state.phase !== "idle" || this.activeWrites !== 0 || this.writesBlocked) {
      throw new Error("Cannot replace managed Gateway lifecycle while consistency work is active.");
    }
    this.lifecycle = lifecycle;
  }

  getState(): RuntimeConsistencyState {
    return this.state;
  }

  async runVersioned<T>(_context: DataMutationContext, operation: () => Promise<T>): Promise<T> {
    return this.runTrackedWrite(operation);
  }

  async runTrackedWrite<T>(operation: () => Promise<T>): Promise<T> {
    while (this.writesBlocked) {
      if (this.terminalFailure) throw unavailable("Managed Gateway 重启失败，数据写入保持停用。请先恢复 runtime。");
      await new Promise<void>((resolve) => this.writableWaiters.add(resolve));
    }
    this.activeWrites += 1;
    try {
      return await operation();
    } finally {
      this.activeWrites -= 1;
      if (this.activeWrites === 0) {
        for (const resolve of this.drainedWaiters) resolve();
        this.drainedWaiters.clear();
      }
    }
  }

  async acquireConsistencyLease(signal?: AbortSignal): Promise<ConsistencyLease> {
    const lifecycle = this.lifecycle;
    if (!lifecycle) throw unavailable("Managed Gateway lifecycle 尚未绑定，无法获取一致性租约。");
    this.pendingLeases += 1;
    this.writesBlocked = true;
    let releaseTurn!: () => void;
    const turn = new Promise<void>((resolve) => { releaseTurn = resolve; });
    const previous = this.leaseTail;
    this.leaseTail = previous.catch(() => undefined).then(() => turn);
    await waitForAbort(previous, signal).catch((error) => {
      this.pendingLeases -= 1;
      if (this.pendingLeases === 0 && !this.terminalFailure) {
        this.writesBlocked = false;
        this.wakeWriters();
      }
      releaseTurn();
      throw error;
    });

    if (this.terminalFailure) {
      this.pendingLeases -= 1;
      releaseTurn();
      throw unavailable("Managed Gateway 处于待恢复状态，无法获取一致性租约。");
    }

    this.state = { phase: "draining" };
    try {
      if (this.activeWrites > 0) {
        await waitForAbort(new Promise<void>((resolve) => this.drainedWaiters.add(resolve)), signal);
      }
      signal?.throwIfAborted();
      this.state = { phase: "stopping" };
      await lifecycle.stop();
      this.state = { phase: "quiesced" };
    } catch (error) {
      this.pendingLeases -= 1;
      this.writesBlocked = this.pendingLeases > 0;
      this.state = { phase: "failed", stage: "stopping", message: "Managed Gateway 停止失败。" };
      if (!this.writesBlocked) this.wakeWriters();
      releaseTurn();
      throw error;
    }

    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        this.state = { phase: "starting" };
        try {
          await lifecycle.start();
          this.terminalFailure = false;
          this.pendingLeases -= 1;
          this.writesBlocked = this.pendingLeases > 0;
          this.state = { phase: "idle" };
          if (!this.writesBlocked) this.wakeWriters();
        } catch (error) {
          this.pendingLeases -= 1;
          this.terminalFailure = true;
          this.state = { phase: "failed", stage: "starting", message: "Managed Gateway 重启失败。" };
          this.wakeWriters();
          throw error;
        } finally {
          releaseTurn();
        }
      },
    };
  }

  async recover(signal?: AbortSignal): Promise<void> {
    if (!this.terminalFailure) return;
    const lifecycle = this.lifecycle;
    if (!lifecycle) throw unavailable("Managed Gateway lifecycle 尚未绑定，无法恢复 runtime。");
    this.state = { phase: "starting" };
    try {
      await waitForAbort(lifecycle.start(signal), signal);
      this.terminalFailure = false;
      this.writesBlocked = this.pendingLeases > 0;
      this.state = { phase: "idle" };
      if (!this.writesBlocked) this.wakeWriters();
    } catch (error) {
      this.state = { phase: "failed", stage: "starting", message: "Managed Gateway 重启失败。" };
      throw error;
    }
  }

  async restartManagedGateway(signal?: AbortSignal): Promise<void> {
    const lease = await this.acquireConsistencyLease(signal);
    await lease.release();
  }

  private wakeWriters(): void {
    for (const resolve of this.writableWaiters) resolve();
    this.writableWaiters.clear();
  }
}
