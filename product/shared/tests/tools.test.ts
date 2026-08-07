import { describe, expect, it } from "vitest";

import { ApprovalRequestSchema, ToolCallSchema } from "../src/index.js";

describe("tool contracts", () => {
  it("parses a tool call", () => {
    expect(
      ToolCallSchema.parse({
        id: "tool-1",
        sessionId: "session-1",
        toolId: "files.read",
        displayName: "Read file",
        state: "succeeded",
        risk: "low",
      }),
    ).toMatchObject({ state: "succeeded" });
  });

  it("rejects invalid tool states", () => {
    expect(() =>
      ToolCallSchema.parse({
        id: "tool-1",
        sessionId: "session-1",
        toolId: "files.read",
        displayName: "Read file",
        state: "approved",
        risk: "low",
      }),
    ).toThrow();
  });

  it("keeps exec and plugin approvals structurally distinct", () => {
    const base = {
      id: "approval-1",
      subject: { kind: "operation", id: "operation-1" },
      title: "Approval",
      description: "Approve scoped operation",
      risk: "high",
      permissions: [{ kind: "other", scope: "plugin.install", description: "Install plugin" }],
      choices: ["allow-once", "deny"],
      status: "pending",
    };

    expect(ApprovalRequestSchema.parse({ ...base, family: "exec", toolCallId: "tool-1" }).family).toBe(
      "exec",
    );
    expect(ApprovalRequestSchema.parse({ ...base, family: "plugin", subject: { kind: "plugin", id: "plugin-1" } }).family).toBe(
      "plugin",
    );
    expect(() =>
      ApprovalRequestSchema.parse({ ...base, family: "plugin", toolCallId: "tool-1" }),
    ).toThrow();
  });
});
