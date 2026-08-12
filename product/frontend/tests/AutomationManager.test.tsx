// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationManager } from "../src/features/automation/AutomationManager.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("AutomationManager", () => {
  it("loads authority and performs complete Agent and Cron workflows with readback", async () => {
    const invoke = vi.fn(async (request: { method: string; requestId: string; params?: unknown }) => {
      if (["agents.list", "agents.create", "agents.update", "agents.delete"].includes(request.method)) return { method: request.method, requestId: request.requestId, ok: true, result: { agents: [{ id: "writer", name: "Writer", workspace: "/tmp/writer", model: "openai/gpt-5" }] } };
      if (request.method === "agent.identity.get") return { method: request.method, requestId: request.requestId, ok: true, result: { agentId: "writer", name: "Writer" } };
      if (request.method === "agents.files.list") return { method: request.method, requestId: request.requestId, ok: true, result: { files: [{ path: "AGENTS.md", name: "AGENTS.md", size: 4 }] } };
      if (["agents.files.get", "agents.files.set"].includes(request.method)) return { method: request.method, requestId: request.requestId, ok: true, result: { file: { path: "AGENTS.md", name: "AGENTS.md", size: 4, content: "rule" } } };
      if (request.method === "agents.workspace.list") return request.params && (request.params as { path?: string }).path === "src" ? { method: request.method, requestId: request.requestId, ok: true, result: { path: "src", parentPath: "", entries: [{ path: "src/index.ts", name: "index.ts", kind: "file" }] } } : { method: request.method, requestId: request.requestId, ok: true, result: { path: "", entries: [{ path: "README.md", name: "README.md", kind: "file" }, { path: "src", name: "src", kind: "directory" }] } };
      if (request.method === "agents.workspace.get") return { method: request.method, requestId: request.requestId, ok: true, result: { entry: { path: "README.md", name: "README.md", kind: "file", content: "readme" } } };
      if (["cron.list", "cron.add", "cron.update", "cron.remove"].includes(request.method)) return { method: request.method, requestId: request.requestId, ok: true, result: { jobs: [{ id: "daily", name: "Daily", enabled: true, schedule: { kind: "cron", expression: "0 9 * * *" }, payload: { kind: "agentTurn", message: "report" } }, { id: "heartbeat", name: "Heartbeat", enabled: true, schedule: { kind: "every", everyMs: 60_000 }, payload: { kind: "systemEvent", message: "tick" } }] } };
      if (request.method === "cron.status") return { method: request.method, requestId: request.requestId, ok: true, result: { enabled: true, jobCount: 1 } };
      if (request.method === "cron.get") return (request.params as { jobId?: string }).jobId === "heartbeat" ? { method: request.method, requestId: request.requestId, ok: true, result: { job: { id: "heartbeat", name: "Heartbeat", enabled: true, schedule: { kind: "every", everyMs: 60_000 }, payload: { kind: "systemEvent", message: "tick" } } } } : { method: request.method, requestId: request.requestId, ok: true, result: { job: { id: "daily", name: "Daily", enabled: true, schedule: { kind: "cron", expression: "0 9 * * *" }, payload: { kind: "agentTurn", message: "report" } } } };
      if (request.method === "cron.runs") return { method: request.method, requestId: request.requestId, ok: true, result: { runs: [] } };
      return { method: request.method, requestId: request.requestId, ok: true, result: {} };
    });
    render(<AutomationManager invoke={invoke as never} />);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    expect(await screen.findByText("Writer")).toBeVisible();
    expect(screen.getByRole("button", { name: "编辑 Agent writer" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Agent workspace"), { target: { value: "/tmp/writer" } });
    fireEvent.click(screen.getByRole("button", { name: "查看 Agent writer" }));
    expect(await screen.findByText("rule")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "README.md" }));
    expect(await screen.findByText("readme")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "src" }));
    expect(await screen.findByRole("button", { name: "index.ts" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "返回上级目录" }));
    expect(await screen.findByRole("button", { name: "README.md" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "创建 Agent" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "agents.create" })));
    fireEvent.click(screen.getByRole("button", { name: "编辑 Agent writer" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "agents.update" })));
    fireEvent.click(screen.getByRole("button", { name: "删除 Agent writer" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "agents.delete" })));
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "agents.delete", params: { agentId: "writer", deleteFiles: false } }));
    fireEvent.click(screen.getByRole("button", { name: "保存 Agent 文件" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "agents.files.set" })));
    fireEvent.click(screen.getByRole("tab", { name: "定时任务" }));
    expect(await screen.findByText("Daily")).toBeVisible();
    expect(screen.getByRole("button", { name: "编辑定时任务 daily" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "查看定时任务 heartbeat" }));
    expect(await screen.findByText(/此任务类型只读/)).toBeVisible();
    expect(screen.getByRole("button", { name: "编辑定时任务 heartbeat" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "查看定时任务 daily" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "cron.get" })));
    fireEvent.click(screen.getByRole("button", { name: "新增定时任务" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "cron.add" })));
    fireEvent.click(screen.getByRole("button", { name: "编辑定时任务 daily" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "cron.update" })));
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "cron.update", params: expect.objectContaining({ enabled: true }) }));
    fireEvent.click(screen.getByRole("button", { name: "删除定时任务 daily" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "cron.remove" })));
    fireEvent.click(screen.getByRole("button", { name: "立即运行 daily" }));
    fireEvent.click(screen.getByRole("button", { name: "查看运行历史 daily" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "cron.runs" })));
    expect(invoke.mock.calls.map(([request]) => request.method)).toEqual(expect.arrayContaining(["agents.create", "agents.update", "agents.delete", "agents.files.set", "cron.add", "cron.update", "cron.remove", "cron.run", "cron.runs"]));
  });
});
