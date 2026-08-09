// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MaintenanceCenter } from "../src/features/data/MaintenanceCenter";

afterEach(() => { cleanup(); vi.restoreAllMocks(); delete window.uclaw; });

const operation = { id: "operation-1", kind: "backup", state: "completed", phase: "completed", processedFiles: 5, totalFiles: 5, processedBytes: 100, totalBytes: 100, partialFailures: 0, failures: [], message: "备份已完成。" };

function bridge(state: "available" | "read-only" | "offline" = "available", coordinated = true, interrupted = false) {
  const invoke = vi.fn(async (request: any) => {
    const ok = (result: any) => ({ method: request.method, requestId: request.requestId, ok: true, result });
    if (request.method === "data.status") return ok({ state, writable: state === "available" });
    if (request.method === "backup.preview") return ok({ previewToken: "preview-backup", target: "当前 U 盘受控备份区", consistency: coordinated ? "coordinated" : "runtime-coordination-required", trigger: "manual", retainLatest: 3, collections: [
      { id: "workspace-user-files", label: "用户文件", fileCount: 1, bytes: 20, risk: "normal" },
      { id: "openclaw-memory", label: "记忆", fileCount: 1, bytes: 20, risk: "sensitive" },
      { id: "openclaw-sessions", label: "会话", fileCount: 1, bytes: 20, risk: "sensitive" },
      { id: "uclaw-configuration", label: "配置、skills/plugins/MCP 与渠道", fileCount: 2, bytes: 40, risk: "sensitive" },
    ], totalFileCount: 5, totalBytes: 100, warnings: [coordinated ? "创建时将暂停跨域写入并获取一致性快照。" : "当前 runtime 无全局 snapshot/CAS，创建将安全拒绝。"] });
    if (request.method === "backup.list") return ok({ items: [{ id: "backup-20260809-1", createdAt: "2026-08-09T00:00:00.000Z", trigger: "manual", state: interrupted ? "incomplete" : "ready", collections: ["openclaw-memory"], fileCount: 1, bytes: 20 }] });
    if (request.method === "storage.stats") return ok({ state: interrupted ? "damaged" : state, totalBytes: 290, categories: [
      ["configuration", "配置", 10, true], ["sessions", "会话", 20, true], ["memory", "记忆", 30, true], ["capabilities", "能力包", 40, true], ["logs", "日志", 20, false], ["cache", "缓存", 50, false], ["temporary-downloads", "临时/下载", 30, false], ["user-files", "用户文件", 80, true], ["backups", "备份", 10, false],
    ].map(([id, label, bytes, protectedValue]) => ({ id, label, bytes, fileCount: 1, protected: protectedValue })) });
    if (request.method === "cleanup.preview") return ok({ previewToken: "preview-cleanup", candidates: [
      { id: "cache:electron", label: "Electron 可重建缓存", bytes: 50, fileCount: 1, reason: "可重建缓存" },
      { id: "cache:temp", label: "临时与下载文件", bytes: 30, fileCount: 1, reason: "可重建缓存" },
    ], totalBytes: 80, totalFileCount: 2, protectedCategories: ["configuration", "sessions", "memory", "capabilities", "user-files"] });
    if (request.method === "backup.restore-preview") return ok({ previewToken: "preview-restore", backupId: "backup-20260809-1", source: "当前 U 盘受控备份区", target: "当前 U 盘数据根", collections: [{ id: "openclaw-memory", label: "记忆", fileCount: 1, bytes: 20, risk: "sensitive" }], totalFileCount: 1, totalBytes: 20, overwriteFileCount: 1, newFileCount: 0, warnings: ["恢复将暂停跨域写入；失败时自动回滚。"] });
    if (["backup.create", "backup.restore", "cleanup.execute", "maintenance.operation-get", "maintenance.operation-cancel"].includes(request.method)) return ok({ ...operation, kind: request.method === "backup.restore" ? "restore" : request.method === "cleanup.execute" ? "cleanup" : "backup" });
    throw new Error(`unexpected ${request.method}`);
  });
  return { invoke };
}

describe("MaintenanceCenter", () => {
  it("renders backup collections and fail-closed consistency state without paths", async () => {
    const data = bridge("available", false);
    render(<MaintenanceCenter bridge={data as any} />);
    expect(await screen.findByRole("heading", { name: "数据维护" })).toBeVisible();
    expect(screen.getByText("配置、skills/plugins/MCP 与渠道")).toBeVisible();
    expect(screen.getByText(/全局 snapshot\/CAS/)).toBeVisible();
    expect(document.body.textContent).not.toMatch(/(?:\/Users\/|\/tmp\/|[A-Za-z]:\\\\)/);
  });

  it("binds backup creation to preview and explicit confirmation", async () => {
    const data = bridge();
    render(<MaintenanceCenter bridge={data as any} />);
    await screen.findByText("用户文件");
    fireEvent.click(screen.getByRole("button", { name: "创建备份" }));
    const dialog = screen.getByRole("dialog", { name: "确认创建备份" });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认创建" }));
    await waitFor(() => expect(data.invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "backup.create", params: expect.objectContaining({ previewToken: "preview-backup", confirmed: true }) })));
    expect(await screen.findByText("备份已完成。")).toBeVisible();
  });

  it("previews restore overwrite and requires a second confirmation", async () => {
    const data = bridge();
    render(<MaintenanceCenter bridge={data as any} />);
    fireEvent.click(screen.getByRole("tab", { name: "恢复" }));
    fireEvent.click(await screen.findByRole("button", { name: /backup-20260809-1/ }));
    expect(await screen.findByText("将覆盖 1 个文件，新增 0 个文件")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "恢复此备份" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "确认恢复" })).getByRole("button", { name: "确认恢复" }));
    await waitFor(() => expect(data.invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "backup.restore", params: expect.objectContaining({ previewToken: "preview-restore", confirmed: true }) })));
  });

  it("offers cleanup only for safe candidates and disables writes when read-only", async () => {
    const data = bridge("read-only");
    render(<MaintenanceCenter bridge={data as any} />);
    fireEvent.click(screen.getByRole("tab", { name: "空间" }));
    expect(await screen.findByText("Electron 可重建缓存")).toBeVisible();
    expect(screen.queryByLabelText(/删除配置/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清理所选" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("U 盘只读");
  });

  it("surfaces interrupted restore recovery and blocks maintenance writes", async () => {
    const data = bridge("available", true, true);
    render(<MaintenanceCenter bridge={data as any} />);
    expect(await screen.findByRole("status")).toHaveTextContent("存储损坏");
    expect(screen.getByRole("button", { name: "创建备份" })).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: "恢复" }));
    expect(await screen.findByText("需人工恢复")).toBeVisible();
    expect(screen.getByRole("button", { name: /backup-20260809-1/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: "空间" }));
    expect(screen.getByRole("button", { name: "清理所选" })).toBeDisabled();
  });
});
