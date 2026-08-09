// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { ManualClock, MockUClawClient } from "@uclaw/adapter";
import type { ClientIpcEvent, ClientIpcRequest, GatewayStatus, IpcResponse, UClawClient, WindowIpcRequest } from "@uclaw/shared";
import { transferableAbortController } from "node:util";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/app/App";

const renderApp = () => render(<App />);
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

  it("manages provider selection, order, status and API keys through the dedicated bridge", async () => {
    const providerSnapshot = {
      schemaVersion: 1 as const,
      selectedProviderId: "openai",
      providers: [
        { id: "openai", templateId: "openai" as const, name: "OpenAI", enabled: true, baseUrl: "https://api.openai.com/v1", model: "gpt-5.4", apiKeyConfigured: false, verification: { state: "unverified" as const } },
        { id: "deepseek", templateId: "deepseek" as const, name: "DeepSeek", enabled: true, baseUrl: "https://api.deepseek.com/v1", model: "deepseek-v4-flash", apiKeyConfigured: true, apiKeyHint: "...5678", verification: { state: "unverified" as const } },
      ],
    };
    const invoke = vi.fn(async (request: any) => ({ method: request.method, requestId: request.requestId, ok: true, result: providerSnapshot }));
    window.uclaw = { providers: { invoke } } as any;
    renderApp();
    fireEvent.click(screen.getByRole("link", { name: "能力" }));

    expect(await screen.findByRole("heading", { name: "模型 Provider" })).toBeVisible();
    expect(screen.getByText("...5678")).toBeVisible();
    expect(document.body.textContent).not.toContain("sk-request-only");
    fireEvent.click(screen.getByRole("button", { name: "选择 DeepSeek" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "providers.select" })));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "上移 DeepSeek" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "上移 DeepSeek" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "providers.move" })));
    await vi.waitFor(() => expect(screen.getByRole("switch", { name: "启用 DeepSeek" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("switch", { name: "启用 DeepSeek" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "providers.set-enabled" })));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "管理 DeepSeek API Key" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "管理 DeepSeek API Key" }));
    fireEvent.change(screen.getByLabelText("新 API Key"), { target: { value: "sk-request-only" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 Key" }));

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "providers.select", params: { providerId: "deepseek" } })));
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "providers.move", params: { providerId: "deepseek", direction: "up" } }));
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "providers.set-enabled", params: { providerId: "deepseek", enabled: false } }));
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "providers.set-api-key", params: { providerId: "deepseek", apiKey: "sk-request-only" } }));
    expect(document.body.textContent).not.toContain("sk-request-only");
  });

  it("validates a custom OpenAI-compatible service before creating it", async () => {
    const providerSnapshot = { schemaVersion: 1 as const, selectedProviderId: null, providers: [] };
    const invoke = vi.fn(async (request: any) => ({ method: request.method, requestId: request.requestId, ok: true, result: providerSnapshot }));
    window.uclaw = { providers: { invoke } } as any;
    renderApp();
    fireEvent.click(screen.getByRole("link", { name: "能力" }));
    await screen.findByRole("heading", { name: "模型 Provider" });
    fireEvent.click(screen.getByRole("button", { name: "新增 Provider" }));
    fireEvent.change(screen.getByLabelText("Provider ID"), { target: { value: "custom-one" } });
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "自定义服务" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "file:///C:/secret" } });
    fireEvent.change(screen.getByLabelText("模型名"), { target: { value: "model-1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 Provider" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Base URL");
    expect(invoke.mock.calls.some(([request]) => request.method === "providers.create")).toBe(false);

    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://models.example.com/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 Provider" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      method: "providers.create",
      params: { provider: expect.objectContaining({ id: "custom-one", baseUrl: "https://models.example.com/v1", model: "model-1" }) },
    })));
  });

  it("recovers from provider loading errors and exposes real redacted verification", async () => {
    const snapshot = { schemaVersion: 1 as const, selectedProviderId: "openai", providers: [{ id: "openai", templateId: "openai" as const, name: "OpenAI", enabled: true, baseUrl: "https://api.openai.com/v1", model: "gpt-5.4", apiKeyConfigured: false, verification: { state: "unverified" as const } }], network: { httpProxy: null, httpsProxy: null, noProxy: ["localhost", "127.0.0.1", "::1"] } };
    let attempts = 0;
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "providers.list" && attempts++ === 0) throw new Error("provider disk failure with sk-secret");
      if (request.method === "providers.verify") return { method: request.method, requestId: request.requestId, ok: true, result: { state: "failed", category: "authentication", code: "PROVIDER_AUTH_FAILED", message: "认证失败，请检查 API Key。", retryable: false } };
      return { method: request.method, requestId: request.requestId, ok: true, result: snapshot };
    });
    window.uclaw = { providers: { invoke } } as any;
    renderApp();
    fireEvent.click(screen.getByRole("link", { name: "能力" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Provider 配置加载失败");
    expect(document.body.textContent).not.toContain("sk-secret");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    fireEvent.click(await screen.findByRole("button", { name: "验证 OpenAI" }));
    expect(await screen.findByText("认证失败，请检查 API Key。")).toBeVisible();
    expect(document.body.textContent).not.toContain("sk-secret");
  });

  it("discovers and selects local models and saves strict proxy settings", async () => {
    let snapshot: any = {
      schemaVersion: 1, selectedProviderId: "openai",
      providers: [{ id: "openai", templateId: "openai", name: "OpenAI", enabled: true, baseUrl: "https://api.openai.com/v1", model: "gpt-5.4", apiKeyConfigured: false, verification: { state: "unverified" } }],
      network: { httpProxy: null, httpsProxy: null, noProxy: ["localhost", "127.0.0.1", "::1"] },
    };
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "providers.discover-local") return { method: request.method, requestId: request.requestId, ok: true, result: { state: "ready", models: [{ id: "llama3.2:latest", label: "llama3.2:latest", source: "ollama", baseUrl: "http://127.0.0.1:11434/v1" }] } };
      if (request.method === "providers.create") snapshot = { ...snapshot, providers: [...snapshot.providers, { ...request.params.provider, apiKeyConfigured: false, verification: { state: "unverified" } }] };
      if (request.method === "providers.select") snapshot = { ...snapshot, selectedProviderId: request.params.providerId };
      if (request.method === "providers.set-network") snapshot = { ...snapshot, network: request.params.network };
      return { method: request.method, requestId: request.requestId, ok: true, result: snapshot };
    });
    window.uclaw = { providers: { invoke } } as any;
    renderApp();
    fireEvent.click(screen.getByRole("link", { name: "能力" }));
    await screen.findByRole("heading", { name: "模型 Provider" });

    fireEvent.click(screen.getByRole("button", { name: "刷新本地模型" }));
    fireEvent.click(await screen.findByRole("button", { name: "使用 llama3.2:latest" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "providers.create", params: { provider: expect.objectContaining({ baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.2:latest" }) } })));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "providers.select" })));

    fireEvent.change(screen.getByLabelText("HTTP 代理"), { target: { value: "http://proxy.example.com:8080" } });
    fireEvent.change(screen.getByLabelText("NO_PROXY"), { target: { value: "localhost, 127.0.0.1, ::1, .example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "保存代理设置" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      method: "providers.set-network",
      params: { network: { httpProxy: "http://proxy.example.com:8080", httpsProxy: null, noProxy: ["localhost", "127.0.0.1", "::1", ".example.com"] } },
    })));
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
    const [firstTab] = screen.getAllByRole("tab");
    const memory = screen.getByRole("tab", { name: "记忆" });

    firstTab!.focus();
    fireEvent.keyDown(firstTab!, { key: "ArrowRight" });
    expect(memory).toHaveFocus();
    expect(memory).toHaveAttribute("aria-selected", "true");
    expect(memory).toHaveAttribute("aria-controls", "context-panel-memory");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "context-panel-memory");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "context-tab-memory");
  });
});
