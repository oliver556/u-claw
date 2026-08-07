import { describe, expect, it } from "vitest";

import { MessageEventSchema, MessageSchema, SendMessageInputSchema } from "../src/index.js";

const message = {
  id: "message-1",
  sessionId: "session-1",
  role: "assistant",
  status: "completed",
  blocks: [{ id: "block-1", type: "text", text: "完成", format: "markdown" }],
  createdAt: "2026-08-07T00:00:00.000Z",
};

describe("chat contracts", () => {
  it("parses messages and send inputs", () => {
    expect(MessageSchema.parse(message)).toEqual(message);
    expect(
      SendMessageInputSchema.parse({
        sessionId: "session-1",
        clientRequestId: "request-1",
        blocks: [{ type: "text", text: "你好", format: "plain" }],
      }),
    ).toMatchObject({ clientRequestId: "request-1" });
  });

  it("rejects invalid message roles", () => {
    expect(() => MessageSchema.parse({ ...message, role: "developer" })).toThrow();
  });

  it.each(["started", "delta", "tool", "approval", "final", "aborted", "error"])(
    "parses %s message events",
    (type) => {
      const events = {
        started: { type: "started", runId: "run-1", sessionId: "session-1" },
        delta: { type: "delta", runId: "run-1", mode: "append", text: "a" },
        tool: {
          type: "tool",
          runId: "run-1",
          tool: {
            id: "tool-1",
            sessionId: "session-1",
            toolId: "shell.readonly",
            displayName: "Read status",
            state: "running",
            risk: "low",
          },
        },
        approval: {
          type: "approval",
          runId: "run-1",
          approval: {
            id: "approval-1",
            family: "exec",
            subject: { kind: "operation", id: "operation-1" },
            title: "Run check",
            description: "Read service status",
            risk: "low",
            permissions: [{ kind: "process", scope: "status-only", description: "Read status" }],
            choices: ["allow-once", "deny"],
            status: "pending",
          },
        },
        final: { type: "final", runId: "run-1", message },
        aborted: { type: "aborted", runId: "run-1", reason: "user" },
        error: {
          type: "error",
          runId: "run-1",
          error: {
            code: "UNAVAILABLE",
            message: "服务暂不可用",
            retryable: true,
            recoveryActions: ["retry"],
          },
        },
      } as const;

      expect(MessageEventSchema.parse(events[type as keyof typeof events])).toMatchObject({ type });
    },
  );

  it("allows only append or replace delta modes", () => {
    expect(() =>
      MessageEventSchema.parse({ type: "delta", runId: "run-1", mode: "merge", text: "x" }),
    ).toThrow();
  });

  it("requires final messages to be completed and match the event run", () => {
    expect(() =>
      MessageEventSchema.parse({
        type: "final",
        runId: "run-1",
        message: { ...message, status: "streaming" },
      }),
    ).toThrow();
    expect(() =>
      MessageEventSchema.parse({
        type: "final",
        runId: "run-1",
        message: { ...message, runId: "run-2" },
      }),
    ).toThrow();
  });
});
