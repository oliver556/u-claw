import assert from "node:assert/strict";
import test from "node:test";

import { waitForEvent } from "./capture-wait.mjs";

function fakeTimers() {
  const state = {
    intervalCallback: undefined,
    timeoutCallback: undefined,
    clearedIntervals: [],
    clearedTimeouts: [],
  };
  return {
    state,
    timers: {
      setInterval(callback) { state.intervalCallback = callback; return "interval"; },
      clearInterval(handle) { state.clearedIntervals.push(handle); },
      setTimeout(callback) { state.timeoutCallback = callback; return "timeout"; },
      clearTimeout(handle) { state.clearedTimeouts.push(handle); },
    },
  };
}

test("clears interval and timeout after an event is found", async () => {
  const events = [];
  const { state, timers } = fakeTimers();
  const waiting = waitForEvent(events, (event) => event.ready, "ready event", 100, timers);
  events.push({ ready: true });
  state.intervalCallback();
  await assert.doesNotReject(waiting);
  assert.deepEqual(state.clearedIntervals, ["interval"]);
  assert.deepEqual(state.clearedTimeouts, ["timeout"]);
});

test("clears interval and timeout after timing out", async () => {
  const { state, timers } = fakeTimers();
  const waiting = waitForEvent([], () => false, "missing event", 100, timers);
  state.timeoutCallback();
  await assert.rejects(waiting, /Timed out waiting for missing event/);
  assert.deepEqual(state.clearedIntervals, ["interval"]);
  assert.deepEqual(state.clearedTimeouts, ["timeout"]);
});

test("does not allocate timers when an event already exists", async () => {
  const { state, timers } = fakeTimers();
  await assert.doesNotReject(waitForEvent([{ ready: true }], (event) => event.ready, "ready event", 100, timers));
  assert.equal(state.intervalCallback, undefined);
  assert.equal(state.timeoutCallback, undefined);
});
