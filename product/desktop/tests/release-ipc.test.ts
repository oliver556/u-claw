import { describe, expect, it, vi } from "vitest";

import { RELEASE_IPC_CHANNEL, WINDOW_IPC_CHANNEL } from "../src/ipc/channels.js";
import { registerIpc } from "../src/ipc/register-ipc.js";

function setup(dispatchRelease: (request: any) => Promise<unknown>, restart?: {
  canRestartForUpdate(operationId: string): boolean;
  restartForUpdate(): Promise<void>;
}) {
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<any>>();
  const authorizedWebContents = { mainFrame: {}, send: vi.fn() };
  registerIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: vi.fn() }, authorizedWebContents,
    windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() }, dispatchClient: vi.fn(), dispatchRelease,
    canRestartForUpdate: restart?.canRestartForUpdate, restartForUpdate: restart?.restartForUpdate });
  return { handler: handlers.get(RELEASE_IPC_CHANNEL)!, windowHandler: handlers.get(WINDOW_IPC_CHANNEL)!, event: { sender: authorizedWebContents, senderFrame: authorizedWebContents.mainFrame } };
}

describe("release IPC", () => {
  it("routes only validated correlated path-free requests", async () => {
    const dispatch = vi.fn(async (request: any) => ({ method: request.method, requestId: request.requestId, ok: true,
      result: { state: "offline", checkedAt: "2026-08-09T00:00:00.000Z", currentVersion: "0.1.0", channel: "stable", retryable: true } }));
    const { handler, event } = setup(dispatch);
    expect(await handler(event, { method: "release.check", requestId: "c1", params: { channel: "stable" } })).toMatchObject({ ok: true, result: { state: "offline" } });
    await expect(handler(event, { method: "release.check", requestId: "bad", params: { channel: "stable", url: "https://evil.invalid" } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(handler({ ...event, sender: {} }, { method: "release.check", requestId: "x", params: { channel: "stable" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects malformed or uncorrelated service responses", async () => {
    const { handler, event } = setup(async () => ({ method: "release.retry", requestId: "wrong", ok: true, result: {} }));
    await expect(handler(event, { method: "release.check", requestId: "real", params: { channel: "stable" } })).rejects.toMatchObject({ code: "UNKNOWN" });
  });

  it("restarts only an install operation authorized by the release service", async () => {
    const restartForUpdate = vi.fn(async () => undefined);
    const canRestartForUpdate = vi.fn((operationId: string) => operationId === "completed-install");
    const { windowHandler, event } = setup(vi.fn(), { canRestartForUpdate, restartForUpdate });

    await expect(windowHandler(event, {
      method: "restart-for-update", requestId: "restart-unknown", params: { operationId: "unknown" },
    })).resolves.toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(restartForUpdate).not.toHaveBeenCalled();

    await expect(windowHandler(event, {
      method: "restart-for-update", requestId: "restart-install", params: { operationId: "completed-install" },
    })).resolves.toMatchObject({ method: "restart-for-update", ok: true });
    expect(restartForUpdate).toHaveBeenCalledOnce();
  });
});
