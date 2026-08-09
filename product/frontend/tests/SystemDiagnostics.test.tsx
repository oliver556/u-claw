// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SystemDiagnostics } from "../src/features/system/SystemDiagnostics";

const log = { id: "desktop:1", timestamp: "2026-08-09T01:00:00.000Z", level: "info", source: "desktop", message: "desktop info event." };
const system = { product: { name: "U-Claw", version: "0.1.0" }, runtime: { node: "24.15.0", electron: "40.10.6", openclaw: "2026.7.1-2" }, platform: "win32", architecture: "x64", gateway: { status: "ready", port: 18789 }, proxy: "http://proxy.example:8080", portableData: { state: "available", writable: true }, storage: { totalBytes: 1000, freeBytes: 400, usedBytes: 600 } };

describe("SystemDiagnostics", () => {
  afterEach(() => { cleanup(); delete window.uclaw; vi.restoreAllMocks(); });
  beforeEach(() => {
    const getComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => getComputedStyle(element));
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
  });

  it("loads factual paged logs, filters, and pauses polling", async () => {
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "logs.list") return { method: request.method, requestId: request.requestId, ok: true, result: { items: [log], nextCursor: request.params.cursor ? null : "offset:1", hasMore: !request.params.cursor } };
      if (request.method === "system.get") return { method: request.method, requestId: request.requestId, ok: true, result: system };
      throw new Error("unexpected");
    });
    window.uclaw = { diagnostics: { invoke } } as never;
    render(<SystemDiagnostics />);
    expect(await screen.findByText("desktop info event.")).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索日志" }), { target: { value: "gateway" } });
    fireEvent.change(screen.getByLabelText("日志级别"), { target: { value: "error" } });
    fireEvent.click(screen.getByRole("button", { name: "应用日志筛选" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "logs.list", params: expect.objectContaining({ query: "gateway", levels: ["error"] }) })));
    fireEvent.click(screen.getByRole("button", { name: "暂停日志刷新" }));
    expect(screen.getByText("已暂停")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "恢复日志刷新" }));
    fireEvent.click(await screen.findByRole("button", { name: "加载更多日志" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "logs.list", params: expect.objectContaining({ cursor: "offset:1" }) })));
  });

  it("exports logs and requires preview plus second confirmation before cleanup", async () => {
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "logs.list") return { method: request.method, requestId: request.requestId, ok: true, result: { items: [], nextCursor: null, hasMore: false } };
      if (request.method === "system.get") return { method: request.method, requestId: request.requestId, ok: true, result: system };
      if (request.method === "logs.export") return { method: request.method, requestId: request.requestId, ok: true, result: { name: request.params.fileName, relativePath: `exports/diagnostics/${request.params.fileName}`, bytes: 20, createdAt: "2026-08-09T01:00:00.000Z" } };
      if (request.method === "logs.cleanup-preview") return { method: request.method, requestId: request.requestId, ok: true, result: { previewId: "956c9f84-1847-4c2c-8809-1fd1122e7509", retentionDays: 7, totalBytes: 80, files: [{ name: "uclaw-old.log", size: 80, modifiedAt: "2026-07-01T00:00:00.000Z" }] } };
      if (request.method === "logs.cleanup") return { method: request.method, requestId: request.requestId, ok: true, result: { removedFiles: 1, removedBytes: 80 } };
      throw new Error("unexpected");
    });
    window.uclaw = { diagnostics: { invoke } } as never;
    render(<SystemDiagnostics />);
    await screen.findByText("暂无日志");
    fireEvent.click(screen.getByRole("button", { name: "导出脱敏日志" }));
    expect(await screen.findByRole("status")).toHaveTextContent("导出完成");
    fireEvent.click(screen.getByRole("button", { name: "预览日志清理" }));
    const dialog = await screen.findByRole("dialog", { name: "确认清理日志" });
    expect(within(dialog).getByText("uclaw-old.log")).toBeInTheDocument();
    expect(invoke.mock.calls.some(([request]) => request.method === "logs.cleanup")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "确认清理" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "logs.cleanup", params: expect.objectContaining({ confirm: true }) })));
    expect(await screen.findByRole("status")).toHaveTextContent("已清理 1 个日志文件");
  });

  it("shows system summary and searchable read-only redacted config", async () => {
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "logs.list") return { method: request.method, requestId: request.requestId, ok: true, result: { items: [], nextCursor: null, hasMore: false } };
      if (request.method === "system.get") return { method: request.method, requestId: request.requestId, ok: true, result: system };
      if (request.method === "config.get") return { method: request.method, requestId: request.requestId, ok: true, result: { content: '{"token":"[REDACTED]"}', entries: [{ path: "gateway.port", value: "18789" }], truncated: false } };
      if (request.method === "config.export") return { method: request.method, requestId: request.requestId, ok: true, result: { name: request.params.fileName, relativePath: `exports/diagnostics/${request.params.fileName}`, bytes: 30, createdAt: "2026-08-09T01:00:00.000Z" } };
      throw new Error("unexpected");
    });
    window.uclaw = { diagnostics: { invoke } } as never;
    render(<SystemDiagnostics />);
    fireEvent.click(screen.getByRole("tab", { name: "系统信息" }));
    expect(await screen.findByText("24.15.0")).toBeVisible();
    expect(screen.getByText("proxy.example:8080", { exact: false })).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "原始配置" }));
    expect(await screen.findByText("gateway.port")).toBeVisible();
    expect(screen.getByText("[REDACTED]", { exact: false })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "配置正文" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索配置" }), { target: { value: "gateway" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索配置" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "config.get", params: { query: "gateway" } })));
    fireEvent.click(screen.getByRole("button", { name: "导出脱敏配置" }));
    expect(await screen.findByRole("status")).toHaveTextContent("配置导出完成");
  });

  it("shows offline and safe error states", async () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    window.uclaw = { diagnostics: { invoke: vi.fn(async () => { throw new Error("token=private /Users/alice"); }) } } as never;
    render(<SystemDiagnostics />);
    expect(await screen.findByRole("alert")).toHaveTextContent("当前离线");
    expect(document.body.textContent).not.toMatch(/private|alice/);
  });

  it("renders structured Doctor checks, controlled repair, and intranet diagnostics", async () => {
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "logs.list") return { method: request.method, requestId: request.requestId, ok: true, result: { items: [], nextCursor: null, hasMore: false } };
      if (request.method === "system.get") return { method: request.method, requestId: request.requestId, ok: true, result: system };
      if (request.method === "doctor.run" || request.method === "doctor.repair") return { method: request.method, requestId: request.requestId, ok: true, result: { state: request.method === "doctor.repair" ? "healthy" : "issues", adapter: "openclaw", checks: [{ id: "gateway", label: "Gateway", level: request.method === "doctor.repair" ? "info" : "error", summary: request.method === "doctor.repair" ? "检查通过。" : "Gateway 未就绪。", suggestion: "重启受控 Gateway。", ...(request.method === "doctor.run" ? { repair: { actionId: "gateway-restart", label: "重启 Gateway", previewToken: "doctor-preview-1" } } : {}) }] } };
      if (request.method === "network.run") return { method: request.method, requestId: request.requestId, ok: true, result: { mode: "intranet-only", checks: [
        "portable-data", "runtime", "gateway", "local-port", "dns", "provider", "channels", "capabilities",
      ].map((id) => ({ id, label: id === "provider" ? "Provider 连通" : id, level: id === "provider" ? "warning" : "info", summary: id === "provider" ? "外网不可用，内网功能仍可使用。" : "检查通过。", durationMs: 10 })), proxy: { configured: true, noProxyConfigured: true } } };
      throw new Error("unexpected");
    });
    window.uclaw = { diagnostics: { invoke } } as never;
    render(<SystemDiagnostics />);
    await screen.findByText("暂无日志");

    fireEvent.click(screen.getByRole("tab", { name: "OpenClaw Doctor" }));
    expect(await screen.findByText("Gateway 未就绪。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "重启 Gateway" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "确认受控修复" })).getByRole("button", { name: "确认修复" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "doctor.repair", params: { actionId: "gateway-restart", previewToken: "doctor-preview-1", confirmed: true, timeoutMs: 10_000 } })));

    fireEvent.click(screen.getByRole("tab", { name: "网络诊断" }));
    expect(await screen.findByText("内网可用，外网不可用")).toBeVisible();
    expect(screen.getByText("外网不可用，内网功能仍可使用。")).toBeVisible();
    expect(document.body.textContent).not.toMatch(/https?:\/\/|proxy\.example|18789/);
  });

  it("offers user cancellation for an in-flight Doctor request", async () => {
    let finishDoctor!: (response: any) => void;
    let doctorRequestId = "";
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "logs.list") return { method: request.method, requestId: request.requestId, ok: true, result: { items: [], nextCursor: null, hasMore: false } };
      if (request.method === "system.get") return { method: request.method, requestId: request.requestId, ok: true, result: system };
      if (request.method === "doctor.run") {
        doctorRequestId = request.requestId;
        return new Promise((resolve) => { finishDoctor = resolve; });
      }
      if (request.method === "operations.cancel") {
        finishDoctor({ method: "doctor.run", requestId: doctorRequestId, ok: false, error: { code: "CANCELLED", message: "诊断操作已取消。", retryable: false, recoveryActions: [], causeDetails: {} } });
        return { method: request.method, requestId: request.requestId, ok: true, result: null };
      }
      throw new Error("unexpected");
    });
    window.uclaw = { diagnostics: { invoke } } as never;
    render(<SystemDiagnostics />);
    await screen.findByText("暂无日志");
    fireEvent.click(screen.getByRole("tab", { name: "OpenClaw Doctor" }));
    fireEvent.click(await screen.findByRole("button", { name: "取消 Doctor 操作" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "operations.cancel", params: { operationRequestId: doctorRequestId } })));
    expect(await screen.findByRole("alert")).toHaveTextContent("诊断数据加载失败");
  });
});
