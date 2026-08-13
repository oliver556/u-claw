// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RootApp } from "../src/app/App";
import { ActivationFlow } from "../src/features/activation/ActivationFlow";
import type { ActivationApi, ActivationStatus } from "../src/features/activation/useActivation";

const code = "7K4P9Q2MX8RT6W3NA5KC4D7H2Q";

function bridge(preflight: ActivationApi["preflight"] = vi.fn(async (): Promise<ActivationStatus> => ({ state: "input" }))) {
  return {
    preflight,
    submit: vi.fn(async (): Promise<ActivationStatus> => ({ state: "complete" })),
    commit: vi.fn(async (): Promise<ActivationStatus> => ({ state: "error", code: "INVALID_STATE" })),
    cancel: vi.fn(async (): Promise<ActivationStatus> => ({ state: "input" })),
    close: vi.fn(async (): Promise<ActivationStatus> => ({ state: "input" })),
  };
}

afterEach(() => { cleanup(); vi.useRealTimers(); delete window.uclawActivation; delete window.uclaw; });

describe("ActivationFlow", () => {
  it("checks first, then focuses the activation code field", async () => {
    let finishCheck!: (status: ActivationStatus) => void;
    const api = bridge(vi.fn(() => new Promise<ActivationStatus>((resolve) => { finishCheck = resolve; })));
    render(<ActivationFlow api={api} />);
    expect(screen.getByText("正在确认产品盘")).toBeVisible();
    finishCheck({ state: "input" });
    expect(await screen.findByRole("heading", { name: "激活这套 U-Claw" })).toBeVisible();
    expect(api.preflight).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("用户名")).not.toBeInTheDocument();
    expect(screen.getByLabelText("激活码")).toHaveFocus();
  });

  it("formats a 26-character code, hides it, supports reveal and Enter submit", async () => {
    const api = bridge();
    render(<ActivationFlow api={api} />);
    const activationCode = await screen.findByLabelText("激活码");
    fireEvent.change(activationCode, { target: { value: code.toLowerCase() } });
    expect(activationCode).toHaveValue("7K4P9-Q2MX8-RT6W3-NA5KC-4D7H2Q");
    expect(activationCode).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "显示激活码" }));
    expect(activationCode).toHaveAttribute("type", "text");
    fireEvent.submit(screen.getByRole("button", { name: "激活当前 U 盘" }).closest("form")!);
    await waitFor(() => expect(api.submit).toHaveBeenCalledWith({ activationCode: code }));
    expect(screen.getByText("这套 U-Claw 已可使用")).toBeVisible();
  });

  it("polls redacted progress while submit is pending and stops after unmount", async () => {
    vi.useFakeTimers();
    let finishSubmit!: (status: ActivationStatus) => void;
    const api = bridge();
    api.submit.mockImplementation(() => new Promise<ActivationStatus>((resolve) => { finishSubmit = resolve; }));
    api.commit
      .mockResolvedValueOnce({ state: "server-bound" })
      .mockResolvedValueOnce({ state: "writing" })
      .mockResolvedValueOnce({ state: "verifying" })
      .mockResolvedValueOnce({ state: "committing" });
    const view = render(<ActivationFlow api={api} />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(screen.getByLabelText("激活码"), { target: { value: code } });
    fireEvent.submit(screen.getByRole("button", { name: "激活当前 U 盘" }).closest("form")!);

    for (const title of ["已绑定当前 U 盘", "正在安全写入产品盘", "正在完成本地验签", "正在确认激活结果"]) {
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(screen.getByText(title)).toBeVisible();
    }
    finishSubmit({ state: "complete" });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("这套 U-Claw 已可使用")).toBeVisible();
    const callsAtCompletion = api.commit.mock.calls.length;
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(api.commit).toHaveBeenCalledTimes(callsAtCompletion);
    vi.useRealTimers();
  });

  it("does not reschedule a late progress poll after submit completes", async () => {
    vi.useFakeTimers();
    let finishSubmit!: (status: ActivationStatus) => void;
    let finishPoll!: (status: ActivationStatus) => void;
    const api = bridge();
    api.submit.mockImplementation(() => new Promise<ActivationStatus>((resolve) => { finishSubmit = resolve; }));
    api.commit.mockImplementation(() => new Promise<ActivationStatus>((resolve) => { finishPoll = resolve; }));
    render(<ActivationFlow api={api} />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(screen.getByLabelText("激活码"), { target: { value: code } });
    fireEvent.submit(screen.getByRole("button", { name: "激活当前 U 盘" }).closest("form")!);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(api.commit).toHaveBeenCalledOnce();

    finishSubmit({ state: "complete" });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("这套 U-Claw 已可使用")).toBeVisible();
    finishPoll({ state: "writing" });
    await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByText("这套 U-Claw 已可使用")).toBeVisible();
    expect(api.commit).toHaveBeenCalledOnce();
  });

  it.each([
    ["submitting", "正在验证激活信息"], ["server-bound", "已绑定当前 U 盘"],
    ["writing", "正在安全写入产品盘"], ["verifying", "正在完成本地验签"],
    ["committing", "正在确认激活结果"], ["complete", "这套 U-Claw 已可使用"],
    ["recovery-required", "继续完成本次激活"],
  ] as const)("renders %s state", async (state, text) => {
    render(<ActivationFlow api={bridge(vi.fn(async () => ({ state })))} />);
    expect(await screen.findByText(text)).toBeVisible();
  });

  it("shows retryable and already-bound errors without overflowing actions", async () => {
    const retry = bridge(vi.fn(async () => ({ state: "error" as const, code: "ACTIVATION_SERVICE_UNAVAILABLE" })));
    const { rerender } = render(<ActivationFlow api={retry} />);
    expect(await screen.findByText("激活服务暂时不可用")).toBeVisible();
    expect(screen.getByRole("button", { name: "重试" })).toBeVisible();
    rerender(<ActivationFlow api={bridge(vi.fn(async () => ({ state: "error" as const, code: "ACTIVATION_CODE_ALREADY_BOUND" })))} />);
    expect(await screen.findByText("此激活码已绑定其他 U 盘")).toBeVisible();
    expect(within(screen.getByRole("alert")).getByRole("button", { name: "关闭" })).toBeVisible();
    expect(screen.getByTestId("activation-shell")).toHaveStyle({ maxWidth: "100%" });
  });

  it("keeps form controls in keyboard order", async () => {
    render(<ActivationFlow api={bridge()} />);
    const activationCode = await screen.findByLabelText("激活码");
    const reveal = screen.getByRole("button", { name: "显示激活码" });
    const submit = screen.getByRole("button", { name: "激活当前 U 盘" });
    expect([activationCode, reveal, submit].map((node) => node.tabIndex)).toEqual([0, 0, 0]);
  });

  it("ignores an older preflight result that resolves after a newer check", async () => {
    const resolves: Array<(status: ActivationStatus) => void> = [];
    const api = bridge(vi.fn(() => new Promise<ActivationStatus>((resolve) => resolves.push(resolve))));
    render(<StrictMode><ActivationFlow api={api} /></StrictMode>);
    await waitFor(() => expect(resolves).toHaveLength(2));
    resolves[1]({ state: "input" });
    expect(await screen.findByRole("heading", { name: "激活这套 U-Claw" })).toBeVisible();
    resolves[0]({ state: "error", code: "PREFLIGHT_FAILED" });
    await waitFor(() => expect(screen.getByRole("heading", { name: "激活这套 U-Claw" })).toBeVisible());
    expect(screen.queryByText("启动检查未通过")).not.toBeInTheDocument();
  });

  it("shows the four checks without claiming they have completed", () => {
    render(<ActivationFlow api={bridge(() => new Promise<ActivationStatus>(() => undefined))} />);
    const list = screen.getByRole("list", { name: "启动检查项" });
    for (const label of ["Windows 与处理器", "内存与可用空间", "U 盘设备身份", "激活服务连接"]) {
      expect(within(list).getByText(label)).toBeVisible();
    }
    expect(within(list).getAllByText("检查中")).toHaveLength(4);
  });

  it.each([
    ["submitting", 0, 1], ["server-bound", 3, 0], ["writing", 3, 1], ["verifying", 4, 1], ["committing", 5, 0],
  ] as const)("maps truthful processing tasks for %s", async (state, completedBefore, activeCount) => {
    render(<ActivationFlow api={bridge(vi.fn(async () => ({ state })))} />);
    const list = await screen.findByRole("list", { name: "激活任务" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    expect(list.querySelectorAll(".done")).toHaveLength(completedBefore);
    expect(list.querySelectorAll(".active")).toHaveLength(activeCount);
  });
});

describe("RootApp", () => {
  it("renders only activation UI when the restricted preload exists", async () => {
    window.uclawActivation = bridge();
    render(<RootApp />);
    expect(await screen.findByRole("heading", { name: "激活这套 U-Claw" })).toBeVisible();
    expect(document.querySelector(".workspace-shell")).not.toBeInTheDocument();
    expect(screen.queryByText("开发预览")).not.toBeInTheDocument();
    expect(document.documentElement.style.getPropertyValue("--uclaw-activation-bg")).not.toBe("");
  });

  it("keeps the normal application path when no activation bridge exists", () => {
    render(<RootApp />);
    expect(screen.getByText("开发预览")).toBeVisible();
    expect(screen.queryByText("激活这套 U-Claw")).not.toBeInTheDocument();
  });
});
