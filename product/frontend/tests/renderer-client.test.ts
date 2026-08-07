import { describe, expect, it, vi } from "vitest";
import type { ClientIpcEvent, ClientIpcRequest, IpcResponse } from "@uclaw/shared";

import { createRendererClient } from "../src/app/renderer-client";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("createRendererClient", () => {
  it("drops buffered send events when cancellation wins before acceptance", async () => {
    let listener: ((event: ClientIpcEvent) => void) | undefined;
    const accepted = deferred<IpcResponse>();
    const invoke = vi.fn((request: ClientIpcRequest): Promise<IpcResponse> => {
      if (request.method === "chat.send") return accepted.promise;
      return Promise.resolve({ method: request.method, requestId: request.requestId, ok: true, result: null } as IpcResponse);
    });
    const client = createRendererClient({ invoke, subscribe: (received) => { listener = received; return vi.fn(); } });
    const controller = new AbortController();
    const iterator = client.chat.send({
      sessionId: "session-1", clientRequestId: "client-1", blocks: [{ type: "text", text: "hello", format: "plain" }],
    }, controller.signal)[Symbol.asyncIterator]();
    const next = iterator.next();
    await vi.waitFor(() => expect(listener).toBeDefined());
    listener?.({ event: "chat.send-event", clientRequestId: "client-1", payload: { type: "started", runId: "run-1", sessionId: "session-1" } });

    controller.abort();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "chat.cancel-stream" })));
    accepted.resolve({ method: "chat.send", requestId: (invoke.mock.calls[0]![0] as ClientIpcRequest).requestId, ok: true, result: { clientRequestId: "client-1", runId: "run-1" } });
    await expect(next).resolves.toEqual({ value: undefined, done: true });
    listener?.({ event: "chat.send-event", clientRequestId: "client-1", payload: { type: "delta", runId: "run-1", mode: "append", text: "late" } });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it("unsubscribes and closes active queues on dispose", async () => {
    const unsubscribe = vi.fn();
    const invoke = vi.fn(async (request: ClientIpcRequest): Promise<IpcResponse> => ({ method: request.method, requestId: request.requestId, ok: true, result: null } as IpcResponse));
    const client = createRendererClient({ invoke, subscribe: () => unsubscribe });
    const iterator = client.gateway.watchStatus()[Symbol.asyncIterator]();
    const next = iterator.next();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "gateway.watch-status" })));

    client.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    await expect(next).resolves.toEqual({ value: undefined, done: true });
  });

  it("ends the older iterator without cancelling a newer send with the same clientRequestId", async () => {
    let listener: ((event: ClientIpcEvent) => void) | undefined;
    let run = 0;
    const invoke = vi.fn(async (request: ClientIpcRequest): Promise<IpcResponse> => {
      if (request.method === "chat.send") {
        run += 1;
        return { method: request.method, requestId: request.requestId, ok: true, result: { clientRequestId: "same", runId: `run-${run}` } };
      }
      return { method: request.method, requestId: request.requestId, ok: true, result: null } as IpcResponse;
    });
    const client = createRendererClient({ invoke, subscribe: (received) => { listener = received; return vi.fn(); } });
    const input = { sessionId: "session-1", clientRequestId: "same", blocks: [{ type: "text" as const, text: "hello", format: "plain" as const }] };
    const first = client.chat.send(input)[Symbol.asyncIterator]();
    let firstResult: IteratorResult<unknown> | undefined;
    void first.next().then((result) => { firstResult = result; });
    await vi.waitFor(() => expect(invoke.mock.calls.filter(([request]) => request.method === "chat.send")).toHaveLength(1));

    const second = client.chat.send(input)[Symbol.asyncIterator]();
    const secondNext = second.next();
    await vi.waitFor(() => expect(invoke.mock.calls.filter(([request]) => request.method === "chat.send")).toHaveLength(2));
    await vi.waitFor(() => expect(firstResult).toEqual({ value: undefined, done: true }));
    expect(invoke.mock.calls.filter(([request]) => request.method === "chat.cancel-stream")).toHaveLength(0);

    listener?.({ event: "chat.send-event", clientRequestId: "same", payload: { type: "started", runId: "run-2", sessionId: "session-1" } });
    await expect(secondNext).resolves.toEqual({ value: { type: "started", runId: "run-2", sessionId: "session-1" }, done: false });
    client.dispose();
  });

  it("does not abort a shared runId when an older send loses ownership", async () => {
    const invoke = vi.fn(async (request: ClientIpcRequest): Promise<IpcResponse> => {
      if (request.method === "chat.send") {
        return { method: request.method, requestId: request.requestId, ok: true, result: { clientRequestId: "same", runId: "shared-run" } };
      }
      return { method: request.method, requestId: request.requestId, ok: true, result: null } as IpcResponse;
    });
    const client = createRendererClient({ invoke, subscribe: () => vi.fn() });
    const input = { sessionId: "session-1", clientRequestId: "same", blocks: [{ type: "text" as const, text: "hello", format: "plain" as const }] };
    const oldController = new AbortController();
    const first = client.chat.send(input, oldController.signal)[Symbol.asyncIterator]();
    const firstNext = first.next();
    await vi.waitFor(() => expect(invoke.mock.calls.filter(([request]) => request.method === "chat.send")).toHaveLength(1));

    const second = client.chat.send(input)[Symbol.asyncIterator]();
    void second.next();
    oldController.abort();
    await expect(firstNext).resolves.toEqual({ value: undefined, done: true });
    await Promise.resolve();

    expect(invoke.mock.calls.filter(([request]) => request.method === "chat.abort")).toHaveLength(0);
    expect(invoke.mock.calls.filter(([request]) => request.method === "chat.cancel-stream")).toHaveLength(0);
    client.dispose();
  });
});
