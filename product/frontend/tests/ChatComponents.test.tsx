// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import type { ApprovalRequest, ContentBlock, Message, ToolCall, ToolState } from "@uclaw/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalCard } from "../src/features/approvals/ApprovalCard";
import { Composer } from "../src/features/chat/Composer";
import { AttachmentPreview } from "../src/features/chat/AttachmentPreview";
import { resolveApproval } from "../src/features/chat/Conversation";
import { MessageContent } from "../src/features/chat/MessageContent";
import { MessageList } from "../src/features/chat/MessageList";
import { QueuedMessageBar } from "../src/features/chat/QueuedMessageBar";
import { ToolRun } from "../src/features/tools/ToolRun";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Composer", () => {
  it("renders a borderless composer with an icon-only send button", () => {
    const { container } = render(<Composer
      value="你好"
      disabled={false}
      sending={false}
      attachmentsSupported
      attachments={[]}
      models={[{ value: "gpt-5.6-sol", label: "GPT" }]}
      modelValue="gpt-5.6-sol"
      modelLoading={false}
      modelError={false}
      skills={[]}
      skillLoading={false}
      onChange={vi.fn()}
      onSelectAttachments={vi.fn()}
      onDropFiles={vi.fn()}
      onPrepareAttachment={vi.fn()}
      onRemoveAttachment={vi.fn()}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onModelChange={vi.fn()}
      onSkillChange={vi.fn()}
    />);

    expect(container.querySelector(".composer.borderless-composer")).toBeInTheDocument();
    const sendButton = screen.getByRole("button", { name: "发送消息" });
    expect(sendButton).toHaveAttribute("title", "发送");
    expect(sendButton).toHaveTextContent("");
    expect(sendButton.querySelector("svg")).toBeInTheDocument();
  });

  it("renders icon-only circular send and stop controls", () => {
    const props = {
      value: "你好", disabled: false, attachmentsSupported: true, attachments: [],
      models: [{ value: "gpt-5.6-sol", label: "GPT" }], modelValue: "gpt-5.6-sol", modelLoading: false, modelError: false,
      skills: [], skillLoading: false, onChange: vi.fn(), onSelectAttachments: vi.fn(), onDropFiles: vi.fn(),
      onPrepareAttachment: vi.fn(), onRemoveAttachment: vi.fn(), onSend: vi.fn(), onStop: vi.fn(), onModelChange: vi.fn(), onSkillChange: vi.fn(),
    };
    const { rerender } = render(<Composer {...props} sending={false} />);
    const send = screen.getByRole("button", { name: "发送消息" });
    expect(send).toHaveClass("composer-action");
    expect(send).toHaveTextContent("");
    expect(send.querySelector(".lucide-arrow-up")).toBeInTheDocument();

    rerender(<Composer {...props} sending />);
    const stop = screen.getByRole("button", { name: "停止生成" });
    expect(stop).toHaveClass("composer-action");
    expect(stop).toHaveTextContent("");
    expect(stop.querySelector(".lucide-square")).toBeInTheDocument();
  });

  it("keeps the textarea editable while sending and routes keyboard submits", () => {
    const onSend = vi.fn();
    const onQueue = vi.fn();
    render(<Composer
      value="调整方向"
      disabled={false}
      sending
      attachmentsSupported
      attachments={[]}
      models={[]}
      modelLoading={false}
      modelError={false}
      skills={[]}
      skillLoading={false}
      onChange={vi.fn()}
      onSelectAttachments={vi.fn()}
      onDropFiles={vi.fn()}
      onPrepareAttachment={vi.fn()}
      onRemoveAttachment={vi.fn()}
      onSend={onSend}
      onQueue={onQueue}
      onStop={vi.fn()}
      onModelChange={vi.fn()}
      onSkillChange={vi.fn()}
    />);

    const textarea = screen.getByRole("textbox", { name: "给 U-Claw 发送消息" });
    expect(textarea).toBeEnabled();
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });

    expect(onSend).toHaveBeenCalledOnce();
    expect(onQueue).toHaveBeenCalledTimes(2);
  });
});

describe("AttachmentPreview", () => {
  it("renders image, video, and file previews with removal controls", () => {
    const onRemove = vi.fn();
    const attachments = [
      { id: "image", file: { id: "image-file", name: "photo.png", mediaType: "image/png", size: 10, kind: "attachment" as const }, category: "image" as const, state: "ready" as const, progress: 1, previewUrl: "blob:image" },
      { id: "video", file: { id: "video-file", name: "clip.mp4", mediaType: "video/mp4", size: 20, kind: "attachment" as const }, category: "video" as const, state: "uploading" as const, progress: 0.5, previewUrl: "blob:video", duration: 65 },
      { id: "file", file: { id: "text-file", name: "notes.txt", mediaType: "text/plain", size: 30, kind: "attachment" as const }, category: "file" as const, state: "ready" as const, progress: 1 },
    ];
    render(<AttachmentPreview attachments={attachments} onRemove={onRemove} />);

    expect(screen.getByRole("img", { name: "photo.png" })).toHaveAttribute("src", "blob:image");
    expect(screen.getByLabelText("视频预览 clip.mp4")).toHaveTextContent("1:05");
    expect(screen.getByLabelText("附件 notes.txt")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "移除 photo.png" }));
    expect(onRemove).toHaveBeenCalledWith("image");
  });
});

describe("QueuedMessageBar", () => {
  it("edits the complete queued message and keeps the editor open when save fails", async () => {
    const item = {
      id: "queue-1", sessionId: "session-1", text: "稍后处理", attachmentIds: ["attachment-old"], status: "queued" as const,
      idempotencyKey: "queue-key-0001", createdAt: "2026-08-08T08:00:00.000Z", updatedAt: "2026-08-08T08:00:00.000Z",
    };
    const onSave = vi.fn(async () => { throw new Error("保存失败"); });
    const onAddAttachments = vi.fn(async () => ["attachment-new"]);
    render(<QueuedMessageBar items={[item]} onSend={vi.fn()} onRemove={vi.fn()} onSave={onSave} onAddAttachments={onAddAttachments} />);

    fireEvent.click(screen.getByRole("button", { name: "更多：稍后处理" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑消息" }));
    expect(screen.getByLabelText("队列附件 attachment-old")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "移除队列附件 attachment-old" }));
    fireEvent.click(screen.getByRole("button", { name: "添加队列附件" }));
    expect(await screen.findByLabelText("队列附件 attachment-new")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "编辑队列消息" }), { target: { value: "修改后" } });
    fireEvent.click(screen.getByRole("button", { name: "保存队列消息" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("保存失败");
    expect(screen.getByRole("textbox", { name: "编辑队列消息" })).toHaveValue("修改后");
    expect(onSave).toHaveBeenCalledWith(item, "修改后", ["attachment-new"]);
  });
});

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

  it("renders a managed outgoing image", () => {
    const blocks: ContentBlock[] = [{
      id: "image-1",
      type: "image",
      file: { id: "image-1", name: "portrait.png", mediaType: "image/png", size: 0, kind: "artifact" },
      alt: "美女肖像",
      sourceUrl: "/api/chat/media/outgoing/agent%3Amain%3Adashboard%3Atest/fc0adee3-cf57-47e3-ba7e-e4095976033f/full",
    }];
    render(<MessageContent blocks={blocks} />);
    const image = blocks[0];
    expect(image?.type).toBe("image");
    expect(screen.getByRole("img", { name: "美女肖像" })).toHaveAttribute("src", image?.type === "image" ? image.sourceUrl : undefined);
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
  it("renders user and assistant messages as anonymous role-aligned bubbles", () => {
    const messages: Message[] = [
      { id: "user-1", sessionId: "session-1", role: "user", status: "completed", blocks: [{ id: "u", type: "text", text: "你好", format: "plain" }], createdAt: "2026-08-13T00:00:00.000Z" },
      { id: "assistant-1", sessionId: "session-1", role: "assistant", status: "completed", blocks: [{ id: "a", type: "text", text: "你好，小李总", format: "markdown" }], createdAt: "2026-08-13T00:00:01.000Z" },
    ];

    const { container } = render(<MessageList messages={messages} stream={{ order: [], runs: {} }} pendingTools={[]} pendingApprovals={[]} canResolveApprovals={false} onResolveApproval={vi.fn()} />);

    expect(container.querySelector(".user-message .message-content")).toHaveTextContent("你好");
    expect(container.querySelector(".assistant-message .message-content")).toHaveTextContent("你好，小李总");
    expect(container.querySelectorAll(".message > header")).toHaveLength(0);
    expect(screen.queryByText("U-Claw")).not.toBeInTheDocument();
    expect(screen.queryByText("你")).not.toBeInTheDocument();
  });

  it("shows elapsed time between the user message and completed assistant reply", () => {
    const messages: Message[] = [
      { id: "user-1", sessionId: "session-1", role: "user", status: "completed", blocks: [{ id: "u", type: "text", text: "开始", format: "plain" }], createdAt: "2026-08-13T00:00:00.000Z" },
      { id: "assistant-1", sessionId: "session-1", role: "assistant", status: "completed", blocks: [{ id: "a", type: "text", text: "完成", format: "plain" }], createdAt: "2026-08-13T00:01:26.000Z" },
    ];

    const { container } = render(<MessageList messages={messages} stream={{ order: [], runs: {} }} pendingTools={[]} pendingApprovals={[]} canResolveApprovals={false} onResolveApproval={vi.fn()} />);

    expect(screen.getByText("耗时 1 分 26 秒")).toBeVisible();
    const children = [...container.children];
    expect(children[1]).toHaveClass("message-run-meta");
    expect(children[2]).toHaveClass("assistant-message");
  });

  it("updates active processing time once per second before the assistant reply", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T00:00:01.000Z"));
    const messages: Message[] = [
      { id: "user-1", sessionId: "session-1", role: "user", status: "completed", blocks: [{ id: "u", type: "text", text: "开始", format: "plain" }], createdAt: "2026-08-13T00:00:00.000Z" },
    ];

    const { container } = render(<MessageList messages={messages} stream={{ order: [], runs: {} }} awaitingResponse pendingTools={[]} pendingApprovals={[]} canResolveApprovals={false} onResolveApproval={vi.fn()} />);
    expect(screen.getByText("已处理 1 秒")).toBeVisible();
    expect(container.children[1]).toHaveClass("message-run-meta");

    act(() => { vi.advanceTimersByTime(2_000); });
    expect(screen.getByText("已处理 3 秒")).toBeVisible();
  });

  it("keeps the completed duration on the same client clock as active processing", () => {
    const messages: Message[] = [
      { id: "user-1", sessionId: "session-1", role: "user", status: "completed", blocks: [{ id: "u", type: "text", text: "开始", format: "plain" }], createdAt: "2026-08-13T00:00:00.000Z" },
      { id: "assistant-1", sessionId: "session-1", runId: "run-1", role: "assistant", status: "completed", blocks: [{ id: "a", type: "text", text: "完成", format: "plain" }], createdAt: "2026-08-13T00:00:07.000Z" },
    ];
    const stream = { order: ["run-1"], runs: { "run-1": { runId: "run-1", text: "", tools: [], approvals: [], terminal: "final" as const, finalMessage: messages[1], completedAt: "2026-08-13T00:00:08.000Z" } } };

    render(<MessageList messages={messages} stream={stream} pendingTools={[]} pendingApprovals={[]} canResolveApprovals={false} onResolveApproval={vi.fn()} />);

    expect(screen.getByText("耗时 8 秒")).toBeVisible();
    expect(screen.queryByText("耗时 7 秒")).not.toBeInTheDocument();
  });

  it("keeps final run tools and approvals visible without duplicating pending items", () => {
    const tool: ToolCall = { id: "tool-final", sessionId: "session-1", runId: "run-1", toolId: "exec", displayName: "Inspect workspace", state: "waiting-authorization", risk: "high" };
    const approval: ApprovalRequest = { id: "approval-final", family: "exec", sessionId: "session-1", toolCallId: tool.id, subject: { kind: "toolCall", id: tool.id }, title: "Inspect workspace", description: "Read files", risk: "high", permissions: [{ kind: "file-read", scope: "fixture", description: "Read fixture" }], choices: ["allow-once", "deny"], status: "pending" };
    const message = { id: "message-final", sessionId: "session-1", runId: "run-1", role: "assistant" as const, status: "completed" as const, blocks: [], createdAt: "2026-08-08T08:00:00.000Z" };
    const stream = { order: ["run-1"], runs: { "run-1": { runId: "run-1", sessionId: "session-1", text: "", tools: [tool], approvals: [approval], terminal: "final" as const, finalMessage: message } } };

    render(<MessageList messages={[]} stream={stream} pendingTools={[tool]} pendingApprovals={[approval]} canResolveApprovals={false} onResolveApproval={vi.fn()} />);

    expect(screen.getAllByRole("status").filter((item) => item.textContent?.includes("Inspect workspace"))).toHaveLength(1);
    expect(screen.getAllByLabelText(/命令执行授权/)).toHaveLength(1);
  });

  it("shows processing before and after the Gateway starts an empty response", () => {
    const { rerender } = render(<MessageList messages={[]} stream={{ order: [], runs: {} }} awaitingResponse pendingTools={[]} pendingApprovals={[]} canResolveApprovals={false} onResolveApproval={vi.fn()} />);
    expect(screen.getByRole("status", { name: "助手正在处理" })).toHaveTextContent("正在处理");

    rerender(<MessageList messages={[]} stream={{ order: ["run-1"], runs: { "run-1": { runId: "run-1", sessionId: "session-1", text: "", tools: [], approvals: [] } } }} awaitingResponse pendingTools={[]} pendingApprovals={[]} canResolveApprovals={false} onResolveApproval={vi.fn()} />);
    expect(screen.getByRole("status", { name: "助手正在处理" })).toHaveTextContent("正在处理");
  });

  it("does not append a final stream reply outside the message timeline", () => {
    const messages: Message[] = [
      { id: "user-1", sessionId: "session-1", role: "user", status: "completed", blocks: [{ id: "u1", type: "text", text: "第一问", format: "plain" }], createdAt: "2026-08-13T00:00:00.000Z" },
      { id: "assistant-1", sessionId: "session-1", role: "assistant", status: "completed", blocks: [{ id: "a1", type: "text", text: "第一答", format: "plain" }], createdAt: "2026-08-13T00:00:01.000Z" },
      { id: "user-2", sessionId: "session-1", role: "user", status: "completed", blocks: [{ id: "u2", type: "text", text: "第二问", format: "plain" }], createdAt: "2026-08-13T00:00:02.000Z" },
    ];
    const finalMessage: Message = { id: "assistant-2", sessionId: "session-1", runId: "run-2", role: "assistant", status: "completed", blocks: [{ id: "a2", type: "text", text: "第二答", format: "plain" }], createdAt: "2026-08-13T00:00:03.000Z" };
    const stream = { order: ["run-2"], runs: { "run-2": { runId: "run-2", sessionId: "session-1", text: "", tools: [], approvals: [], terminal: "final" as const, finalMessage } } };

    const { container } = render(<MessageList messages={messages} stream={stream} pendingTools={[]} pendingApprovals={[]} canResolveApprovals={false} onResolveApproval={vi.fn()} />);
    expect([...container.querySelectorAll(".message-content")].map((item) => item.textContent)).toEqual(["第一问", "第一答", "第二问"]);
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
