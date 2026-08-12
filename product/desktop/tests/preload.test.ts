import { describe, expect, it, vi } from "vitest";

import {
  AUTOMATION_IPC_CHANNEL,
  CLIENT_IPC_CHANNEL,
  CLIENT_IPC_EVENT_CHANNEL,
  IPC_CHANNELS,
  RELEASE_IPC_CHANNEL,
  PRODUCT_SERVICES_IPC_CHANNEL,
  SESSION_ADVANCED_IPC_CHANNEL,
  SYSTEM_NODE_IPC_CHANNEL,
  SYSTEM_NODE_IPC_EVENT_CHANNEL,
  SYSTEM_VOICE_IPC_CHANNEL,
  TASK_ARTIFACT_EVENT_CHANNEL,
  TASK_ARTIFACT_IPC_CHANNEL,
  USAGE_IPC_CHANNEL,
  WINDOW_MAXIMIZED_EVENT_CHANNEL,
  WINDOW_IPC_CHANNEL,
} from "../src/ipc/channels.js";
import { installPreloadBridge } from "../src/ipc/preload-bridge.js";

describe("installPreloadBridge", () => {
  it("registers release in the fixed IPC channel inventory", () => {
    expect(IPC_CHANNELS).toContain(RELEASE_IPC_CHANNEL);
    expect(IPC_CHANNELS).toContain(AUTOMATION_IPC_CHANNEL);
    expect(IPC_CHANNELS).toContain(TASK_ARTIFACT_IPC_CHANNEL);
    expect(IPC_CHANNELS).toContain(SYSTEM_NODE_IPC_CHANNEL);
    expect(IPC_CHANNELS).toContain(SYSTEM_VOICE_IPC_CHANNEL);
    expect(IPC_CHANNELS).toContain(PRODUCT_SERVICES_IPC_CHANNEL);
  });

  it("exposes only fixed window and client contract methods", async () => {
    const invoke = vi.fn(async (_channel: string, request: unknown) => {
      const { method, requestId } = request as { method: string; requestId: string };
      if (method === "sessions.files.list") {
        return { method, requestId, ok: true, result: { sessionId: "agent:main:main", files: [] } };
      }
      if (method === "usage.session-logs") {
        return { method, requestId, ok: true, result: [] };
      }
      if (method === "product.authority.read") {
        return { method, requestId, ok: true, result: {
          license: { status: "active", revision: 1, expiresAt: "2027-08-01T00:00:00.000Z" },
          product: { status: "active", generation: 1, userStatus: "active" },
          service: { state: "enabled", revision: 1, reasonCode: "OPERATOR_ENABLED" },
          policy: { quota: { unit: "tokens", limit: 100, period: "monthly" }, rateLimit: { requestsPerMinute: 60, concurrentRequests: 2 }, allowedModels: ["builtin/model"], disabled: false },
          usage: { consumed: 25, remaining: 75, resetAt: null, updatedAt: "2026-08-12T00:00:00.000Z" },
        } };
      }
      return { method, requestId, ok: true, result: null };
    });
    let api: Record<string, unknown> | undefined;
    const on = vi.fn();
    const removeListener = vi.fn();

    installPreloadBridge({
      contextBridge: {
        exposeInMainWorld: (_name, exposed) => {
          api = exposed;
        },
      },
      ipcRenderer: { invoke, on, removeListener },
    });

    expect(Object.keys(api ?? {})).toEqual(["window", "client", "attachments", "providers", "skills", "plugins", "channels", "mcp", "sessionAdvanced", "usage", "automation", "taskArtifacts", "systemNode", "systemVoice", "productServices", "data", "diagnostics", "release"]);
    expect(api).not.toHaveProperty("ipcRenderer");
    expect(api).not.toHaveProperty("invoke");
    expect(Object.keys(api?.client as object)).toEqual(["invoke", "subscribe"]);
    expect(Object.keys(api?.window as object)).toEqual(["invoke", "onMaximizedChange"]);
    expect(Object.keys(api?.providers as object)).toEqual(["invoke"]);
    expect(Object.keys(api?.skills as object)).toEqual(["invoke"]);
    expect(Object.keys(api?.plugins as object)).toEqual(["invoke"]);
    expect(Object.keys(api?.channels as object)).toEqual(["invoke"]);
    expect(Object.keys(api?.mcp as object)).toEqual(["invoke"]);
    expect(Object.keys(api?.sessionAdvanced as object)).toEqual(["invoke"]);
    expect(Object.keys(api?.usage as object)).toEqual(["invoke"]);
    expect(Object.keys(api?.automation as object)).toEqual(["invoke"]);
    expect(Object.keys(api?.taskArtifacts as object)).toEqual(["invoke", "subscribe"]);
    expect(Object.keys(api?.systemNode as object)).toEqual(["invoke", "subscribe"]);
    expect(Object.keys(api?.systemVoice as object)).toEqual(["invoke"]);
    expect(Object.keys(api?.productServices as object)).toEqual(["readAuthority"]);
    expect(Object.keys(api?.data as object)).toEqual(["invoke"]);
    expect(Object.keys(api?.diagnostics as object)).toEqual(["invoke"]);
    expect(Object.keys(api?.release as object)).toEqual(["invoke"]);

    await (api?.window as { invoke: (request: unknown) => Promise<unknown> }).invoke({
      method: "minimize",
      requestId: "window-1",
      params: {},
    });
    expect(invoke).toHaveBeenLastCalledWith(WINDOW_IPC_CHANNEL, expect.any(Object));

    await (api?.sessionAdvanced as { invoke: (request: unknown) => Promise<unknown> }).invoke({
      method: "sessions.files.list",
      requestId: "advanced-1",
      params: { sessionId: "agent:main:main" },
    });
    expect(invoke).toHaveBeenLastCalledWith(SESSION_ADVANCED_IPC_CHANNEL, expect.any(Object));

    await (api?.usage as { invoke: (request: unknown) => Promise<unknown> }).invoke({
      method: "usage.session-logs",
      requestId: "usage-1",
      params: { sessionKey: "agent:main:session-1" },
    });
    expect(invoke).toHaveBeenLastCalledWith(USAGE_IPC_CHANNEL, expect.any(Object));

    await (api?.automation as { invoke: (request: unknown) => Promise<unknown> }).invoke({ method: "agents.list", requestId: "automation-1", params: {} });
    expect(invoke).toHaveBeenLastCalledWith(AUTOMATION_IPC_CHANNEL, expect.any(Object));

    await (api?.taskArtifacts as { invoke: (request: unknown) => Promise<unknown> }).invoke({ method: "tasks.list", requestId: "tasks-1", params: {} });
    expect(invoke).toHaveBeenLastCalledWith(TASK_ARTIFACT_IPC_CHANNEL, expect.any(Object));
    const taskListener = vi.fn();
    const unsubscribeTasks = (api?.taskArtifacts as { subscribe: (listener: (event: unknown) => void) => () => void }).subscribe(taskListener);
    expect(on).toHaveBeenCalledWith(TASK_ARTIFACT_EVENT_CHANNEL, expect.any(Function));
    unsubscribeTasks();
    expect(removeListener).toHaveBeenCalledWith(TASK_ARTIFACT_EVENT_CHANNEL, expect.any(Function));

    await (api?.systemNode as { invoke: (request: unknown) => Promise<unknown> }).invoke({ method: "environments.list", requestId: "system-node-1", params: {} });
    expect(invoke).toHaveBeenLastCalledWith(SYSTEM_NODE_IPC_CHANNEL, expect.any(Object));
    const systemNodeListener = vi.fn();
    const unsubscribeSystemNode = (api?.systemNode as { subscribe: (listener: (event: unknown) => void) => () => void }).subscribe(systemNodeListener);
    expect(on).toHaveBeenCalledWith(SYSTEM_NODE_IPC_EVENT_CHANNEL, expect.any(Function));
    unsubscribeSystemNode();
    expect(removeListener).toHaveBeenCalledWith(SYSTEM_NODE_IPC_EVENT_CHANNEL, expect.any(Function));

    await (api?.systemVoice as { invoke: (request: unknown) => Promise<unknown> }).invoke({ method: "talk.runtime.status", requestId: "system-voice-1", params: {} });
    expect(invoke).toHaveBeenLastCalledWith(SYSTEM_VOICE_IPC_CHANNEL, expect.any(Object));

    await (api?.productServices as { readAuthority: (request: unknown) => Promise<unknown> }).readAuthority({ method: "product.authority.read", requestId: "product-1", params: {} });
    expect(invoke).toHaveBeenLastCalledWith(PRODUCT_SERVICES_IPC_CHANNEL, expect.any(Object));
    await expect((api?.productServices as { readAuthority: (request: unknown) => Promise<unknown> }).readAuthority({ method: "product.provision", requestId: "product-write", params: {} })).rejects.toThrow();

    await expect((api?.usage as { invoke: (request: unknown) => Promise<unknown> }).invoke({
      method: "usage.session-logs",
      requestId: "usage-bad",
      params: { sessionKey: "" },
    })).rejects.toThrow();

    await expect(
      (api?.client as { invoke: (request: unknown) => Promise<unknown> }).invoke({
        method: "exec",
        requestId: "client-1",
        params: { command: "rm -rf /" },
      }),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalledWith(CLIENT_IPC_CHANNEL, expect.objectContaining({ method: "exec" }));
  });

  it("subscribes to fixed maximize state events and cleans up the exact listener", () => {
    let maximizeListener: ((_event: unknown, payload: unknown) => void) | undefined;
    const on = vi.fn((channel: string, listener: typeof maximizeListener) => {
      if (channel === WINDOW_MAXIMIZED_EVENT_CHANNEL) maximizeListener = listener;
    });
    const removeListener = vi.fn();
    const reportInvalidEvent = vi.fn();
    let api: Record<string, unknown> | undefined;
    installPreloadBridge({
      contextBridge: { exposeInMainWorld: (_name, exposed) => { api = exposed; } },
      ipcRenderer: { invoke: vi.fn(), on, removeListener },
      reportInvalidEvent,
    });
    const receive = vi.fn();
    const unsubscribe = (api?.window as {
      onMaximizedChange(listener: (maximized: boolean) => void): () => void;
    }).onMaximizedChange(receive);

    maximizeListener?.({}, true);
    maximizeListener?.({}, "true");
    expect(receive).toHaveBeenCalledOnce();
    expect(receive).toHaveBeenCalledWith(true);
    expect(reportInvalidEvent).toHaveBeenCalledWith(expect.objectContaining({
      message: "Invalid window maximized event.",
    }));

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(WINDOW_MAXIMIZED_EVENT_CHANNEL, maximizeListener);
  });

  it("parses events on one fixed channel and removes the exact listener on unsubscribe", () => {
    let eventListener: ((_event: unknown, payload: unknown) => void) | undefined;
    const on = vi.fn((channel: string, listener: typeof eventListener) => {
      expect(channel).toBe(CLIENT_IPC_EVENT_CHANNEL);
      eventListener = listener;
    });
    const removeListener = vi.fn();
    let api: Record<string, unknown> | undefined;
    installPreloadBridge({
      contextBridge: { exposeInMainWorld: (_name, exposed) => { api = exposed; } },
      ipcRenderer: { invoke: vi.fn(), on, removeListener },
    });
    const receive = vi.fn();
    const unsubscribe = (api?.client as {
      subscribe(listener: (event: unknown) => void): () => void;
    }).subscribe(receive);
    const validEvent = {
      event: "chat.send-event",
      clientRequestId: "client-1",
      payload: { type: "delta", runId: "run-1", mode: "append", text: "hello" },
    };

    eventListener?.({}, validEvent);
    expect(receive).toHaveBeenCalledWith(validEvent);
    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(CLIENT_IPC_EVENT_CHANNEL, eventListener);
  });

  it("drops invalid events and reports only a safe validation error", () => {
    let eventListener: ((_event: unknown, payload: unknown) => void) | undefined;
    const reportInvalidEvent = vi.fn();
    let api: Record<string, unknown> | undefined;
    installPreloadBridge({
      contextBridge: { exposeInMainWorld: (_name, exposed) => { api = exposed; } },
      ipcRenderer: {
        invoke: vi.fn(),
        on: (_channel, listener) => { eventListener = listener; },
        removeListener: vi.fn(),
      },
      reportInvalidEvent,
    });
    const receive = vi.fn();
    (api?.client as { subscribe(listener: (event: unknown) => void): () => void }).subscribe(receive);

    eventListener?.({}, { event: "process.exec", token: "secret-value" });
    expect(receive).not.toHaveBeenCalled();
    expect(reportInvalidEvent).toHaveBeenCalledWith(expect.objectContaining({
      message: "Invalid client IPC event.",
    }));
    expect(JSON.stringify(reportInvalidEvent.mock.calls)).not.toContain("secret-value");
  });
});
