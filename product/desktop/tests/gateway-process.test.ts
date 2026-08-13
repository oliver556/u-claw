import { EventEmitter } from "node:events";
import { spawn as spawnChild } from "node:child_process";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GatewayProcessManager } from "../src/gateway/gateway-process.js";

class FakeChild extends EventEmitter {
  pid: number | undefined = 4123;
  exitCode: number | null = null;
  killed = false;
  stderr = new PassThrough();
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
      expect.objectContaining({ shell: false, stdio: ["ignore", "ignore", "pipe"], cwd: "/runtime" }),
    );
    expect(manager.getState()).toMatchObject({ phase: "running", pid: 4123 });
  });

  it("records readiness only after explicit health and capability milestones", () => {
    const child = new FakeChild();
    const events: Array<Record<string, unknown>> = [];
    const manager = new GatewayProcessManager({
      spawn: () => child,
      diagnostics: { append: (event) => { events.push(event); } },
      now: () => 1_000,
    });
    manager.setPort(18789);
    const identity = manager.start({ executable: "node", args: [] });

    expect(events.map((event) => event.event)).toEqual(["gateway-spawned"]);
    manager.markHealthReady(identity);
    manager.markCapabilityReady(identity);

    expect(events.map((event) => event.event)).toEqual([
      "gateway-spawned",
      "gateway-health-ready",
      "gateway-capability-ready",
      "gateway-started",
    ]);
    expect(events.at(-1)).toMatchObject({ pid: 4123, instanceId: 1, port: 18789 });
  });

  it("classifies a pre-readiness exit once and includes redacted bounded stderr", () => {
    const child = new FakeChild();
    const events: Array<Record<string, unknown>> = [];
    let now = 1_000;
    const manager = new GatewayProcessManager({
      spawn: () => child,
      diagnostics: { append: (event) => { events.push(event); } },
      now: () => now,
    });
    manager.setPort(18790);
    manager.start({ executable: "node", args: [] });
    child.stderr.write(`old-${"x".repeat(70 * 1024)}\n`);
    child.stderr.write("Authorization: Bearer top-secret\napi_key=sk-secret\n--token gateway-secret\nfinal failure\n");
    now = 1_250;

    child.emit("exit", 1, null);
    child.emit("close", 1, null);

    const exited = events.filter((event) => event.event === "gateway-exited");
    expect(exited).toHaveLength(1);
    expect(events.filter((event) => event.event === "gateway-startup-failed")).toHaveLength(1);
    expect(exited[0]).toMatchObject({
      classification: "startup-failure",
      exitCode: 1,
      signal: null,
      stopRequested: false,
      uptimeMs: 250,
      phase: "starting",
    });
    const stderrTail = String(exited[0]?.stderrTail);
    expect(Buffer.byteLength(stderrTail, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(stderrTail).toContain("final failure");
    expect(stderrTail).not.toMatch(/top-secret|sk-secret|gateway-secret/);
  });

  it("captures stderr emitted after exit before close", () => {
    const child = new FakeChild();
    const events: Array<Record<string, unknown>> = [];
    const manager = new GatewayProcessManager({
      spawn: () => child,
      diagnostics: { append: (event) => { events.push(event); } },
    });
    manager.start({ executable: "node", args: [] });

    child.emit("exit", 1, null);
    child.stderr.write("late crash reason\n");
    child.emit("close", 1, null);

    expect(events.find((event) => event.event === "gateway-exited")).toMatchObject({
      stderrTail: expect.stringContaining("late crash reason"),
    });
  });

  it("waits for diagnostics to flush before stop completes", async () => {
    const child = new FakeChild();
    let releaseFlush!: () => void;
    const flushPending = new Promise<void>((resolve) => { releaseFlush = resolve; });
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", 0, null));
      return true;
    });
    const flush = vi.fn(() => flushPending);
    const manager = new GatewayProcessManager({
      spawn: () => child,
      diagnostics: { append: () => undefined, flush },
    });
    manager.start({ executable: "node", args: [] });

    let stopped = false;
    const stopping = manager.stop("application-quit").then(() => { stopped = true; });
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalled());
    await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
    expect(stopped).toBe(false);

    releaseFlush();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("flushes diagnostics when stop is called after the child already exited", async () => {
    const child = new FakeChild();
    const flush = vi.fn();
    const manager = new GatewayProcessManager({
      spawn: () => child,
      diagnostics: { append: () => undefined, flush },
    });
    manager.start({ executable: "node", args: [] });
    child.emit("exit", 1, null);
    child.emit("close", 1, null);

    await manager.stop("application-quit");

    expect(flush).toHaveBeenCalledOnce();
  });

  it("redacts secrets split across stderr chunks", () => {
    const child = new FakeChild();
    const events: Array<Record<string, unknown>> = [];
    const manager = new GatewayProcessManager({
      spawn: () => child,
      diagnostics: { append: (event) => { events.push(event); } },
    });
    manager.start({ executable: "node", args: [] });

    child.stderr.write("Authorization: Bearer split-");
    child.stderr.write("secret\n");
    child.emit("exit", 1, null);
    child.emit("close", 1, null);

    const stderrTail = String(events.at(-1)?.stderrTail);
    expect(stderrTail).toContain("Authorization: Bearer [REDACTED]");
    expect(stderrTail).not.toContain("[REDACTED]secret");
  });

  it("redacts non-Bearer Authorization headers", () => {
    const child = new FakeChild();
    const events: Array<Record<string, unknown>> = [];
    const manager = new GatewayProcessManager({
      spawn: () => child,
      diagnostics: { append: (event) => { events.push(event); } },
    });
    manager.start({ executable: "node", args: [] });
    child.stderr.write("Authorization: Basic dXNlcjpwYXNz\n");
    child.emit("exit", 1, null);
    child.emit("close", 1, null);

    expect(String(events.at(-1)?.stderrTail)).toContain("Authorization: [REDACTED]");
    expect(String(events.at(-1)?.stderrTail)).not.toContain("dXNlcjpwYXNz");
  });

  it("drops an overlong stderr line whose sensitive prefix cannot be retained safely", () => {
    const child = new FakeChild();
    const events: Array<Record<string, unknown>> = [];
    const manager = new GatewayProcessManager({
      spawn: () => child,
      diagnostics: { append: (event) => { events.push(event); } },
    });
    manager.start({ executable: "node", args: [] });
    child.stderr.write(`Authorization: Bearer ${"secret".repeat(12_000)}\nuseful failure\n`);
    child.emit("exit", 1, null);
    child.emit("close", 1, null);

    const stderrTail = String(events.at(-1)?.stderrTail);
    expect(stderrTail).toContain("[stderr line truncated]");
    expect(stderrTail).toContain("useful failure");
    expect(stderrTail).not.toContain("secret");
  });

  it("classifies post-readiness exits as unexpected", () => {
    const child = new FakeChild();
    const events: Array<Record<string, unknown>> = [];
    const manager = new GatewayProcessManager({
      spawn: () => child,
      diagnostics: { append: (event) => { events.push(event); } },
    });
    const identity = manager.start({ executable: "node", args: [] });
    manager.markCapabilityReady(identity);

    child.emit("exit", null, "SIGABRT");
    child.emit("close", null, "SIGABRT");

    expect(events.at(-1)).toMatchObject({
      event: "gateway-exited",
      classification: "unexpected-exit",
      exitCode: null,
      signal: "SIGABRT",
    });
  });

  it("records explicit stop reason and classifies requested shutdown", async () => {
    const child = new FakeChild();
    const events: Array<Record<string, unknown>> = [];
    child.kill.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
      return true;
    });
    const manager = new GatewayProcessManager({
      spawn: () => child,
      diagnostics: { append: (event) => { events.push(event); } },
    });
    manager.start({ executable: "node", args: [] });

    await manager.stop("application-quit");

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "gateway-stop-requested", stopReason: "application-quit" }),
      expect.objectContaining({ event: "gateway-exited", classification: "requested-stop", stopReason: "application-quit" }),
    ]));
  });

  it("consumes a real ENOENT spawn error and throws a stable startup error", async () => {
    const manager = new GatewayProcessManager({ spawn: spawnChild });

    expect(() => manager.start({
      executable: "/uclaw/definitely-missing/gateway-binary",
      args: [],
    })).toThrow("Gateway process failed to start.");

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(manager.getOwnedPid()).toBeNull();
    expect(manager.getState()).toEqual({
      phase: "failed",
      message: "Gateway process failed to start.",
    });
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
    setTimeout(() => {
      child.exitCode = 0;
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    }, 50);

    const stopping = manager.stop();
    await vi.advanceTimersByTimeAsync(50);
    await stopping;

    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
    expect(manager.getOwnedPid()).toBeNull();
  });

  it("retains ownership after kill error and escalates until exit", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.kill.mockImplementation((signal?: NodeJS.Signals | number) => {
      if (signal === "SIGTERM") {
        queueMicrotask(() => child.emit("error", new Error("kill failed")));
      }
      if (signal === "SIGKILL") {
        setTimeout(() => {
          child.exitCode = 137;
          child.emit("exit", null, "SIGKILL");
          child.emit("close", null, "SIGKILL");
        }, 1);
      }
      return true;
    });
    const manager = new GatewayProcessManager({
      spawn: () => child,
      stopTimeoutMs: 50,
      killTimeoutMs: 20,
    });
    manager.start({ executable: "node", args: [] });

    const stopping = manager.stop();
    await Promise.resolve();
    expect(manager.getOwnedPid()).toBe(4123);

    await vi.advanceTimersByTimeAsync(51);
    await stopping;
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(manager.getOwnedPid()).toBeNull();
    expect(manager.getState()).toEqual({ phase: "stopped" });
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
          child.emit("close", null, "SIGKILL");
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
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("error", new Error("kill syscall failed")));
      return false;
    });
    manager.start({ executable: "node", args: [] });

    const rejected = expect(manager.stop()).rejects.toThrow("did not exit after SIGKILL");
    await vi.advanceTimersByTimeAsync(70);
    await rejected;

    expect(manager.getState()).toMatchObject({ phase: "failed" });
    expect(manager.getOwnedPid()).toBe(4123);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  });

  it("clears ownership when its child exits", () => {
    const child = new FakeChild();
    const manager = new GatewayProcessManager({ spawn: () => child });
    manager.start({ executable: "node", args: [] });

    child.exitCode = 0;
    child.emit("exit", 0, null);
    child.emit("close", 0, null);

    expect(manager.getState()).toEqual({ phase: "stopped" });
    expect(manager.getOwnedPid()).toBeNull();
  });
});
