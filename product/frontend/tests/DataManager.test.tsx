// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DataManager } from "../src/features/data/DataManager";

describe("DataManager", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("fails explicitly when the native data bridge is unavailable", async () => {
    const original = window.uclaw;
    Object.defineProperty(window, "uclaw", { configurable: true, value: undefined });
    try {
      render(<DataManager domain="workspace" />);
      expect(await screen.findByRole("alert")).toHaveTextContent("原生数据服务未连接");
      expect(screen.queryByText("当前文件夹为空")).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "uclaw", { configurable: true, value: original });
    }
  });

  it("ignores a stale refresh that finishes after a newer refresh", async () => {
    let resolveFirstStatus!: (value: any) => void;
    const firstStatus = new Promise((resolve) => { resolveFirstStatus = resolve; });
    let statusCalls = 0;
    let listCalls = 0;
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "data.status") {
        statusCalls += 1;
        if (statusCalls === 1) return firstStatus;
        return { method: request.method, requestId: request.requestId, ok: true, result: { state: "available", writable: true } };
      }
      if (request.method === "workspace.list") {
        listCalls += 1;
        const name = listCalls === 1 ? "new.md" : "stale.md";
        return { method: request.method, requestId: request.requestId, ok: true, result: { items: [{ id: name, name, kind: "file", size: 1, modifiedAt: "2026-08-09T00:00:00.000Z", version: name, readable: true }], nextCursor: null, hasMore: false } };
      }
      throw new Error("unexpected");
    });
    render(<DataManager domain="workspace" bridge={{ invoke } as any} />);
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByRole("button", { name: "查看 new.md" })).toBeVisible();
    resolveFirstStatus({ method: "data.status", requestId: "stale", ok: true, result: { state: "read-only", writable: false } });
    await vi.waitFor(() => expect(statusCalls).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("stale.md")).not.toBeInTheDocument();
    expect(screen.queryByText("当前工作区只读")).not.toBeInTheDocument();
  });

  it("ignores a stale detail read that finishes after a newer selection", async () => {
    let resolveFirstRead!: (value: any) => void;
    const firstRead = new Promise((resolve) => { resolveFirstRead = resolve; });
    const entries = ["a.md", "b.md"].map((name) => ({ id: name, name, kind: "file", size: 1, modifiedAt: "2026-08-09T00:00:00.000Z", version: name, readable: true }));
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "data.status") return { method: request.method, requestId: request.requestId, ok: true, result: { state: "available", writable: true } };
      if (request.method === "workspace.list") return { method: request.method, requestId: request.requestId, ok: true, result: { items: entries, nextCursor: null, hasMore: false } };
      if (request.method === "workspace.read" && request.params.entryId === "a.md") return firstRead;
      if (request.method === "workspace.read") return { method: request.method, requestId: request.requestId, ok: true, result: { entry: entries[1], content: "b", encoding: "utf-8" } };
      throw new Error("unexpected");
    });
    render(<DataManager domain="workspace" bridge={{ invoke } as any} />);
    fireEvent.click(await screen.findByRole("button", { name: "查看 a.md" }));
    fireEvent.click(screen.getByRole("button", { name: "查看 b.md" }));
    expect(await screen.findByLabelText("文件内容")).toHaveValue("b");
    resolveFirstRead({ method: "workspace.read", requestId: "stale", ok: true, result: { entry: entries[0], content: "a", encoding: "utf-8" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByLabelText("文件内容")).toHaveValue("b");
  });
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
    fireEvent.click(screen.getByRole("button", { name: "打开 plan.md" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "workspace.open", params: { entryId: "notes/plan.md" } })));
    const reveal = screen.getByRole("button", { name: "定位 plan.md" });
    await vi.waitFor(() => expect(reveal).toBeEnabled());
    fireEvent.click(reveal);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "workspace.reveal", params: { entryId: "notes/plan.md" } })));
    const remove = screen.getByRole("button", { name: "删除 plan.md" });
    await vi.waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);
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

  it("guards renderer unload only while a memory edit is dirty", async () => {
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const add = vi.spyOn(window, "addEventListener").mockImplementation(((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === "beforeunload") listeners.add(listener);
    }) as typeof window.addEventListener);
    const remove = vi.spyOn(window, "removeEventListener").mockImplementation(((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === "beforeunload") listeners.delete(listener);
    }) as typeof window.removeEventListener);
    let content = "old";
    let version = "m1";
    const memory = () => ({ id: "MEMORY.md", title: "长期记忆", modifiedAt: "2026-08-09T00:00:00.000Z", version, size: content.length });
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "data.status") return { method: request.method, requestId: request.requestId, ok: true, result: { state: "available", writable: true } };
      if (request.method === "memory.list") return { method: request.method, requestId: request.requestId, ok: true, result: { items: [memory()], nextCursor: null, hasMore: false } };
      if (request.method === "memory.read") return { method: request.method, requestId: request.requestId, ok: true, result: { memory: memory(), content } };
      if (request.method === "memory.write") {
        content = request.params.content;
        version = "m2";
        return { method: request.method, requestId: request.requestId, ok: true, result: { memory: memory() } };
      }
      throw new Error("unexpected");
    });
    render(<DataManager domain="memory" bridge={{ invoke } as any} />);
    fireEvent.click(await screen.findByRole("button", { name: "查看 长期记忆" }));
    await screen.findByLabelText("记忆正文");
    expect(listeners).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("记忆正文"), { target: { value: "dirty" } });
    expect(add).toHaveBeenCalledWith("beforeunload", expect.any(Function));
    expect(listeners).toHaveLength(1);
    const event = new Event("beforeunload", { cancelable: true });
    for (const listener of listeners) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
    expect(event.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "保存记忆" }));
    await vi.waitFor(() => expect(listeners).toHaveLength(0));
    expect(remove).toHaveBeenCalledWith("beforeunload", expect.any(Function));
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

  it("destroys the edited memory state and renders the authoritative readback after saving", async () => {
    let content = "old";
    let version = "m1";
    const memory = () => ({ id: "MEMORY.md", title: "长期记忆", modifiedAt: "2026-08-09T00:00:00.000Z", version, size: content.length });
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "data.status") return { method: request.method, requestId: request.requestId, ok: true, result: { state: "available", writable: true } };
      if (request.method === "memory.list") return { method: request.method, requestId: request.requestId, ok: true, result: { items: [memory()], nextCursor: null, hasMore: false } };
      if (request.method === "memory.read") return { method: request.method, requestId: request.requestId, ok: true, result: { memory: memory(), content } };
      if (request.method === "memory.write") {
        content = `${request.params.content}\n<!-- authoritative -->`;
        version = "m2";
        return { method: request.method, requestId: request.requestId, ok: true, result: { memory: memory() } };
      }
      throw new Error("unexpected");
    });
    render(<DataManager domain="memory" bridge={{ invoke } as any} />);
    fireEvent.click(await screen.findByRole("button", { name: "查看 长期记忆" }));
    fireEvent.change(await screen.findByLabelText("记忆正文"), { target: { value: "new" } });
    fireEvent.click(screen.getByRole("button", { name: "保存记忆" }));
    expect(await screen.findByLabelText("记忆正文")).toHaveValue("new\n<!-- authoritative -->");
    expect(invoke.mock.calls.map(([request]) => request.method).slice(-3)).toEqual(["memory.write", "memory.list", "memory.read"]);
  });

  it("re-reads a renamed workspace file instead of trusting the mutation response", async () => {
    let entry = { id: "notes/plan.md", name: "plan.md", kind: "file", size: 7, modifiedAt: "2026-08-09T00:00:00.000Z", version: "v1", readable: true };
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "data.status") return { method: request.method, requestId: request.requestId, ok: true, result: { state: "available", writable: true } };
      if (request.method === "workspace.list") return { method: request.method, requestId: request.requestId, ok: true, result: { items: [entry], nextCursor: null, hasMore: false } };
      if (request.method === "workspace.read") return { method: request.method, requestId: request.requestId, ok: true, result: { entry, content: `disk:${entry.id}`, encoding: "utf-8" } };
      if (request.method === "workspace.rename") {
        entry = { ...entry, id: "notes/renamed.md", name: "renamed.md", version: "v2" };
        return { method: request.method, requestId: request.requestId, ok: true, result: entry };
      }
      throw new Error("unexpected");
    });
    render(<DataManager domain="workspace" bridge={{ invoke } as any} />);
    fireEvent.click(await screen.findByRole("button", { name: "查看 plan.md" }));
    expect(await screen.findByLabelText("文件内容")).toHaveValue("disk:notes/plan.md");
    fireEvent.click(screen.getByRole("button", { name: "重命名 plan.md" }));
    const dialog = screen.getByRole("dialog", { name: "重命名文件" });
    fireEvent.change(within(dialog).getByLabelText("新名称"), { target: { value: "renamed.md" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认重命名" }));
    expect(await screen.findByLabelText("文件内容")).toHaveValue("disk:notes/renamed.md");
    expect(invoke.mock.calls.map(([request]) => request.method).slice(-3)).toEqual(["workspace.rename", "workspace.list", "workspace.read"]);
  });

  it("moves a workspace file through a controlled dialog", async () => {
    let entry = { id: "notes/plan.md", name: "plan.md", kind: "file", size: 7, modifiedAt: "2026-08-09T00:00:00.000Z", version: "v1", readable: true };
    const invoke = vi.fn(async (request: any) => {
      if (request.method === "data.status") return { method: request.method, requestId: request.requestId, ok: true, result: { state: "available", writable: true } };
      if (request.method === "workspace.list") return { method: request.method, requestId: request.requestId, ok: true, result: { items: [entry], nextCursor: null, hasMore: false } };
      if (request.method === "workspace.read") return { method: request.method, requestId: request.requestId, ok: true, result: { entry, content: "plan", encoding: "utf-8" } };
      if (request.method === "workspace.move") {
        entry = { ...entry, id: "archive/plan.md", version: "v2" };
        return { method: request.method, requestId: request.requestId, ok: true, result: entry };
      }
      throw new Error("unexpected");
    });
    render(<DataManager domain="workspace" bridge={{ invoke } as any} />);
    fireEvent.click(await screen.findByRole("button", { name: "查看 plan.md" }));
    fireEvent.click(await screen.findByRole("button", { name: "移动 plan.md" }));
    const dialog = screen.getByRole("dialog", { name: "移动文件" });
    fireEvent.change(within(dialog).getByLabelText("目标文件夹"), { target: { value: "archive" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认移动" }));
    expect(await within(screen.getByRole("region", { name: "详情" })).findByText("archive/plan.md")).toBeVisible();
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      method: "workspace.move",
      params: expect.objectContaining({ destinationId: "archive" }),
    }));
  });
});
