// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import type { IpcResponse, WindowIpcRequest } from "@uclaw/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/app/App";

const renderApp = () => render(<App />);
const getComputedStyle = window.getComputedStyle.bind(window);

describe("U-Claw application shell", () => {
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

  it("exposes six primary destinations and marks Work current", () => {
    renderApp();

    const navigation = screen.getByRole("navigation", { name: "主导航" });
    for (const label of ["工作", "文件", "记忆", "能力", "连接", "系统"]) {
      expect(within(navigation).getByRole("link", { name: label })).toBeVisible();
    }
    expect(within(navigation).getByRole("link", { name: "工作" })).toHaveAttribute("aria-current", "page");
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

  it("focuses main content from the skip link without changing hash routes", () => {
    renderApp();
    fireEvent.click(screen.getByRole("link", { name: "文件" }));
    expect(window.location.hash).toBe("#/files");

    fireEvent.click(screen.getByRole("link", { name: "跳到主要内容" }));

    expect(screen.getByRole("main")).toHaveFocus();
    expect(window.location.hash).toBe("#/files");
  });

  it("collapses and restores both side panels", () => {
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "收起会话栏" }));
    expect(screen.queryByLabelText("会话栏")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开会话栏" }));
    expect(screen.getByLabelText("会话栏")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "收起上下文舱" }));
    expect(screen.queryByLabelText("上下文舱")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开上下文舱" }));
    expect(screen.getByLabelText("上下文舱")).toBeVisible();
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

    const system = within(menu).getByRole("menuitem", { name: "系统" });
    expect(within(menu).getByRole("menuitem", { name: "连接" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
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
    const system = screen.getByRole("menuitem", { name: "系统" });
    expect(connection).toHaveAttribute("tabindex", "0");
    expect(system).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(connection, { key: "ArrowDown" });
    expect(connection).toHaveAttribute("tabindex", "-1");
    expect(system).toHaveAttribute("tabindex", "0");

    fireEvent.blur(system, { relatedTarget: screen.getByRole("main") });
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

  it("supports arrow-key context tabs with linked tabpanels", () => {
    renderApp();
    const files = screen.getByRole("tab", { name: "文件" });
    const memory = screen.getByRole("tab", { name: "记忆" });

    files.focus();
    fireEvent.keyDown(files, { key: "ArrowRight" });
    expect(memory).toHaveFocus();
    expect(memory).toHaveAttribute("aria-selected", "true");
    expect(memory).toHaveAttribute("aria-controls", "context-panel-memory");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "context-panel-memory");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "context-tab-memory");
  });
});
