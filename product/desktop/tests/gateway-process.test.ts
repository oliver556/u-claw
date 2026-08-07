import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GatewayProcessManager } from "../src/gateway/gateway-process.js";

class FakeChild extends EventEmitter {
  pid: number | undefined = 4123;
  exitCode: number | null = null;
  killed = false;
  kill = vi.fn((signal?: NodeJS.Signals | number) => {
    if (signal === "SIGKILL") this.killed = true;
    return true;
  });
}

describe("GatewayProcessManager", () => {
  afterEach(() => vi.useRealTimers());

  it("spawns an executable with an args array and shell disabled", () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const manager = new GatewayProcessManager({ spawn });

    manager.start({
      executable: "/runtime/node.exe",
      args: ["openclaw.js", "gateway", "--port", "18789"],
      cwd: "/runtime",
      env: { UCLAW_DATA_DIR: "D:\\uclaw" },
    });

    expect(spawn).toHaveBeenCalledWith(
      "/runtime/node.exe",
      ["openclaw.js", "gateway", "--port", "18789"],
      expect.objectContaining({ shell: false, stdio: "ignore", cwd: "/runtime" }),
    );
    expect(manager.getState()).toMatchObject({ phase: "running", pid: 4123 });
  });

  it("shares one stop completion and sends SIGTERM once", async () => {
    const child = new FakeChild();
    child.kill.mockImplementation(() => {
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit("close", 0, null);
      });
      return true;
    });
    const manager = new GatewayProcessManager({ spawn: () => child });
    manager.start({ executable: "node", args: [] });

    await Promise.all([manager.stop(), manager.stop()]);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(manager.getOwnedPid()).toBeNull();
  });

  it("does not SIGKILL when exitCode becomes available at the graceful timeout boundary", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const manager = new GatewayProcessManager({ spawn: () => child, stopTimeoutMs: 50, killTimeoutMs: 20 });
    manager.start({ executable: "node", args: [] });
    setTimeout(() => { child.exitCode = 0; }, 50);

    const stopping = manager.stop();
    await vi.advanceTimersByTimeAsync(50);
    await stopping;

    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
    expect(manager.getOwnedPid()).toBeNull();
  });

  it("rejects stop with the child error and clears ownership", async () => {
    const child = new FakeChild();
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("error", new Error("direct child failed")));
      return true;
    });
    const manager = new GatewayProcessManager({ spawn: () => child });
    manager.start({ executable: "node", args: [] });

    await expect(manager.stop()).rejects.toThrow("direct child failed");
    expect(manager.getOwnedPid()).toBeNull();
    expect(manager.getState()).toMatchObject({ phase: "failed" });
  });

  it("escalates after timeout only while the captured PID is still owned", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const manager = new GatewayProcessManager({ spawn: () => child, stopTimeoutMs: 50, killTimeoutMs: 20 });
    manager.start({ executable: "node", args: [] });

    const stopping = manager.stop();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.pid = 9999;
    const rejected = expect(stopping).rejects.toThrow("ownership");
    await vi.advanceTimersByTimeAsync(50);
    await rejected;

    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
  });

  it("force-kills its still-running owned process after the graceful timeout", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.kill.mockImplementation((signal?: NodeJS.Signals | number) => {
      child.killed = true;
      if (signal === "SIGKILL") {
        setTimeout(() => {
          child.exitCode = 137;
          child.emit("exit", null, "SIGKILL");
        }, 1);
      }
      return signal === "SIGTERM" || signal === "SIGKILL";
    });
    const manager = new GatewayProcessManager({ spawn: () => child, stopTimeoutMs: 50, killTimeoutMs: 20 });
    manager.start({ executable: "node", args: [] });

    const stopping = manager.stop();
    await vi.advanceTimersByTimeAsync(51);
    await stopping;

    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(manager.getOwnedPid()).toBeNull();
    expect(manager.getState()).toEqual({ phase: "stopped" });
  });

  it("fails explicitly when the owned process does not exit after SIGKILL", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const manager = new GatewayProcessManager({
      spawn: () => child,
      stopTimeoutMs: 50,
      killTimeoutMs: 20,
    });
    manager.start({ executable: "node", args: [] });

    const rejected = expect(manager.stop()).rejects.toThrow("did not exit after SIGKILL");
    await vi.advanceTimersByTimeAsync(70);
    await rejected;

    expect(manager.getState()).toMatchObject({ phase: "failed" });
    expect(manager.getOwnedPid()).toBe(4123);
  });

  it("clears ownership when its child exits", () => {
    const child = new FakeChild();
    const manager = new GatewayProcessManager({ spawn: () => child });
    manager.start({ executable: "node", args: [] });

    child.exitCode = 0;
    child.emit("exit", 0, null);

    expect(manager.getState()).toEqual({ phase: "stopped" });
    expect(manager.getOwnedPid()).toBeNull();
  });
});
