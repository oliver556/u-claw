// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import type { ActivityCenterService, TaskActivitySnapshot } from "@uclaw/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskActivityCenter } from "../src/features/activity/TaskActivityCenter";

const snapshot: TaskActivitySnapshot = {
  contractVersion: 1,
  generatedAt: "2026-08-09T08:00:00.000Z",
  source: "openclaw",
  tasks: [
    { id: "run:1", sessionId: "session-1", sessionTitle: "运行会话", runId: "run-1", title: "运行任务", state: "running", updatedAt: "2026-08-09T08:00:00.000Z" },
    { id: "run:2", sessionId: "session-2", sessionTitle: "等待会话", runId: "run-2", title: "等待任务", state: "waiting-input", updatedAt: "2026-08-09T07:00:00.000Z" },
    { id: "run:3", sessionId: "session-3", sessionTitle: "成功会话", runId: "run-3", title: "成功任务", state: "succeeded", updatedAt: "2026-08-09T06:00:00.000Z" },
    { id: "run:4", sessionId: "session-4", sessionTitle: "失败会话", runId: "run-4", title: "失败任务", state: "failed", updatedAt: "2026-08-09T05:00:00.000Z", error: { code: "OPERATION_FAILED", message: "Task failed.", retryable: true } },
    { id: "run:5", sessionId: "session-5", sessionTitle: "取消会话", runId: "run-5", title: "取消任务", state: "cancelled", updatedAt: "2026-08-09T04:00:00.000Z" },
  ],
};

describe("TaskActivityCenter", () => {
  afterEach(cleanup);

  it("shows all OpenClaw task states and returns to the related session", async () => {
    const service: ActivityCenterService = { list: vi.fn(async () => snapshot) };
    const onOpenSession = vi.fn();
    render(<TaskActivityCenter open service={service} onClose={vi.fn()} onOpenSession={onOpenSession} />);

    for (const label of ["运行中", "等待输入", "成功", "失败", "已取消"]) expect(await screen.findByText(label)).toBeVisible();
    expect(screen.getByText("错误码：OPERATION_FAILED")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "回到失败会话" }));
    expect(onOpenSession).toHaveBeenCalledWith("session-4");
  });

  it("shows a recoverable loading error and rebuilds from source after retry", async () => {
    let calls = 0;
    const service: ActivityCenterService = { list: vi.fn(async () => {
      if (calls++ === 0) throw new Error("offline path /tmp/secret");
      return snapshot;
    }) };
    render(<TaskActivityCenter open service={service} onClose={vi.fn()} onOpenSession={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("任务状态加载失败");
    expect(document.body.textContent).not.toContain("/tmp/secret");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.getByText("运行任务")).toBeVisible());
    expect(service.list).toHaveBeenCalledTimes(2);
  });
});
