// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import type { ArtifactSnapshot, CapabilitySet, Message, Session, ToolCall, UClawClient } from "@uclaw/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextTabs } from "../src/features/context/ContextTabs";

const now = "2026-08-09T08:00:00.000Z";
const contextCapabilities: CapabilitySet = { protocolVersion: 4, methods: new Set(["chat.list"]), events: new Set(), features: {} };

function session(id: string, title: string): Session {
  return { id, title, createdAt: now, updatedAt: now, pinned: false, status: "idle" };
}

function message(sessionId: string, id: string, blocks: Message["blocks"]): Message {
  return { id, sessionId, role: "assistant", status: "completed", blocks, createdAt: now };
}

function clientFixture(): UClawClient {
  const tools: Record<string, ToolCall> = {
    "tool-one": {
      id: "tool-one", sessionId: "session-one", runId: "run-one", toolId: "workspace.search", displayName: "检索工作区", state: "succeeded", risk: "low",
      inputSummary: { query: "发布清单" }, outputSummary: { matches: 2 }, startedAt: now, finishedAt: now,
    },
    "tool-two": {
      id: "tool-two", sessionId: "session-two", runId: "run-two", toolId: "workspace.search", displayName: "检索第二会话", state: "succeeded", risk: "low",
      inputSummary: { query: "第二会话" }, outputSummary: { matches: 1 }, startedAt: now, finishedAt: now,
    },
    "tool-shared": {
      id: "tool-shared", sessionId: "session-repeat", runId: "run-shared", toolId: "workspace.search", displayName: "重复工具结果", state: "succeeded", risk: "low",
      inputSummary: { query: "重复资源" }, outputSummary: { matches: 1 }, startedAt: now, finishedAt: now,
    },
  };
  const messages = {
    "session-one": [message("session-one", "message-one", [
      { id: "text-one", type: "text", text: "整理发布清单", format: "plain" },
      { id: "attachment-one", type: "file", file: { id: "attachment-one", name: "发布清单.xlsx", mediaType: "application/vnd.ms-excel", size: 12, kind: "attachment" } },
      { id: "citation-one", type: "citation", source: { kind: "file", id: "reference-one", label: "发布规范.md" }, label: "发布规范.md", excerpt: "先完成验收" },
      { id: "memory-one", type: "citation", source: { kind: "memory", id: "memory-one", label: "发布偏好" }, label: "发布偏好", excerpt: "优先生成检查清单" },
      { id: "tool-block-one", type: "tool-call", toolCallId: "tool-one" },
      { id: "artifact-one", type: "file", file: { id: "artifact-one", name: "release-report.md", mediaType: "text/markdown", size: 24, kind: "artifact" } },
    ])],
    "session-two": [message("session-two", "message-two", [
      { id: "text-two", type: "text", text: "处理第二会话", format: "plain" },
      { id: "tool-block-two", type: "tool-call", toolCallId: "tool-two" },
    ])],
    "session-repeat": ["步骤甲", "步骤乙"].map((step, index) => message("session-repeat", `message-repeat-${index}`, [
      { id: `text-repeat-${index}`, type: "text", text: step, format: "plain" },
      { id: `attachment-repeat-${index}`, type: "file", file: { id: "attachment-repeat", name: "同一附件.txt", mediaType: "text/plain", size: 1, kind: "attachment" } },
      { id: `reference-repeat-${index}`, type: "citation", source: { kind: "file", id: "reference-repeat", label: "同一引用.md" }, label: "同一引用.md", excerpt: "引用内容" },
      { id: `memory-repeat-${index}`, type: "citation", source: { kind: "memory", id: "memory-repeat", label: "同一记忆" }, label: "同一记忆", excerpt: "记忆内容" },
      { id: `tool-repeat-${index}`, type: "tool-call", toolCallId: "tool-shared" },
      { id: `artifact-repeat-${index}`, type: "file", file: { id: "artifact-repeat", name: "同一产物.md", mediaType: "text/markdown", size: 1, kind: "artifact" } },
    ])),
  };
  return {
    gateway: { negotiate: vi.fn(), getStatus: vi.fn(), watchStatus: vi.fn(), reconnect: vi.fn() },
    sessions: { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn() },
    chat: {
      list: vi.fn(async (sessionId: string) => ({ items: messages[sessionId as keyof typeof messages] ?? [], nextCursor: null, hasMore: false })),
      get: vi.fn(), watch: vi.fn(), send: vi.fn(), abort: vi.fn(),
    },
    tools: { list: vi.fn(), getCall: vi.fn(async (id: string) => tools[id]) },
    approvals: { listPending: vi.fn(), resolveExec: vi.fn(), resolvePlugin: vi.fn() },
    models: { list: vi.fn(), selectForSession: vi.fn() },
    skills: { list: vi.fn() },
    channels: { list: vi.fn() },
    files: { list: vi.fn(), readText: vi.fn() },
    diagnostics: { list: vi.fn(), listLogs: vi.fn() },
  };
}

describe("ContextTabs", () => {
  afterEach(() => { cleanup(); delete window.uclaw; });

  it("mounts the fixed Session Advanced preload bridge for the selected session", async () => {
    const invoke = vi.fn(async (request: { method: string; requestId: string }) => request.method === "sessions.files.list"
      ? { method: request.method, requestId: request.requestId, ok: true, result: { sessionId: "session-one", files: [] } }
      : { method: request.method, requestId: request.requestId, ok: true, result: { sessionId: "session-one", checkpoints: [] } });
    window.uclaw = { sessionAdvanced: { invoke } } as typeof window.uclaw;
    render(<ContextTabs client={clientFixture()} session={session("session-one", "发布检查")} capabilities={contextCapabilities} activity={[]} />);

    fireEvent.click(screen.getByRole("tab", { name: "高级" }));
    expect(await screen.findByText("当前会话没有关联文件")).toBeVisible();
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "sessions.files.list", params: { sessionId: "session-one" } }));
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "sessions.checkpoints.list", params: { sessionId: "session-one" } }));
  });

  it("shows controlled artifact metadata in a dedicated result files tab", async () => {
    const client = clientFixture();
    const artifacts: ArtifactSnapshot = {
      contractVersion: 1, generatedAt: now, source: "openclaw",
      artifacts: [{
        id: "artifact-one", sessionId: "session-one", messageId: "message-one", runId: "run-one",
        name: "release-report.md", mediaType: "text/markdown", size: 2048, createdAt: now, status: "ready",
      }],
    };
    const listArtifacts = vi.fn(async () => artifacts);
    client.artifacts = { list: listArtifacts };
    render(<ContextTabs client={client} session={session("session-one", "发布检查")} capabilities={contextCapabilities} activity={[]} />);

    fireEvent.click(screen.getByRole("tab", { name: "成果" }));
    expect(await screen.findByText("release-report.md")).toBeVisible();
    expect(screen.getByText("text/markdown")).toBeVisible();
    expect(screen.getByText(/2 KB/)).toBeVisible();
    expect(screen.getByText(/OpenClaw · 已就绪/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "定位 release-report.md" }));
    expect(screen.getByText("整理发布清单")).toBeVisible();
    expect(JSON.stringify(listArtifacts.mock.calls)).not.toContain("path");
  });

  it("builds attachments, references, memories, tool results, and artifacts from current session only", async () => {
    const client = clientFixture();
    render(<ContextTabs client={client} session={session("session-one", "发布检查")} capabilities={contextCapabilities} activity={[]} />);

    await waitFor(() => expect(client.chat.list).toHaveBeenCalledWith("session-one", undefined));
    fireEvent.click(screen.getByRole("tab", { name: "上下文" }));
    expect(await screen.findByText("发布清单.xlsx")).toBeVisible();
    expect(screen.getByText("发布规范.md")).toBeVisible();
    expect(screen.getByText("先完成验收")).toBeVisible();
    expect(await screen.findByText("检索工作区")).toBeVisible();
    expect(screen.getByText("query：发布清单")).toBeVisible();
    expect(screen.getByText("matches：2")).toBeVisible();
    expect(screen.getByText("release-report.md")).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "记忆" }));
    expect(screen.getByText("发布偏好")).toBeVisible();
    expect(screen.getByText("优先生成检查清单")).toBeVisible();
    expect(client.tools.getCall).toHaveBeenCalledWith("tool-one");
    expect(client.tools.getCall).not.toHaveBeenCalledWith("tool-two");
  });

  it("discards stale context and resets the selected step when session changes", async () => {
    const client = clientFixture();
    const view = render(<ContextTabs client={client} session={session("session-one", "发布检查")} capabilities={contextCapabilities} activity={[]} />);
    await screen.findByText("检索工作区");
    fireEvent.click(screen.getByRole("tab", { name: "上下文" }));
    await screen.findByText("检索工作区");
    fireEvent.click(screen.getByRole("button", { name: /检索工作区/ }));
    expect(screen.getByText("整理发布清单")).toBeVisible();

    view.rerender(<ContextTabs client={client} session={session("session-two", "知识库调研")} capabilities={contextCapabilities} activity={[]} />);
    await screen.findByText("检索第二会话");
    expect(screen.queryByText("检索工作区")).not.toBeInTheDocument();
    expect(screen.queryByText("整理发布清单")).not.toBeInTheDocument();
    expect(within(screen.getByRole("tabpanel")).getByRole("button", { name: /处理第二会话/ })).toBeVisible();
    expect(client.chat.list).toHaveBeenLastCalledWith("session-two", undefined);
    expect(client.tools.getCall).toHaveBeenCalledWith("tool-two");
  });

  it("waits for negotiated history capability before reading session context", async () => {
    const client = clientFixture();
    const view = render(<ContextTabs client={client} session={session("session-one", "发布检查")} activity={[]} />);
    expect(client.chat.list).not.toHaveBeenCalled();

    view.rerender(<ContextTabs client={client} session={session("session-one", "发布检查")} capabilities={contextCapabilities} activity={[]} />);
    await waitFor(() => expect(client.chat.list).toHaveBeenCalledWith("session-one", undefined));
  });

  it("keeps each repeated resource occurrence linked to its own selected step", async () => {
    const client = clientFixture();
    render(<ContextTabs client={client} session={session("session-repeat", "重复关联")} capabilities={contextCapabilities} activity={[]} />);
    await screen.findAllByText("同一附件.txt");

    fireEvent.click(screen.getByRole("button", { name: "同一附件.txt，步骤甲" }));
    expect(screen.getByText("步骤甲")).toBeVisible();
    expect(document.querySelector(".context-callout")).toHaveTextContent("当前选中步骤关联 5 项上下文。");

    fireEvent.click(screen.getByRole("button", { name: "同一附件.txt，步骤乙" }));
    expect(screen.getByText("步骤乙")).toBeVisible();
    expect(document.querySelector(".context-callout")).toHaveTextContent("当前选中步骤关联 5 项上下文。");
  });

  it("reads authoritative context again when session activity advances", async () => {
    const client = clientFixture();
    const first = message("session-live", "message-first", [
      { id: "text-first", type: "text", text: "开始处理", format: "plain" },
    ]);
    const completed = message("session-live", "message-completed", [
      { id: "text-completed", type: "text", text: "处理完成", format: "plain" },
      { id: "memory-completed", type: "citation", source: { kind: "memory", id: "memory-live", label: "最新记忆" }, label: "最新记忆", excerpt: "来自 OpenClaw 的新引用" },
    ]);
    vi.mocked(client.chat.list)
      .mockResolvedValueOnce({ items: [first], nextCursor: null, hasMore: false })
      .mockResolvedValueOnce({ items: [first, completed], nextCursor: null, hasMore: false });
    const view = render(<ContextTabs client={client} session={session("session-live", "实时上下文")} capabilities={contextCapabilities} activity={[]} />);
    await waitFor(() => expect(client.chat.list).toHaveBeenCalledTimes(1));

    view.rerender(<ContextTabs client={client} session={session("session-live", "实时上下文")} capabilities={contextCapabilities} activity={["响应已完成"]} />);
    fireEvent.click(screen.getByRole("tab", { name: "记忆" }));

    expect(await screen.findByText("最新记忆")).toBeVisible();
    expect(screen.getByText("来自 OpenClaw 的新引用")).toBeVisible();
    expect(client.chat.list).toHaveBeenCalledTimes(2);
  });
});
