import { describe, expect, it, vi } from "vitest";
import { MockUClawClient } from "@uclaw/adapter";

import { ATTACHMENT_IPC_CHANNEL, CLIENT_IPC_CHANNEL, WINDOW_IPC_CHANNEL } from "../src/ipc/channels.js";
import { registerIpc } from "../src/ipc/register-ipc.js";

describe("registerIpc", () => {
  function setup() {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>();
    const removeHandler = vi.fn((channel: string) => handlers.delete(channel));
    const mainFrame = {};
    const authorizedWebContents = { mainFrame };
    const minimize = vi.fn();
    const openAdvancedConsole = vi.fn();
    const dispatchClient = vi.fn(async (request: { method: string; requestId: string }) => ({
      method: request.method,
      requestId: request.requestId,
      ok: true,
      result: [],
    }));
    const dispose = registerIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler },
      authorizedWebContents,
      windowControls: {
        minimize,
        toggleMaximize: vi.fn(),
        close: vi.fn(),
        openAdvancedConsole,
      },
      dispatchClient,
    });
    const event = { sender: authorizedWebContents, senderFrame: mainFrame };
    return { handlers, minimize, openAdvancedConsole, dispatchClient, dispose, removeHandler, event, authorizedWebContents };
  }

  it("registers only the fixed shared-contract channels", () => {
    const { handlers } = setup();
    expect([...handlers.keys()]).toEqual([WINDOW_IPC_CHANNEL, CLIENT_IPC_CHANNEL]);
  });

  it("routes streaming attachment imports through the frozen IPC contract", async () => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>();
    const authorizedWebContents = { mainFrame: {} };
    const attachments = {
      import: vi.fn(), get: vi.fn(), prepare: vi.fn(), cancel: vi.fn(), remove: vi.fn(),
      beginImport: vi.fn(async () => ({ importId: "import-1" })),
      importChunk: vi.fn(async () => ({ nextOffset: 4 })),
      finishImport: vi.fn(async () => ({ id: "attachment-1", file: { id: "attachment-1", name: "a.png", mediaType: "image/png", size: 4, kind: "attachment" as const }, category: "image" as const, state: "ready" as const })),
    };
    registerIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: vi.fn() },
      authorizedWebContents,
      windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
      dispatchClient: vi.fn(), attachments,
    });
    const event = { sender: authorizedWebContents, senderFrame: authorizedWebContents.mainFrame };
    await handlers.get(ATTACHMENT_IPC_CHANNEL)!(event, { method: "import.begin", requestId: "b", params: { name: "a.png", mediaType: "image/png", size: 4 } });
    await handlers.get(ATTACHMENT_IPC_CHANNEL)!(event, { method: "import.chunk", requestId: "c", params: { importId: "import-1", offset: 0, contentBase64: "YWJjZA==" } });
    const result = await handlers.get(ATTACHMENT_IPC_CHANNEL)!(event, { method: "import.finish", requestId: "f", params: { importId: "import-1" } });
    expect(attachments.beginImport).toHaveBeenCalledOnce();
    expect(attachments.importChunk).toHaveBeenCalledOnce();
    expect(attachments.finishImport).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ method: "import.finish", ok: true, result: { id: "attachment-1" } });
  });

  it("rejects an arbitrary command payload with a safe UClawError", async () => {
    const { handlers, dispatchClient, event } = setup();
    const handler = handlers.get(CLIENT_IPC_CHANNEL)!;

    await expect(handler(event, {
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
    const { handlers, minimize, dispatchClient, event } = setup();
    const response = await handlers.get(WINDOW_IPC_CHANNEL)!(event, {
      method: "minimize",
      requestId: "window-1",
      params: {},
    });

    expect(minimize).toHaveBeenCalledOnce();
    expect(dispatchClient).not.toHaveBeenCalled();
    expect(response).toEqual({ method: "minimize", requestId: "window-1", ok: true, result: null });
  });

  it("opens the advanced console without accepting a renderer URL", async () => {
    const { handlers, openAdvancedConsole, event } = setup();
    await handlers.get(WINDOW_IPC_CHANNEL)!(event, {
      method: "open-advanced-console", requestId: "console-1", params: {},
    });
    expect(openAdvancedConsole).toHaveBeenCalledOnce();
  });

  it("waits for advanced console loading failures and returns a safe response", async () => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>();
    const authorizedWebContents = { mainFrame: {} };
    registerIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: vi.fn() },
      authorizedWebContents,
      windowControls: {
        minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn(),
        openAdvancedConsole: vi.fn(async () => { throw new Error("http://127.0.0.1:18789 secret"); }),
      },
      dispatchClient: vi.fn(),
    });

    await expect(handlers.get(WINDOW_IPC_CHANNEL)!({ sender: authorizedWebContents, senderFrame: authorizedWebContents.mainFrame }, {
      method: "open-advanced-console", requestId: "console-failed", params: {},
    })).resolves.toMatchObject({ method: "open-advanced-console", ok: false, error: { code: "OPERATION_FAILED" } });
  });

  it("injects a UClawClient behind the validated client channel", async () => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>();
    const authorizedWebContents = { mainFrame: {}, send: vi.fn() };
    const fallback = vi.fn();
    const client = new MockUClawClient();
    await client.gateway.negotiate();
    registerIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: vi.fn() },
      authorizedWebContents,
      windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
      dispatchClient: fallback,
      client,
    });

    const response = await handlers.get(CLIENT_IPC_CHANNEL)!({ sender: authorizedWebContents, senderFrame: authorizedWebContents.mainFrame }, {
      method: "sessions.list", requestId: "real-client-1", params: {},
    });
    expect(response).toMatchObject({ method: "sessions.list", ok: true, result: { items: expect.any(Array) } });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("keeps model routing in main while renderer sends only the chat contract", async () => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>();
    const authorizedWebContents = { mainFrame: {}, send: vi.fn() };
    const client = new MockUClawClient();
    await client.gateway.negotiate();
    const routeChatSend = vi.fn(async () => (async function* () {
      yield { type: "started" as const, runId: "run-routed", sessionId: "session-1" };
    })());
    registerIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: vi.fn() },
      authorizedWebContents,
      windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
      dispatchClient: vi.fn(),
      client,
      routeChatSend,
    });

    const response = await handlers.get(CLIENT_IPC_CHANNEL)!({ sender: authorizedWebContents, senderFrame: authorizedWebContents.mainFrame }, {
      method: "chat.send", requestId: "routed-chat", params: {
        sessionId: "session-1", clientRequestId: "renderer-request",
        blocks: [{ type: "text", text: "hello", format: "plain" }],
      },
    });
    expect(response).toMatchObject({ ok: true, result: { runId: "run-routed" } });
    expect(routeChatSend).toHaveBeenCalledOnce();
    expect(JSON.stringify(routeChatSend.mock.calls[0])).not.toMatch(/endpoint|username|tokenSecret|authorization/iu);
  });

  it("rejects requests from another sender and from subframes", async () => {
    const { handlers, dispatchClient, event, authorizedWebContents } = setup();
    const payload = { method: "tools.list", requestId: "client-auth", params: {} };

    await expect(handlers.get(CLIENT_IPC_CHANNEL)!({ ...event, sender: {} }, payload))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(handlers.get(CLIENT_IPC_CHANNEL)!({
      sender: authorizedWebContents,
      senderFrame: {},
    }, payload)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(dispatchClient).not.toHaveBeenCalled();
  });

  it("removes both fixed handlers when disposed", () => {
    const { dispose, handlers, removeHandler } = setup();
    dispose();
    dispose();

    expect(removeHandler.mock.calls).toEqual([
      [WINDOW_IPC_CHANNEL],
      [CLIENT_IPC_CHANNEL],
    ]);
    expect(handlers.size).toBe(0);
  });

  it("rejects a malformed client response without exposing its secret", async () => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>();
    const authorizedWebContents = { mainFrame: undefined };
    registerIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: vi.fn() },
      authorizedWebContents,
      windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
      dispatchClient: vi.fn(async () => ({ token: ["sk", "super", "secret", "token"].join("-") })),
    });

    const error = await handlers.get(CLIENT_IPC_CHANNEL)!({
      sender: authorizedWebContents,
      senderFrame: undefined,
    }, {
      method: "tools.list",
      requestId: "client-1",
      params: {},
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "UNKNOWN", retryable: false });
    expect(JSON.stringify(error)).not.toContain("sk-super-secret-token");
  });

  it("returns a safe failure response when a validated client operation fails", async () => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>();
    const authorizedWebContents = { mainFrame: undefined };
    registerIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: vi.fn() },
      authorizedWebContents,
      windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
      dispatchClient: vi.fn(async () => { throw new Error("password=hunter2 internal failure"); }),
    });

    await expect(handlers.get(CLIENT_IPC_CHANNEL)!({
      sender: authorizedWebContents,
      senderFrame: undefined,
    }, {
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

  it("does not trust renderer-unsafe text inside an otherwise valid UClawError", async () => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>();
    const authorizedWebContents = { mainFrame: undefined };
    registerIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: vi.fn() },
      authorizedWebContents,
      windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
      dispatchClient: vi.fn(async () => { throw {
        code: "OPERATION_FAILED", message: "Run rm -rf /private/work via http://127.0.0.1:18789", retryable: true,
        recoveryActions: ["retry"], causeDetails: { operation: "cwd=/private/work" }, correlationId: "sk-secret-token",
      }; }),
    });

    const response = await handlers.get(CLIENT_IPC_CHANNEL)!({ sender: authorizedWebContents, senderFrame: undefined }, {
      method: "tools.list", requestId: "client-valid-unsafe", params: {},
    });
    expect(response).toMatchObject({
      ok: false,
      error: { code: "OPERATION_FAILED", message: "Client operation failed.", retryable: true, recoveryActions: ["retry"], causeDetails: {} },
    });
    expect(JSON.stringify(response)).not.toMatch(/rm -rf|\/private\/work|127\.0\.0\.1|sk-secret-token/);
  });

  it("projects a resolved failure response before returning it to renderer", async () => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>();
    const authorizedWebContents = { mainFrame: undefined };
    registerIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: vi.fn() },
      authorizedWebContents,
      windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
      dispatchClient: vi.fn(async () => ({
        method: "tools.list", requestId: "client-resolved-unsafe", ok: false,
        error: {
          code: "OPERATION_FAILED", message: "Run rm -rf /private/work via http://127.0.0.1:18789", retryable: true,
          recoveryActions: ["retry"], causeDetails: { operation: "cwd=/private/work" }, correlationId: "sk-secret-token",
        },
      })),
    });

    const response = await handlers.get(CLIENT_IPC_CHANNEL)!({ sender: authorizedWebContents, senderFrame: undefined }, {
      method: "tools.list", requestId: "client-resolved-unsafe", params: {},
    });
    expect(response).toMatchObject({
      ok: false,
      error: { code: "OPERATION_FAILED", message: "Client operation failed.", retryable: true, recoveryActions: ["retry"], causeDetails: {} },
    });
    expect(JSON.stringify(response)).not.toMatch(/rm -rf|\/private\/work|127\.0\.0\.1|sk-secret-token/);
  });

  it("projects nested errors in resolved success responses from the fallback dispatcher", async () => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>();
    const authorizedWebContents = { mainFrame: undefined };
    const unsafeSummary = {
      code: "OPERATION_FAILED", message: "Run rm -rf /private/work via http://127.0.0.1:18789", retryable: true,
    };
    const unsafeError = {
      ...unsafeSummary, recoveryActions: ["retry"], causeDetails: { operation: "cwd=/private/work" }, correlationId: "sk-secret-token",
    };
    const results: Record<string, unknown> = {
      "gateway.get-status": {
        connectionState: "failed", protocolVersion: 4, phase: "failed", processAlive: false, serviceReady: false,
        businessAvailable: false, since: "2026-08-08T08:00:00.000Z", attempt: 1,
        usb: { state: "available", dataWritable: true }, error: unsafeError,
      },
      "models.list": [{ id: "model-1", label: "Model", providerId: "provider-1", available: false, locality: "cloud", capabilities: ["text"], unavailableReason: unsafeSummary }],
      "channels.list": [{ id: "channel-1", kind: "telegram", name: "Telegram", configured: true, enabled: true, state: "error", error: unsafeSummary }],
      "diagnostics.list": [{ id: "diagnostic-1", label: "Gateway", state: "failed", repairable: true, error: unsafeSummary }],
    };
    registerIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: vi.fn() },
      authorizedWebContents,
      windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
      dispatchClient: vi.fn(async (request) => ({
        method: request.method, requestId: request.requestId, ok: true, result: results[request.method],
      })),
    });

    const responses = [];
    for (const [index, method] of Object.keys(results).entries()) {
      responses.push(await handlers.get(CLIENT_IPC_CHANNEL)!({ sender: authorizedWebContents, senderFrame: undefined }, {
        method, requestId: `client-success-${index}`, params: {},
      }));
    }
    const serialized = JSON.stringify(responses);
    expect(serialized.match(/Client operation failed\./g)).toHaveLength(4);
    expect(serialized).not.toMatch(/rm -rf|\/private\/work|127\.0\.0\.1|sk-secret-token/);
  });
});
