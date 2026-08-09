import { describe, expect, it, vi } from "vitest";

import { DIAGNOSTICS_IPC_CHANNEL } from "../src/ipc/channels.js";
import { installPreloadBridge } from "../src/ipc/preload-bridge.js";

describe("diagnostics preload bridge", () => {
  it("exposes one schema-validated diagnostics invoke function", async () => {
    let api: Record<string, any> = {};
    const invoke = vi.fn(async (_channel, request) => ({
      method: request.method,
      requestId: request.requestId,
      ok: true,
      result: { product: { name: "U-Claw", version: "0.1.0" }, runtime: { node: "24.15.0", electron: "40.10.6", openclaw: "2026.7.1-2" }, platform: "win32", architecture: "x64", gateway: { status: "ready", port: 18789 }, proxy: null, portableData: { state: "available", writable: true }, storage: { totalBytes: 100, freeBytes: 40, usedBytes: 60 } },
    }));
    installPreloadBridge({
      contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
    });
    expect(Object.keys(api.diagnostics)).toEqual(["invoke"]);
    await api.diagnostics.invoke({ method: "system.get", requestId: "system-1", params: {} });
    expect(invoke).toHaveBeenCalledWith(DIAGNOSTICS_IPC_CHANNEL, expect.objectContaining({ method: "system.get" }));
    await expect(api.diagnostics.invoke({ method: "fs.read", requestId: "bad", params: { path: "/secret" } })).rejects.toThrow();
  });
});
