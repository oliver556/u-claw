import { describe, expect, it, vi } from "vitest";

import * as desktop from "../src/index.js";

const snapshot = {
  schemaVersion: 1, storage: { state: "healthy" as const }, runtime: { state: "unavailable" as const, reason: "locked-runtime-no-mcp-rpc" as const },
  servers: [],
};

describe("MCP IPC", () => {
  it("registers one authorized fixed MCP channel and disposes it", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const webContents = { mainFrame: {} };
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => handlers.set(channel, handler)),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    };
    const mcp = { list: vi.fn(async () => snapshot) };
    const dispose = (desktop as any).registerIpc({
      ipcMain, authorizedWebContents: webContents,
      windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
      dispatchClient: vi.fn(), mcp, mcpRuntime: { capability: () => false },
    });
    expect((desktop as any).MCP_IPC_CHANNEL).toBe("uclaw:mcp-servers");
    expect((desktop as any).IPC_CHANNELS).toContain("uclaw:mcp-servers");
    const response = await handlers.get("uclaw:mcp-servers")!(
      { sender: webContents, senderFrame: webContents.mainFrame },
      { method: "mcp.list", requestId: "list-1", params: {} },
    );
    expect(response).toEqual({ method: "mcp.list", requestId: "list-1", ok: true, result: snapshot });
    await expect(handlers.get("uclaw:mcp-servers")!({ sender: {}, senderFrame: {} }, { method: "mcp.list", requestId: "forbidden", params: {} }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    dispose();
    expect(ipcMain.removeHandler).toHaveBeenCalledWith("uclaw:mcp-servers");
  });

  it("preload exposes only validated invoke and rejects secret-bearing responses", async () => {
    let api: Record<string, any> | undefined;
    const invoke = vi.fn(async (_channel: string, request: any) => ({ method: request.method, requestId: request.requestId, ok: true, result: snapshot }));
    (desktop as any).installPreloadBridge({
      contextBridge: { exposeInMainWorld: (_name: string, exposed: any) => { api = exposed; } },
      ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
    });
    expect(Object.keys(api?.mcp ?? {})).toEqual(["invoke"]);
    await api?.mcp.invoke({ method: "mcp.list", requestId: "list-1", params: {} });
    expect(invoke).toHaveBeenCalledWith("uclaw:mcp-servers", expect.objectContaining({ method: "mcp.list" }));
    invoke.mockResolvedValueOnce({ method: "mcp.list", requestId: "leak", ok: true, result: {
      ...snapshot, servers: [{ id: "leak", name: "Leak", enabled: true, transport: "streamable-http", endpointHint: "example.com", authentication: { type: "bearer", configured: true, secret: "top-secret" }, status: "connected", capabilitySummary: { tools: 0, resources: 0, prompts: 0 }, toolNames: [], resourceSchemes: [] }],
    } } as any);
    const error = await api?.mcp.invoke({ method: "mcp.list", requestId: "leak", params: {} }).catch((reason: unknown) => reason);
    expect(String(error)).toContain("Invalid MCP IPC response");
    expect(String(error)).not.toContain("top-secret");
  });
});
