import { once } from "node:events";

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return true;
  let timer;
  try {
    return await Promise.race([
      once(child, "exit").then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function stopChildBounded(child, options = {}) {
  if (!child || child.exitCode !== null) return;
  const interruptTimeoutMs = options.interruptTimeoutMs ?? 5_000;
  const killTimeoutMs = options.killTimeoutMs ?? 2_000;
  child.kill("SIGINT");
  if (await waitForExit(child, interruptTimeoutMs)) return;
  child.kill("SIGKILL");
  if (!await waitForExit(child, killTimeoutMs)) throw new Error("Gateway did not exit after SIGKILL");
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function runBounded(action, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function forceCloseServer(server) {
  for (const client of server?.clients ?? []) client.terminate?.();
  server?.closeAllConnections?.();
  server?.closeIdleConnections?.();
}

async function closeServerBounded(server, timeoutMs, label) {
  if (!server) return;
  const closing = closeServer(server);
  try {
    await runBounded(() => closing, timeoutMs, label);
  } catch (firstError) {
    forceCloseServer(server);
    try {
      await runBounded(() => closing, timeoutMs, `${label} after forced close`);
    } catch {
      throw firstError;
    }
  }
}

export async function cleanupCaptureResources(resources, options = {}) {
  const errors = [];
  const resourceTimeoutMs = options.resourceTimeoutMs ?? 5_000;
  const attempt = async (label, action) => {
    try {
      await action();
    } catch (error) {
      errors.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`));
    }
  };

  await attempt("requester stop", () => runBounded(() => resources.requester?.stop(), resourceTimeoutMs, "requester stop"));
  await attempt("client stop", () => runBounded(() => resources.client?.stop(), resourceTimeoutMs, "client stop"));
  await attempt("proxy close", () => closeServerBounded(resources.proxy, resourceTimeoutMs, "proxy close"));
  await attempt("model server close", () => closeServerBounded(resources.modelServer, resourceTimeoutMs, "model server close"));
  await attempt("Gateway stop", () => stopChildBounded(resources.gateway, options));
  await attempt("debug capture write", () => runBounded(() => resources.writeDebug?.(), resourceTimeoutMs, "debug capture write"));

  if (errors.length > 0) throw new AggregateError(errors, "OpenClaw capture cleanup failed");
}
