import { describe, expect, it, vi } from "vitest";

import { registerIpc } from "../src/ipc/register-ipc.js";
import { installPreloadBridge } from "../src/ipc/preload-bridge.js";

describe("data IPC", () => {
  it("registers one validated data channel and rejects unauthorized senders", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const authorizedWebContents = { mainFrame: {} };
    const dispatchData = vi.fn(async (request: any) => ({
      method: request.method,
      requestId: request.requestId,
      ok: true,
      result: { items: [], nextCursor: null, hasMore: false },
    }));
    const ipcMain = { handle: vi.fn((channel: string, handler: any) => handlers.set(channel, handler)), removeHandler: vi.fn() };
    const dispose = registerIpc({
      ipcMain,
      authorizedWebContents,
      windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
      dispatchClient: vi.fn(),
      dispatchData,
    });

    expect(handlers.has("uclaw:data")).toBe(true);
    await expect(handlers.get("uclaw:data")!({ sender: {}, senderFrame: {} }, {
      method: "workspace.list", requestId: "bad", params: { limit: 20 },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(handlers.get("uclaw:data")!({ sender: authorizedWebContents, senderFrame: authorizedWebContents.mainFrame }, {
      method: "workspace.list", requestId: "ok", params: { limit: 20 },
    })).resolves.toMatchObject({ ok: true, method: "workspace.list" });
    await expect(handlers.get("uclaw:data")!({ sender: authorizedWebContents, senderFrame: authorizedWebContents.mainFrame }, {
      method: "workspace.read", requestId: "path", params: { entryId: "C:\\secret.txt" },
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(dispatchData).toHaveBeenCalledOnce();
    dispose();
    expect(ipcMain.removeHandler).toHaveBeenCalledWith("uclaw:data");
  });

  it("preload exposes only a schema-checked data invoke method", async () => {
    let api: any;
    const invoke = vi.fn(async (_channel: string, request: any) => ({
      method: request.method, requestId: request.requestId, ok: true,
      result: { items: [], nextCursor: null, hasMore: false },
    }));
    installPreloadBridge({
      contextBridge: { exposeInMainWorld: (_name, exposed) => { api = exposed; } },
      ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
    });
    await api.data.invoke({ method: "workspace.list", requestId: "list", params: { limit: 20 } });
    expect(invoke).toHaveBeenCalledWith("uclaw:data", expect.objectContaining({ method: "workspace.list" }));
    await expect(api.data.invoke({ method: "workspace.read", requestId: "bad", params: { entryId: "../secret" } })).rejects.toThrow();
    expect(invoke).toHaveBeenCalledOnce();
    expect(Object.keys(api.data)).toEqual(["invoke"]);
  });
});
