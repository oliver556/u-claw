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
      expect.objectContaining({ shell: false, cwd: "/runtime" }),
    );
    expect(manager.getState()).toMatchObject({ phase: "running", pid: 4123 });
  });

  it("escalates after timeout only while the captured PID is still owned", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const manager = new GatewayProcessManager({ spawn: () => child, stopTimeoutMs: 50 });
    manager.start({ executable: "node", args: [] });

    const stopping = manager.stop();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.pid = 9999;
    await vi.advanceTimersByTimeAsync(50);
    await stopping;

    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
  });

  it("force-kills its still-running owned process after the graceful timeout", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.kill.mockImplementation((signal?: NodeJS.Signals | number) => {
      child.killed = true;
      return signal === "SIGTERM" || signal === "SIGKILL";
    });
    const manager = new GatewayProcessManager({ spawn: () => child, stopTimeoutMs: 50 });
    manager.start({ executable: "node", args: [] });

    const stopping = manager.stop();
    await vi.advanceTimersByTimeAsync(50);
    await stopping;

    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
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
