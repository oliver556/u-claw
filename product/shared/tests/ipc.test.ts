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
      ["approvals.resolve-exec", { ref: { family: "exec", id: "a" }, decision: "deny" }], ["approvals.resolve-plugin", { ref: { family: "plugin", id: "a" }, decision: "deny" }],
      ["models.list", {}], ["models.select-for-session", { sessionId: "s", modelId: "m" }], ["skills.list", {}], ["channels.list", {}],
      ["files.list", {}], ["files.read-text", { fileId: "f" }], ["diagnostics.list", {}], ["diagnostics.list-logs", {}],
      ["subscriptions.cancel", { subscriptionId: "sub-1" }],
    ] as const;

    for (const [method, params] of requests) {
      expect(ClientIpcRequestSchema.parse({ method, requestId: `request-${method}`, params })).toBeTruthy();
    }
  });

  it("models subscription start and cancellation lifecycle", () => {
    expect(ClientIpcRequestSchema.parse({ method: "gateway.watch-status", requestId: "request-1", params: { subscriptionId: "sub-1" } })).toBeTruthy();
    expect(ClientIpcRequestSchema.parse({ method: "chat.watch", requestId: "request-2", params: { sessionId: "session-1", subscriptionId: "sub-2" } })).toBeTruthy();
    expect(ClientIpcRequestSchema.parse({ method: "subscriptions.cancel", requestId: "request-3", params: { subscriptionId: "sub-1" } })).toBeTruthy();
    expect(ClientIpcSuccessResponseSchema.parse({ method: "subscriptions.cancel", requestId: "request-3", ok: true, result: null })).toBeTruthy();
  });

  it("returns a typed accepted result for chat sends", () => {
    expect(ClientIpcSuccessResponseSchema.parse({ method: "chat.send", requestId: "request-1", ok: true, result: { clientRequestId: "client-1", runId: "run-1" } })).toBeTruthy();
  });

  it("routes concurrent sends in one session by clientRequestId", () => {
    const firstRequest = ClientIpcRequestSchema.parse({ method: "chat.send", requestId: "request-1", params: { sessionId: "session-1", clientRequestId: "client-1", blocks: [{ type: "text", text: "one", format: "plain" }] } });
    const secondRequest = ClientIpcRequestSchema.parse({ method: "chat.send", requestId: "request-2", params: { sessionId: "session-1", clientRequestId: "client-2", blocks: [{ type: "text", text: "two", format: "plain" }] } });
    const firstResult = ClientIpcSuccessResponseSchema.parse({ method: "chat.send", requestId: "request-1", ok: true, result: { clientRequestId: "client-1", runId: "run-1" } });
    const secondResult = ClientIpcSuccessResponseSchema.parse({ method: "chat.send", requestId: "request-2", ok: true, result: { clientRequestId: "client-2", runId: "run-2" } });
    const first = ClientIpcEventSchema.parse({ event: "chat.send-event", clientRequestId: "client-1", payload: { type: "delta", runId: "run-1", mode: "append", text: "a" } });
    const second = ClientIpcEventSchema.parse({ event: "chat.send-event", clientRequestId: "client-2", payload: { type: "delta", runId: "run-2", mode: "append", text: "b" } });

    expect(firstRequest).toMatchObject({ params: { sessionId: "session-1", clientRequestId: "client-1" } });
    expect(secondRequest).toMatchObject({ params: { sessionId: "session-1", clientRequestId: "client-2" } });
    expect(firstResult).toMatchObject({ result: { clientRequestId: "client-1", runId: "run-1" } });
    expect(secondResult).toMatchObject({ result: { clientRequestId: "client-2", runId: "run-2" } });
    expect(first).toMatchObject({ clientRequestId: "client-1" });
    expect(second).toMatchObject({ clientRequestId: "client-2" });
  });

  it("rejects cross-family approval routing", () => {
    expect(() => ClientIpcRequestSchema.parse({ method: "approvals.resolve-exec", requestId: "request-1", params: { ref: { family: "plugin", id: "same-id" }, decision: "deny" } })).toThrow();
    expect(() => ClientIpcRequestSchema.parse({ method: "approvals.resolve-plugin", requestId: "request-2", params: { ref: { family: "exec", id: "same-id" }, decision: "deny" } })).toThrow();
  });

  it("rejects unsafe paths and plaintext secrets in responses and events", () => {
    expect(() => ClientIpcSuccessResponseSchema.parse({ method: "files.read-text", requestId: "request-1", ok: true, result: { file: { id: "f", name: "x", mediaType: "text/plain", size: 1, kind: "workspace", entryType: "file", modifiedAt: "2026-08-07T00:00:00.000Z", writable: false, relativePath: "../secret" }, content: "x", encoding: "utf-8" } })).toThrow();
    expect(() => ClientIpcSuccessResponseSchema.parse({ method: "channels.list", requestId: "request-2", ok: true, result: [{ id: "c", kind: "telegram", name: "Channel", configured: true, enabled: true, state: "connected", fields: [{ key: "credential", label: "Key", kind: "secret", required: true, secret: { configured: true }, value: "plaintext" }] }] })).toThrow();
    expect(() => ClientIpcSuccessResponseSchema.parse({ method: "files.read-text", requestId: "request-3", ok: true, result: { file: { id: "f", name: "folder/secret.txt", mediaType: "text/plain", size: 1, kind: "workspace", entryType: "file", modifiedAt: "2026-08-07T00:00:00.000Z", writable: false }, content: "x", encoding: "utf-8" } })).toThrow();
    expect(() => ClientIpcEventSchema.parse({
      event: "chat.send-event",
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

  it("redacts secret-bearing complete IPC outputs and preserves normal status text", () => {
    const gateway = {
      connectionState: "ready",
      protocolVersion: 4,
      phase: "available",
      processAlive: true,
      serviceReady: true,
      businessAvailable: true,
      since: "2026-08-07T00:00:00.000Z",
      attempt: 1,
      usb: { state: "available", dataWritable: true },
    };
    const gatewayResponse = IpcResponseSchema.parse({ method: "gateway.get-status", requestId: "request-1", ok: true, result: { ...gateway, endpointLabel: "Authorization: Bearer actual-token" } });
    const normalGatewayResponse = IpcResponseSchema.parse({ method: "gateway.get-status", requestId: "request-normal", ok: true, result: { ...gateway, endpointLabel: "Authorization: required" } });
    const toolResponse = IpcResponseSchema.parse({ method: "tools.get-call", requestId: "request-2", ok: true, result: { id: "tool-1", sessionId: "session-1", toolId: "status", displayName: "Status", state: "running", risk: "low", inputSummary: { tokenCount: 42, apiKeyStatus: "configured" }, outputSummary: { token: "actual-token" } } });
    const logResponse = IpcResponseSchema.parse({ method: "diagnostics.list-logs", requestId: "request-3", ok: true, result: { items: [{ id: "log-1", timestamp: "2026-08-07T00:00:00.000Z", level: "error", source: "adapter", message: "Cookie: session=actual-cookie" }], nextCursor: null, hasMore: false } });
    const normalLogResponse = IpcResponseSchema.parse({ method: "diagnostics.list-logs", requestId: "request-4", ok: true, result: { items: [{ id: "log-2", timestamp: "2026-08-07T00:00:00.000Z", level: "warning", source: "adapter", message: "Cookie: missing" }], nextCursor: null, hasMore: false } });
    const errorResponse = IpcResponseSchema.parse({ method: "gateway.get-status", requestId: "request-5", ok: false, error: { code: "UNAUTHORIZED", message: "Authorization: Basic Zm9vOmJhcg==", retryable: false, recoveryActions: ["open-settings"], causeDetails: {} } });
    const normalErrorResponse = IpcResponseSchema.parse({ method: "gateway.get-status", requestId: "request-6", ok: false, error: { code: "AUTHORIZATION_REQUIRED", message: "Token: expired", retryable: false, recoveryActions: ["open-settings"], causeDetails: {} } });

    expect(JSON.stringify(gatewayResponse)).not.toContain("actual-token");
    expect(JSON.stringify(toolResponse)).not.toContain("actual-token");
    expect(JSON.stringify(logResponse)).not.toContain("actual-cookie");
    expect(JSON.stringify(errorResponse)).not.toContain("Zm9vOmJhcg==");
    expect(JSON.stringify(normalGatewayResponse)).toContain("Authorization: required");
    expect(JSON.stringify(toolResponse)).toContain('"tokenCount":42');
    expect(JSON.stringify(toolResponse)).toContain('"apiKeyStatus":"configured"');
    expect(JSON.stringify(normalLogResponse)).toContain("Cookie: missing");
    expect(JSON.stringify(normalErrorResponse)).toContain("Token: expired");
  });

  it("rejects extra sensitive fields on strict objects", () => {
    expect(() => ClientIpcRequestSchema.parse({ method: "gateway.get-status", requestId: "request-1", params: { token: "secret" } })).toThrow();
    expect(() => ClientIpcSuccessResponseSchema.parse({ method: "chat.abort", requestId: "request-2", ok: true, result: null, authorization: "Bearer secret" })).toThrow();
  });
});
