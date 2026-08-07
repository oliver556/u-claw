import { describe, expect, it, vi } from "vitest";

import {
  CLIENT_IPC_CHANNEL,
  CLIENT_IPC_EVENT_CHANNEL,
  WINDOW_IPC_CHANNEL,
} from "../src/ipc/channels.js";
import { installPreloadBridge } from "../src/ipc/preload-bridge.js";

describe("installPreloadBridge", () => {
  it("exposes only fixed window and client contract methods", async () => {
    const invoke = vi.fn(async (_channel: string, request: unknown) => {
      const { method, requestId } = request as { method: string; requestId: string };
      return { method, requestId, ok: true, result: null };
    });
    let api: Record<string, unknown> | undefined;
    const on = vi.fn();
    const removeListener = vi.fn();

    installPreloadBridge({
      contextBridge: {
        exposeInMainWorld: (_name, exposed) => {
          api = exposed;
        },
      },
      ipcRenderer: { invoke, on, removeListener },
    });

    expect(Object.keys(api ?? {})).toEqual(["window", "client"]);
    expect(api).not.toHaveProperty("ipcRenderer");
    expect(api).not.toHaveProperty("invoke");
    expect(Object.keys(api?.client as object)).toEqual(["invoke", "subscribe"]);

    await (api?.window as { invoke: (request: unknown) => Promise<unknown> }).invoke({
      method: "minimize",
      requestId: "window-1",
      params: {},
    });
    expect(invoke).toHaveBeenLastCalledWith(WINDOW_IPC_CHANNEL, expect.any(Object));

    await expect(
      (api?.client as { invoke: (request: unknown) => Promise<unknown> }).invoke({
        method: "exec",
        requestId: "client-1",
        params: { command: "rm -rf /" },
      }),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalledWith(CLIENT_IPC_CHANNEL, expect.objectContaining({ method: "exec" }));
  });

  it("parses events on one fixed channel and removes the exact listener on unsubscribe", () => {
    let eventListener: ((_event: unknown, payload: unknown) => void) | undefined;
    const on = vi.fn((channel: string, listener: typeof eventListener) => {
      expect(channel).toBe(CLIENT_IPC_EVENT_CHANNEL);
      eventListener = listener;
    });
    const removeListener = vi.fn();
    let api: Record<string, unknown> | undefined;
    installPreloadBridge({
      contextBridge: { exposeInMainWorld: (_name, exposed) => { api = exposed; } },
      ipcRenderer: { invoke: vi.fn(), on, removeListener },
    });
    const receive = vi.fn();
    const unsubscribe = (api?.client as {
      subscribe(listener: (event: unknown) => void): () => void;
    }).subscribe(receive);
    const validEvent = {
      event: "chat.send-event",
      clientRequestId: "client-1",
      payload: { type: "delta", runId: "run-1", mode: "append", text: "hello" },
    };

    eventListener?.({}, validEvent);
    expect(receive).toHaveBeenCalledWith(validEvent);
    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(CLIENT_IPC_EVENT_CHANNEL, eventListener);
  });

  it("drops invalid events and reports only a safe validation error", () => {
    let eventListener: ((_event: unknown, payload: unknown) => void) | undefined;
    const reportInvalidEvent = vi.fn();
    let api: Record<string, unknown> | undefined;
    installPreloadBridge({
      contextBridge: { exposeInMainWorld: (_name, exposed) => { api = exposed; } },
      ipcRenderer: {
        invoke: vi.fn(),
        on: (_channel, listener) => { eventListener = listener; },
        removeListener: vi.fn(),
      },
      reportInvalidEvent,
    });
    const receive = vi.fn();
    (api?.client as { subscribe(listener: (event: unknown) => void): () => void }).subscribe(receive);

    eventListener?.({}, { event: "process.exec", token: "secret-value" });
    expect(receive).not.toHaveBeenCalled();
    expect(reportInvalidEvent).toHaveBeenCalledWith(expect.objectContaining({
      message: "Invalid client IPC event.",
    }));
    expect(JSON.stringify(reportInvalidEvent.mock.calls)).not.toContain("secret-value");
  });
});
