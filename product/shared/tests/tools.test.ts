import { describe, expect, it } from "vitest";

import {
  ApprovalRequestSchema,
  ResolveExecApprovalInputSchema,
  ResolvePluginApprovalInputSchema,
  ToolCallSchema,
} from "../src/index.js";

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

  it.each(["queued", "waiting-authorization"])("parses %s tool state", (state) => {
    expect(
      ToolCallSchema.parse({
        id: "tool-1",
        sessionId: "session-1",
        toolId: "files.read",
        displayName: "Read file",
        state,
        risk: "low",
      }),
    ).toMatchObject({ state });
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

  it("requires at least one permission", () => {
    expect(() =>
      ApprovalRequestSchema.parse({
        id: "approval-1",
        family: "exec",
        subject: { kind: "operation", id: "operation-1" },
        title: "Approval",
        description: "Approve operation",
        risk: "low",
        permissions: [],
        choices: ["deny"],
        status: "pending",
      }),
    ).toThrow();
  });

  it("separates exec and plugin resolve inputs at runtime", () => {
    expect(ResolveExecApprovalInputSchema.parse({ family: "exec", requestId: "same-id", decision: "deny" })).toBeTruthy();
    expect(ResolvePluginApprovalInputSchema.parse({ family: "plugin", requestId: "same-id", decision: "deny" })).toBeTruthy();
    expect(() => ResolveExecApprovalInputSchema.parse({ family: "plugin", requestId: "same-id", decision: "deny" })).toThrow();
    expect(() => ResolvePluginApprovalInputSchema.parse({ family: "exec", requestId: "same-id", decision: "deny" })).toThrow();
  });
});
