// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PluginManager } from "../src/features/plugins/PluginManager";

afterEach(() => { cleanup(); delete window.uclaw; });

const plugin = {
  packageKind: "plugin", slug: "openclaw-shell-tools", name: "命令工具包", description: "提供原生命令扩展", version: "2.0.0",
  installedVersion: null, enabled: false, updateAvailable: false,
  source: { provider: "fixture", url: "https://plugins.openclaw.ai/openclaw-shell-tools", packaged: true },
  integritySha256: "0".repeat(64),
  integrityVerified: true, managedByUClaw: false,
  availability: "installable", compatibility: { state: "compatible", openClawVersion: "2026.7.1-2" },
  permissions: [{ kind: "command", access: "execute", target: "approved commands", risk: "high", reason: "执行用户批准的本地命令" }],
  permissionFingerprint: "permission-hash", risk: "high", nativeCode: true, commandExecution: true, mode: "fixture",
};

describe("PluginManager", () => {
  it("renders offline retry, search pagination, and unverified repository boundary", async () => {
    let attempts = 0;
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "plugins.search" && attempts++ === 0) throw new Error("offline");
      return { method: request.method, requestId: request.requestId, ok: true, result: { items: [plugin], nextCursor: "1", hasMore: true, mode: "fixture", repositoryVerified: false } };
    });
    window.uclaw = { plugins: { invoke } } as any;
    render(<PluginManager />);
    expect(screen.getByText("正在加载插件目录")).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent("插件目录离线");
    fireEvent.click(screen.getByRole("button", { name: "重试插件目录" }));
    expect(await screen.findByText("命令工具包")).toBeVisible();
    expect(screen.getByText("Fixture 数据，真实插件仓库未验收")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "加载更多插件" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "plugins.search", params: expect.objectContaining({ cursor: "1" }) })));
  });

  it("shows unpackaged and incompatible external plugins without pretending availability", async () => {
    const items = [
      { ...plugin, slug: "community-wechat-preview", name: "微信社区预览", source: { provider: "external", url: "https://plugins.openclaw.ai/community-wechat-preview", packaged: false }, availability: "unpackaged" },
      { ...plugin, slug: "legacy-openclaw-plugin", name: "旧版插件", availability: "incompatible", compatibility: { state: "incompatible", openClawVersion: "2026.7.1-2", reason: "Requires older OpenClaw." } },
    ];
    window.uclaw = { plugins: { invoke: vi.fn(async (request: any) => ({ method: request.method, requestId: request.requestId, ok: true, result: { items, nextCursor: null, hasMore: false, mode: "fixture", repositoryVerified: false } })) } } as any;
    render(<PluginManager />);
    expect(await screen.findByText("未打包")).toBeVisible();
    expect(screen.getByText("不兼容")).toBeVisible();
    expect(screen.getByRole("button", { name: "安装 微信社区预览" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "安装 旧版插件" })).toBeDisabled();
  });

  it("requires explicit confirmation for high risk native command plugins", async () => {
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "plugins.search") return { method: request.method, requestId: request.requestId, ok: true, result: { items: [plugin], nextCursor: null, hasMore: false, mode: "fixture", repositoryVerified: false } };
      if (request.method === "plugins.detail") return { method: request.method, requestId: request.requestId, ok: true, result: { ...plugin, manifest: { id: plugin.slug, configSchema: { type: "object", additionalProperties: false, properties: {} }, packageName: "@uclaw/openclaw-shell-tools", entry: "./dist/index.js", minHostVersion: ">=2026.7.1-2", pluginApi: ">=2026.7.1-2" } } };
      if (request.method === "plugins.install") return { method: request.method, requestId: request.requestId, ok: true, result: { id: "op", slug: plugin.slug, action: "install", state: "running", progress: 25, phase: "validating" } };
      return { method: request.method, requestId: request.requestId, ok: true, result: { id: "op", slug: plugin.slug, action: "install", state: "succeeded", progress: 100, phase: "complete" } };
    });
    window.uclaw = { plugins: { invoke } } as any;
    render(<PluginManager />);
    fireEvent.click(await screen.findByRole("button", { name: "安装 命令工具包" }));
    const dialog = await screen.findByRole("dialog", { name: "确认安装命令工具包" });
    expect(dialog).toHaveTextContent("原生代码");
    expect(dialog).toHaveTextContent("命令执行");
    expect(screen.getByRole("button", { name: "确认安装" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "我已了解插件高风险权限" }));
    fireEvent.click(screen.getByRole("button", { name: "确认安装" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      method: "plugins.install",
      params: { slug: plugin.slug, confirmation: { permissionFingerprint: "permission-hash", acceptedRisk: "high" } },
    })));
  });

  it("loads USB-installed Plugins from an independent tab", async () => {
    const installed = { ...plugin, installedVersion: plugin.version, enabled: true, availability: "available" };
    const invoke = vi.fn(async (request: any) => ({
      method: request.method, requestId: request.requestId, ok: true,
      result: request.method === "plugins.installed" ? [installed] : { items: [], nextCursor: null, hasMore: false, mode: "fixture", repositoryVerified: false },
    }));
    window.uclaw = { plugins: { invoke } } as any;
    render(<PluginManager />);
    fireEvent.click(screen.getByRole("tab", { name: "已安装" }));
    expect(await screen.findByText("命令工具包")).toBeVisible();
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "plugins.installed" }));
  });
});
