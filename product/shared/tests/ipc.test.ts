import { describe, expect, it } from "vitest";

import {
  ClientIpcEventSchema,
  ClientIpcRequestSchema,
  ClientIpcSuccessResponseSchema,
  IpcResponseSchema,
  WindowIpcRequestSchema,
} from "../src/index.js";

describe("IPC contracts", () => {
  it("keeps window control separate from client methods", () => {
    expect(WindowIpcRequestSchema.parse({ method: "minimize", requestId: "request-1", params: {} })).toBeTruthy();
    expect(() => ClientIpcRequestSchema.parse({ method: "minimize", requestId: "request-1", params: {} })).toThrow();
  });

  it("parses a typed window failure response", () => {
    expect(IpcResponseSchema.parse({
      method: "close",
      requestId: "request-1",
      ok: false,
      error: {
        code: "OPERATION_FAILED",
        message: "窗口关闭失败",
        retryable: true,
        recoveryActions: ["retry"],
        causeDetails: { operation: "window.close" },
      },
    })).toBeTruthy();
  });

  it("expresses every public client method as an explicit request", () => {
    const requests = [
      ["gateway.negotiate", {}], ["gateway.get-status", {}], ["gateway.watch-status", { subscriptionId: "sub-1" }], ["gateway.reconnect", {}],
      ["sessions.list", {}], ["sessions.get", { sessionId: "s" }], ["sessions.create", {}], ["sessions.remove", { sessionId: "s" }],
      ["chat.list", { sessionId: "s" }], ["chat.get", { sessionId: "s", messageId: "m" }], ["chat.watch", { sessionId: "s", subscriptionId: "sub-2" }],
      ["chat.send", { sessionId: "s", clientRequestId: "c", blocks: [{ type: "text", text: "hi", format: "plain" }] }], ["chat.abort", { runId: "r" }],
      ["tools.list", {}], ["tools.get-call", { toolCallId: "t" }], ["approvals.list-pending", {}],
      ["approvals.resolve-exec", { family: "exec", requestId: "a", decision: "deny" }], ["approvals.resolve-plugin", { family: "plugin", requestId: "a", decision: "deny" }],
      ["models.list", {}], ["models.select-for-session", { sessionId: "s", modelId: "m" }], ["skills.list", {}], ["channels.list", {}],
      ["files.list", {}], ["files.read-text", { fileId: "f" }], ["diagnostics.list", {}], ["diagnostics.list-logs", {}],
    ] as const;

    for (const [method, params] of requests) {
      expect(ClientIpcRequestSchema.parse({ method, requestId: `request-${method}`, params })).toBeTruthy();
    }
  });

  it("returns a typed accepted result for chat sends", () => {
    expect(ClientIpcSuccessResponseSchema.parse({ method: "chat.send", requestId: "request-1", ok: true, result: { clientRequestId: "client-1", runId: "run-1" } })).toBeTruthy();
  });

  it("routes concurrent sends in one session by clientRequestId", () => {
    const first = ClientIpcEventSchema.parse({ event: "chat.send-event", subscriptionId: "sub-1", clientRequestId: "client-1", payload: { type: "delta", runId: "run-1", mode: "append", text: "a" } });
    const second = ClientIpcEventSchema.parse({ event: "chat.send-event", subscriptionId: "sub-1", clientRequestId: "client-2", payload: { type: "delta", runId: "run-2", mode: "append", text: "b" } });

    expect(first).toMatchObject({ clientRequestId: "client-1" });
    expect(second).toMatchObject({ clientRequestId: "client-2" });
  });

  it("rejects cross-family approval routing", () => {
    expect(() => ClientIpcRequestSchema.parse({ method: "approvals.resolve-exec", requestId: "request-1", params: { family: "plugin", requestId: "same-id", decision: "deny" } })).toThrow();
    expect(() => ClientIpcRequestSchema.parse({ method: "approvals.resolve-plugin", requestId: "request-2", params: { family: "exec", requestId: "same-id", decision: "deny" } })).toThrow();
  });

  it("rejects unsafe paths and plaintext secrets in responses and events", () => {
    expect(() => ClientIpcSuccessResponseSchema.parse({ method: "files.read-text", requestId: "request-1", ok: true, result: { file: { id: "f", name: "x", mediaType: "text/plain", size: 1, kind: "workspace", entryType: "file", modifiedAt: "2026-08-07T00:00:00.000Z", writable: false, relativePath: "../secret" }, content: "x", encoding: "utf-8" } })).toThrow();
    expect(() => ClientIpcSuccessResponseSchema.parse({ method: "channels.list", requestId: "request-2", ok: true, result: [{ id: "c", kind: "telegram", name: "Channel", configured: true, enabled: true, state: "connected", fields: [{ key: "credential", label: "Key", kind: "secret", required: true, secret: { state: "configured" }, value: "plaintext" }] }] })).toThrow();
    expect(() => ClientIpcEventSchema.parse({
      event: "chat.send-event",
      subscriptionId: "sub-1",
      clientRequestId: "client-1",
      payload: {
        type: "final",
        runId: "run-1",
        message: {
          id: "message-1",
          sessionId: "session-1",
          runId: "run-1",
          role: "assistant",
          status: "completed",
          blocks: [{ id: "block-1", type: "file", file: { id: "f", name: "x", mediaType: "text/plain", size: 1, kind: "workspace", relativePath: "C:\\secret" } }],
          createdAt: "2026-08-07T00:00:00.000Z",
        },
      },
    })).toThrow();
  });

  it("rejects extra sensitive fields on strict objects", () => {
    expect(() => ClientIpcRequestSchema.parse({ method: "gateway.get-status", requestId: "request-1", params: { token: "secret" } })).toThrow();
    expect(() => ClientIpcSuccessResponseSchema.parse({ method: "chat.abort", requestId: "request-2", ok: true, result: null, authorization: "Bearer secret" })).toThrow();
  });
});
