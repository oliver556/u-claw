// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import type { MessageEvent, UClawClient } from "@uclaw/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/app/App";
import { initialStreamState, messageEventReducer } from "../src/features/chat/useMessageStream";

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
      get: vi.fn(async (id: string) => ({ id, title: id === "session-1" ? "发布检查" : "知识库调研", createdAt: now, updatedAt: now, pinned: false, status: "idle" as const })),
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
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    delete window.uclaw;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
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

  it("creates and selects an empty session", async () => {
    const client = clientFixture();
    render(<App client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "新建会话" }));
    expect(await screen.findByRole("heading", { name: "新会话" })).toBeVisible();
    expect(await screen.findByText("开始一段新会话")).toBeVisible();
  });

  it("filters sessions by title or preview", async () => {
    render(<App client={clientFixture()} />);
    const sidebar = await screen.findByRole("complementary", { name: "会话栏" });
    fireEvent.change(within(sidebar).getByRole("searchbox", { name: "搜索会话" }), { target: { value: "知识库" } });
    expect(within(sidebar).getByRole("button", { name: /知识库调研/ })).toBeVisible();
    expect(within(sidebar).queryByRole("button", { name: /发布检查/ })).not.toBeInTheDocument();
  });

  it("sends text, renders append and replace deltas, then finalizes once", async () => {
    const pending = deferredStream();
    const client = clientFixture({ chat: { ...clientFixture().chat, send: vi.fn(() => pending.stream) } });
    render(<App client={client} />);

    const composer = await screen.findByRole("textbox", { name: "给 U-Claw 发送消息" });
    fireEvent.change(composer, { target: { value: "检查发布目录" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    expect(screen.getByText("检查发布目录")).toBeVisible();

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

  it("stops active run", async () => {
    const pending = deferredStream();
    const base = clientFixture();
    const abort = vi.fn(async () => undefined);
    const client = clientFixture({ chat: { ...base.chat, send: vi.fn(() => pending.stream), abort } });
    render(<App client={client} />);
    const composer = await screen.findByRole("textbox", { name: "给 U-Claw 发送消息" });
    await waitFor(() => expect(composer).toBeEnabled());
    fireEvent.change(composer, { target: { value: "停止测试" } });
    const send = screen.getByRole("button", { name: "发送消息" });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    pending.emit({ type: "started", runId: "run-stop", sessionId: "session-1" });

    fireEvent.click(await screen.findByRole("button", { name: "停止生成" }));
    expect(abort).toHaveBeenCalledWith("run-stop");
  });

  it("restores failed message to composer for retry", async () => {
    const client = clientFixture({ chat: { ...clientFixture().chat, send: vi.fn(async function* () { throw new Error("send failed"); }) } });
    render(<App client={client} />);
    const composer = await screen.findByRole("textbox", { name: "给 U-Claw 发送消息" });
    fireEvent.change(composer, { target: { value: "保留这段草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("发送失败");
    expect(composer).toHaveValue("保留这段草稿");
    expect([...document.querySelectorAll(".message")].some((message) => message.textContent?.includes("保留这段草稿"))).toBe(false);
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
