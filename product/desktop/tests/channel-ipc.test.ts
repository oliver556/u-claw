import { describe, expect, it, vi } from "vitest";

import * as desktop from "../src/index.js";

const snapshot = {
  schemaVersion: 1 as const,
  channels: [{
    id: "telegram-main", kind: "telegram" as const, name: "Telegram", mode: "bot" as const,
    configured: true, enabled: true, status: "pending-verification" as const,
    capability: "available" as const, credentialHints: { botToken: "...oken" },
  }],
};

describe("channel IPC", () => {
  it("registers one authorized fixed channel and disposes it", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const webContents = { mainFrame: {} };
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => handlers.set(channel, handler)),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    };
    const channels = {
      list: vi.fn(async () => snapshot), create: vi.fn(), update: vi.fn(), remove: vi.fn(),
      setEnabled: vi.fn(), record: vi.fn(), getForRuntime: vi.fn(),
    };
    const dispose = (desktop as any).registerIpc({
      ipcMain, authorizedWebContents: webContents,
      windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
      dispatchClient: vi.fn(), channels, channelRuntime: { capability: () => true },
    });
    expect((desktop as any).CHANNEL_IPC_CHANNEL).toBe("uclaw:managed-channels");
    const response = await handlers.get("uclaw:managed-channels")!(
      { sender: webContents, senderFrame: webContents.mainFrame },
      { method: "channels.list-managed", requestId: "list-1", params: {} },
    );
    expect(response).toEqual({ method: "channels.list-managed", requestId: "list-1", ok: true, result: snapshot });
    await expect(handlers.get("uclaw:managed-channels")!(
      { sender: {}, senderFrame: {} },
      { method: "channels.list-managed", requestId: "forbidden", params: {} },
    )).rejects.toMatchObject({ code: "FORBIDDEN" });
    dispose();
    expect(ipcMain.removeHandler).toHaveBeenCalledWith("uclaw:managed-channels");
  });

  it("preload exposes validated channel invoke and rejects secret-bearing responses", async () => {
    let api: Record<string, any> | undefined;
    const invoke = vi.fn(async (_channel: string, request: any) => ({ method: request.method, requestId: request.requestId, ok: true, result: snapshot }));
    (desktop as any).installPreloadBridge({
      contextBridge: { exposeInMainWorld: (_name: string, exposed: any) => { api = exposed; } },
      ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
    });
    expect(Object.keys(api?.channels ?? {})).toEqual(["invoke"]);
    await api?.channels.invoke({ method: "channels.list-managed", requestId: "list-1", params: {} });
    expect(invoke).toHaveBeenCalledWith("uclaw:managed-channels", expect.objectContaining({ method: "channels.list-managed" }));

    invoke.mockResolvedValueOnce({
      method: "channels.list-managed", requestId: "bad-response", ok: true,
      result: { schemaVersion: 1, channels: [{ ...(snapshot.channels[0] as Record<string, unknown>), credentials: { botToken: "full-secret-token" } }] },
    } as any);
    const error = await api?.channels.invoke({ method: "channels.list-managed", requestId: "bad-response", params: {} }).catch((reason: unknown) => reason);
    expect(String(error)).toContain("Invalid channel IPC response");
    expect(String(error)).not.toContain("full-secret-token");
  });

  it("serializes channel logout, send, action, and poll as writes", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const webContents = { mainFrame: {} };
    const coordinateWrite = vi.fn(async <T>(operation: () => Promise<T>) => operation());
    const stored = { id: "discord-main", kind: "discord", name: "Discord", mode: "bot", enabled: true, credentials: { botToken: "secret" } } as const;
    const channels = {
      getForRuntime: vi.fn(async () => stored),
      record: vi.fn(async () => snapshot),
    };
    const channelRuntime = {
      capability: () => true,
      logout: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      action: vi.fn(async () => undefined),
      poll: vi.fn(async () => undefined),
    };
    const dispose = (desktop as any).registerIpc({
      ipcMain: { handle: (channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => handlers.set(channel, handler), removeHandler: vi.fn() },
      authorizedWebContents: webContents,
      windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
      dispatchClient: vi.fn(), channels, channelRuntime, coordinateWrite,
    });
    const requests = [
      { method: "channels.logout", requestId: "logout-1", params: { channelId: "discord-main" } },
      { method: "channels.send", requestId: "send-1", params: { channelId: "discord-main", target: "channel:1", message: "hello" } },
      { method: "channels.action", requestId: "action-1", params: { channelId: "discord-main", target: "channel:1", action: "react", messageId: "message-1", emoji: ":thumbsup:" } },
      { method: "channels.poll", requestId: "poll-1", params: { channelId: "discord-main", target: "channel:1", question: "Ship?", options: ["Yes", "No"], multiple: false } },
    ];
    for (const request of requests) {
      await handlers.get("uclaw:managed-channels")!({ sender: webContents, senderFrame: webContents.mainFrame }, request);
    }
    expect(coordinateWrite).toHaveBeenCalledTimes(4);
    dispose();
  });
});
