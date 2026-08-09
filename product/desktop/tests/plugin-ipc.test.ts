import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { PLUGIN_IPC_CHANNEL } from "../src/ipc/channels.js";
import { installPreloadBridge } from "../src/ipc/preload-bridge.js";
import { registerIpc } from "../src/ipc/register-ipc.js";
import { createFixturePluginRegistryClient } from "../src/plugins/fixture-client.js";
import { createFixturePluginRuntime } from "../src/plugins/fixture-runtime.js";
import { createPluginDispatcher } from "../src/plugins/plugin-dispatcher.js";
import { createPluginService } from "../src/plugins/plugin-service.js";

function pluginService() {
  return {
    search: vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false, mode: "fixture" as const, repositoryVerified: false })),
    detail: vi.fn(), installed: vi.fn(async () => []), startInstall: vi.fn(), startUpdate: vi.fn(),
    startUninstall: vi.fn(), setEnabled: vi.fn(), operation: vi.fn(), waitForOperation: vi.fn(),
  };
}

describe("Plugin IPC", () => {
  it("projects a non-empty independent fixture catalog", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-plugin-ipc-"));
    try {
      const dispatch = createPluginDispatcher(await createPluginService({ dataDir, client: createFixturePluginRegistryClient(), runtime: createFixturePluginRuntime(dataDir) }));
      const response = await dispatch({ method: "plugins.search", requestId: "catalog", params: { query: "", cursor: null, pageSize: 20 } });
      expect(response.ok).toBe(true);
      if (!response.ok || response.method !== "plugins.search") throw new Error("Unexpected Plugin response.");
      expect(response.result.items.length).toBeGreaterThan(0);
      expect(response.result.repositoryVerified).toBe(false);
      expect(response.result.items.every((item) => item.packageKind === "plugin" && item.source.provider !== ("skillhub" as never))).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("routes validated Plugin objects and rejects renderer paths or commands", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const authorizedWebContents = { mainFrame: {} };
    const plugins = pluginService();
    registerIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: vi.fn() },
      authorizedWebContents,
      windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
      dispatchClient: vi.fn(),
      plugins,
    });
    const event = { sender: authorizedWebContents, senderFrame: authorizedWebContents.mainFrame };
    const response = await handlers.get(PLUGIN_IPC_CHANNEL)!(event, {
      method: "plugins.search", requestId: "plugins-1", params: { query: "calendar", cursor: null, pageSize: 20 },
    });
    expect(plugins.search).toHaveBeenCalledWith({ query: "calendar", cursor: null, pageSize: 20 });
    expect(response).toMatchObject({ method: "plugins.search", requestId: "plugins-1", ok: true });
    await expect(handlers.get(PLUGIN_IPC_CHANNEL)!(event, {
      method: "plugins.install", requestId: "bad", params: { slug: "openclaw-calendar", confirmation: null, path: "/tmp", command: "run" },
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(plugins.startInstall).not.toHaveBeenCalled();
  });

  it("preload exposes only a parsed Plugin invoke bridge", async () => {
    let api: Record<string, any> = {};
    const invoke = vi.fn(async (_channel: string, request: any) => ({ method: request.method, requestId: request.requestId, ok: true, result: { items: [], nextCursor: null, hasMore: false, mode: "fixture", repositoryVerified: false } }));
    installPreloadBridge({
      contextBridge: { exposeInMainWorld: (_name, exposed) => { api = exposed; } },
      ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
    });
    expect(Object.keys(api.plugins)).toEqual(["invoke"]);
    await api.plugins.invoke({ method: "plugins.search", requestId: "preload", params: { query: "", cursor: null, pageSize: 20 } });
    expect(invoke).toHaveBeenCalledWith(PLUGIN_IPC_CHANNEL, expect.objectContaining({ method: "plugins.search" }));
    await expect(api.plugins.invoke({ method: "exec", requestId: "bad", params: { command: "whoami" } })).rejects.toThrow();
  });
});
