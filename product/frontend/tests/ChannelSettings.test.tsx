// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import type { ChannelIpcRequest, ChannelIpcResponse, ChannelSnapshot } from "@uclaw/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChannelSettings } from "../src/features/channels/ChannelSettings";

const snapshot: ChannelSnapshot = {
  schemaVersion: 1,
  channels: [
    {
      id: "telegram-main",
      kind: "telegram",
      name: "Telegram 主机器人",
      mode: "bot",
      configured: true,
      enabled: true,
      status: "connected",
      capability: "available",
      credentialHints: { botToken: "...7890" },
      lastCheckedAt: "2026-08-09T08:30:00.000Z",
    },
    {
      id: "feishu-ops",
      kind: "feishu",
      name: "飞书运维",
      mode: "webhook",
      configured: true,
      enabled: false,
      status: "needs-action",
      capability: "unavailable",
      capabilityReason: "当前便携运行时未打包该 OpenClaw 渠道插件。",
      credentialHints: { appId: "...1001", appSecret: "...5678" },
      error: { category: "capability", code: "CAPABILITY_UNAVAILABLE", message: "渠道插件不可用。", retryable: false },
    },
  ],
};

function success(request: ChannelIpcRequest, result: ChannelSnapshot = snapshot): ChannelIpcResponse {
  return { method: request.method, requestId: request.requestId, ok: true, result } as ChannelIpcResponse;
}

describe("ChannelSettings", () => {
  const getComputedStyle = window.getComputedStyle.bind(window);

  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => getComputedStyle(element));
    delete window.uclaw;
  });

  it("shows unified status, last check and only masked credential hints", async () => {
    window.uclaw = { channels: { invoke: vi.fn(async (request: ChannelIpcRequest) => success(request)) } } as never;
    render(<ChannelSettings />);

    expect(await screen.findByText("Telegram 主机器人")).toBeVisible();
    expect(screen.getByText("已连接")).toBeVisible();
    expect(screen.getByText(/2026\/08\/09 16:30/u)).toBeVisible();
    expect(screen.getByText("...7890")).toBeVisible();
    expect(document.body.textContent).not.toContain("123456:complete-secret");

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "渠道筛选" }));
    fireEvent.click(await screen.findByText("飞书", { selector: ".ant-select-item-option-content" }));
    expect(screen.queryByText("Telegram 主机器人")).not.toBeInTheDocument();
    expect(screen.getByText("飞书运维")).toBeVisible();
    expect(screen.getByText("需要操作")).toBeVisible();
  });

  it("runs Telegram test, stop and reconnect while disabling unavailable runtime actions", async () => {
    const invoke = vi.fn(async (request: ChannelIpcRequest) => request.method === "channels.test" || request.method === "channels.reconnect"
      ? { method: request.method, requestId: request.requestId, ok: true, result: { channelId: request.params.channelId, status: "connected", checkedAt: "2026-08-09T09:00:00.000Z" } } as ChannelIpcResponse
      : success(request));
    window.uclaw = { channels: { invoke } } as never;
    render(<ChannelSettings />);
    await screen.findByText("Telegram 主机器人");

    fireEvent.click(screen.getByRole("button", { name: "测试 Telegram 主机器人" }));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "重连 Telegram 主机器人" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "重连 Telegram 主机器人" }));
    await vi.waitFor(() => expect(screen.getByRole("switch", { name: "停用 Telegram 主机器人" })).toBeEnabled());
    fireEvent.click(screen.getByRole("switch", { name: "停用 Telegram 主机器人" }));

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "channels.test", params: { channelId: "telegram-main" } })));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "channels.reconnect", params: { channelId: "telegram-main" } })));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "channels.set-enabled", params: { channelId: "telegram-main", enabled: false } })));
    expect(screen.getByRole("button", { name: "测试 飞书运维" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重连 飞书运维" })).toBeDisabled();
    expect(screen.getByText("当前便携运行时未打包该 OpenClaw 渠道插件。")).toBeVisible();
  });

  it("cancels an in-flight connection test by operation request ID", async () => {
    let resolveTest!: (value: ChannelIpcResponse) => void;
    const pending = new Promise<ChannelIpcResponse>((resolve) => { resolveTest = resolve; });
    const invoke = vi.fn((request: ChannelIpcRequest) => request.method === "channels.test" ? pending : Promise.resolve(success(request)));
    window.uclaw = { channels: { invoke } } as never;
    render(<ChannelSettings />);
    await screen.findByText("Telegram 主机器人");

    fireEvent.click(screen.getByRole("button", { name: "测试 Telegram 主机器人" }));
    const testRequest = invoke.mock.calls.find(([request]) => request.method === "channels.test")?.[0];
    fireEvent.click(await screen.findByRole("button", { name: "取消 Telegram 主机器人" }));

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "channels.cancel", params: { operationRequestId: testRequest?.requestId } })));
    resolveTest({ method: "channels.test", requestId: testRequest!.requestId, ok: true, result: { channelId: "telegram-main", status: "disconnected", checkedAt: "2026-08-09T09:00:00.000Z" } });
  });

  it("creates Telegram credentials and never pre-fills stored secrets while editing", async () => {
    const invoke = vi.fn(async (request: ChannelIpcRequest) => success(request));
    window.uclaw = { channels: { invoke } } as never;
    render(<ChannelSettings />);
    await screen.findByText("Telegram 主机器人");

    fireEvent.click(screen.getByRole("button", { name: "新增连接" }));
    fireEvent.change(screen.getByLabelText("渠道"), { target: { value: "telegram" } });
    fireEvent.change(screen.getByLabelText("渠道 ID"), { target: { value: "telegram-alerts" } });
    fireEvent.change(screen.getByLabelText("连接名称"), { target: { value: "Telegram 告警" } });
    fireEvent.change(screen.getByLabelText("Bot Token"), { target: { value: "fixture-token-not-real" } });
    fireEvent.click(screen.getByRole("button", { name: "保存渠道" }));

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      method: "channels.create",
      params: { channel: { id: "telegram-alerts", kind: "telegram", name: "Telegram 告警", mode: "bot", enabled: true, credentials: { botToken: "fixture-token-not-real" } } },
    })));

    await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: "新增渠道连接" })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "编辑 Telegram 主机器人" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑渠道连接" });
    expect(within(dialog).getByLabelText("Bot Token")).toHaveValue("");
    expect(within(dialog).getByText("已保存：...7890")).toBeInTheDocument();
  });

  it("distinguishes Feishu and WeCom webhook credential contracts", async () => {
    window.uclaw = { channels: { invoke: vi.fn(async (request: ChannelIpcRequest) => success(request, { schemaVersion: 1, channels: [] })) } } as never;
    render(<ChannelSettings />);
    await screen.findByText("还没有渠道配置");
    fireEvent.click(screen.getByRole("button", { name: "新增连接" }));

    fireEvent.change(screen.getByLabelText("渠道"), { target: { value: "feishu" } });
    expect(screen.getByLabelText("App ID")).toBeInTheDocument();
    expect(screen.getByLabelText("App Secret")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("连接模式"), { target: { value: "webhook" } });
    expect(screen.getByLabelText("Verification Token")).toBeInTheDocument();
    expect(screen.getByLabelText("Encrypt Key")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("渠道"), { target: { value: "wecom" } });
    fireEvent.change(screen.getByLabelText("连接模式"), { target: { value: "webhook" } });
    expect(screen.getByLabelText("Token")).toBeInTheDocument();
    expect(screen.getByLabelText("Encoding AES Key")).toBeInTheDocument();
    expect(screen.getByLabelText("Receive ID")).toBeInTheDocument();
  });

  it("requires confirmation before deleting stored channel credentials", async () => {
    const invoke = vi.fn(async (request: ChannelIpcRequest) => success(request));
    window.uclaw = { channels: { invoke } } as never;
    render(<ChannelSettings />);
    await screen.findByText("Telegram 主机器人");

    fireEvent.click(screen.getByRole("button", { name: "删除 Telegram 主机器人" }));
    expect(invoke.mock.calls.some(([request]) => request.method === "channels.remove")).toBe(false);
    const confirmation = await screen.findByText("删除渠道连接？");
    const popup = confirmation.closest(".ant-popover-inner") as HTMLElement;
    fireEvent.click(within(popup).getByRole("button", { name: /删\s*除/u }));

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "channels.remove", params: { channelId: "telegram-main" } })));
  });

  it("supports retry and empty state without leaking bridge errors", async () => {
    let attempt = 0;
    const empty: ChannelSnapshot = { schemaVersion: 1, channels: [] };
    const invoke = vi.fn(async (request: ChannelIpcRequest) => {
      if (attempt++ === 0) throw new Error("network failed with token secret-token");
      return success(request, empty);
    });
    window.uclaw = { channels: { invoke } } as never;
    render(<ChannelSettings />);

    expect(await screen.findByText("渠道配置暂时不可用")).toBeVisible();
    expect(document.body.textContent).not.toContain("secret-token");
    fireEvent.click(screen.getByRole("button", { name: "重试加载渠道" }));
    expect(await screen.findByText("还没有渠道配置")).toBeVisible();
  });
});
