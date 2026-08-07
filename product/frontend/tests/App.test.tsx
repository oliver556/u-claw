// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/app/App";

const renderApp = () => render(<App />);

describe("U-Claw application shell", () => {
  afterEach(cleanup);

  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
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
    const invoke = vi.fn().mockResolvedValue({ ok: true });
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
    const invoke = vi.fn().mockResolvedValue({ ok: true });
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
        invoke: vi.fn().mockResolvedValue({ ok: true }),
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
    fireEvent.keyDown(more, { key: "Enter" });
    const menu = screen.getByRole("menu", { name: "更多导航" });
    expect(menu).toBeVisible();

    const system = within(menu).getByRole("menuitem", { name: "系统" });
    system.focus();
    fireEvent.keyDown(system, { key: "Enter" });
    expect(screen.getByRole("heading", { name: "系统" })).toBeVisible();
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
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "全局搜索" })).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "全局搜索" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "全局搜索" })).not.toBeInTheDocument();
  });
});
