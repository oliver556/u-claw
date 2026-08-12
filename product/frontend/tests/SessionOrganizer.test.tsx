// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { SessionOrganizerDocument, SessionOrganizerService, UClawClient } from "@uclaw/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/app/App";
import { SessionSidebar } from "../src/features/sessions/SessionSidebar";

const sessions = [
  { id: "session-1", title: "发布检查", createdAt: "2026-08-08T07:00:00.000Z", updatedAt: "2026-08-08T08:00:00.000Z", pinned: true, groupId: "group-1", status: "idle" as const, lastMessagePreview: "第一段历史" },
  { id: "session-2", title: "知识库调研", createdAt: "2026-08-08T08:00:00.000Z", updatedAt: "2026-08-08T09:00:00.000Z", pinned: false, status: "idle" as const, lastMessagePreview: "整理文档" },
];
const props = () => ({
  sessions, groups: [{ id: "group-1", name: "发布" }], activeSessionId: "session-1", state: "ready" as const, organizerState: "ready" as const,
  onSelect: vi.fn(), onCreate: vi.fn(), onRename: vi.fn(), onRemove: vi.fn(), onLoadMore: vi.fn(), onRetry: vi.fn(), onClose: vi.fn(),
  onTogglePinned: vi.fn(), onCreateGroup: vi.fn(), onRenameGroup: vi.fn(), onAssignGroup: vi.fn(), onRetryOrganizer: vi.fn(),
});

afterEach(cleanup);

describe("SessionSidebar organizer", () => {
  it("shows organizer loading and recoverable error states", () => {
    const value = props();
    const { rerender } = render(<SessionSidebar {...value} organizerState="loading" />);
    expect(screen.getByText("正在加载整理信息")).toBeVisible();
    rerender(<SessionSidebar {...value} organizerState="error" organizerError="整理信息读取失败" />);
    expect(screen.getByRole("alert")).toHaveTextContent("整理信息读取失败");
    fireEvent.click(screen.getByRole("button", { name: "重试整理信息" }));
    expect(value.onRetryOrganizer).toHaveBeenCalledOnce();
  });

  it("shows loaded sessions together with a recoverable action error", () => {
    render(<SessionSidebar {...props()} error="会话写后读回失败" />);
    expect(screen.getByRole("alert")).toHaveTextContent("会话写后读回失败");
    expect(screen.getByRole("button", { name: /^发布检查，/ })).toBeVisible();
  });

  it("searches, pins, assigns and clears groups", () => {
    const value = props();
    render(<SessionSidebar {...value} />);
    const sidebar = screen.getByRole("complementary", { name: "会话栏" });
    fireEvent.change(within(sidebar).getByRole("searchbox", { name: "搜索会话" }), { target: { value: "文档" } });
    expect(within(sidebar).getByRole("button", { name: /^知识库调研，/ })).toBeVisible();
    expect(within(sidebar).queryByRole("button", { name: /^发布检查，/ })).not.toBeInTheDocument();
    fireEvent.change(within(sidebar).getByRole("searchbox", { name: "搜索会话" }), { target: { value: "" } });
    const releaseRow = within(sidebar).getByRole("button", { name: /^发布检查，/ }).closest(".session-row")!;
    const researchRow = within(sidebar).getByRole("button", { name: /^知识库调研，/ }).closest(".session-row")!;
    fireEvent.click(within(releaseRow as HTMLElement).getByRole("button", { name: "取消固定会话" }));
    expect(value.onTogglePinned).toHaveBeenCalledWith(sessions[0], false);
    fireEvent.click(within(researchRow as HTMLElement).getByRole("button", { name: "固定会话" }));
    expect(value.onTogglePinned).toHaveBeenCalledWith(sessions[1], true);
    fireEvent.change(within(sidebar).getByRole("combobox", { name: "设置 知识库调研 的分组" }), { target: { value: "group-1" } });
    expect(value.onAssignGroup).toHaveBeenCalledWith(sessions[1], "group-1");
    fireEvent.change(within(sidebar).getByRole("combobox", { name: "设置 发布检查 的分组" }), { target: { value: "" } });
    expect(value.onAssignGroup).toHaveBeenCalledWith(sessions[0], null);
  });

  it("filters sessions by group and toggles back to all sessions", () => {
    const value = props();
    render(<SessionSidebar {...value} />);
    fireEvent.click(screen.getByRole("button", { name: "筛选分组 发布" }));
    expect(screen.getByRole("button", { name: "筛选分组 发布" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^发布检查，/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /^知识库调研，/ })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索会话" }), { target: { value: "知识库" } });
    expect(screen.getByText("没有匹配的会话")).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索会话" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "筛选分组 发布" }));
    expect(screen.getByRole("button", { name: /^知识库调研，/ })).toBeVisible();
  });

  it("creates and renames groups from an in-app dialog", () => {
    const value = props();
    render(<SessionSidebar {...value} />);
    fireEvent.click(screen.getByRole("button", { name: "新建分组" }));
    expect(screen.getByRole("dialog", { name: "新建分组" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "分组名称" }), { target: { value: "客户 A" } });
    fireEvent.click(screen.getByRole("button", { name: "创建分组" }));
    expect(value.onCreateGroup).toHaveBeenCalledWith("客户 A");

    fireEvent.click(screen.getByRole("button", { name: "重命名分组 发布" }));
    expect(screen.getByRole("dialog", { name: "重命名分组" })).toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "分组名称" });
    expect(input).toHaveValue("发布");
    fireEvent.change(input, { target: { value: "正式发布" } });
    fireEvent.click(screen.getByRole("button", { name: "保存分组名称" }));
    expect(value.onRenameGroup).toHaveBeenCalledWith({ id: "group-1", name: "发布" }, "正式发布");
  });

  it("shows empty search and empty group states", () => {
    const value = props();
    const { rerender } = render(<SessionSidebar {...value} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索会话" }), { target: { value: "不存在" } });
    expect(screen.getByText("没有匹配的会话")).toBeVisible();
    rerender(<SessionSidebar {...value} sessions={[]} groups={[]} />);
    expect(screen.getByText("还没有会话")).toBeVisible();
    expect(screen.getByText("还没有分组")).toBeVisible();
  });
});

describe("WorkspaceShell organizer readback", () => {
  it("reloads USB organizer metadata after writes and renderer reconstruction", async () => {
    const now = "2026-08-08T08:00:00.000Z";
    let document: SessionOrganizerDocument = { schemaVersion: 1, groups: [], sessions: [] };
    const organizer: SessionOrganizerService = {
      get: vi.fn(async () => structuredClone(document)),
      setPinned: vi.fn(async (sessionId, pinned) => {
        document = { ...document, sessions: [{ sessionId, pinned }] };
        return { schemaVersion: 1 as const, groups: [], sessions: [] };
      }),
      createGroup: vi.fn(), renameGroup: vi.fn(), assignGroup: vi.fn(),
    };
    const client = {
      gateway: { negotiate: vi.fn(async () => ({ protocolVersion: 4 as const, methods: new Set<string>(), events: new Set<string>(), features: { attachments: false, approvalResolve: false } })), getStatus: vi.fn(), watchStatus: vi.fn(async function* () {}), reconnect: vi.fn() },
      sessions: { list: vi.fn(async () => ({ items: [{ id: "session-1", title: "发布检查", createdAt: now, updatedAt: now, pinned: false, status: "idle" as const }], nextCursor: null, hasMore: false })), get: vi.fn(async () => ({ id: "session-1", title: "发布检查", createdAt: now, updatedAt: now, pinned: false, status: "idle" as const })), create: vi.fn(), remove: vi.fn() },
      chat: { list: vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false })), get: vi.fn(), watch: vi.fn(async function* () {}), send: vi.fn(async function* () {}), abort: vi.fn() },
      tools: { list: vi.fn(async () => []), getCall: vi.fn() }, approvals: { listPending: vi.fn(async () => []), resolveExec: vi.fn(), resolvePlugin: vi.fn() },
      models: { list: vi.fn(), selectForSession: vi.fn() }, skills: { list: vi.fn() }, channels: { list: vi.fn() }, files: { list: vi.fn(), readText: vi.fn() }, diagnostics: { list: vi.fn(), listLogs: vi.fn() },
      sessionOrganizer: organizer,
    } as UClawClient & { sessionOrganizer: SessionOrganizerService };
    const first = render(<App client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "固定会话" }));
    await screen.findByRole("button", { name: "取消固定会话" });
    expect(organizer.get).toHaveBeenCalledTimes(2);

    first.unmount();
    render(<App client={client} />);
    expect(await screen.findByRole("button", { name: "取消固定会话" })).toBeVisible();
  });
});
