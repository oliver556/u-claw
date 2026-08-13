// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import type { MessageEvent, UClawClient } from "@uclaw/shared";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/app/App";
import { initialStreamState, messageEventReducer, useMessageStream } from "../src/features/chat/useMessageStream";

vi.mock("antd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("antd")>();
  const { cloneElement } = await import("react");
  return { ...actual, Popconfirm: ({ children, onConfirm }: { children: ReactElement<{ onClick?(): void }>; onConfirm?(): void }) => cloneElement(children, { onClick: onConfirm }) };
});

function deferredStream() {
  let emit: ((event: MessageEvent) => void) | undefined;
  let finish: (() => void) | undefined;
  const values: MessageEvent[] = [];
  let waiter: (() => void) | undefined;

  async function* stream(): AsyncIterable<MessageEvent> {
    while (true) {
      if (values.length > 0) yield values.shift()!;
      else {
        await new Promise<void>((resolve) => { waiter = resolve; });
        if (finish === undefined) return;
      }
    }
  }

  emit = (event) => { values.push(event); waiter?.(); waiter = undefined; };
  finish = () => { finish = undefined; waiter?.(); waiter = undefined; };
  return { stream: stream(), emit, finish };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function clientFixture(overrides: Partial<UClawClient> = {}): UClawClient {
  const now = "2026-08-08T08:00:00.000Z";
  const readyStatus = { connectionState: "ready" as const, protocolVersion: 4 as const, phase: "available" as const, processAlive: true, serviceReady: true, businessAvailable: true, since: now, attempt: 0, usb: { state: "available" as const, dataWritable: true } };
  const base: UClawClient = {
    gateway: {
      negotiate: vi.fn(async () => ({ protocolVersion: 4 as const, methods: new Set(["chat.send", "chat.abort", "sessions.create"]), events: new Set(["chat"]), features: { attachments: false, approvalResolve: false } })),
      getStatus: vi.fn(async () => readyStatus),
      watchStatus: vi.fn(async function* () { yield readyStatus; }),
      reconnect: vi.fn(async () => undefined),
    },
    sessions: {
      list: vi.fn(async () => ({ items: [
        { id: "session-1", title: "发布检查", createdAt: now, updatedAt: now, pinned: false, status: "idle" as const, lastMessagePreview: "第一段历史" },
        { id: "session-2", title: "知识库调研", createdAt: now, updatedAt: now, pinned: false, status: "idle" as const, lastMessagePreview: "第二段历史" },
      ], nextCursor: null, hasMore: false })),
      get: vi.fn(async (id: string) => ({ id, title: id === "session-1" ? "发布检查" : id === "session-3" ? "新会话" : "知识库调研", createdAt: now, updatedAt: now, pinned: false, status: "idle" as const })),
      create: vi.fn(async () => ({ id: "session-3", title: "新会话", createdAt: now, updatedAt: now, pinned: false, status: "idle" as const })),
      remove: vi.fn(async () => undefined),
    },
    chat: {
      list: vi.fn(async (sessionId: string) => ({ items: sessionId === "session-3" ? [] : [{ id: `message-${sessionId}`, sessionId, role: "assistant" as const, status: "completed" as const, blocks: [{ id: `block-${sessionId}`, type: "text" as const, text: sessionId === "session-1" ? "第一段历史" : "第二段历史", format: "plain" as const }], createdAt: now }], nextCursor: null, hasMore: false })),
      get: vi.fn(),
      watch: vi.fn(async function* () {}),
      send: vi.fn(async function* () {}),
      abort: vi.fn(async () => undefined),
    },
    tools: { list: vi.fn(async () => []), getCall: vi.fn() },
    approvals: { listPending: vi.fn(async () => []), resolveExec: vi.fn(), resolvePlugin: vi.fn() },
    models: { list: vi.fn(), selectForSession: vi.fn() },
    skills: { list: vi.fn() },
    channels: { list: vi.fn() },
    files: { list: vi.fn(), readText: vi.fn() },
    diagnostics: { list: vi.fn(), listLogs: vi.fn() },
  } satisfies UClawClient;
  return { ...base, ...overrides };
}

describe("chat workspace", () => {
  it("selects GPT-5.6 Sol as the only first-release model", async () => {
    const base = clientFixture();
    const selectForSession = vi.fn(async () => undefined);
    const client = clientFixture({
      gateway: {
        ...base.gateway,
        negotiate: vi.fn(async () => ({ protocolVersion: 4 as const, methods: new Set(["chat.send", "chat.abort", "sessions.create", "models.list"]), events: new Set(["chat"]), features: { attachments: false, approvalResolve: false } })),
      },
      models: {
        list: vi.fn(async () => [
          { id: "uclaw-development-gpt/gpt-5.6-sol", label: "Raw Sol", providerId: "uclaw-development-gpt", available: true, locality: "cloud" as const, capabilities: ["text" as const] },
          { id: "uclaw-development-gpt/gpt-5.6-luna", label: "Luna", providerId: "uclaw-development-gpt", available: true, locality: "cloud" as const, capabilities: ["text" as const] },
          { id: "anthropic/claude-opus", label: "Claude", providerId: "anthropic", available: true, locality: "cloud" as const, capabilities: ["text" as const] },
        ]),
        selectForSession,
      },
    });

    render(<App client={client} />);

    await waitFor(() => expect(selectForSession).toHaveBeenCalledWith("session-1", "uclaw-development-gpt/gpt-5.6-sol"));
    expect(screen.queryByText("Luna")).not.toBeInTheDocument();
    expect(screen.queryByText("Claude")).not.toBeInTheDocument();
  });

  it("shows current model while clearly degrading unavailable model discovery", async () => {
    const client = clientFixture();
    vi.mocked(client.sessions.get).mockResolvedValue({
      id: "session-1", title: "发布检查", createdAt: "2026-08-08T08:00:00.000Z", updatedAt: "2026-08-08T08:00:00.000Z",
      pinned: false, status: "idle", model: { id: "openai/gpt-5", label: "GPT-5", providerId: "openai" },
    });
    render(<App client={client} />);

    expect(await screen.findByRole("combobox", { name: "会话模型" })).toBeInTheDocument();
    expect(screen.queryByText("当前连接不支持模型列表")).not.toBeInTheDocument();
  });
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    delete window.uclaw;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("reads back an official SkillHub install even when the chat run reports an error", async () => {
    const base = clientFixture();
    const send = vi.fn(() => (async function* () {
      yield { type: "started" as const, runId: "run-skill", sessionId: "session-1" };
      yield {
        type: "error" as const,
        runId: "run-skill",
        error: {
          code: "NOT_FOUND" as const,
          message: "Requested resource was not found.",
          retryable: false,
          recoveryActions: [],
          causeDetails: {},
        },
      };
    })());
    const skillInvoke = vi.fn(async (request: any) => {
      if (request.method === "skills.runtime-status") return { method: request.method, requestId: request.requestId, ok: true, result: { workspaceDir: "w", managedSkillsDir: "m", skills: [] } };
      if (request.method === "skills.installed") return { method: request.method, requestId: request.requestId, ok: true, result: [{
        slug: "global-biblio-base", name: "Global Biblio Base", description: "Bibliography", version: "local", pricingType: "free", installedVersion: "local",
        enabled: true, updateAvailable: false, source: { provider: "openclaw", origin: "workspace" }, permissions: [], permissionFingerprint: "empty",
        risk: "low", mode: "live", categories: [],
      }] };
      throw new Error(`unexpected ${request.method}`);
    });
    window.uclaw = { skills: { invoke: skillInvoke } } as any;
    render(<App client={clientFixture({ chat: { ...base.chat, send } })} />);
    const prompt = "请根据 https://skillhub.cn/install/skillhub.md，安装 @user_164f4c1f/global-biblio-base。";
    fireEvent.change(await screen.findByRole("textbox", { name: "给 U-Claw 发送消息" }), { target: { value: prompt } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(await screen.findByText("Global Biblio Base 安装成功，OpenClaw 已完成读回。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "关闭安装成功提示" }));
    expect(screen.queryByText("Global Biblio Base 安装成功，OpenClaw 已完成读回。")).not.toBeInTheDocument();
    expect(screen.queryByText("发送失败")).not.toBeInTheDocument();
    expect(skillInvoke.mock.calls.some(([request]) => request.method === "skills.resolve-install")).toBe(false);
    expect(screen.queryByRole("dialog", { name: /确认安装/ })).not.toBeInTheDocument();
  });

  it("does not inspect ordinary chat messages as Skill installs", async () => {
    const base = clientFixture();
    const skillInvoke = vi.fn(async (request: any) => ({ method: request.method, requestId: request.requestId, ok: true, result: { workspaceDir: "w", managedSkillsDir: "m", skills: [] } }));
    window.uclaw = { skills: { invoke: skillInvoke } } as any;
    render(<App client={base} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "给 U-Claw 发送消息" }), { target: { value: "帮我总结今天的工作" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(base.chat.send).toHaveBeenCalledOnce());
    expect(skillInvoke.mock.calls.some(([request]) => request.method === "skills.resolve-install")).toBe(false);
  });

  it("loads sessions and switches history", async () => {
    const client = clientFixture();
    render(<App client={client} />);

    const main = screen.getByRole("main");
    expect(await within(main).findByText("第一段历史")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /知识库调研/ }));
    expect(await within(main).findByText("第二段历史")).toBeVisible();
    expect(within(main).queryByText("第一段历史")).not.toBeInTheDocument();
  });

  it("paginates history with stable deduplication and resets paging on session switch", async () => {
    const base = clientFixture();
    const now = "2026-08-08T08:00:00.000Z";
    const message = (id: string, sessionId: string, text: string) => ({ id, sessionId, role: "assistant" as const, status: "completed" as const, blocks: [{ id: `block-${id}`, type: "text" as const, text, format: "plain" as const }], createdAt: now });
    const list = vi.fn(async (sessionId: string, page?: { cursor?: string }) => {
      if (sessionId === "session-2") return { items: [message("other", sessionId, "第二会话消息")], nextCursor: null, hasMore: false };
      if (page?.cursor === "history-2") return { items: [message("shared", sessionId, "共享消息"), message("third", sessionId, "第三条消息")], nextCursor: null, hasMore: false };
      return { items: [message("first", sessionId, "第一条消息"), message("shared", sessionId, "共享消息")], nextCursor: "history-2", hasMore: true };
    });
    const client = clientFixture({ chat: { ...base.chat, list } });
    render(<App client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "加载更多消息" }));
    expect(await screen.findByText("第三条消息")).toBeVisible();
    expect(screen.getAllByText("共享消息")).toHaveLength(1);
    expect(list).toHaveBeenCalledWith("session-1", { cursor: "history-2" });

    fireEvent.click(screen.getByRole("button", { name: /知识库调研/ }));
    expect(await screen.findByText("第二会话消息")).toBeVisible();
    expect(screen.queryByRole("button", { name: "加载更多消息" })).not.toBeInTheDocument();
    expect(screen.queryByText("第三条消息")).not.toBeInTheDocument();
  });

  it("shows a recoverable error when loading more history fails", async () => {
    const base = clientFixture();
    let pageAttempts = 0;
    const list = vi.fn(async (sessionId: string, page?: { cursor?: string }) => {
      if (page?.cursor === "history-next") {
        pageAttempts += 1;
        if (pageAttempts === 1) throw new Error("history page failed");
        return { items: [{ id: "message-next", sessionId, role: "assistant" as const, status: "completed" as const, blocks: [{ id: "block-next", type: "text" as const, text: "重试加载成功", format: "plain" as const }], createdAt: "2026-08-08T08:00:00.000Z" }], nextCursor: null, hasMore: false };
      }
      return { items: [], nextCursor: "history-next", hasMore: true };
    });
    const client = clientFixture({ chat: { ...base.chat, list } });
    render(<App client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "加载更多消息" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("history page failed");
    fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    expect(await screen.findByText("重试加载成功")).toBeVisible();
  });

  it("ignores stale session responses that resolve out of order", async () => {
    const client = clientFixture();
    render(<App client={client} />);
    expect(await screen.findByText("第一段历史")).toBeVisible();
    const sessionOne = deferred<Awaited<ReturnType<UClawClient["sessions"]["get"]>>>();
    const sessionTwo = deferred<Awaited<ReturnType<UClawClient["sessions"]["get"]>>>();
    vi.mocked(client.sessions.get).mockImplementation((id) => id === "session-1" ? sessionOne.promise : sessionTwo.promise);

    fireEvent.click(screen.getByRole("button", { name: /知识库调研/ }));
    fireEvent.click(screen.getByRole("button", { name: /发布检查/ }));
    sessionOne.resolve({ id: "session-1", title: "发布检查", createdAt: "2026-08-08T08:00:00.000Z", updatedAt: "2026-08-08T08:00:00.000Z", pinned: false, status: "idle" });
    await act(async () => undefined);
    sessionTwo.resolve({ id: "session-2", title: "知识库调研", createdAt: "2026-08-08T08:00:00.000Z", updatedAt: "2026-08-08T08:00:00.000Z", pinned: false, status: "idle" });
    await act(async () => undefined);

    expect(within(screen.getByRole("main")).getByText("第一段历史")).toBeVisible();
  });

  it("creates and selects an empty session", async () => {
    const client = clientFixture();
    render(<App client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "新建会话" }));
    expect(await screen.findByText("开始一段新会话")).toBeVisible();
    expect(client.sessions.create).toHaveBeenCalledWith();
    expect(client.sessions.get).toHaveBeenCalledWith("session-3");
  });

  it("reads authoritative session state after create and renderer reconstruction", async () => {
    const base = clientFixture();
    const now = "2026-08-08T08:00:00.000Z";
    let authoritative = [
      { id: "session-1", title: "发布检查", createdAt: now, updatedAt: now, pinned: false, status: "idle" as const },
    ];
    const list = vi.fn(async () => ({ items: authoritative, nextCursor: null, hasMore: false }));
    const get = vi.fn(async (id: string) => authoritative.find((session) => session.id === id)!);
    const create = vi.fn(async () => {
      authoritative = [...authoritative, { id: "session-3", title: "网关权威会话", createdAt: now, updatedAt: now, pinned: false, status: "idle" as const }];
      return { ...authoritative[1], title: "临时创建响应" };
    });
    const client = clientFixture({ sessions: { ...base.sessions, list, get, create } });
    const first = render(<App client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "新建会话" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /网关权威会话/ }).closest(".session-row")).toHaveClass("active"));
    expect(list).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledWith("session-3");

    first.unmount();
    render(<App client={client} />);
    expect(await screen.findByRole("button", { name: /网关权威会话/ })).toBeVisible();
  });

  it("reads authoritative session list after rename and delete", async () => {
    const base = clientFixture();
    const now = "2026-08-08T08:00:00.000Z";
    let authoritative = [
      { id: "session-1", title: "发布检查", createdAt: now, updatedAt: now, pinned: false, status: "idle" as const },
      { id: "session-2", title: "知识库调研", createdAt: now, updatedAt: now, pinned: false, status: "idle" as const },
    ];
    const list = vi.fn(async () => ({ items: authoritative, nextCursor: null, hasMore: false }));
    const get = vi.fn(async (id: string) => authoritative.find((session) => session.id === id)!);
    const rename = vi.fn(async (id: string, title: string) => {
      authoritative = authoritative.map((session) => session.id === id ? { ...session, title: `${title}（权威）` } : session);
      return { ...authoritative.find((session) => session.id === id)!, title: "临时重命名响应" };
    });
    const remove = vi.fn(async (id: string) => { authoritative = authoritative.filter((session) => session.id !== id); });
    const organizerGet = vi.fn(async () => ({ schemaVersion: 1 as const, groups: [], sessions: [] }));
    const client = Object.assign(clientFixture({ sessions: { ...base.sessions, list, get, rename, remove } }), {
      sessionOrganizer: { get: organizerGet, setPinned: vi.fn(), createGroup: vi.fn(), renameGroup: vi.fn(), removeGroup: vi.fn(), assignGroup: vi.fn() },
    });
    vi.spyOn(window, "prompt").mockReturnValue("正式发布");
    render(<App client={client} />);

    const firstRow = (await screen.findByRole("button", { name: /发布检查/ })).closest(".session-row")!;
    fireEvent.click(within(firstRow as HTMLElement).getByRole("button", { name: "重命名会话" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /正式发布（权威）/ }).closest(".session-row")).toHaveClass("active"));

    const renamedRow = screen.getByRole("button", { name: /正式发布（权威）/ }).closest(".session-row")!;
    fireEvent.click(within(renamedRow as HTMLElement).getByRole("button", { name: "删除会话" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /正式发布（权威）/ })).not.toBeInTheDocument());
    expect(list).toHaveBeenCalledTimes(3);
    expect(organizerGet).toHaveBeenCalledTimes(2);
  });

  it("shows authoritative readback failures without discarding the loaded session list", async () => {
    const base = clientFixture();
    let listCalls = 0;
    const list = vi.fn(async () => {
      listCalls += 1;
      if (listCalls > 1) throw new Error("gateway readback failed");
      return base.sessions.list();
    });
    const client = clientFixture({ sessions: { ...base.sessions, list } });
    render(<App client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "新建会话" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("gateway readback failed");
    expect(screen.getByRole("button", { name: /发布检查/ })).toBeVisible();
  });

  it("filters sessions by title or preview", async () => {
    render(<App client={clientFixture()} />);
    const sidebar = await screen.findByRole("complementary", { name: "会话栏" });
    fireEvent.change(within(sidebar).getByRole("searchbox", { name: "搜索会话" }), { target: { value: "知识库" } });
    expect(within(sidebar).getByRole("button", { name: /知识库调研/ })).toBeVisible();
    expect(within(sidebar).queryByRole("button", { name: /发布检查/ })).not.toBeInTheDocument();
  });

  it("keeps separate drafts while switching sessions", async () => {
    render(<App client={clientFixture()} />);
    const composer = await screen.findByRole("textbox", { name: "给 U-Claw 发送消息" });
    await waitFor(() => expect(composer).toBeEnabled());
    fireEvent.change(composer, { target: { value: "发布会话草稿" } });
    fireEvent.click(screen.getByRole("button", { name: /知识库调研/ }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "给 U-Claw 发送消息" })).toHaveValue(""));
    fireEvent.change(screen.getByRole("textbox", { name: "给 U-Claw 发送消息" }), { target: { value: "知识库草稿" } });
    fireEvent.click(screen.getByRole("button", { name: /发布检查/ }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "给 U-Claw 发送消息" })).toHaveValue("发布会话草稿"));
    fireEvent.click(screen.getByRole("button", { name: /知识库调研/ }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "给 U-Claw 发送消息" })).toHaveValue("知识库草稿"));
  });

  it("hides the conversation header and context panel", async () => {
    render(<App client={clientFixture()} />);
    expect(await screen.findByText("第一段历史")).toBeVisible();
    expect(document.querySelector(".canvas-head")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "上下文舱" })).not.toBeInTheDocument();
  });

  it("reopens the session sidebar without restoring the conversation header", async () => {
    render(<App client={clientFixture()} />);
    fireEvent.click(await screen.findByRole("button", { name: "收起会话栏" }));
    fireEvent.click(screen.getByRole("button", { name: "展开会话栏" }));
    expect(await screen.findByRole("complementary", { name: "会话栏" })).toBeVisible();
    expect(document.querySelector(".canvas-head")).not.toBeInTheDocument();
  });

  it("sends text, renders append and replace deltas, then finalizes once", async () => {
    const pending = deferredStream();
    const client = clientFixture({ chat: { ...clientFixture().chat, send: vi.fn(() => pending.stream) } });
    render(<App client={client} />);

    const composer = await screen.findByRole("textbox", { name: "给 U-Claw 发送消息" });
    fireEvent.change(composer, { target: { value: "检查发布目录" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    expect(screen.getAllByText("检查发布目录").some((element) => element.matches(".message p"))).toBe(true);

    pending.emit({ type: "started", runId: "run-1", sessionId: "session-1" });
    pending.emit({ type: "delta", runId: "run-1", mode: "append", text: "正在" });
    expect(await screen.findByText("正在")).toBeVisible();
    pending.emit({ type: "delta", runId: "run-1", mode: "replace", text: "检查完成" });
    expect(await screen.findByText("检查完成")).toBeVisible();
    expect(screen.queryByText("正在")).not.toBeInTheDocument();
    pending.emit({ type: "final", runId: "run-1", message: { id: "final-1", sessionId: "session-1", runId: "run-1", role: "assistant", status: "completed", blocks: [{ id: "final-block", type: "text", text: "检查完成", format: "plain" }], createdAt: "2026-08-08T08:01:00.000Z" } });
    pending.finish();

    await waitFor(() => expect(screen.queryByRole("button", { name: "停止生成" })).not.toBeInTheDocument());
    expect(screen.getAllByText("检查完成")).toHaveLength(1);
  });

  it("sends one available Skill with the next message and clears it after success", async () => {
    const send = vi.fn(async function* () {
      yield { type: "started" as const, runId: "run-skill", sessionId: "session-1" };
      yield { type: "final" as const, runId: "run-skill", message: { id: "skill-final", sessionId: "session-1", runId: "run-skill", role: "assistant" as const, status: "completed" as const, blocks: [], createdAt: "2026-08-08T08:01:00.000Z" } };
    });
    window.uclaw = { skills: { invoke: vi.fn(async (request: any) => ({ method: request.method, requestId: request.requestId, ok: true, result: {
      workspaceDir: "/workspace", managedSkillsDir: "/workspace/skills", skills: [
        { id: "document-writer", name: "文档整理", source: "workspace", bundled: false, disabled: false, eligible: true, modelVisible: true, userInvocable: true, commandVisible: true, availability: "available", missing: { bins: [], anyBins: [], env: [], config: [], os: [] }, conflicts: [] },
        { id: "disabled-skill", name: "不可用技能", source: "workspace", bundled: false, disabled: true, eligible: true, modelVisible: true, userInvocable: true, commandVisible: true, availability: "disabled", missing: { bins: [], anyBins: [], env: [], config: [], os: [] }, conflicts: [] },
      ],
    } })) } } as never;
    const base = clientFixture();
    const client = clientFixture({ chat: { ...base.chat, send } });
    render(<App client={client} />);

    const skillSelect = await screen.findByRole("combobox", { name: "下一条消息 Skill" });
    fireEvent.mouseDown(skillSelect);
    fireEvent.click(await screen.findByText("文档整理"));
    expect(screen.queryByText("不可用技能")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "给 U-Claw 发送消息" }), { target: { value: "整理需求" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ skillId: "document-writer" }), expect.any(AbortSignal)));
    await waitFor(() => expect(document.querySelector('.composer-tools .ant-select-selection-item[title="文档整理"]')).not.toBeInTheDocument());
  });

  it("shows an installed Skill under its local display name while sending the OpenClaw runtime id", async () => {
    const send = vi.fn(async function* () {
      yield { type: "started" as const, runId: "run-local-skill", sessionId: "session-1" };
      yield { type: "final" as const, runId: "run-local-skill", message: { id: "local-skill-final", sessionId: "session-1", runId: "run-local-skill", role: "assistant" as const, status: "completed" as const, blocks: [], createdAt: "2026-08-08T08:01:00.000Z" } };
    });
    window.uclaw = { skills: { invoke: vi.fn(async (request: any) => {
      if (request.method === "skills.installed") return { method: request.method, requestId: request.requestId, ok: true, result: [{
        slug: "contextweave-interactive-architecture", name: "架构图一键生成", description: "Architecture", version: "1.2.0", pricingType: "free", installedVersion: "1.2.0",
        enabled: true, updateAvailable: false, source: { provider: "openclaw", origin: "workspace" }, permissions: [], permissionFingerprint: "empty", risk: "low", mode: "live", categories: [],
      }] };
      return { method: request.method, requestId: request.requestId, ok: true, result: { workspaceDir: "/workspace", managedSkillsDir: "/workspace/skills", skills: [
        { id: "contextweave-interactive-architecture", runtimeId: "interactive-architecture-diagram", name: "interactive-architecture-diagram", description: "Architecture", source: "workspace", bundled: false, disabled: false, eligible: true, modelVisible: true, userInvocable: true, commandVisible: true, availability: "available", missing: { bins: [], anyBins: [], env: [], config: [], os: [] }, conflicts: [] },
      ] } };
    }) } } as never;
    const base = clientFixture();
    render(<App client={clientFixture({ chat: { ...base.chat, send } })} />);

    fireEvent.mouseDown(await screen.findByRole("combobox", { name: "下一条消息 Skill" }));
    fireEvent.click(await screen.findByText("架构图一键生成"));
    fireEvent.change(screen.getByRole("textbox", { name: "给 U-Claw 发送消息" }), { target: { value: "生成架构图" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ skillId: "interactive-architecture-diagram" }), expect.any(AbortSignal)));
  });

  it("keeps the selected Skill after a failed send", async () => {
    window.uclaw = { skills: { invoke: vi.fn(async (request: any) => ({ method: request.method, requestId: request.requestId, ok: true, result: {
      workspaceDir: "/workspace", managedSkillsDir: "/workspace/skills", skills: [
        { id: "document-writer", name: "文档整理", source: "workspace", bundled: false, disabled: false, eligible: true, modelVisible: true, userInvocable: true, commandVisible: true, availability: "available", missing: { bins: [], anyBins: [], env: [], config: [], os: [] }, conflicts: [] },
      ],
    } })) } } as never;
    const base = clientFixture();
    const send = vi.fn(async function* () { throw new Error("skill send failed"); });
    render(<App client={clientFixture({ chat: { ...base.chat, send } })} />);

    fireEvent.mouseDown(await screen.findByRole("combobox", { name: "下一条消息 Skill" }));
    fireEvent.click(await screen.findByText("文档整理"));
    fireEvent.change(screen.getByRole("textbox", { name: "给 U-Claw 发送消息" }), { target: { value: "整理需求" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    expect(await screen.findByText("skill send failed")).toBeVisible();
    expect(document.querySelector('.composer-tools .ant-select-selection-item[title="文档整理"]')).toBeInTheDocument();
  });

  it("resolves a pending exec approval once when Gateway advertises approval support", async () => {
    const base = clientFixture();
    const resolveExec = vi.fn(async () => undefined);
    const approval = {
      id: "approval-live",
      family: "exec" as const,
      sessionId: "session-1",
      subject: { kind: "operation" as const, id: "operation-live" },
      title: "运行发布检查",
      description: "OpenClaw 请求执行一次受控操作",
      risk: "high" as const,
      permissions: [{ kind: "process" as const, scope: "gateway", description: "执行检查" }],
      choices: ["allow-once" as const, "deny" as const],
      status: "pending" as const,
    };
    const client = clientFixture({
      gateway: {
        ...base.gateway,
        negotiate: vi.fn(async () => ({
          protocolVersion: 4 as const,
          methods: new Set(["exec.approval.resolve"]),
          events: new Set(["exec.approval.requested"]),
          features: { attachments: false, approvalResolve: true, execApproval: true, pluginApproval: false },
        })),
      },
      approvals: {
        ...base.approvals,
        listPending: vi.fn(async () => [approval]),
        resolveExec,
      },
    });
    render(<App client={client} />);

    const allowOnce = await screen.findByRole("button", { name: "允许一次" });
    expect(allowOnce).toBeEnabled();
    fireEvent.click(allowOnce);

    await waitFor(() => expect(resolveExec).toHaveBeenCalledOnce());
    expect(resolveExec).toHaveBeenCalledWith({ ref: { family: "exec", id: "approval-live" }, decision: "allow-once" });
    await waitFor(() => expect(screen.queryByLabelText(/运行发布检查/)).not.toBeInTheDocument());
  });

  it("completes sends after the StrictMode effect replay", async () => {
    const base = clientFixture();
    const send = vi.fn(async function* () {
      yield { type: "started" as const, runId: "run-strict", sessionId: "session-1" };
      yield { type: "final" as const, runId: "run-strict", message: { id: "strict-final", sessionId: "session-1", runId: "run-strict", role: "assistant" as const, status: "completed" as const, blocks: [], createdAt: "2026-08-08T08:01:00.000Z" } };
    });
    const client = clientFixture({ chat: { ...base.chat, send } });
    render(<StrictMode><App client={client} /></StrictMode>);
    const composer = await screen.findByRole("textbox", { name: "给 U-Claw 发送消息" });
    fireEvent.change(composer, { target: { value: "StrictMode 发送" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).toBeVisible());
    expect(composer).toHaveValue("");
    expect(screen.queryByText("发送失败")).not.toBeInTheDocument();
  });

  it("clears the composer immediately while a response is pending", async () => {
    const gate = deferred<void>();
    const base = clientFixture();
    const send = vi.fn(async function* () {
      yield { type: "started" as const, runId: "run-pending-composer", sessionId: "session-1" };
      await gate.promise;
      yield { type: "final" as const, runId: "run-pending-composer", message: { id: "pending-composer-final", sessionId: "session-1", runId: "run-pending-composer", role: "assistant" as const, status: "completed" as const, blocks: [], createdAt: "2026-08-08T08:01:00.000Z" } };
    });
    render(<App client={clientFixture({ chat: { ...base.chat, send } })} />);
    const composer = await screen.findByRole("textbox", { name: "给 U-Claw 发送消息" });
    fireEvent.change(composer, { target: { value: "立即清空" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    expect(composer).toHaveValue("");
    gate.resolve();
    await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).toBeVisible());
  });

  it("stops a send before started and aborts as soon as run id arrives", async () => {
    const start = deferred<void>();
    const terminal = deferred<void>();
    let sentSignal: AbortSignal | undefined;
    const base = clientFixture();
    const abort = vi.fn(async () => { terminal.resolve(); });
    const sendStream = vi.fn((_input: Parameters<UClawClient["chat"]["send"]>[0], signal?: AbortSignal) => {
      sentSignal = signal;
      return (async function* () {
        await start.promise;
        if (signal?.aborted) throw new Error("signal aborted before started");
        yield { type: "started" as const, runId: "run-stop", sessionId: "session-1" };
        await terminal.promise;
        if (signal?.aborted) throw new Error("signal aborted before terminal");
        yield { type: "aborted" as const, runId: "run-stop", reason: "Stopped" };
      })();
    });
    const client = clientFixture({ chat: { ...base.chat, send: sendStream, abort } });
    render(<App client={client} />);
    const composer = await screen.findByRole("textbox", { name: "给 U-Claw 发送消息" });
    await waitFor(() => expect(composer).toBeEnabled());
    fireEvent.change(composer, { target: { value: "停止测试" } });
    const sendButton = screen.getByRole("button", { name: "发送消息" });
    await waitFor(() => expect(sendButton).toBeEnabled());
    fireEvent.click(sendButton);
    fireEvent.click(await screen.findByRole("button", { name: "停止生成" }));
    expect(sentSignal?.aborted).toBe(false);
    expect(abort).not.toHaveBeenCalled();
    start.resolve();
    await waitFor(() => expect(abort).toHaveBeenCalledWith("run-stop"));
    await waitFor(() => expect(screen.getByText("Stopped")).toBeVisible());
    await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).toBeVisible());
    expect(screen.queryByText("发送失败")).not.toBeInTheDocument();
  });

  it("uses protocol abort after started without cancelling the iterator signal", async () => {
    let release!: () => void;
    let sentSignal: AbortSignal | undefined;
    const abort = vi.fn(async () => { release(); });
    const base = clientFixture();
    const send = vi.fn((_input: Parameters<UClawClient["chat"]["send"]>[0], signal?: AbortSignal) => {
      sentSignal = signal;
      return (async function* () {
        yield { type: "started" as const, runId: "run-aware", sessionId: "session-1" };
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          signal?.addEventListener("abort", () => reject(new Error("signal aborted")), { once: true });
        });
        yield { type: "aborted" as const, runId: "run-aware", reason: "Stopped" };
      })();
    });
    const client = clientFixture({ chat: { ...base.chat, send, abort } });
    render(<App client={client} />);
    const composer = await screen.findByRole("textbox", { name: "给 U-Claw 发送消息" });
    fireEvent.change(composer, { target: { value: "协议停止" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "停止生成" })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "停止生成" }));

    await waitFor(() => expect(abort).toHaveBeenCalledWith("run-aware"));
    expect(sentSignal?.aborted).toBe(false);
    await waitFor(() => expect(screen.getByText("Stopped")).toBeVisible());
    expect(screen.queryByText("发送失败")).not.toBeInTheDocument();
  });

  it("does not let an old send completion reactivate its session after switching", async () => {
    const pending = deferredStream();
    let signal: AbortSignal | undefined;
    const base = clientFixture();
    const client = clientFixture({ chat: { ...base.chat, send: vi.fn((_input, value) => { signal = value; return pending.stream; }) } });
    render(<App client={client} />);
    const composer = await screen.findByRole("textbox", { name: "给 U-Claw 发送消息" });
    fireEvent.change(composer, { target: { value: "旧会话发送" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    pending.emit({ type: "started", runId: "run-old", sessionId: "session-1" });
    fireEvent.click(screen.getByRole("button", { name: /知识库调研/ }));
    expect(await within(screen.getByRole("main")).findByText("第二段历史")).toBeVisible();
    expect(signal?.aborted).toBe(true);
    pending.emit({ type: "final", runId: "run-old", message: { id: "old-final", sessionId: "session-1", runId: "run-old", role: "assistant", status: "completed", blocks: [], createdAt: "2026-08-08T08:01:00.000Z" } });
    pending.finish();
    await act(async () => undefined);

    expect(within(screen.getByRole("main")).getByText("第二段历史")).toBeVisible();
  });

  it("removes a stream approval after resolving it once", async () => {
    const base = clientFixture();
    const approval = { id: "approval-stream", family: "exec" as const, sessionId: "session-1", toolCallId: "tool-stream", subject: { kind: "toolCall" as const, id: "tool-stream" }, title: "Inspect workspace", description: "Read files", risk: "high" as const, permissions: [{ kind: "file-read" as const, scope: "fixture", description: "Read fixture" }], choices: ["allow-once" as const, "deny" as const], status: "pending" as const };
    const resolveExec = vi.fn(async () => undefined);
    const send = vi.fn(async function* () {
      yield { type: "started" as const, runId: "run-approval", sessionId: "session-1" };
      yield { type: "approval" as const, runId: "run-approval", approval };
      yield { type: "final" as const, runId: "run-approval", message: { id: "approval-final", sessionId: "session-1", runId: "run-approval", role: "assistant" as const, status: "completed" as const, blocks: [], createdAt: "2026-08-08T08:01:00.000Z" } };
    });
    const client = clientFixture({
      gateway: { ...base.gateway, negotiate: vi.fn(async () => ({ protocolVersion: 4 as const, methods: new Set(["chat.send", "chat.abort"]), events: new Set(["chat"]), features: { attachments: false, approvalResolve: true } })) },
      chat: { ...base.chat, send },
      approvals: { ...base.approvals, resolveExec },
    });
    render(<App client={client} />);
    const composer = await screen.findByRole("textbox", { name: "给 U-Claw 发送消息" });
    fireEvent.change(composer, { target: { value: "授权测试" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    const card = await screen.findByLabelText(/命令执行授权/);
    fireEvent.click(within(card).getByRole("button", { name: "允许一次" }));

    await waitFor(() => expect(screen.queryByLabelText(/命令执行授权/)).not.toBeInTheDocument());
    expect(resolveExec).toHaveBeenCalledOnce();
  });

  it("keeps a failed user message in the transcript and clears the composer", async () => {
    const client = clientFixture({ chat: { ...clientFixture().chat, send: vi.fn(async function* () { throw new Error("send failed"); }) } });
    render(<App client={client} />);
    const composer = await screen.findByRole("textbox", { name: "给 U-Claw 发送消息" });
    fireEvent.change(composer, { target: { value: "保留这段草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("发送失败");
    expect(composer).toHaveValue("");
    const failedMessage = screen.getByLabelText("用户消息，发送失败");
    expect(failedMessage).toHaveTextContent("保留这段草稿");
    expect(failedMessage).toHaveTextContent("发送失败");
  });

  it("scrolls the conversation to the latest optimistic message", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scrollTo });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 480 });
    const gate = deferred<void>();
    const base = clientFixture();
    const send = vi.fn(async function* () {
      yield { type: "started" as const, runId: "run-scroll", sessionId: "session-1" };
      await gate.promise;
    });
    render(<App client={clientFixture({ chat: { ...base.chat, send } })} />);
    const composer = await screen.findByRole("textbox", { name: "给 U-Claw 发送消息" });
    scrollTo.mockClear();
    fireEvent.change(composer, { target: { value: "滚到最新消息" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 480, behavior: "smooth" }));
    gate.resolve();
  });

  it("rotates clientRequestId after a failed message is re-entered", async () => {
    const base = clientFixture();
    let attempt = 0;
    const send = vi.fn((input: Parameters<UClawClient["chat"]["send"]>[0]) => (async function* () {
      attempt += 1;
      if (attempt === 1) throw new Error("send failed");
      yield { type: "started" as const, runId: `run-${attempt}`, sessionId: input.sessionId };
      yield { type: "final" as const, runId: `run-${attempt}`, message: { id: `final-${attempt}`, sessionId: input.sessionId, runId: `run-${attempt}`, role: "assistant" as const, status: "completed" as const, blocks: [], createdAt: "2026-08-08T08:01:00.000Z" } };
    })());
    const client = clientFixture({ chat: { ...base.chat, send } });
    render(<App client={client} />);
    const composer = await screen.findByRole("textbox", { name: "给 U-Claw 发送消息" });
    fireEvent.change(composer, { target: { value: "同一发送意图" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await screen.findByText("send failed");
    fireEvent.change(composer, { target: { value: "同一发送意图" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]![0].clientRequestId).not.toBe(send.mock.calls[0]![0].clientRequestId);

    fireEvent.change(composer, { target: { value: "新的发送意图" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls[2]![0].clientRequestId).not.toBe(send.mock.calls[1]![0].clientRequestId);
  });

  it("rotates clientRequestId only when the attachment picker adds an attachment", async () => {
    const base = clientFixture();
    const attachment = { id: "attachment-new", file: { id: "file-new", name: "new.txt", mediaType: "text/plain", size: 4, kind: "attachment" as const }, state: "ready" as const, progress: 1 };
    let selectCount = 0;
    const invoke = vi.fn(async (request: { method: string; requestId: string }) => ({
      method: request.method, requestId: request.requestId, ok: true,
      result: request.method === "select" ? (++selectCount === 1 ? [] : [attachment]) : request.method === "prepare" ? [attachment] : null,
    }));
    window.uclaw = { attachments: { invoke: invoke as never } };
    let attempt = 0;
    const send = vi.fn((input: Parameters<UClawClient["chat"]["send"]>[0]) => (async function* () {
      attempt += 1;
      if (attempt < 3) throw new Error("send failed");
      yield { type: "started" as const, runId: "run-picker", sessionId: input.sessionId };
      yield { type: "final" as const, runId: "run-picker", message: { id: "final-picker", sessionId: input.sessionId, runId: "run-picker", role: "assistant" as const, status: "completed" as const, blocks: [], createdAt: "2026-08-08T08:01:00.000Z" } };
    })());
    const client = clientFixture({ gateway: { ...base.gateway, negotiate: vi.fn(async () => ({ protocolVersion: 4 as const, methods: new Set(["chat.send"]), events: new Set<string>(), features: { attachments: true } })) }, chat: { ...base.chat, send } });
    render(<App client={client} />);
    const composer = await screen.findByRole("textbox", { name: "给 U-Claw 发送消息" });
    fireEvent.change(composer, { target: { value: "选择附件" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await screen.findByText("send failed");

    fireEvent.click(screen.getByRole("button", { name: "添加附件" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "select" })));
    fireEvent.change(composer, { target: { value: "选择附件" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]![0].clientRequestId).not.toBe(send.mock.calls[0]![0].clientRequestId);

    fireEvent.click(screen.getByRole("button", { name: "添加附件" }));
    expect(await screen.findByText("new.txt")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls[2]![0].clientRequestId).not.toBe(send.mock.calls[1]![0].clientRequestId);
  });

  it("prepares a concurrently selected duplicate attachment only once", async () => {
    const base = clientFixture();
    const attachment = { id: "attachment-concurrent", file: { id: "file-concurrent", name: "same.txt", mediaType: "text/plain", size: 4, kind: "attachment" as const }, state: "ready" as const, progress: 1 };
    const first = deferred<typeof attachment[]>();
    const second = deferred<typeof attachment[]>();
    let selectCount = 0;
    const invoke = vi.fn((request: { method: string; requestId: string }) => {
      if (request.method === "select") {
        selectCount += 1;
        return (selectCount === 1 ? first.promise : second.promise).then((result) => ({ method: request.method, requestId: request.requestId, ok: true as const, result }));
      }
      return Promise.resolve({ method: request.method, requestId: request.requestId, ok: true as const, result: request.method === "prepare" ? [attachment] : null });
    });
    window.uclaw = { attachments: { invoke: invoke as never } };
    const client = clientFixture({ gateway: { ...base.gateway, negotiate: vi.fn(async () => ({ protocolVersion: 4 as const, methods: new Set(["chat.send"]), events: new Set<string>(), features: { attachments: true } })) } });
    render(<App client={client} />);
    const add = await screen.findByRole("button", { name: "添加附件" });
    fireEvent.click(add);
    fireEvent.click(add);
    first.resolve([attachment]);
    second.resolve([attachment]);

    expect(await screen.findByText("same.txt")).toBeVisible();
    await waitFor(() => expect(invoke.mock.calls.filter(([request]) => request.method === "prepare")).toHaveLength(1));
  });

  it("preserves clientRequestId when a dropped attachment import fails", async () => {
    const base = clientFixture();
    const invoke = vi.fn(async (request: { method: string; requestId: string }) => {
      if (request.method === "import") throw new Error("import failed");
      return { method: request.method, requestId: request.requestId, ok: true, result: null };
    });
    window.uclaw = { attachments: { invoke: invoke as never } };
    let attempt = 0;
    const send = vi.fn((input: Parameters<UClawClient["chat"]["send"]>[0]) => (async function* () {
      attempt += 1;
      if (attempt === 1) throw new Error("send failed");
      yield { type: "started" as const, runId: "run-drop", sessionId: input.sessionId };
      yield { type: "final" as const, runId: "run-drop", message: { id: "final-drop", sessionId: input.sessionId, runId: "run-drop", role: "assistant" as const, status: "completed" as const, blocks: [], createdAt: "2026-08-08T08:01:00.000Z" } };
    })());
    const client = clientFixture({ gateway: { ...base.gateway, negotiate: vi.fn(async () => ({ protocolVersion: 4 as const, methods: new Set(["chat.send"]), events: new Set<string>(), features: { attachments: true } })) }, chat: { ...base.chat, send } });
    const { container } = render(<App client={client} />);
    const composer = await screen.findByRole("textbox", { name: "给 U-Claw 发送消息" });
    fireEvent.change(composer, { target: { value: "拖放失败后重试" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await screen.findByText("send failed");
    const file = new File(["data"], "failed.txt", { type: "text/plain" });
    fireEvent.drop(container.querySelector(".composer")!, { dataTransfer: { files: [file] } });
    await screen.findByText("import failed");
    fireEvent.change(composer, { target: { value: "拖放失败后重试" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]![0].clientRequestId).not.toBe(send.mock.calls[0]![0].clientRequestId);
  });

  it("rotates clientRequestId as soon as the first dropped attachment is imported", async () => {
    const base = clientFixture();
    const firstAttachment = { id: "attachment-first", file: { id: "file-first", name: "first.txt", mediaType: "text/plain", size: 5, kind: "attachment" as const }, state: "ready" as const, progress: 1 };
    const secondImport = deferred<typeof firstAttachment>();
    const invoke = vi.fn(async (request: { method: string; requestId: string; params?: { name?: string } }) => {
      if (request.method === "import") {
        const result = request.params?.name === "first.txt" ? firstAttachment : await secondImport.promise;
        return { method: request.method, requestId: request.requestId, ok: true, result };
      }
      return { method: request.method, requestId: request.requestId, ok: true, result: request.method === "prepare" ? [firstAttachment] : null };
    });
    window.uclaw = { attachments: { invoke: invoke as never } };
    let attempt = 0;
    const send = vi.fn((input: Parameters<UClawClient["chat"]["send"]>[0]) => (async function* () {
      attempt += 1;
      if (attempt === 1) throw new Error("send failed");
      yield { type: "started" as const, runId: "run-partial-drop", sessionId: input.sessionId };
      yield { type: "final" as const, runId: "run-partial-drop", message: { id: "final-partial-drop", sessionId: input.sessionId, runId: "run-partial-drop", role: "assistant" as const, status: "completed" as const, blocks: [], createdAt: "2026-08-08T08:01:00.000Z" } };
    })());
    const client = clientFixture({ gateway: { ...base.gateway, negotiate: vi.fn(async () => ({ protocolVersion: 4 as const, methods: new Set(["chat.send"]), events: new Set<string>(), features: { attachments: true } })) }, chat: { ...base.chat, send } });
    const { container } = render(<App client={client} />);
    const composer = await screen.findByRole("textbox", { name: "给 U-Claw 发送消息" });
    fireEvent.change(composer, { target: { value: "首个附件入队后发送" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await screen.findByText("send failed");
    fireEvent.drop(container.querySelector(".composer")!, { dataTransfer: { files: [
      new File(["first"], "first.txt", { type: "text/plain" }),
      new File(["second"], "second.txt", { type: "text/plain" }),
    ] } });
    expect(await screen.findByText("first.txt")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]![0].clientRequestId).not.toBe(send.mock.calls[0]![0].clientRequestId);
    secondImport.resolve({ ...firstAttachment, id: "attachment-second", file: { ...firstAttachment.file, id: "file-second", name: "second.txt" } });
  });

  it("rotates clientRequestId after an aborted terminal event", async () => {
    const base = clientFixture();
    let attempt = 0;
    const send = vi.fn((input: Parameters<UClawClient["chat"]["send"]>[0]) => (async function* () {
      attempt += 1;
      yield { type: "started" as const, runId: `run-aborted-${attempt}`, sessionId: input.sessionId };
      if (attempt === 1) {
        yield { type: "aborted" as const, runId: "run-aborted-1", reason: "Stopped" };
        return;
      }
      yield { type: "final" as const, runId: "run-aborted-2", message: { id: "final-aborted", sessionId: input.sessionId, runId: "run-aborted-2", role: "assistant" as const, status: "completed" as const, blocks: [], createdAt: "2026-08-08T08:01:00.000Z" } };
    })());
    const client = clientFixture({ chat: { ...base.chat, send } });
    render(<App client={client} />);
    const composer = await screen.findByRole("textbox", { name: "给 U-Claw 发送消息" });
    fireEvent.change(composer, { target: { value: "停止后重发" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await screen.findByText("Stopped");
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]![0].clientRequestId).not.toBe(send.mock.calls[0]![0].clientRequestId);
  });

  it("clears successful attachments so a later text-only send is not blocked", async () => {
    const base = clientFixture();
    const attachment = { id: "attachment-1", file: { id: "file-1", name: "report.txt", mediaType: "text/plain", size: 4, kind: "attachment" as const }, state: "ready" as const, progress: 1 };
    const invoke = vi.fn(async (request: { method: string; requestId: string }) => ({ method: request.method, requestId: request.requestId, ok: true, result: request.method === "select" ? [attachment] : request.method === "prepare" ? [attachment] : null }));
    window.uclaw = { attachments: { invoke: invoke as never } };
    const send = vi.fn((input: Parameters<UClawClient["chat"]["send"]>[0]) => (async function* () {
      yield { type: "started" as const, runId: `run-${send.mock.calls.length}`, sessionId: input.sessionId };
      yield { type: "final" as const, runId: `run-${send.mock.calls.length}`, message: { id: `final-${send.mock.calls.length}`, sessionId: input.sessionId, runId: `run-${send.mock.calls.length}`, role: "assistant" as const, status: "completed" as const, blocks: [], createdAt: "2026-08-08T08:01:00.000Z" } };
    })());
    const client = clientFixture({ gateway: { ...base.gateway, negotiate: vi.fn(async () => ({ protocolVersion: 4 as const, methods: new Set(["chat.send"]), events: new Set<string>(), features: { attachments: true } })) }, chat: { ...base.chat, send } });
    render(<App client={client} />);
    const addAttachment = await screen.findByRole("button", { name: "添加附件" });
    await waitFor(() => expect(addAttachment).toBeEnabled());
    fireEvent.click(addAttachment);
    expect(await screen.findByText("report.txt")).toBeVisible();
    const composer = screen.getByRole("textbox", { name: "给 U-Claw 发送消息" });
    fireEvent.change(composer, { target: { value: "带附件发送" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(screen.queryByLabelText("附件队列")).not.toBeInTheDocument());

    fireEvent.change(composer, { target: { value: "纯文本发送" } });
    expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]![0].blocks).toEqual([{ type: "text", text: "纯文本发送", format: "plain" }]);
  });

  it("reads failed attachment state after send failure and retries the same attachment", async () => {
    const base = clientFixture();
    const ready = { id: "attachment-failed", file: { id: "file-failed", name: "failed.txt", mediaType: "text/plain", size: 4, kind: "attachment" as const }, state: "ready" as const, progress: 1 };
    const failed = { ...ready, state: "failed" as const, error: { code: "OPERATION_FAILED" as const, message: "上传失败", retryable: true } };
    const invoke = vi.fn(async (request: { method: string; requestId: string }) => ({ method: request.method, requestId: request.requestId, ok: true, result: request.method === "select" ? [ready] : request.method === "get" ? failed : request.method === "prepare" ? [ready] : null }));
    window.uclaw = { attachments: { invoke: invoke as never } };
    let attempt = 0;
    const send = vi.fn((input: Parameters<UClawClient["chat"]["send"]>[0]) => (async function* () {
      attempt += 1;
      if (attempt === 1) throw new Error("send failed");
      yield { type: "started" as const, runId: "run-attachment-retry", sessionId: input.sessionId };
      yield { type: "final" as const, runId: "run-attachment-retry", message: { id: "final-attachment-retry", sessionId: input.sessionId, runId: "run-attachment-retry", role: "assistant" as const, status: "completed" as const, blocks: [], createdAt: "2026-08-08T08:01:00.000Z" } };
    })());
    const client = clientFixture({ gateway: { ...base.gateway, negotiate: vi.fn(async () => ({ protocolVersion: 4 as const, methods: new Set(["chat.send"]), events: new Set<string>(), features: { attachments: true } })) }, chat: { ...base.chat, send } });
    render(<App client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "添加附件" }));
    const composer = screen.getByRole("textbox", { name: "给 U-Claw 发送消息" });
    fireEvent.change(composer, { target: { value: "失败附件" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    expect(await screen.findByText("上传失败")).toBeVisible();
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "get", params: { attachmentId: "attachment-failed" } }));
    fireEvent.click(screen.getByRole("button", { name: "重试 failed.txt" }));
    await waitFor(() => expect(invoke.mock.calls.filter(([request]) => request.method === "prepare").length).toBeGreaterThan(1));
    fireEvent.change(composer, { target: { value: "失败附件" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]![0].clientRequestId).not.toBe(send.mock.calls[0]![0].clientRequestId);
  });

  it("resets session paging metadata after a successful refresh", async () => {
    const base = clientFixture();
    let listCall = 0;
    const list = vi.fn(async () => {
      listCall += 1;
      const items = [{ id: "session-1", title: "发布检查", updatedAt: "2026-08-08T08:00:00.000Z", pinned: false, status: "idle" as const }];
      return listCall === 1 ? { items, nextCursor: "old-cursor", hasMore: true } : { items, nextCursor: null, hasMore: false };
    });
    const send = vi.fn(async function* () {
      yield { type: "started" as const, runId: "run-refresh", sessionId: "session-1" };
      yield { type: "final" as const, runId: "run-refresh", message: { id: "final-refresh", sessionId: "session-1", runId: "run-refresh", role: "assistant" as const, status: "completed" as const, blocks: [], createdAt: "2026-08-08T08:01:00.000Z" } };
    });
    const client = clientFixture({ sessions: { ...base.sessions, list }, chat: { ...base.chat, send } });
    render(<App client={client} />);
    expect(await screen.findByRole("button", { name: "加载更多" })).toBeVisible();
    const composer = screen.getByRole("textbox", { name: "给 U-Claw 发送消息" });
    fireEvent.change(composer, { target: { value: "刷新分页" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument());
  });

  it("shows disconnected state and reconnect action", async () => {
    const base = clientFixture();
    const disconnected = { ...(await base.gateway.getStatus()), connectionState: "failed" as const, phase: "failed" as const, businessAvailable: false, serviceReady: false };
    const reconnect = vi.fn(async () => undefined);
    const client = clientFixture({ gateway: { ...base.gateway, getStatus: vi.fn(async () => disconnected), watchStatus: vi.fn(async function* () { yield disconnected; }), reconnect } });
    render(<App client={client} />);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("服务连接已断开")).toBeVisible();
    fireEvent.click(within(alert).getByRole("button", { name: "重新连接" }));
    expect(reconnect).toHaveBeenCalledOnce();
  });
});

describe("messageEventReducer", () => {
  it("applies append and replace deltas", () => {
    const started = messageEventReducer(initialStreamState, { type: "started", runId: "run-1", sessionId: "session-1" });
    const appended = messageEventReducer(started, { type: "delta", runId: "run-1", mode: "append", text: "A" });
    const replaced = messageEventReducer(appended, { type: "delta", runId: "run-1", mode: "replace", text: "B" });
    expect(replaced.runs["run-1"].text).toBe("B");
  });

  it("keeps the first terminal event for each run", () => {
    const started = messageEventReducer(initialStreamState, { type: "started", runId: "run-1", sessionId: "session-1" });
    const aborted = messageEventReducer(started, { type: "aborted", runId: "run-1", reason: "Stopped" });
    const errored = messageEventReducer(aborted, { type: "error", runId: "run-1", error: { code: "UNKNOWN", message: "late", retryable: false, recoveryActions: [], causeDetails: {} } });
    expect(errored.runs["run-1"].terminal).toBe("aborted");
  });
});

describe("useMessageStream", () => {
  it("rejects when the gateway stream closes before a terminal event", async () => {
    const source: AsyncIterable<MessageEvent> = {
      [Symbol.asyncIterator]: () => ({
        next: vi.fn()
          .mockResolvedValueOnce({ done: false as const, value: { type: "started" as const, runId: "run-closed", sessionId: "session-1" } })
          .mockResolvedValueOnce({ done: true as const, value: undefined }),
      }),
    };
    const { result } = renderHook(() => useMessageStream());

    await act(async () => {
      await expect(result.current.consume(source)).rejects.toThrow("消息流在完成前中断");
    });
    expect(result.current.state.runs["run-closed"]).toMatchObject({
      terminal: "error",
      errorMessage: "消息流在完成前中断",
    });
  });

  it("returns the first terminal event and closes the iterator", async () => {
    const final: MessageEvent = { type: "final", runId: "run-1", message: { id: "message-1", sessionId: "session-1", runId: "run-1", role: "assistant", status: "completed", blocks: [], createdAt: "2026-08-08T08:00:00.000Z" } };
    const lateError: MessageEvent = { type: "error", runId: "run-1", error: { code: "UNKNOWN", message: "late", retryable: false, recoveryActions: [], causeDetails: {} } };
    const events: MessageEvent[] = [{ type: "started", runId: "run-1", sessionId: "session-1" }, final, lateError];
    const close = vi.fn(async () => ({ done: true as const, value: undefined }));
    const source: AsyncIterable<MessageEvent> = { [Symbol.asyncIterator]: () => ({ next: vi.fn(async () => events.length > 0 ? { done: false as const, value: events.shift()! } : { done: true as const, value: undefined }), return: close }) };
    const onEvent = vi.fn();
    const { result } = renderHook(() => useMessageStream(onEvent));
    let terminal: MessageEvent | undefined;

    await act(async () => { terminal = await result.current.consume(source); });

    expect(terminal).toEqual(final);
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual(["started", "final"]);
    expect(close).toHaveBeenCalledOnce();
  });
});
