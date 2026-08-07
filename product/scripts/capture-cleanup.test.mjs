import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { cleanupCaptureResources, stopChildBounded } from "./capture-cleanup.mjs";

class FakeChild extends EventEmitter {
  exitCode = null;
  signals = [];

  kill(signal) {
    this.signals.push(signal);
    if (signal === "SIGKILL") {
      this.exitCode = 137;
      queueMicrotask(() => this.emit("exit", 137, signal));
    }
    return true;
  }
}

test("escalates an unresponsive Gateway from SIGINT to SIGKILL", async () => {
  const child = new FakeChild();
  await stopChildBounded(child, { interruptTimeoutMs: 1, killTimeoutMs: 20 });
  assert.deepEqual(child.signals, ["SIGINT", "SIGKILL"]);
  assert.equal(child.exitCode, 137);
});

test("cleans every resource before surfacing a debug write failure", async () => {
  const calls = [];
  const child = new FakeChild();
  const server = (name) => ({ close(callback) { calls.push(name); callback(); } });
  await assert.rejects(cleanupCaptureResources({
    requester: { stop() { calls.push("requester"); } },
    client: { stop() { calls.push("client"); } },
    proxy: server("proxy"),
    modelServer: server("model"),
    gateway: child,
    writeDebug() { calls.push("debug"); throw new Error("disk full"); },
  }, { interruptTimeoutMs: 1, killTimeoutMs: 20 }), AggregateError);
  assert.deepEqual(calls, ["requester", "client", "proxy", "model", "debug"]);
  assert.deepEqual(child.signals, ["SIGINT", "SIGKILL"]);
});

test("continues cleanup when a server close never settles", async () => {
  const calls = [];
  const child = new FakeChild();
  const hangingProxy = {
    clients: new Set([{ terminate() { calls.push("terminate client"); } }]),
    close() { calls.push("proxy"); },
  };
  const cleanup = cleanupCaptureResources({
    requester: { stop() { calls.push("requester"); } },
    client: { stop() { calls.push("client"); } },
    proxy: hangingProxy,
    modelServer: { close(callback) { calls.push("model"); callback(); } },
    gateway: child,
    writeDebug() { calls.push("debug"); },
  }, { resourceTimeoutMs: 1, interruptTimeoutMs: 1, killTimeoutMs: 20 });
  await assert.rejects(Promise.race([
    cleanup,
    new Promise((_, reject) => setTimeout(() => reject(new Error("cleanup test timed out")), 100)),
  ]), AggregateError);
  assert.deepEqual(calls, ["requester", "client", "proxy", "terminate client", "model", "debug"]);
  assert.deepEqual(child.signals, ["SIGINT", "SIGKILL"]);
});

test("accepts a server close completed by forced client termination", async () => {
  let closeCallback;
  const child = new FakeChild();
  const proxy = {
    clients: new Set([{ terminate() { closeCallback(); } }]),
    close(callback) { closeCallback = callback; },
  };
  await cleanupCaptureResources({ proxy, gateway: child }, {
    resourceTimeoutMs: 1,
    interruptTimeoutMs: 1,
    killTimeoutMs: 20,
  });
  assert.deepEqual(child.signals, ["SIGINT", "SIGKILL"]);
});
