import { UClawErrorSchema } from "@uclaw/shared";
import { describe, expect, it } from "vitest";

import { MockUClawClient, ManualClock } from "../src/mock/mock-client.js";

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

describe("MockUClawClient", () => {
  it("lists sessions/history and deterministically streams send", async () => {
    const clock = new ManualClock("2026-08-07T12:00:00.000Z");
    const client = new MockUClawClient({ clock });
    const page = await client.sessions.list();
    expect(page.items).toHaveLength(1);
    expect((await client.chat.list(page.items[0].id)).items).toHaveLength(1);

    const eventsPromise = collect(client.chat.send({ sessionId: page.items[0].id, clientRequestId: "request-1", blocks: [{ type: "text", text: "hello", format: "plain" }] }));
    await clock.runAll();
    const events = await eventsPromise;
    expect(events.map((event) => event.type)).toEqual(["started", "delta", "delta", "final"]);
  });

  it("aborts only the requested run", async () => {
    const clock = new ManualClock("2026-08-07T12:00:00.000Z");
    const client = new MockUClawClient({ clock, streamDelayMs: 10 });
    const sessionId = (await client.sessions.list()).items[0].id;
    const stream = client.chat.send({ sessionId, clientRequestId: "request-abort", blocks: [{ type: "text", text: "stop", format: "plain" }] });
    const iterator = stream[Symbol.asyncIterator]();
    const startedPromise = iterator.next();
    await clock.advance(0);
    const started = await startedPromise;
    expect(started.value?.type).toBe("started");
    if (started.value?.type !== "started") throw new Error("missing run id");
    await client.chat.abort(started.value.runId);
    await clock.runAll();
    const rest = [await iterator.next(), await iterator.next()];
    expect(rest.find((item) => item.value?.type === "aborted")?.value).toMatchObject({ type: "aborted", runId: started.value.runId });
  });

  it("exposes tool, approval families, and reconnect status deterministically", async () => {
    const clock = new ManualClock("2026-08-07T12:00:00.000Z");
    const client = new MockUClawClient({ clock });
    expect(await client.tools.getCall("tool-call-1")).toMatchObject({ state: "waiting-authorization" });
    expect((await client.approvals.listPending()).map((request) => request.family)).toEqual(["exec", "plugin"]);
    const statuses = client.gateway.watchStatus()[Symbol.asyncIterator]();
    expect((await statuses.next()).value?.connectionState).toBe("ready");
    const reconnect = client.gateway.reconnect();
    await expect(statuses.next()).resolves.toMatchObject({ value: { connectionState: "reconnecting", attempt: 1 } });
    await clock.runAll();
    await reconnect;
    const ready = (await statuses.next()).value;
    expect(ready).toMatchObject({ connectionState: "ready", attempt: 0 });
    expect(await client.gateway.getStatus()).toEqual(ready);
    await statuses.return?.();
  });

  it("declares every implemented method and no unsupported method", async () => {
    const capabilities = await new MockUClawClient().gateway.negotiate();
    expect([...capabilities.methods]).toEqual([
      "sessions.list", "sessions.get", "sessions.create", "sessions.delete",
      "chat.history", "chat.message.get", "chat.send", "chat.abort",
      "tools.catalog", "session.tool.get", "exec.approval.list", "plugin.approval.list",
    ]);
  });

  it("throws UNSUPPORTED for management capabilities without fixtures", async () => {
    const client = new MockUClawClient();
    await expect(client.models.list()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(client.skills.list()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(client.channels.list()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(client.files.list()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(client.diagnostics.list()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(client.approvals.resolveExec({ ref: { family: "exec", id: "approval-exec-1" }, decision: "deny" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(client.approvals.resolvePlugin({ ref: { family: "plugin", id: "approval-plugin-1" }, decision: "deny" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    const unsupported = await client.models.list().catch((error: unknown) => error) as { uclawError: unknown };
    expect(UClawErrorSchema.parse(unsupported.uclawError).code).toBe("UNSUPPORTED");
  });

  it("normalizes public not-found errors", async () => {
    const client = new MockUClawClient();
    const error = await client.sessions.get("missing").catch((reason: unknown) => reason) as { uclawError: unknown };
    expect(UClawErrorSchema.parse(error.uclawError)).toMatchObject({ code: "NOT_FOUND", retryable: false });
  });
});
