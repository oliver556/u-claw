import { describe, expect, it, vi } from "vitest";

import { ProductionRuntimeConsistencyCoordinator } from "../src/data/production-consistency-coordinator.js";

const context = { method: "memory.write" as const, id: "MEMORY.md", expectedVersion: "v1" };

describe("ProductionRuntimeConsistencyCoordinator", () => {
  it("blocks new writes, drains an in-flight write, then stops and restarts the managed Gateway", async () => {
    let finishWrite!: () => void;
    const events: string[] = [];
    const coordinator = new ProductionRuntimeConsistencyCoordinator({
      stop: async () => { events.push("stop"); },
      start: async () => { events.push("start"); },
    });
    const write = coordinator.runVersioned(context, async () => {
      events.push("write-start");
      await new Promise<void>((resolve) => { finishWrite = resolve; });
      events.push("write-end");
    });
    await vi.waitFor(() => expect(events).toEqual(["write-start"]));

    const leasePromise = coordinator.acquireConsistencyLease();
    const blockedWrite = coordinator.runVersioned(context, async () => { events.push("blocked-write"); });
    await Promise.resolve();
    expect(events).toEqual(["write-start"]);

    finishWrite();
    await write;
    const lease = await leasePromise;
    expect(events).toEqual(["write-start", "write-end", "stop"]);
    await lease.release();
    await blockedWrite;
    expect(events).toEqual(["write-start", "write-end", "stop", "start", "blocked-write"]);
    expect(coordinator.getState()).toEqual({ phase: "idle" });
  });

  it("drains non-versioned production writers before stopping Gateway", async () => {
    let finishWrite!: () => void;
    const events: string[] = [];
    const coordinator = new ProductionRuntimeConsistencyCoordinator({
      stop: async () => { events.push("stop"); },
      start: async () => { events.push("start"); },
    });
    const write = coordinator.runTrackedWrite(async () => {
      events.push("write-start");
      await new Promise<void>((resolve) => { finishWrite = resolve; });
      events.push("write-end");
    });

    await vi.waitFor(() => expect(events).toEqual(["write-start"]));
    const leasePromise = coordinator.acquireConsistencyLease();
    await Promise.resolve();
    expect(events).toEqual(["write-start"]);
    finishWrite();
    await write;
    const lease = await leasePromise;
    expect(events).toEqual(["write-start", "write-end", "stop"]);
    await lease.release();
  });

  it("serializes concurrent consistency leases", async () => {
    const events: string[] = [];
    const coordinator = new ProductionRuntimeConsistencyCoordinator({
      stop: async () => { events.push("stop"); }, start: async () => { events.push("start"); },
    });
    const first = await coordinator.acquireConsistencyLease();
    const secondPromise = coordinator.acquireConsistencyLease();
    await Promise.resolve();
    expect(events).toEqual(["stop"]);
    await first.release();
    const second = await secondPromise;
    expect(events).toEqual(["stop", "start", "stop"]);
    await second.release();
  });

  it("fails acquisition cleanly when Gateway stop fails", async () => {
    const coordinator = new ProductionRuntimeConsistencyCoordinator({
      stop: async () => { throw new Error("stop failed"); }, start: vi.fn(),
    });
    await expect(coordinator.acquireConsistencyLease()).rejects.toThrow("stop failed");
    await expect(coordinator.runVersioned(context, async () => "ok")).resolves.toBe("ok");
    expect(coordinator.getState()).toMatchObject({ phase: "failed", stage: "stopping" });
  });

  it("restarts Gateway after an operation fails while holding the lease", async () => {
    const start = vi.fn(async () => undefined);
    const coordinator = new ProductionRuntimeConsistencyCoordinator({ stop: async () => undefined, start });
    const lease = await coordinator.acquireConsistencyLease();
    await expect((async () => { try { throw new Error("operation failed"); } finally { await lease.release(); } })()).rejects.toThrow("operation failed");
    expect(start).toHaveBeenCalledOnce();
  });

  it("stays fail-closed after restart failure and can recover", async () => {
    const start = vi.fn().mockRejectedValueOnce(new Error("restart failed")).mockResolvedValueOnce(undefined);
    const coordinator = new ProductionRuntimeConsistencyCoordinator({ stop: async () => undefined, start });
    const lease = await coordinator.acquireConsistencyLease();
    await expect(lease.release()).rejects.toThrow("restart failed");
    await expect(coordinator.runVersioned(context, async () => "unsafe")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await coordinator.recover();
    await expect(coordinator.runVersioned(context, async () => "ok")).resolves.toBe("ok");
  });

  it("cancels while waiting for in-flight writes without stopping Gateway", async () => {
    let finishWrite!: () => void;
    const stop = vi.fn(async () => undefined);
    const coordinator = new ProductionRuntimeConsistencyCoordinator({ stop, start: async () => undefined });
    const write = coordinator.runVersioned(context, () => new Promise<void>((resolve) => { finishWrite = resolve; }));
    const controller = new AbortController();
    const pending = coordinator.acquireConsistencyLease(controller.signal);
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(stop).not.toHaveBeenCalled();
    finishWrite();
    await write;
  });
});
