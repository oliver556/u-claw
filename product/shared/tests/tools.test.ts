import { describe, expect, it } from "vitest";

import {
  ApprovalRequestSchema,
  ResolveExecApprovalInputSchema,
  ResolvePluginApprovalInputSchema,
  ToolCallSchema,
  toApprovalRef,
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

  it("rejects the erroneous pending summary state", () => {
    expect(() => ToolCallSchema.parse({
      id: "tool-1",
      sessionId: "session-1",
      toolId: "files.read",
      displayName: "Read file",
      state: "pending",
      risk: "low",
    })).toThrow();
  });

  it("redacts secret tool summary values without rejecting normal counters", () => {
    const base = {
      id: "tool-1",
      sessionId: "session-1",
      toolId: "files.read",
      displayName: "Read file",
      state: "running",
      risk: "low",
    };
    const parsed = ToolCallSchema.parse({
      ...base,
      inputSummary: { access_token: "actual-token", tokenCount: 42, apiKeyStatus: "configured" },
      outputSummary: { status: "Authorization: Bearer actual-token" },
    });

    expect(parsed.inputSummary).toEqual({ access_token: "[REDACTED]", tokenCount: 42, apiKeyStatus: "configured" });
    expect(parsed.outputSummary).toEqual({ status: "Authorization: Bearer [REDACTED]" });
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
    const plugin = ApprovalRequestSchema.parse({
      id: "same-id",
      family: "plugin",
      subject: { kind: "plugin", id: "plugin-1" },
      title: "Install plugin",
      description: "Install selected plugin",
      risk: "high",
      permissions: [{ kind: "other", scope: "plugin.install", description: "Install plugin" }],
      choices: ["allow-once", "deny"],
      status: "pending",
    });
    const pluginRef = toApprovalRef(plugin);

    expect(ResolvePluginApprovalInputSchema.parse({ ref: pluginRef, decision: "deny" })).toBeTruthy();
    expect(() => ResolveExecApprovalInputSchema.parse({ ref: pluginRef, decision: "deny" })).toThrow();
  });

  it.each([
    "/Users/private/tool",
    "C:\\Users\\private\\tool",
    "file:///tmp/tool",
    "ghp_fixtureA123456789012345678901234567890",
    "sk_" + "live_123456789012345678901234",
    "rk_" + "live_123456789012345678901234",
    "sk-1234567890123456",
    "sk-proj-fixtureA123456789012",
    "xoxa-fixtureA1234567890123",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz123456",
  ])("rejects unsafe opaque ids: %s", (id) => {
    expect(() => ToolCallSchema.parse({
      id, sessionId: "session-1", toolId: "exec", displayName: "Execute", state: "running", risk: "high",
    })).toThrow();
  });

  it("preserves a safe plugin tool call id", () => {
    expect(ApprovalRequestSchema.parse({
      id: "plugin:approval-1", family: "plugin", toolCallId: "tool-call-1",
      subject: { kind: "plugin", id: "plugin-1" }, title: "Approval", description: "Plugin operation",
      risk: "high", permissions: [{ kind: "other", scope: "plugin-1", description: "Plugin operation" }],
      choices: ["deny"], status: "pending",
    })).toMatchObject({ toolCallId: "tool-call-1" });
  });
});
