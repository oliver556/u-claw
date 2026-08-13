// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskArtifactCenter } from "../src/features/activity/TaskArtifactCenter";

describe("TaskArtifactCenter", () => {
  afterEach(cleanup);
  it("loads authority, cancels, retries, opens artifacts, and traces source sessions", async () => {
    const invoke = vi.fn(async (request: { method: string }) => {
      if (request.method === "tasks.list") return { ok: true, result: [{ id: "task-1", title: "Report", status: "running", sessionId: "session-1", createdAt: "2026-08-12T08:00:00.000Z", updatedAt: "2026-08-12T08:01:00.000Z" }] };
      if (request.method === "tasks.get") return { ok: true, result: { id: "task-1", title: "Report", status: "failed", sessionId: "session-1", createdAt: "2026-08-12T08:00:00.000Z", updatedAt: "2026-08-12T08:01:00.000Z", error: { message: "failed" } } };
      if (request.method === "artifacts.list") return { ok: true, result: [{ id: "artifact-1", name: "report.md", mediaType: "text/markdown", size: 42, status: "ready", sessionId: "session-1", createdAt: "2026-08-12T08:02:00.000Z" }] };
      return { ok: true, result: null };
    });
    const onOpenSession = vi.fn();
    render(<TaskArtifactCenter invoke={invoke as never} subscribe={() => vi.fn()} onOpenSession={onOpenSession} />);
    expect(await screen.findByText("Report")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "取消任务 Report" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Task 活动中心" })).toHaveAttribute("aria-busy", "false"));
    fireEvent.click(screen.getByRole("button", { name: "查看任务 Report" }));
    expect((await screen.findAllByText("failed")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("tab", { name: "历史" }));
    fireEvent.click(screen.getByRole("button", { name: "重试任务 Report" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Task 活动中心" })).toHaveAttribute("aria-busy", "false"));
    fireEvent.click(screen.getByRole("tab", { name: "成果" }));
    fireEvent.click(screen.getByRole("button", { name: "查看成果 report.md" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "artifacts.get" })));
    fireEvent.click(screen.getByRole("button", { name: "打开成果 report.md" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "artifacts.open" })));
    fireEvent.click(screen.getByRole("button", { name: "导出成果 report.md" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "artifacts.export" })));
    fireEvent.click(screen.getByRole("button", { name: "回到成果来源会话 report.md" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "tasks.cancel" })));
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "tasks.retry" }));
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "artifacts.open" }));
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "artifacts.export" }));
    expect(onOpenSession).toHaveBeenCalledWith("session-1");
  });

  it("updates the active list from authoritative task events", async () => {
    let listener: ((event: { event: "task"; payload: { type: string; task: unknown } }) => void) | undefined;
    const invoke = vi.fn(async (request: { method: string }) => ({ ok: true, result: request.method === "tasks.list" || request.method === "artifacts.list" ? [] : null }));
    render(<TaskArtifactCenter invoke={invoke as never} subscribe={(next) => { listener = next as never; return vi.fn(); }} onOpenSession={vi.fn()} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "tasks.list" })));
    listener?.({ event: "task", payload: { type: "created", task: { id: "task-live", title: "Live task", status: "running", createdAt: "2026-08-12T08:00:00.000Z", updatedAt: "2026-08-12T08:01:00.000Z" } } });
    expect(await screen.findByText("Live task")).toBeVisible();
  });

  it("closes the single activity center from its header", async () => {
    const onClose = vi.fn();
    const invoke = vi.fn(async (request: { method: string }) => ({ ok: true, result: request.method === "tasks.list" || request.method === "artifacts.list" ? [] : null }));
    render(<TaskArtifactCenter invoke={invoke as never} subscribe={() => vi.fn()} onOpenSession={vi.fn()} onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: "关闭任务活动中心" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
