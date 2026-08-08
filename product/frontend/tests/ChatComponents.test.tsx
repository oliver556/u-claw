// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import type { ApprovalRequest, ContentBlock, ToolCall, ToolState } from "@uclaw/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalCard } from "../src/features/approvals/ApprovalCard";
import { resolveApproval } from "../src/features/chat/Conversation";
import { MessageContent } from "../src/features/chat/MessageContent";
import { MessageList } from "../src/features/chat/MessageList";
import { ToolRun } from "../src/features/tools/ToolRun";

afterEach(cleanup);

describe("MessageContent", () => {
  it("allows https links without creating in-app navigation links", () => {
    const blocks: ContentBlock[] = [{ id: "markdown", type: "text", format: "markdown", text: "查看[帮助](https://example.com/help)" }];
    render(<MessageContent blocks={blocks} />);
    expect(screen.getByRole("link", { name: "帮助" })).toMatchObject({ target: "_blank", rel: "noreferrer noopener" });
  });

  it.each(["http://example.com/help", "/local/help", "javascript:alert(1)"])("renders %s as inert text", (href) => {
    const blocks: ContentBlock[] = [{ id: "markdown", type: "text", format: "markdown", text: `[不可打开](${href})` }];
    render(<MessageContent blocks={blocks} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("不可打开")).toBeVisible();
  });

});

describe("ToolRun", () => {
  it.each<[ToolState, string]>([
    ["queued", "已排队"], ["waiting-authorization", "等待授权"], ["running", "运行中"],
    ["succeeded", "已完成"], ["failed", "失败"], ["cancelled", "已取消"],
  ])("renders %s state", (state, label) => {
    const tool: ToolCall = { id: `tool-${state}`, sessionId: "session-1", toolId: "exec", displayName: "执行命令", state, risk: "high" };
    render(<ToolRun tool={tool} />);
    expect(screen.getByRole("status")).toHaveTextContent(label);
    cleanup();
  });

  it("renders validated input, output, and error summaries", () => {
    const tool: ToolCall = {
      id: "tool-summary", sessionId: "session-1", toolId: "exec", displayName: "执行命令", state: "failed", risk: "high",
      inputSummary: { command: "npm test", tokenCount: 42 },
      outputSummary: { configured: true, token: "[REDACTED]" },
      error: { code: "OPERATION_FAILED", message: "Tool operation failed.", retryable: true },
    };
    render(<ToolRun tool={tool} />);
    expect(screen.getByText(/输入：/)).toHaveTextContent("npm test");
    expect(screen.getByText(/输出：/)).toHaveTextContent("[REDACTED]");
    expect(screen.getByText("Tool operation failed.")).toBeVisible();
  });
});

describe("MessageList", () => {
  it("keeps final run tools and approvals visible without duplicating pending items", () => {
    const tool: ToolCall = { id: "tool-final", sessionId: "session-1", runId: "run-1", toolId: "exec", displayName: "Inspect workspace", state: "waiting-authorization", risk: "high" };
    const approval: ApprovalRequest = { id: "approval-final", family: "exec", sessionId: "session-1", toolCallId: tool.id, subject: { kind: "toolCall", id: tool.id }, title: "Inspect workspace", description: "Read files", risk: "high", permissions: [{ kind: "file-read", scope: "fixture", description: "Read fixture" }], choices: ["allow-once", "deny"], status: "pending" };
    const message = { id: "message-final", sessionId: "session-1", runId: "run-1", role: "assistant" as const, status: "completed" as const, blocks: [], createdAt: "2026-08-08T08:00:00.000Z" };
    const stream = { order: ["run-1"], runs: { "run-1": { runId: "run-1", sessionId: "session-1", text: "", tools: [tool], approvals: [approval], terminal: "final" as const, finalMessage: message } } };

    render(<MessageList messages={[]} stream={stream} pendingTools={[tool]} pendingApprovals={[approval]} canResolveApprovals={false} onResolveApproval={vi.fn()} />);

    expect(screen.getAllByRole("status").filter((item) => item.textContent?.includes("Inspect workspace"))).toHaveLength(1);
    expect(screen.getAllByLabelText(/命令执行授权/)).toHaveLength(1);
  });
});

describe("ApprovalCard", () => {
  const base = {
    id: "approval-1", title: "请求权限", description: "需要确认", risk: "high" as const,
    permissions: [{ kind: "process" as const, scope: "npm test", description: "运行测试" }],
    choices: ["allow-once" as const, "deny" as const], status: "pending" as const,
    subject: { kind: "toolCall" as const, id: "tool-1" },
  };

  it("keeps exec and plugin business labels separate", () => {
    const exec: ApprovalRequest = { ...base, family: "exec", toolCallId: "tool-1" };
    const plugin: ApprovalRequest = { ...base, id: "approval-2", family: "plugin", subject: { kind: "plugin", id: "plugin-1" } };
    const { rerender } = render(<ApprovalCard approval={exec} canResolve={false} />);
    expect(screen.getByLabelText(/命令执行授权/)).toBeVisible();
    rerender(<ApprovalCard approval={plugin} canResolve={false} />);
    expect(screen.getByLabelText(/插件授权/)).toBeVisible();
  });

  it("disables decisions when capability does not support resolution", () => {
    const exec: ApprovalRequest = { ...base, family: "exec", toolCallId: "tool-1" };
    render(<ApprovalCard approval={exec} canResolve={false} />);
    expect(screen.getByRole("button", { name: "允许一次" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeDisabled();
    expect(screen.getByText(/不支持在此处理授权/)).toBeVisible();
  });

  it("dispatches exec and plugin decisions to different services", async () => {
    const resolveExec = vi.fn(async () => undefined);
    const resolvePlugin = vi.fn(async () => undefined);
    const approvals = { listPending: vi.fn(async () => []), resolveExec, resolvePlugin };
    const exec: ApprovalRequest = { ...base, family: "exec", toolCallId: "tool-1" };
    const plugin: ApprovalRequest = { ...base, id: "approval-2", family: "plugin", subject: { kind: "plugin", id: "plugin-1" } };

    await resolveApproval({ approvals }, exec, "deny");
    await resolveApproval({ approvals }, plugin, "allow-once");

    expect(resolveExec).toHaveBeenCalledWith({ ref: { family: "exec", id: "approval-1" }, decision: "deny" });
    expect(resolvePlugin).toHaveBeenCalledWith({ ref: { family: "plugin", id: "approval-2" }, decision: "allow-once" });
  });
});
