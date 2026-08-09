import { describe, expect, it, vi } from "vitest";

import { DIAGNOSTICS_IPC_CHANNEL } from "../src/ipc/channels.js";
import { registerIpc } from "../src/ipc/register-ipc.js";

function setup(dispatchDiagnostics: (request: any) => Promise<unknown>, timeoutMs = 100) {
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
  const authorizedWebContents = { mainFrame: {} };
  registerIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: vi.fn() },
    authorizedWebContents,
    windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
    dispatchClient: vi.fn(),
    dispatchDiagnostics,
    diagnosticsTimeoutMs: timeoutMs,
  });
  return { handlers, event: { sender: authorizedWebContents, senderFrame: authorizedWebContents.mainFrame } };
}

describe("diagnostics IPC", () => {
  it("routes only validated correlated responses on its fixed channel", async () => {
    const dispatch = vi.fn(async (request: any) => ({
      method: request.method, requestId: request.requestId, ok: true,
      result: { items: [], nextCursor: null, hasMore: false },
    }));
    const { handlers, event } = setup(dispatch);
    const response = await handlers.get(DIAGNOSTICS_IPC_CHANNEL)!(event, { method: "logs.list", requestId: "logs-1", params: { limit: 100 } });
    expect(response).toMatchObject({ method: "logs.list", requestId: "logs-1", ok: true });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("rejects arbitrary methods, other senders, subframes, and malformed responses", async () => {
    const dispatch = vi.fn(async () => ({ method: "config.get", requestId: "wrong", ok: true, result: { content: "secret", entries: [], truncated: false } }));
    const { handlers, event } = setup(dispatch);
    const handler = handlers.get(DIAGNOSTICS_IPC_CHANNEL)!;
    await expect(handler(event, { method: "fs.read", requestId: "bad", params: { path: "/etc/passwd" } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(handler({ ...event, sender: {} }, { method: "system.get", requestId: "x", params: {} })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(handler({ ...event, senderFrame: {} }, { method: "system.get", requestId: "x", params: {} })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(handler(event, { method: "config.get", requestId: "expected", params: {} })).rejects.toMatchObject({ code: "UNKNOWN" });
  });

  it("times out and sends a bounded cancellation request", async () => {
    const dispatch = vi.fn(async (request: any) => {
      if (request.method === "operations.cancel") return { method: request.method, requestId: request.requestId, ok: true, result: null };
      return new Promise(() => undefined);
    });
    const { handlers, event } = setup(dispatch, 5);
    const response = await handlers.get(DIAGNOSTICS_IPC_CHANNEL)!(event, { method: "logs.export", requestId: "slow-export", params: { fileName: "safe.jsonl" } });
    expect(response).toMatchObject({ method: "logs.export", ok: false, error: { code: "TIMEOUT" } });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ method: "operations.cancel", params: { operationRequestId: "slow-export" } }));
  });

  it("converts rejected response-shaped values and oversized responses to fixed safe failures", async () => {
    const rejected = setup(async () => Promise.reject({ method: "system.get", requestId: "forged", ok: false, error: { code: "UNKNOWN", message: "secret", retryable: false, recoveryActions: [], causeDetails: {} } }));
    await expect(rejected.handlers.get(DIAGNOSTICS_IPC_CHANNEL)!(rejected.event, { method: "system.get", requestId: "real", params: {} })).rejects.toMatchObject({ code: "UNKNOWN", message: "Invalid diagnostics IPC response." });

    const huge = setup(async (request) => ({ method: request.method, requestId: request.requestId, ok: true, result: { content: "x".repeat(1_000_000), entries: Array.from({ length: 500 }, (_, index) => ({ path: `field.${index}`, value: "y".repeat(500) })), truncated: false } }));
    const response = await huge.handlers.get(DIAGNOSTICS_IPC_CHANNEL)!(huge.event, { method: "config.get", requestId: "huge", params: {} });
    expect(response).toMatchObject({ ok: false, error: { code: "FILE_TOO_LARGE" } });
  });
});
