export function waitForEvent(events, predicate, label, ms = 20_000, timers = globalThis) {
  const found = events.find(predicate);
  if (found) return Promise.resolve(found);
  let interval;
  let timeout;
  return new Promise((resolveEvent, reject) => {
    interval = timers.setInterval(() => {
      const event = events.find(predicate);
      if (event) resolveEvent(event);
    }, 20);
    timeout = timers.setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
  }).finally(() => {
    timers.clearInterval(interval);
    timers.clearTimeout(timeout);
  });
}
