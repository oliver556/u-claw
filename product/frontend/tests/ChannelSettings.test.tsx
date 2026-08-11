// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import type { ChannelIpcRequest, ChannelIpcResponse, ChannelSnapshot, WechatConnectionSnapshot } from "@uclaw/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
    {
      id: "discord-main",
      kind: "discord",
      name: "Discord 主机器人",
      mode: "bot",
      configured: true,
      enabled: true,
      status: "connected",
      capability: "available",
      credentialHints: { botToken: "...dcba" },
      runtimeAuthoritative: true,
      pendingAction: "none",
      lastInboundAt: "2026-08-11T12:00:00.000Z",
      lastOutboundAt: "2026-08-11T12:01:00.000Z",
    },
  ],
};

const unavailableWechat: WechatConnectionSnapshot = {
  channelId: "wechat-personal",
  status: "needs-action",
  loginState: "error",
  capability: "unavailable",
  capabilityReason: "需要安装并启用个人微信插件。",
  plugin: { id: "openclaw-weixin", requiredVersion: "2.4.6", status: "missing" },
  error: { category: "capability", code: "WECHAT_PLUGIN_MISSING", message: "个人微信插件未安装。", retryable: false },
};

function success(request: ChannelIpcRequest, result: ChannelSnapshot = snapshot): ChannelIpcResponse {
  if (request.method.startsWith("channels.wechat-")) {
    return { method: request.method, requestId: request.requestId, ok: true, result: unavailableWechat } as ChannelIpcResponse;
  }
  return { method: request.method, requestId: request.requestId, ok: true, result } as ChannelIpcResponse;
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

  it("shows unified status, last check and only masked credential hints", async () => {
    window.uclaw = { channels: { invoke: vi.fn(async (request: ChannelIpcRequest) => success(request)) } } as never;
    render(<ChannelSettings />);

    expect(await screen.findByText("Telegram 主机器人")).toBeVisible();
    expect(screen.getAllByText("已连接").length).toBeGreaterThan(0);
    expect(screen.getByText(/2026\/08\/09 16:30/u)).toBeVisible();
    expect(screen.getByText("...7890")).toBeVisible();
    expect(document.body.textContent).not.toContain("123456:complete-secret");

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "渠道筛选" }));
    fireEvent.click(await screen.findByText("飞书", { selector: ".ant-select-item-option-content" }));
    expect(screen.queryByText("Telegram 主机器人")).not.toBeInTheDocument();
    expect(screen.getByText("飞书运维")).toBeVisible();
    expect(within(screen.getByText("飞书运维").closest("article") as HTMLElement).getByText("需要操作")).toBeVisible();
  });

  it("shows personal WeChat as a distinct connection and explains missing plugin", async () => {
    window.uclaw = { channels: { invoke: vi.fn(async (request: ChannelIpcRequest) => success(request)) } } as never;
    render(<ChannelSettings />);

    expect(await screen.findByText("个人微信")).toBeVisible();
    expect(screen.getByText("@tencent-weixin/openclaw-weixin@2.4.6")).toBeVisible();
    expect(screen.getByText("需要安装并启用个人微信插件。")).toBeVisible();
    expect(screen.getByRole("button", { name: "开始个人微信扫码登录" })).toBeDisabled();
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

  it("configures Discord and routes logout, send, reaction and poll commands", async () => {
    const invoke = vi.fn(async (request: ChannelIpcRequest) => {
      if (["channels.logout", "channels.send", "channels.action", "channels.poll"].includes(request.method)) {
        if (!("channelId" in request.params)) throw new Error("Expected channel command params");
        return { method: request.method, requestId: request.requestId, ok: true, result: {
          channelId: request.params.channelId,
          operation: request.method.slice("channels.".length),
          completedAt: "2026-08-11T12:02:00.000Z",
        } } as ChannelIpcResponse;
      }
      return success(request);
    });
    window.uclaw = { channels: { invoke } } as never;
    render(<ChannelSettings />);
    await screen.findByText("Discord 主机器人");

    expect(screen.getByText(/最近收取/u)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "发送 Discord 主机器人" }));
    fireEvent.change(screen.getByLabelText("目标"), { target: { value: "channel:123" } });
    fireEvent.change(screen.getByLabelText("消息"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "执行渠道操作" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "channels.send", params: { channelId: "discord-main", target: "channel:123", message: "hello" } })));

    fireEvent.click(screen.getByRole("button", { name: "发送 Discord 主机器人" }));
    fireEvent.click(screen.getByText("回应"));
    fireEvent.change(screen.getByLabelText("目标"), { target: { value: "channel:123" } });
    fireEvent.change(screen.getByLabelText("消息 ID"), { target: { value: "message-1" } });
    fireEvent.change(screen.getByLabelText("Emoji"), { target: { value: ":thumbsup:" } });
    fireEvent.click(screen.getByRole("button", { name: "执行渠道操作" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "channels.action" })));

    fireEvent.click(screen.getByRole("button", { name: "发送 Discord 主机器人" }));
    fireEvent.click(screen.getByText("投票"));
    fireEvent.change(screen.getByLabelText("目标"), { target: { value: "channel:123" } });
    fireEvent.change(screen.getByLabelText("问题"), { target: { value: "Ship?" } });
    fireEvent.change(screen.getByLabelText("选项"), { target: { value: "Yes\nNo" } });
    fireEvent.click(screen.getByRole("button", { name: "执行渠道操作" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "channels.poll", params: expect.objectContaining({ options: ["Yes", "No"] }) })));

    fireEvent.click(screen.getByRole("button", { name: "登出 Discord 主机器人" }));
    const confirmation = await screen.findByText("登出渠道账号？");
    fireEvent.click(within(confirmation.closest(".ant-popover-inner") as HTMLElement).getByRole("button", { name: /登\s*出/u }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "channels.logout", params: { channelId: "discord-main" } })));

    fireEvent.click(screen.getByRole("button", { name: "新增连接" }));
    fireEvent.change(screen.getByLabelText("渠道"), { target: { value: "discord" } });
    expect(screen.getByLabelText("Bot Token")).toBeInTheDocument();
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

  it("submits QQ Bot allowFrom as a bounded line list", async () => {
    const invoke = vi.fn(async (request: ChannelIpcRequest) => success(request));
    window.uclaw = { channels: { invoke } } as never;
    render(<ChannelSettings />);
    await screen.findByText("Telegram 主机器人");

    fireEvent.click(screen.getByRole("button", { name: "新增连接" }));
    fireEvent.change(screen.getByLabelText("渠道"), { target: { value: "qq-bot" } });
    fireEvent.change(screen.getByLabelText("渠道 ID"), { target: { value: "qq-alerts" } });
    fireEvent.change(screen.getByLabelText("连接名称"), { target: { value: "QQ 告警" } });
    fireEvent.change(screen.getByLabelText("允许来源"), { target: { value: "user:1\ngroup:2" } });
    fireEvent.change(screen.getByLabelText("App ID"), { target: { value: "1024" } });
    fireEvent.change(screen.getByLabelText("Client Secret"), { target: { value: "qq-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "保存渠道" }));

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      method: "channels.create",
      params: { channel: { id: "qq-alerts", kind: "qq-bot", name: "QQ 告警", mode: "app", enabled: true, allowFrom: ["user:1", "group:2"], credentials: { appId: "1024", clientSecret: "qq-secret" } } },
    })));
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
      if (request.method === "channels.list-managed" && attempt++ === 0) throw new Error("network failed with token secret-token");
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
