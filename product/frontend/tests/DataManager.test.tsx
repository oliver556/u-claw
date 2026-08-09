// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DataManager } from "../src/features/data/DataManager";

describe("DataManager", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  it("loads files, searches, opens detail and confirms deletion", async () => {
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "data.status") return { method: request.method, requestId: request.requestId, ok: true, result: { state: "available", writable: true } };
      if (request.method === "workspace.list") return { method: request.method, requestId: request.requestId, ok: true, result: { items: [{ id: "notes/plan.md", name: "plan.md", kind: "file", size: 7, modifiedAt: "2026-08-09T00:00:00.000Z", version: "v1", readable: true }], nextCursor: null, hasMore: false } };
      if (request.method === "workspace.read") return { method: request.method, requestId: request.requestId, ok: true, result: { entry: { id: "notes/plan.md", name: "plan.md", kind: "file", size: 7, modifiedAt: "2026-08-09T00:00:00.000Z", version: "v1", readable: true }, content: "plan v1", encoding: "utf-8" } };
      return { method: request.method, requestId: request.requestId, ok: true, result: null };
    });
    render(<DataManager domain="workspace" bridge={{ invoke } as any} />);
    expect(await screen.findByText("plan.md")).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索工作区文件" }), { target: { value: "plan" } });
    fireEvent.click(screen.getByRole("button", { name: "查看 plan.md" }));
    expect(await screen.findByDisplayValue("plan v1")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "删除 plan.md" }));
    expect(screen.getByRole("dialog", { name: "确认删除" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "workspace.delete", params: expect.objectContaining({ confirmed: true }) })));
  });

  it("edits memory through its versioned bridge and never puts content in errors", async () => {
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "data.status") return { method: request.method, requestId: request.requestId, ok: true, result: { state: "available", writable: true } };
      if (request.method === "memory.list") return { method: request.method, requestId: request.requestId, ok: true, result: { items: [{ id: "MEMORY.md", title: "长期记忆", modifiedAt: "2026-08-09T00:00:00.000Z", version: "m1", size: 10 }], nextCursor: null, hasMore: false } };
      if (request.method === "memory.read") return { method: request.method, requestId: request.requestId, ok: true, result: { memory: { id: "MEMORY.md", title: "长期记忆", modifiedAt: "2026-08-09T00:00:00.000Z", version: "m1", size: 10 }, content: "private memory" } };
      if (request.method === "memory.write") return { method: request.method, requestId: request.requestId, ok: false, error: { code: "CONFLICT", message: "记忆已被其他进程修改，请重新加载。", retryable: true, recoveryActions: ["reload"], causeDetails: {} } };
      throw new Error("unexpected");
    });
    render(<DataManager domain="memory" bridge={{ invoke } as any} />);
    fireEvent.click(await screen.findByRole("button", { name: "查看 长期记忆" }));
    const editor = await screen.findByLabelText("记忆正文");
    fireEvent.change(editor, { target: { value: "changed private memory" } });
    fireEvent.click(screen.getByRole("button", { name: "保存记忆" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("记忆已被其他进程修改");
    expect(screen.getByRole("alert")).not.toHaveTextContent("changed private memory");
  });

  it("shows explicit offline recovery", async () => {
    const invoke = vi.fn(async (request: any) => ({ method: request.method, requestId: request.requestId, ok: false, error: { code: "USB_UNAVAILABLE", message: "U 盘工作区离线。", retryable: true, recoveryActions: ["reconnect-usb"], causeDetails: {} } }));
    render(<DataManager domain="workspace" bridge={{ invoke } as any} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("U 盘工作区离线");
    expect(within(alert).getByRole("button", { name: "重新加载" })).toBeVisible();
  });

  it("loads native status and disables writes while the workspace is read-only", async () => {
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "data.status") return { method: request.method, requestId: request.requestId, ok: true, result: { state: "read-only", writable: false } };
      if (request.method === "memory.list") return { method: request.method, requestId: request.requestId, ok: true, result: { items: [{ id: "MEMORY.md", title: "长期记忆", modifiedAt: "2026-08-09T00:00:00.000Z", version: "m1", size: 10 }], nextCursor: null, hasMore: false } };
      if (request.method === "memory.read") return { method: request.method, requestId: request.requestId, ok: true, result: { memory: { id: "MEMORY.md", title: "长期记忆", modifiedAt: "2026-08-09T00:00:00.000Z", version: "m1", size: 10 }, content: "private memory" } };
      throw new Error("unexpected mutation");
    });
    render(<DataManager domain="memory" bridge={{ invoke } as any} />);
    fireEvent.click(await screen.findByRole("button", { name: "查看 长期记忆" }));
    expect(await screen.findByText("当前工作区只读")).toBeVisible();
    fireEvent.change(screen.getByLabelText("记忆正文"), { target: { value: "changed" } });
    expect(screen.getByRole("button", { name: "保存记忆" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "删除 长期记忆" })).toBeDisabled();
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "data.status" }));
  });

  it("clears selected content when the data domain changes", async () => {
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "data.status") return { method: request.method, requestId: request.requestId, ok: true, result: { state: "available", writable: true } };
      if (request.method === "workspace.list") return { method: request.method, requestId: request.requestId, ok: true, result: { items: [{ id: "notes/plan.md", name: "plan.md", kind: "file", size: 7, modifiedAt: "2026-08-09T00:00:00.000Z", version: "v1", readable: true }], nextCursor: null, hasMore: false } };
      if (request.method === "workspace.read") return { method: request.method, requestId: request.requestId, ok: true, result: { entry: { id: "notes/plan.md", name: "plan.md", kind: "file", size: 7, modifiedAt: "2026-08-09T00:00:00.000Z", version: "v1", readable: true }, content: "plan v1", encoding: "utf-8" } };
      if (request.method === "memory.list") return { method: request.method, requestId: request.requestId, ok: true, result: { items: [], nextCursor: null, hasMore: false } };
      throw new Error("unexpected");
    });
    const view = render(<DataManager domain="workspace" bridge={{ invoke } as any} />);
    fireEvent.click(await screen.findByRole("button", { name: "查看 plan.md" }));
    expect(await screen.findByDisplayValue("plan v1")).toBeVisible();
    view.rerender(<DataManager domain="memory" bridge={{ invoke } as any} />);
    expect(await screen.findByText("还没有 AI 记忆")).toBeVisible();
    expect(screen.queryByDisplayValue("plan v1")).not.toBeInTheDocument();
  });

  it("keeps dirty memory selected when the user cancels switching entries", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const entries = ["MEMORY.md", "memory/next.md"].map((id, index) => ({ id, title: index === 0 ? "长期记忆" : "next", modifiedAt: "2026-08-09T00:00:00.000Z", version: `m${index}`, size: 10 }));
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "data.status") return { method: request.method, requestId: request.requestId, ok: true, result: { state: "available", writable: true } };
      if (request.method === "memory.list") return { method: request.method, requestId: request.requestId, ok: true, result: { items: entries, nextCursor: null, hasMore: false } };
      if (request.method === "memory.read") return { method: request.method, requestId: request.requestId, ok: true, result: { memory: entries.find((entry) => entry.id === request.params.memoryId), content: request.params.memoryId } };
      throw new Error("unexpected");
    });
    render(<DataManager domain="memory" bridge={{ invoke } as any} />);
    fireEvent.click(await screen.findByRole("button", { name: "查看 长期记忆" }));
    fireEvent.change(await screen.findByLabelText("记忆正文"), { target: { value: "dirty body" } });
    fireEvent.click(screen.getByRole("button", { name: "查看 next" }));
    expect(confirm).toHaveBeenCalledWith("当前记忆尚未保存，放弃修改吗？");
    expect(screen.getByLabelText("记忆正文")).toHaveValue("dirty body");
  });

  it("reports dirty memory state to the router-level navigation guard", async () => {
    const onDirtyChange = vi.fn();
    const memory = { id: "MEMORY.md", title: "长期记忆", modifiedAt: "2026-08-09T00:00:00.000Z", version: "m1", size: 10 };
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "data.status") return { method: request.method, requestId: request.requestId, ok: true, result: { state: "available", writable: true } };
      if (request.method === "memory.list") return { method: request.method, requestId: request.requestId, ok: true, result: { items: [memory], nextCursor: null, hasMore: false } };
      if (request.method === "memory.read") return { method: request.method, requestId: request.requestId, ok: true, result: { memory, content: "old" } };
      throw new Error("unexpected");
    });
    const GuardedDataManager = DataManager as any;
    render(<GuardedDataManager domain="memory" bridge={{ invoke } as any} onDirtyChange={onDirtyChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "查看 长期记忆" }));
    fireEvent.change(await screen.findByLabelText("记忆正文"), { target: { value: "dirty" } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it("reports a successful memory write separately from a failed list refresh", async () => {
    let listCalls = 0;
    const memory = { id: "MEMORY.md", title: "长期记忆", modifiedAt: "2026-08-09T00:00:00.000Z", version: "m1", size: 10 };
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "data.status") return { method: request.method, requestId: request.requestId, ok: true, result: { state: "available", writable: true } };
      if (request.method === "memory.list") {
        listCalls += 1;
        if (listCalls > 1) return { method: request.method, requestId: request.requestId, ok: false, error: { code: "OPERATION_FAILED", message: "列表刷新失败。", retryable: true, recoveryActions: ["retry"], causeDetails: {} } };
        return { method: request.method, requestId: request.requestId, ok: true, result: { items: [memory], nextCursor: null, hasMore: false } };
      }
      if (request.method === "memory.read") return { method: request.method, requestId: request.requestId, ok: true, result: { memory, content: "old" } };
      if (request.method === "memory.write") return { method: request.method, requestId: request.requestId, ok: true, result: { memory: { ...memory, version: "m2" } } };
      throw new Error("unexpected");
    });
    render(<DataManager domain="memory" bridge={{ invoke } as any} />);
    fireEvent.click(await screen.findByRole("button", { name: "查看 长期记忆" }));
    fireEvent.change(await screen.findByLabelText("记忆正文"), { target: { value: "new" } });
    fireEvent.click(screen.getByRole("button", { name: "保存记忆" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("记忆已保存，但列表刷新失败");
    expect(screen.getByRole("button", { name: "保存记忆" })).toBeDisabled();
  });
});
