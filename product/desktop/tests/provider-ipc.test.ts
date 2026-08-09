import { describe, expect, it, vi } from "vitest";

import * as desktop from "../src/index.js";

const snapshot = {
  schemaVersion: 1 as const,
  selectedProviderId: "openai",
  providers: [{
    id: "openai", templateId: "openai" as const, name: "OpenAI", enabled: true,
    baseUrl: "https://api.openai.com/v1", model: "gpt-5.4", apiKeyConfigured: true,
    apiKeyHint: "...cret", verification: { state: "unverified" as const },
  }],
};

function fakeStore() {
  return {
    list: vi.fn(async () => snapshot), create: vi.fn(async () => snapshot), update: vi.fn(async () => snapshot),
    remove: vi.fn(async () => snapshot), setEnabled: vi.fn(async () => snapshot), move: vi.fn(async () => snapshot),
    select: vi.fn(async () => snapshot), setApiKey: vi.fn(async () => snapshot), clearApiKey: vi.fn(async () => snapshot),
    getSelectedForRuntime: vi.fn(),
  };
}

describe("provider IPC", () => {
  it("dispatches strict provider methods without returning the submitted API key", async () => {
    const store = fakeStore();
    const create = (desktop as any).createProviderDispatcher;
    expect(create).toBeTypeOf("function");
    const dispatch = create(store);
    const response = await dispatch({
      method: "providers.set-api-key", requestId: "key-1", params: { providerId: "openai", apiKey: "sk-request-only" },
    });
    expect(store.setApiKey).toHaveBeenCalledWith("openai", "sk-request-only");
    expect(response).toMatchObject({ method: "providers.set-api-key", requestId: "key-1", ok: true });
    expect(JSON.stringify(response)).not.toContain("sk-request-only");
  });

  it("keeps verification as an explicit deferred capability", async () => {
    const dispatch = (desktop as any).createProviderDispatcher(fakeStore());
    await expect(dispatch({ method: "providers.verify", requestId: "verify-1", params: { providerId: "openai" } }))
      .rejects.toMatchObject({ code: "UNAVAILABLE", causeDetails: {} });
  });

  it("registers one authorized fixed provider channel and removes it on dispose", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const webContents = { mainFrame: {} };
    const ipcMain = { handle: vi.fn((channel: string, handler: any) => handlers.set(channel, handler)), removeHandler: vi.fn((channel: string) => handlers.delete(channel)) };
    const store = fakeStore();
    const dispose = (desktop as any).registerIpc({
      ipcMain,
      authorizedWebContents: webContents,
      windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
      dispatchClient: vi.fn(),
      providers: store,
    });
    const channel = (desktop as any).PROVIDER_IPC_CHANNEL;
    expect(channel).toBe("uclaw:providers");
    const response = await handlers.get(channel)!({ sender: webContents, senderFrame: webContents.mainFrame }, {
      method: "providers.list", requestId: "list-1", params: {},
    });
    expect(response).toEqual({ method: "providers.list", requestId: "list-1", ok: true, result: snapshot });
    await expect(handlers.get(channel)!({ sender: {}, senderFrame: {} }, {
      method: "providers.list", requestId: "forbidden-1", params: {},
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    dispose();
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(channel);
  });

  it("preload exposes only validated provider invoke on the fixed channel", async () => {
    let api: Record<string, any> | undefined;
    const invoke = vi.fn(async (_channel: string, request: any) => ({ method: request.method, requestId: request.requestId, ok: true, result: snapshot }));
    (desktop as any).installPreloadBridge({
      contextBridge: { exposeInMainWorld: (_name: string, exposed: any) => { api = exposed; } },
      ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
    });
    expect(Object.keys(api?.providers ?? {})).toEqual(["invoke"]);
    await api?.providers.invoke({ method: "providers.list", requestId: "list-1", params: {} });
    expect(invoke).toHaveBeenCalledWith("uclaw:providers", expect.objectContaining({ method: "providers.list" }));
    await expect(api?.providers.invoke({ method: "providers.read-api-key", requestId: "bad-1", params: { providerId: "openai" } })).rejects.toThrow();
    invoke.mockResolvedValueOnce({
      method: "providers.list", requestId: "malformed-1", ok: true,
      result: { schemaVersion: 1, selectedProviderId: null, providers: [{ apiKey: "stored-super-secret" }] },
    } as any);
    const error = await api?.providers.invoke({ method: "providers.list", requestId: "malformed-1", params: {} }).catch((reason: unknown) => reason);
    expect(String(error)).toContain("Invalid provider IPC response");
    expect(String(error)).not.toContain("stored-super-secret");
  });
});
