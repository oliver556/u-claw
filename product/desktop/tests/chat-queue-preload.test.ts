import { describe, expect, it, vi } from "vitest";

import { installPreloadBridge } from "../src/ipc/preload-bridge.js";

describe("chat queue preload", () => {
  it("exposes validated queue IPC to the isolated Renderer", async () => {
    let api: Record<string, any> | undefined;
    const invoke = vi.fn(async (_channel: string, request: any) => ({
      method: request.method, requestId: request.requestId, ok: true,
      result: { schemaVersion: 1, sessionId: "session-1", items: [] },
    }));
    installPreloadBridge({
      contextBridge: { exposeInMainWorld: (_name, exposed) => { api = exposed; } },
      ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
    });
    await api?.chatQueue.invoke({ method: "chat-queue.list", requestId: "list-1", params: { sessionId: "session-1" } });
    expect(invoke).toHaveBeenCalledWith("uclaw:chat-queue", expect.objectContaining({ method: "chat-queue.list" }));
    await expect(api?.chatQueue.invoke({ method: "chat-queue.list", requestId: "bad", params: {} })).rejects.toThrow();
  });
});
