// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReleaseCenter } from "../src/features/system/ReleaseCenter";

afterEach(() => { cleanup(); delete window.uclaw; });

function bridge(state: "available" | "offline" | "unavailable" = "available", recovery: "clean" | "rolled-back" | "recovery-required" = "clean", operationRunning = false, operationPhase: "cleaning" | "switching" = "cleaning", message?: string) {
  const invoke = vi.fn(async (request: any) => {
    const ok = (result: any) => ({ method: request.method, requestId: request.requestId, ok: true, result });
    if (request.method === "release.recovery") return ok({ state: recovery, message: recovery === "recovery-required" ? "自动回滚失败，需要恢复。" : recovery === "rolled-back" ? "检测到中断更新，已回滚。" : "无待恢复更新。" });
    if (["release.check", "release.retry"].includes(request.method)) return ok({ state, checkedAt: "2026-08-09T00:00:00.000Z", currentVersion: "0.1.0", channel: "stable", retryable: state !== "unavailable", ...(message ? { message } : {}), ...(state === "available" ? { update: { id: "release-42", version: "0.2.0", channel: "stable", publishedAt: "2026-08-09T00:00:00.000Z", notes: ["安全更新", "修复恢复流程"], compatibility: { platform: "win32", arch: "x64", runtimeId: "openclaw-2026.7.1-2-win-x64" }, bytes: 128, mandatory: false, previewToken: "preview-42" } } : {}) });
    if (request.method === "uninstall.preview") return ok({ previewToken: "uninstall-token", scopes: [
      { id: "application", label: "U-Claw 应用", selected: false, protected: false, available: false, detail: "由 Windows 卸载器移除" },
      { id: "usb-user-data", label: "U 盘用户数据", selected: false, protected: true, available: false, detail: "默认永久保留" },
      { id: "host-cache", label: "本机 U-Claw 缓存", selected: true, protected: false, available: true, detail: "仅 marker 证明归属的缓存" },
    ] });
    if (["release.install", "uninstall.execute", "release.operation"].includes(request.method)) return ok({ id: "operation-1", kind: request.method === "uninstall.execute" ? "uninstall" : "install", state: operationRunning ? "running" : "completed", phase: operationRunning ? operationPhase : "completed", processedItems: 3, totalItems: 3, partialFailures: 0, message: "操作完成。", recovery: "none" });
    throw new Error(`unexpected ${request.method}`);
  });
  return { invoke };
}

describe("ReleaseCenter", () => {
  it("renders structured update metadata and installs only after confirmation", async () => {
    const release = bridge();
    render(<ReleaseCenter bridge={release as any} onOpenDiagnostics={vi.fn()} />);
    expect(await screen.findByText("0.2.0")).toBeVisible();
    expect(screen.getByText("win32 · x64")).toBeVisible();
    expect(screen.getByText("安全更新")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "安装更新" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "确认安装更新" })).getByRole("button", { name: "确认安装" }));
    await waitFor(() => expect(release.invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "release.install", params: { updateId: "release-42", previewToken: "preview-42", confirmed: true } })));
  });

  it("shows offline retry and unavailable states", async () => {
    const offline = bridge("offline"); render(<ReleaseCenter bridge={offline as any} onOpenDiagnostics={vi.fn()} />);
    expect(await screen.findByText("当前离线，无法检查更新")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(offline.invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "release.retry" })));
    cleanup();
    render(<ReleaseCenter bridge={bridge("unavailable") as any} onOpenDiagnostics={vi.fn()} />);
    expect(await screen.findByText("更新服务不可用")).toBeVisible();
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
  });

  it("shows a fail-closed production configuration reason", async () => {
    render(<ReleaseCenter bridge={bridge("unavailable", "clean", false, "cleaning", "发布更新配置缺失。") as any} onOpenDiagnostics={vi.fn()} />);
    expect(await screen.findByText("发布更新配置缺失。")).toBeVisible();
  });

  it("keeps USB data protected and requires token confirmation for host cache cleanup", async () => {
    const release = bridge("available", "clean", true); render(<ReleaseCenter bridge={release as any} onOpenDiagnostics={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "卸载与清理" }));
    expect(await screen.findByText("默认永久保留")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "清理本机缓存" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "确认清理本机缓存" })).getByRole("button", { name: "确认清理" }));
    await waitFor(() => expect(release.invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "uninstall.execute", params: { scopeIds: ["host-cache"], previewToken: "uninstall-token", confirmed: true } })));
    expect(screen.queryByRole("button", { name: "取消" })).not.toBeInTheDocument();
  });

  it("surfaces interrupted update recovery state", async () => {
    render(<ReleaseCenter bridge={bridge("unavailable", "recovery-required") as any} onOpenDiagnostics={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("自动回滚失败，需要恢复");
  });

  it("does not offer cancellation after an install enters switching", async () => {
    const release = bridge("available", "clean", true, "switching");
    render(<ReleaseCenter bridge={release as any} onOpenDiagnostics={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "安装更新" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "确认安装更新" })).getByRole("button", { name: "确认安装" }));
    await waitFor(() => expect(screen.getByText("操作完成。")).toBeVisible());
    expect(screen.queryByRole("button", { name: "取消" })).not.toBeInTheDocument();
  });

  it("offers Doctor as UI navigation and never accepts command input", async () => {
    const open = vi.fn(); const invoke = vi.fn(async (request: any) => ({ method: request.method, requestId: request.requestId, ok: true, result: null }));
    window.uclaw = { window: { invoke: invoke as any } };
    render(<ReleaseCenter bridge={bridge() as any} onOpenDiagnostics={open} />);
    fireEvent.click(await screen.findByRole("button", { name: "打开 Doctor" }));
    expect(open).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "打开 CLI 控制台" }));
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "open-advanced-console", params: {} }));
    expect(screen.queryByRole("textbox", { name: /命令/ })).not.toBeInTheDocument();
  });
});
