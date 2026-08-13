// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { ManualClock, MockUClawClient } from "@uclaw/adapter";
import type { ClientIpcEvent, ClientIpcRequest, GatewayStatus, IpcResponse, UClawClient, WindowIpcRequest } from "@uclaw/shared";
import { transferableAbortController } from "node:util";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/app/App";

const previewClock = new ManualClock("2026-08-08T08:00:00.000Z");
const previewClient = new MockUClawClient({ clock: previewClock });
const renderApp = () => render(<App client={window.uclaw?.client ? undefined : previewClient} />);
const getComputedStyle = window.getComputedStyle.bind(window);
const JsdomAbortController = globalThis.AbortController;

class RequestCompatibleAbortController {
  readonly #controller = transferableAbortController();
  get signal() { return this.#controller.signal; }
  abort(reason?: unknown) { this.#controller.abort(reason); }
}

const statusFixture = (overrides: Partial<GatewayStatus> = {}): GatewayStatus => ({
  connectionState: "ready",
  protocolVersion: 4,
  phase: "available",
  processAlive: true,
  serviceReady: true,
  businessAvailable: true,
  since: "2026-08-09T00:00:00.000Z",
  attempt: 1,
  usb: { state: "available", dataWritable: true, displayName: "U-Claw" },
  ...overrides,
});

function clientWithStatus(status: GatewayStatus, reconnect: UClawClient["gateway"]["reconnect"] = async () => undefined): UClawClient {
  const mock = new MockUClawClient({ clock: new ManualClock("2026-08-09T00:00:00.000Z") });
  return {
    ...mock,
    gateway: {
      ...mock.gateway,
      getStatus: async () => status,
      watchStatus: async function* () { yield status; },
      reconnect,
    },
  };
}

describe("U-Claw application shell", () => {
  it("mounts the Agent/Cron manager on the automation route", async () => {
    window.history.pushState({}, "", "/#/automation");
    Object.defineProperty(window, "uclaw", { configurable: true, value: {
      automation: { invoke: vi.fn(async (request: { method: string; requestId: string }) => ({
        method: request.method, requestId: request.requestId, ok: true,
        result: request.method === "agents.list" ? { agents: [] } : null,
      })) },
    } });
    render(<App client={previewClient} />);
    expect(await screen.findByRole("region", { name: "Agent 与定时任务" })).toBeInTheDocument();
  });
  beforeAll(() => { globalThis.AbortController = RequestCompatibleAbortController as typeof AbortController; });
  afterAll(() => { globalThis.AbortController = JsdomAbortController; });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => getComputedStyle(element));
    delete window.uclaw;
  });

  it("uses the preload client bridge instead of Mock in Electron", async () => {
    const subscribers = new Set<(event: ClientIpcEvent) => void>();
    const invoke = vi.fn(async (request: ClientIpcRequest): Promise<IpcResponse> => {
      if (request.method === "sessions.list") return { method: request.method, requestId: request.requestId, ok: true, result: { items: [], nextCursor: null, hasMore: false } };
      if (request.method === "gateway.negotiate") return { method: request.method, requestId: request.requestId, ok: true, result: { protocolVersion: 4, methods: [], events: [], features: {} } };
      if (request.method === "gateway.watch-status" || request.method === "subscriptions.cancel") return { method: request.method, requestId: request.requestId, ok: true, result: null };
      throw new Error(`unexpected ${request.method}`);
    });
    window.uclaw = {
      client: { invoke, subscribe: (listener) => { subscribers.add(listener); return () => subscribers.delete(listener); } },
    };

    renderApp();

    expect((await screen.findAllByText("还没有会话")).length).toBeGreaterThan(0);
    expect(screen.getByText("U 盘检测中")).toBeVisible();
    expect(screen.getByText("Gateway 启动中")).toBeVisible();
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "sessions.list", params: {} }));
  });

  it("labels browser startup without preload as development preview and does not create a mock client", () => {
    render(<App />);

    expect(screen.getByRole("status")).toHaveTextContent("开发预览");
    expect(screen.queryByRole("navigation", { name: "主导航" })).not.toBeInTheDocument();
  });

  it("keeps one preload event listener through StrictMode replay and removes it on unmount", async () => {
    const subscribers = new Set<(event: ClientIpcEvent) => void>();
    const unsubscribe = vi.fn((listener: (event: ClientIpcEvent) => void) => subscribers.delete(listener));
    const invoke = vi.fn(async (request: ClientIpcRequest): Promise<IpcResponse> => {
      if (request.method === "sessions.list") return { method: request.method, requestId: request.requestId, ok: true, result: { items: [], nextCursor: null, hasMore: false } };
      if (request.method === "gateway.negotiate") return { method: request.method, requestId: request.requestId, ok: true, result: { protocolVersion: 4, methods: [], events: [], features: {} } };
      if (request.method === "gateway.watch-status" || request.method === "subscriptions.cancel") return { method: request.method, requestId: request.requestId, ok: true, result: null };
      throw new Error(`unexpected ${request.method}`);
    });
    window.uclaw = {
      client: { invoke, subscribe: (listener) => { subscribers.add(listener); return () => { unsubscribe(listener); }; } },
    };

    const { unmount } = render(<StrictMode><App /></StrictMode>);
    expect((await screen.findAllByText("还没有会话")).length).toBeGreaterThan(0);
    expect(subscribers.size).toBe(1);

    unmount();
    await Promise.resolve();
    expect(subscribers.size).toBe(0);
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("exposes billing destinations and marks Work current", () => {
    renderApp();

    const navigation = screen.getByRole("navigation", { name: "主导航" });
    for (const label of ["工作", "文件", "记忆", "能力", "连接", "用量", "余额", "系统"]) {
      expect(within(navigation).getByRole("link", { name: label })).toBeVisible();
    }
    expect(within(navigation).getByRole("link", { name: "工作" })).toHaveAttribute("aria-current", "page");
  });

  it("opens the usage and balance product views", async () => {
    renderApp();

    fireEvent.click(screen.getByRole("link", { name: "用量" }));
    expect(await screen.findByRole("region", { name: "积分使用量" })).toBeVisible();

    fireEvent.click(screen.getByRole("link", { name: "余额" }));
    expect(await screen.findByRole("region", { name: "余额与积分" })).toBeVisible();
  });

  it("opens the authoritative Task and Artifact center from the titlebar", async () => {
    const invokeTaskArtifacts = vi.fn(async (request: { method: string; requestId: string }) => ({ method: request.method, requestId: request.requestId, ok: true, result: [] }));
    window.uclaw = { taskArtifacts: { invoke: invokeTaskArtifacts as never, subscribe: () => () => undefined } } as never;
    renderApp();
    const titlebar = document.querySelector(".titlebar")!;
    fireEvent.click(within(titlebar as HTMLElement).getByRole("button", { name: "打开任务活动中心" }));
    expect(await screen.findByRole("region", { name: "Task 活动中心" })).toBeVisible();
    expect(invokeTaskArtifacts).toHaveBeenCalledWith(expect.objectContaining({ method: "tasks.list" }));
    expect(invokeTaskArtifacts).toHaveBeenCalledWith(expect.objectContaining({ method: "artifacts.list" }));
  });

  it("opens the same Task and Artifact center from the session sidebar bell", async () => {
    const invokeTaskArtifacts = vi.fn(async (request: { method: string; requestId: string }) => ({ method: request.method, requestId: request.requestId, ok: true, result: [] }));
    window.uclaw = { taskArtifacts: { invoke: invokeTaskArtifacts as never, subscribe: () => () => undefined } } as never;
    renderApp();
    const sidebar = await screen.findByRole("complementary", { name: "会话栏" });
    fireEvent.click(within(sidebar).getByRole("button", { name: "打开任务活动中心" }));
    expect(await screen.findByRole("region", { name: "Task 活动中心" })).toBeVisible();
  });

  it("navigates to another primary destination", () => {
    renderApp();
    fireEvent.click(screen.getByRole("link", { name: "文件" }));

    expect(screen.getByRole("heading", { name: "文件" })).toBeVisible();
    expect(screen.getByRole("link", { name: "文件" })).toHaveAttribute("aria-current", "page");
    expect(document.querySelector(".workspace-grid")).toHaveClass("secondary-layout");
    expect(screen.queryByLabelText("会话栏")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("上下文舱")).not.toBeInTheDocument();
  });

  it("changes and persists appearance from the system center", async () => {
    localStorage.clear();
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      media: "(prefers-color-scheme: dark)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    renderApp();
    fireEvent.click(screen.getByRole("link", { name: "系统" }));
    fireEvent.click(screen.getByRole("tab", { name: "外观" }));

    const chooser = screen.getByRole("radiogroup", { name: "主题模式" });
    fireEvent.click(within(chooser).getByRole("radio", { name: /深色/ }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(JSON.parse(localStorage.getItem("uclaw.settings.v1") ?? "{}")).toMatchObject({ appearance: { theme: "dark" } });

    fireEvent.click(within(chooser).getByRole("radio", { name: /跟随系统/ }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(JSON.parse(localStorage.getItem("uclaw.settings.v1") ?? "{}")).toMatchObject({ appearance: { theme: "system" } });
  });

  it("blocks router navigation while memory edits are dirty", async () => {
    const memory = { id: "MEMORY.md", title: "长期记忆", modifiedAt: "2026-08-09T00:00:00.000Z", version: "m1", size: 10 };
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "data.status") return { method: request.method, requestId: request.requestId, ok: true, result: { state: "available", writable: true } };
      if (request.method === "memory.list") return { method: request.method, requestId: request.requestId, ok: true, result: { items: [memory], nextCursor: null, hasMore: false } };
      if (request.method === "memory.read") return { method: request.method, requestId: request.requestId, ok: true, result: { memory, content: "old" } };
      if (request.method === "workspace.list") return { method: request.method, requestId: request.requestId, ok: true, result: { items: [], nextCursor: null, hasMore: false } };
      throw new Error(`unexpected ${request.method}`);
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    window.uclaw = { data: { invoke } } as any;
    renderApp();

    fireEvent.click(screen.getByRole("link", { name: "记忆" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看 长期记忆" }));
    fireEvent.change(await screen.findByLabelText("记忆正文"), { target: { value: "dirty" } });
    fireEvent.click(screen.getByRole("link", { name: "文件" }));

    expect(confirm).toHaveBeenCalledWith("当前记忆尚未保存，放弃修改吗？");
    expect(screen.getByRole("link", { name: "记忆" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByLabelText("记忆正文")).toHaveValue("dirty");

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("link", { name: "文件" }));
    expect(await screen.findByRole("heading", { name: "文件" })).toBeVisible();
  });

  it("opens advanced console through fixed window IPC without a URL", async () => {
    const invoke = vi.fn(async (request: WindowIpcRequest): Promise<IpcResponse> => ({
      method: request.method, requestId: request.requestId, ok: true, result: null,
    }));
    window.uclaw = { window: { invoke } };
    renderApp();
    fireEvent.click(screen.getByRole("link", { name: "系统" }));
    fireEvent.click(screen.getByRole("button", { name: "打开高级控制台" }));

    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "open-advanced-console", params: {} }));
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("url");
  });

  it("keeps diagnostics and data maintenance available from the system route", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("link", { name: "系统" }));

    expect(screen.getByRole("tab", { name: "诊断" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "系统" })).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "设备与运行" }));
    expect(screen.getByLabelText("设备与运行")).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "语音与通知" }));
    expect(screen.getByLabelText("语音与通知")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "产品授权" }));
    expect(screen.getByLabelText("产品授权")).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "备份与存储" }));
    expect(screen.getByRole("tab", { name: "备份与存储" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "数据维护" })).toBeVisible();
  });

  it("keeps live USB, Gateway, and model status visible with Chinese recovery actions", async () => {
    const status = {
      connectionState: "degraded",
      protocolVersion: 4,
      phase: "degraded",
      processAlive: true,
      serviceReady: true,
      businessAvailable: false,
      since: "2026-08-09T00:00:00.000Z",
      attempt: 1,
      activeModel: { id: "gpt-5", label: "GPT-5" },
      usb: { state: "read-only", dataWritable: false, displayName: "U-Claw" },
      error: {
        code: "USB_READ_ONLY",
        message: "U 盘数据目录只读",
        retryable: false,
        recoveryActions: ["open-diagnostics", "safe-exit"],
        causeDetails: {},
      },
    } satisfies GatewayStatus;
    const mock = new MockUClawClient({ clock: new ManualClock("2026-08-09T00:00:00.000Z") });
    const reconnect = vi.fn(async () => undefined);
    const client: UClawClient = {
      ...mock,
      gateway: {
        ...mock.gateway,
        getStatus: async () => status,
        watchStatus: async function* () { yield status; },
        reconnect,
      },
    };
    const invoke = vi.fn(async (request: WindowIpcRequest): Promise<IpcResponse> => ({ ...request, ok: true, result: null }));
    window.uclaw = { window: { invoke } };

    render(<App client={client} />);

    expect(await screen.findByText("U 盘只读")).toBeVisible();
    expect(screen.getByText("Gateway 异常")).toBeVisible();
    expect(screen.getByText("GPT-5")).toBeVisible();
    expect(screen.getByText("U 盘数据目录只读").closest("[role=alert]")).toHaveTextContent("错误码：USB_READ_ONLY");
    fireEvent.click(screen.getByRole("link", { name: "查看诊断" }));
    expect(screen.getByRole("heading", { name: "系统" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "安全退出" }));
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "close", params: {} }));
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("marks an available but unwritable USB drive as warning", async () => {
    const client = clientWithStatus(statusFixture({
      usb: { state: "available", dataWritable: false, displayName: "U-Claw" },
    }));

    render(<App client={client} />);

    const label = await screen.findByText("U 盘不可写");
    const dot = label.closest(".status-item")?.querySelector(".status-dot");
    expect(dot).toHaveClass("warning");
    expect(dot).not.toHaveClass("success");
  });

  it("reports a rejected reconnect without an unhandled promise", async () => {
    const reconnect = vi.fn(async () => { throw new Error("reconnect failed"); });
    const client = clientWithStatus(statusFixture({
      connectionState: "failed",
      phase: "failed",
      businessAvailable: false,
      error: {
        code: "GATEWAY_FAILED",
        message: "Gateway 启动失败",
        retryable: true,
        recoveryActions: ["reconnect"],
        causeDetails: {},
      },
    }), reconnect);

    render(<App client={client} />);
    const recovery = (await screen.findByText("Gateway 启动失败")).closest("[role=alert]");
    fireEvent.click(within(recovery as HTMLElement).getByRole("button", { name: "重新连接" }));

    expect(await screen.findByText("重新连接失败，请重试")).toBeVisible();
    expect(reconnect).toHaveBeenCalledOnce();
  });

  it("focuses main content from the skip link without changing hash routes", () => {
    renderApp();
    fireEvent.click(screen.getByRole("link", { name: "文件" }));
    expect(window.location.hash).toBe("#/files");

    fireEvent.click(screen.getByRole("link", { name: "跳到主要内容" }));

    expect(screen.getByRole("main")).toHaveFocus();
    expect(window.location.hash).toBe("#/files");
  });

  it("collapses and restores the session panel while keeping the context panel hidden", () => {
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "收起会话栏" }));
    expect(screen.queryByLabelText("会话栏")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开会话栏" }));
    expect(screen.getByLabelText("会话栏")).toBeVisible();

    expect(screen.queryByLabelText("上下文舱")).not.toBeInTheDocument();
  });

  it("routes Windows controls through the injected bridge", () => {
    const invoke = vi.fn(async (request: WindowIpcRequest): Promise<IpcResponse> => ({ ...request, ok: true, result: null }));
    window.uclaw = { window: { invoke } };
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "最小化" }));
    fireEvent.click(screen.getByRole("button", { name: "最大化" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    expect(invoke.mock.calls.map(([request]) => request.method)).toEqual(["minimize", "toggle-maximize", "close"]);
    for (const [request] of invoke.mock.calls) {
      expect(request).toMatchObject({ params: {} });
      expect(request.requestId).toMatch(/^window-/);
    }
  });

  it("toggles maximize when the draggable titlebar is double-clicked", () => {
    const invoke = vi.fn(async (request: WindowIpcRequest): Promise<IpcResponse> => ({ ...request, ok: true, result: null }));
    window.uclaw = { window: { invoke } };
    renderApp();

    fireEvent.doubleClick(document.querySelector(".titlebar")!);

    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      method: "toggle-maximize",
      params: {},
    }));
  });

  it("shows the restore control when preload reports a maximized window", () => {
    let reportMaximized: ((maximized: boolean) => void) | undefined;
    const unsubscribe = vi.fn();
    window.uclaw = {
      window: {
        invoke: vi.fn(async (request: WindowIpcRequest): Promise<IpcResponse> => ({ ...request, ok: true, result: null })),
        onMaximizedChange: (listener) => {
          reportMaximized = listener;
          return unsubscribe;
        },
      },
    };
    const { unmount } = renderApp();

    act(() => reportMaximized?.(true));
    expect(screen.getByRole("button", { name: "还原" })).toBeVisible();
    act(() => reportMaximized?.(false));
    expect(screen.getByRole("button", { name: "最大化" })).toBeVisible();

    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("opens the narrow-screen More menu and navigates with keyboard", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    renderApp();

    const more = screen.getByRole("button", { name: "更多" });
    more.focus();
    fireEvent.click(more);
    const menu = screen.getByRole("menu", { name: "更多导航" });
    expect(menu).toBeVisible();

    const automation = within(menu).getByRole("menuitem", { name: "自动化" });
    expect(within(menu).getByRole("menuitem", { name: "连接" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(automation).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    const system = within(menu).getByRole("menuitem", { name: "系统" });
    expect(system).toHaveFocus();
    fireEvent.click(system);
    expect(screen.getByRole("heading", { name: "系统" })).toBeVisible();
  });

  it("closes the narrow More menu with Escape and outside interaction", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    renderApp();

    const more = screen.getByRole("button", { name: "更多" });
    fireEvent.click(more);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(more).toHaveFocus();

    fireEvent.click(more);
    fireEvent.mouseDown(screen.getByRole("main"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("uses roving tab stops and closes More when focus leaves", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "更多" }));

    const connection = screen.getByRole("menuitem", { name: "连接" });
    const automation = screen.getByRole("menuitem", { name: "自动化" });
    expect(connection).toHaveAttribute("tabindex", "0");
    expect(automation).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(connection, { key: "ArrowDown" });
    expect(connection).toHaveAttribute("tabindex", "-1");
    expect(automation).toHaveAttribute("tabindex", "0");

    fireEvent.blur(automation, { relatedTarget: screen.getByRole("main") });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("updates primary navigation when the window becomes narrow", () => {
    renderApp();
    expect(screen.queryByRole("button", { name: "更多" })).not.toBeInTheDocument();

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    fireEvent(window, new Event("resize"));

    expect(screen.getByRole("button", { name: "更多" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "连接" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("会话栏")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("上下文舱")).not.toBeInTheDocument();
  });

  it("opens and closes global search with keyboard", () => {
    renderApp();
    const trigger = screen.getByRole("button", { name: "打开全局搜索" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "全局搜索" });
    expect(dialog).toBeInTheDocument();
    screen.getByRole("searchbox", { name: "全局搜索" }).focus();
    fireEvent.keyDown(dialog, { key: "Escape", keyCode: 27 });
    expect(screen.queryByRole("dialog", { name: "全局搜索" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("opens global search from Ctrl+K", () => {
    renderApp();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "全局搜索" })).toBeInTheDocument();
    screen.getByRole("searchbox", { name: "全局搜索" }).focus();
  });

  it("keeps the original focus target when Ctrl+K repeats inside search", () => {
    renderApp();
    const trigger = screen.getByRole("button", { name: "打开全局搜索" });
    trigger.focus();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const dialog = screen.getByRole("dialog", { name: "全局搜索" });
    screen.getByRole("searchbox", { name: "全局搜索" }).focus();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.keyDown(dialog, { key: "Escape", keyCode: 27 });

    expect(trigger).toHaveFocus();
  });

  it("reports unavailable and failed window controls accessibly", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "最小化" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("窗口控制不可用");

    cleanup();
    const invoke = vi.fn(async (request: WindowIpcRequest): Promise<IpcResponse> => ({
      method: request.method,
      requestId: request.requestId,
      ok: false as const,
      error: {
        code: "OPERATION_FAILED" as const,
        message: "窗口操作被拒绝",
        retryable: false,
        recoveryActions: [],
        causeDetails: {},
      },
    }));
    window.uclaw = { window: { invoke } };
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("窗口操作被拒绝");
  });

  it("keeps context tabs and panels hidden from the work surface", () => {
    renderApp();
    expect(screen.queryByRole("complementary", { name: "上下文舱" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
  });
});
