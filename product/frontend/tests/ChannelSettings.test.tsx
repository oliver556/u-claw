// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import type { ChannelIpcRequest, ChannelIpcResponse, WechatConnectionSnapshot } from "@uclaw/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChannelSettings } from "../src/features/channels/ChannelSettings";

const unavailableWechat: WechatConnectionSnapshot = {
  channelId: "wechat-personal",
  status: "needs-action",
  loginState: "error",
  capability: "unavailable",
  capabilityReason: "需要安装并启用个人微信插件。",
  plugin: { id: "openclaw-weixin", requiredVersion: "2.4.6", status: "missing" },
  error: { category: "capability", code: "WECHAT_PLUGIN_MISSING", message: "个人微信插件未安装。", retryable: false },
};

function success(request: ChannelIpcRequest): ChannelIpcResponse {
  if (request.method.startsWith("channels.wechat-")) {
    return { method: request.method, requestId: request.requestId, ok: true, result: unavailableWechat } as ChannelIpcResponse;
  }
  throw new Error(`Unexpected managed-channel request: ${request.method}`);
}

describe("ChannelSettings", () => {
  const getComputedStyle = window.getComputedStyle.bind(window);

  afterEach(() => { vi.useRealTimers(); cleanup(); vi.restoreAllMocks(); });

  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => getComputedStyle(element));
    delete window.uclaw;
  });

  it("shows only personal WeChat and does not load managed channels", async () => {
    const invoke = vi.fn(async (request: ChannelIpcRequest) => success(request));
    window.uclaw = { channels: { invoke } } as never;
    render(<ChannelSettings />);

    expect(await screen.findByText("个人微信")).toBeVisible();
    expect(screen.queryByRole("button", { name: "新增连接" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("渠道筛选器")).not.toBeInTheDocument();
    for (const label of ["Telegram", "QQ Bot", "飞书", "企业微信", "Discord"]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    expect(invoke).not.toHaveBeenCalledWith(expect.objectContaining({ method: "channels.list-managed" }));
  });

  it("shows personal WeChat as a distinct connection and explains missing plugin", async () => {
    window.uclaw = { channels: { invoke: vi.fn(async (request: ChannelIpcRequest) => success(request)) } } as never;
    render(<ChannelSettings />);

    expect(await screen.findByText("个人微信")).toBeVisible();
    expect(screen.getByText("@tencent-weixin/openclaw-weixin@2.4.6")).toBeVisible();
    expect(screen.getByText("需要安装并启用个人微信插件。")).toBeVisible();
    expect(screen.getByRole("button", { name: "开始个人微信扫码登录" })).toBeDisabled();
  });

  it("retries loading personal WeChat after a bridge error", async () => {
    let attempts = 0;
    const invoke = vi.fn(async (request: ChannelIpcRequest) => {
      if (request.method === "channels.wechat-status" && attempts++ === 0) {
        throw new Error("runtime unavailable");
      }
      return success(request);
    });
    window.uclaw = { channels: { invoke } } as never;
    render(<ChannelSettings />);

    expect(await screen.findByText("个人微信状态暂不可用")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /重\s*试/u }));

    expect(await screen.findByText("个人微信插件未安装")).toBeVisible();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).not.toHaveBeenCalledWith(expect.objectContaining({ method: "channels.list-managed" }));
  });

  it("renders safe QR, polls confirmation, then shows masked connected account", async () => {
    vi.useFakeTimers();
    const qrImage = { kind: "data-url" as const, value: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==" };
    const available = { ...unavailableWechat, capability: "available" as const, capabilityReason: undefined, plugin: { ...unavailableWechat.plugin, status: "installed" as const }, error: undefined, status: "not-configured" as const, loginState: "idle" as const };
    let poll = 0;
    const invoke = vi.fn(async (request: ChannelIpcRequest) => {
      if (request.method === "channels.wechat-status") return { method: request.method, requestId: request.requestId, ok: true, result: available } as ChannelIpcResponse;
      if (request.method === "channels.wechat-login-start") return { method: request.method, requestId: request.requestId, ok: true, result: { ...available, status: "pending-verification", loginState: "awaiting-scan", flowId: "flow-1", qrGeneration: 1, qrImage, qrExpiresAt: "2026-08-09T09:05:00.000Z" } } as ChannelIpcResponse;
      if (request.method === "channels.wechat-login-poll") {
        poll += 1;
        return { method: request.method, requestId: request.requestId, ok: true, result: poll === 1
          ? { ...available, status: "pending-verification", loginState: "awaiting-confirmation", flowId: "flow-1", qrGeneration: 1, qrImage, qrExpiresAt: "2026-08-09T09:05:00.000Z" }
          : { ...available, status: "connected", loginState: "connected", account: { displayName: "微信账号", accountIdHint: "...7a2f" } } } as ChannelIpcResponse;
      }
      return success(request);
    });
    window.uclaw = { channels: { invoke } } as never;
    render(<ChannelSettings />);
    await act(async () => { await Promise.resolve(); });

    fireEvent.click(screen.getByRole("button", { name: "开始个人微信扫码登录" }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("img", { name: "个人微信登录二维码" })).toHaveAttribute("src", qrImage.value);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });

    expect(screen.getAllByText("扫码后请在手机微信确认").length).toBeGreaterThan(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(screen.getByText("...7a2f")).toBeVisible();
    expect(screen.queryByRole("img", { name: "个人微信登录二维码" })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("bot_token");
  });

  it("offers authoritative reconnect and logout after personal WeChat login becomes invalid", async () => {
    const invalid: WechatConnectionSnapshot = {
      ...unavailableWechat,
      capability: "available",
      capabilityReason: undefined,
      plugin: { ...unavailableWechat.plugin, status: "installed" },
      status: "auth-failed",
      loginState: "error",
      account: { accountIdHint: "...7a2f" },
      error: { category: "authentication", code: "WECHAT_LOGGED_OUT", message: "个人微信登录已失效。", retryable: true },
    };
    const invoke = vi.fn(async (request: ChannelIpcRequest) => request.method.startsWith("channels.wechat-") ? ({
      method: request.method,
      requestId: request.requestId,
      ok: true,
      result: invalid,
    }) as ChannelIpcResponse : success(request));
    window.uclaw = { channels: { invoke } } as never;
    render(<ChannelSettings />);

    expect(await screen.findByText("...7a2f")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "channels.wechat-reconnect" })));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "退出登录" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    const confirmation = await screen.findByText("退出个人微信？");
    fireEvent.click(within(confirmation.closest(".ant-popover-inner") as HTMLElement).getByRole("button", { name: /退\s*出/u }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "channels.wechat-logout" })));
  });

});
