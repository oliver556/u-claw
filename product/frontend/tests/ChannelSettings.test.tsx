// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import type { ChannelIpcRequest, ChannelIpcResponse, ChannelSnapshot, WechatConnectionSnapshot } from "@uclaw/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChannelSettings } from "../src/features/channels/ChannelSettings";
import { ManagedChannelSettings } from "../src/features/channels/ManagedChannelSettings";

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

  it("shows only personal WeChat on the first-release surface", async () => {
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

  it("shows unified status, last check and only masked credential hints", async () => {
    window.uclaw = { channels: { invoke: vi.fn(async (request: ChannelIpcRequest) => success(request)) } } as never;
    render(<ManagedChannelSettings />);

    expect(await screen.findByText("Telegram 主机器人")).toBeVisible();
    expect(screen.getAllByText("已连接").length).toBeGreaterThan(0);
    const checkedAt = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      .format(new Date(snapshot.channels[0].lastCheckedAt as string));
    expect(screen.getByText(`最后检查：${checkedAt}`)).toBeVisible();
    expect(screen.getByText("...7890")).toBeVisible();
    expect(document.body.textContent).not.toContain("123456:complete-secret");

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "渠道筛选" }));
    fireEvent.click(await screen.findByText("飞书", { selector: ".ant-select-item-option-content" }));
    expect(screen.queryByText("Telegram 主机器人")).not.toBeInTheDocument();
    expect(screen.getByText("飞书运维")).toBeVisible();
    expect(within(screen.getByText("飞书运维").closest("article") as HTMLElement).getByText("需要操作")).toBeVisible();
  });

  it("turns unavailable personal WeChat internals into a disabled business recovery state", async () => {
    const technicalUnavailable: WechatConnectionSnapshot = {
      ...unavailableWechat,
      capabilityReason: "Gateway RPC channels.wechat-login-start failed at C:\\uclaw\\runtime\\node_modules\\@tencent-weixin\\openclaw-weixin.",
      error: {
        category: "capability",
        code: "WECHAT_PLUGIN_MISSING",
        message: "Plugin ID openclaw-weixin missing; run npm install with token=secret-token.",
        retryable: false,
      },
    };
    const invoke = vi.fn(async (request: ChannelIpcRequest) => request.method.startsWith("channels.wechat-")
      ? { method: request.method, requestId: request.requestId, ok: true, result: technicalUnavailable } as ChannelIpcResponse
      : success(request));
    window.uclaw = { channels: { invoke } } as never;
    render(<ChannelSettings />);

    expect(await screen.findByText("个人微信")).toBeVisible();
    expect(screen.getAllByText("组件缺失，需修复 U-Claw").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "开始个人微信扫码登录" })).toBeDisabled();
    for (const internal of ["@tencent-weixin", "openclaw-weixin", "Plugin ID", "npm install", "Gateway RPC", "channels.wechat-login-start", "C:\\uclaw", "secret-token"]) {
      expect(document.body.textContent).not.toContain(internal);
    }
  });

  it("maps damaged, updating and repairing components to business states", async () => {
    const cases = [
      ["WECHAT_PLUGIN_DAMAGED", "组件损坏，需修复或更新 U-Claw"],
      ["WECHAT_PLUGIN_UPDATING", "组件更新中"],
      ["WECHAT_PLUGIN_REPAIRING", "组件修复中"],
    ] as const;

    for (const [code, expected] of cases) {
      const state: WechatConnectionSnapshot = {
        ...unavailableWechat,
        plugin: { ...unavailableWechat.plugin, status: "installed" },
        error: { category: "capability", code, message: `technical ${code}`, retryable: false },
      };
      const invoke = vi.fn(async (request: ChannelIpcRequest) => ({
        method: request.method,
        requestId: request.requestId,
        ok: true,
        result: state,
      }) as ChannelIpcResponse);
      window.uclaw = { channels: { invoke } } as never;
      render(<ChannelSettings />);
      expect((await screen.findAllByText(expected)).length).toBeGreaterThan(0);
      expect(document.body.textContent).not.toContain(`technical ${code}`);
      cleanup();
    }
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
          : { ...available, status: "connected", loginState: "connected", account: { displayName: "完整账号 wxid_private_account", accountIdHint: "...7a2f" } } } as ChannelIpcResponse;
      }
      return success(request);
    });
    window.uclaw = { channels: { invoke } } as never;
    render(<ChannelSettings />);
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText("可扫码连接")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "开始个人微信扫码登录" }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("img", { name: "个人微信登录二维码" })).toHaveAttribute("src", qrImage.value);
    expect(screen.getByText(/^有效期至 /u)).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });

    expect(screen.getAllByText("已扫码，等待手机确认").length).toBeGreaterThan(0);
    expect(screen.getByText("扫码后请在手机微信确认")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(screen.getByText("...7a2f")).toBeVisible();
    expect(screen.getAllByText("已连接").length).toBeGreaterThan(0);
    expect(screen.queryByRole("img", { name: "个人微信登录二维码" })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("wxid_private_account");
    expect(document.body.textContent).not.toContain("bot_token");
  });

  it("turns preparing into a business loading state", async () => {
    const preparingWechat: WechatConnectionSnapshot = {
      ...unavailableWechat,
      capability: "available",
      capabilityReason: undefined,
      plugin: { ...unavailableWechat.plugin, status: "installed" },
      status: "not-configured",
      loginState: "preparing",
      error: undefined,
    };
    const invoke = vi.fn(async (request: ChannelIpcRequest) => request.method.startsWith("channels.wechat-")
      ? { method: request.method, requestId: request.requestId, ok: true, result: preparingWechat } as ChannelIpcResponse
      : success(request));
    window.uclaw = { channels: { invoke } } as never;
    render(<ChannelSettings />);

    expect(await screen.findByText("检查中")).toBeVisible();
    expect(document.body.textContent).not.toContain("正在准备二维码");
  });

  it("requires a fresh scan and keeps logout available after personal WeChat authorization expires", async () => {
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
    expect(screen.getAllByText("授权失效，需重新扫码").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("个人微信登录已失效。");
    fireEvent.click(screen.getByRole("button", { name: "重新扫码" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "channels.wechat-login-start", params: { force: true } })));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "退出登录" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    const confirmation = await screen.findByText("退出个人微信？");
    fireEvent.click(within(confirmation.closest(".ant-popover-inner") as HTMLElement).getByRole("button", { name: /退\s*出/u }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "channels.wechat-logout" })));
  });

  it("runs Telegram test, stop and reconnect while disabling unavailable runtime actions", async () => {
    const invoke = vi.fn(async (request: ChannelIpcRequest) => request.method === "channels.test" || request.method === "channels.reconnect"
      ? { method: request.method, requestId: request.requestId, ok: true, result: { channelId: request.params.channelId, status: "connected", checkedAt: "2026-08-09T09:00:00.000Z" } } as ChannelIpcResponse
      : success(request));
    window.uclaw = { channels: { invoke } } as never;
    render(<ManagedChannelSettings />);
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
    render(<ManagedChannelSettings />);
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
    render(<ManagedChannelSettings />);
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
    render(<ManagedChannelSettings />);
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
    render(<ManagedChannelSettings />);
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
    render(<ManagedChannelSettings />);
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
    render(<ManagedChannelSettings />);
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
    render(<ManagedChannelSettings />);

    expect(await screen.findByText("渠道配置暂时不可用")).toBeVisible();
    expect(document.body.textContent).not.toContain("secret-token");
    fireEvent.click(screen.getByRole("button", { name: "重试加载渠道" }));
    expect(await screen.findByText("还没有渠道配置")).toBeVisible();
  });
});
