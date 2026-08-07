import { describe, expect, it, vi } from "vitest";

import { CLIENT_IPC_CHANNEL, WINDOW_IPC_CHANNEL } from "../src/ipc/channels.js";
import { registerIpc } from "../src/ipc/register-ipc.js";

describe("registerIpc", () => {
  function setup() {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>();
    const minimize = vi.fn();
    const dispatchClient = vi.fn(async (request: { method: string; requestId: string }) => ({
      method: request.method,
      requestId: request.requestId,
      ok: true,
      result: [],
    }));
    registerIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      windowControls: {
        minimize,
        toggleMaximize: vi.fn(),
        close: vi.fn(),
      },
      dispatchClient,
    });
    return { handlers, minimize, dispatchClient };
  }

  it("registers only the fixed shared-contract channels", () => {
    const { handlers } = setup();
    expect([...handlers.keys()]).toEqual([WINDOW_IPC_CHANNEL, CLIENT_IPC_CHANNEL]);
  });

  it("rejects an arbitrary command payload with a safe UClawError", async () => {
    const { handlers, dispatchClient } = setup();
    const handler = handlers.get(CLIENT_IPC_CHANNEL)!;

    await expect(handler({}, {
      method: "exec",
      requestId: "bad-1",
      params: { command: "secret-token-value", path: "/etc/passwd" },
    })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      retryable: false,
      recoveryActions: [],
      causeDetails: {},
    });
    expect(dispatchClient).not.toHaveBeenCalled();
  });

  it("routes validated window operations separately", async () => {
    const { handlers, minimize, dispatchClient } = setup();
    const response = await handlers.get(WINDOW_IPC_CHANNEL)!({}, {
      method: "minimize",
      requestId: "window-1",
      params: {},
    });

    expect(minimize).toHaveBeenCalledOnce();
    expect(dispatchClient).not.toHaveBeenCalled();
    expect(response).toEqual({ method: "minimize", requestId: "window-1", ok: true, result: null });
  });

  it("rejects a malformed client response without exposing its secret", async () => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>();
    registerIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
      dispatchClient: vi.fn(async () => ({ token: "sk-super-secret-token" })),
    });

    const error = await handlers.get(CLIENT_IPC_CHANNEL)!({}, {
      method: "tools.list",
      requestId: "client-1",
      params: {},
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "UNKNOWN", retryable: false });
    expect(JSON.stringify(error)).not.toContain("sk-super-secret-token");
  });

  it("returns a safe failure response when a validated client operation fails", async () => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>();
    registerIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
      dispatchClient: vi.fn(async () => { throw new Error("password=hunter2 internal failure"); }),
    });

    await expect(handlers.get(CLIENT_IPC_CHANNEL)!({}, {
      method: "tools.list",
      requestId: "client-2",
      params: {},
    })).resolves.toEqual({
      method: "tools.list",
      requestId: "client-2",
      ok: false,
      error: {
        code: "UNKNOWN",
        message: "Client operation failed.",
        retryable: false,
        recoveryActions: [],
        causeDetails: {},
      },
    });
  });
});
