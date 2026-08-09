// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { McpIpcRequest, McpIpcResponse, McpSnapshot } from "@uclaw/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { McpManager } from "../src/features/mcp/McpManager";

const snapshot: McpSnapshot = {
  schemaVersion: 1,
  storage: { state: "healthy" },
  runtime: { state: "unavailable", reason: "locked-runtime-no-mcp-rpc" },
  servers: [{
    id: "docs", name: "Docs MCP", enabled: true, transport: "streamable-http",
    endpointHint: "mcp.example.com", authentication: { type: "bearer", configured: true, hint: "...cret" },
    status: "unavailable", capabilitySummary: { tools: 2, resources: 1, prompts: 0 },
    toolNames: ["search", "read"], resourceSchemes: ["docs"],
    lastError: { code: "UNAVAILABLE", message: "Runtime MCP RPC unavailable.", retryable: false, recoveryActions: [], causeDetails: {} },
  }],
};

const success = (request: McpIpcRequest, result: unknown = snapshot): McpIpcResponse => ({
  method: request.method, requestId: request.requestId, ok: true, result,
} as McpIpcResponse);

describe("McpManager", () => {
  afterEach(() => { cleanup(); delete window.uclaw; vi.restoreAllMocks(); });
  beforeEach(() => {
    const getComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => getComputedStyle(element));
    Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
  });

  it("shows runtime unavailability, status, capabilities, and masked authentication", async () => {
    window.uclaw = { mcp: { invoke: vi.fn(async (request: McpIpcRequest) => success(request)) } } as never;
    render(<McpManager />);
    expect(await screen.findByText("Docs MCP")).toBeVisible();
    expect(screen.getByText("OpenClaw runtime 未提供 MCP RPC")).toBeVisible();
    expect(screen.getByText("2 工具")).toBeVisible();
    expect(screen.getByText("1 资源")).toBeVisible();
    expect(screen.getByText("...cret")).toBeVisible();
    expect(screen.getByRole("button", { name: "测试 Docs MCP" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重连 Docs MCP" })).toBeDisabled();
    expect(document.body.textContent).not.toContain("top-secret");
  });

  it("creates HTTP and stdio servers through transport-specific forms", async () => {
    const empty = { ...snapshot, servers: [] };
    const invoke = vi.fn(async (request: McpIpcRequest) => success(request, empty));
    window.uclaw = { mcp: { invoke } } as never;
    render(<McpManager />);
    await screen.findByText("还没有 MCP server");
    fireEvent.click(screen.getByRole("button", { name: "新增 MCP server" }));
    fireEvent.change(screen.getByLabelText("Server ID"), { target: { value: "remote" } });
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "Remote MCP" } });
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://mcp.example.com/rpc" } });
    fireEvent.change(screen.getByLabelText("认证方式"), { target: { value: "bearer" } });
    fireEvent.change(screen.getByLabelText("认证 secret"), { target: { value: "one-use-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 MCP server" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      method: "mcp.create", params: { server: expect.objectContaining({ id: "remote", transport: "streamable-http", authentication: { type: "bearer", secret: "one-use-secret" } }) },
    })));

    fireEvent.click(screen.getByRole("button", { name: "新增 MCP server" }));
    fireEvent.change(screen.getByLabelText("Transport"), { target: { value: "stdio" } });
    fireEvent.change(screen.getByLabelText("Server ID"), { target: { value: "local" } });
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "Local MCP" } });
    fireEvent.change(screen.getByLabelText("Executable"), { target: { value: "node" } });
    fireEvent.change(screen.getByLabelText("参数"), { target: { value: "server.js" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 MCP server" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      method: "mcp.create", params: { server: expect.objectContaining({ id: "local", transport: "stdio", executableId: "node", args: ["server.js"] }) },
    })));
  });

  it("updates metadata without requesting or clearing main-process-only fields", async () => {
    const localSnapshot: McpSnapshot = { ...snapshot, servers: [snapshot.servers[0], {
      id: "local", name: "Local MCP", enabled: true, transport: "stdio", executableId: "node",
      risk: "none", status: "unavailable", capabilitySummary: { tools: 0, resources: 0, prompts: 0 },
      toolNames: [], resourceSchemes: [],
    }] };
    const invoke = vi.fn(async (request: McpIpcRequest) => success(request, localSnapshot));
    window.uclaw = { mcp: { invoke } } as never;
    render(<McpManager />);
    await screen.findByText("Docs MCP");

    fireEvent.click(screen.getByRole("button", { name: "编辑 Docs MCP" }));
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "Docs renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 MCP server" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      method: "mcp.update",
      params: { serverId: "docs", server: {
        id: "docs", name: "Docs renamed", enabled: true, transport: "streamable-http",
        authentication: { type: "bearer" },
      } },
    })));

    fireEvent.click(screen.getByRole("button", { name: "编辑 Local MCP" }));
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "Local renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 MCP server" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      method: "mcp.update",
      params: { serverId: "local", server: {
        id: "local", name: "Local renamed", enabled: true, transport: "stdio", executableId: "node",
      } },
    })));
  });

  it("confirms stdio risk fingerprint and deletion explicitly", async () => {
    const risky: McpSnapshot = { ...snapshot, runtime: { state: "available" }, servers: [{
      id: "package", name: "Package MCP", enabled: false, transport: "stdio", executableId: "npx",
      risk: "confirmation-required", riskFingerprint: "sha256:fixture", status: "disabled",
      capabilitySummary: { tools: 0, resources: 0, prompts: 0 }, toolNames: [], resourceSchemes: [],
    }] };
    const invoke = vi.fn(async (request: McpIpcRequest) => success(request, risky));
    window.uclaw = { mcp: { invoke } } as never;
    render(<McpManager />);
    await screen.findByText("Package MCP");
    expect(screen.getByRole("switch", { name: "启用 Package MCP" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "确认 Package MCP 风险" }));
    const dialog = await screen.findByRole("dialog", { name: "确认 stdio 风险" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "我确认执行该受控 stdio 配置" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "确认风险" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "mcp.confirm-risk", params: { serverId: "package", fingerprint: "sha256:fixture", confirmed: true } })));
    await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: "确认 stdio 风险" })).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "删除 Package MCP" }));
    const confirmation = await screen.findByText("删除 MCP server？");
    fireEvent.click(within(confirmation.closest(".ant-popover-inner") as HTMLElement).getByRole("button", { name: /删\s*除/u }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "mcp.remove", params: { serverId: "package", confirmed: true } })));
  });

  it("recovers loading failures without exposing bridge errors", async () => {
    let attempt = 0;
    const invoke = vi.fn(async (request: McpIpcRequest) => {
      if (attempt++ === 0) throw new Error("Bearer top-secret /Users/name/private");
      return success(request, { ...snapshot, servers: [] });
    });
    window.uclaw = { mcp: { invoke } } as never;
    render(<McpManager />);
    expect(await screen.findByText("MCP 配置暂时不可用")).toBeVisible();
    expect(document.body.textContent).not.toMatch(/top-secret|Users\/name/u);
    fireEvent.click(screen.getByRole("button", { name: "重试加载 MCP" }));
    expect(await screen.findByText("还没有 MCP server")).toBeVisible();
  });
});
