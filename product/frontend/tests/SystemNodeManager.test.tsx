// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SystemNodeManager } from "../src/features/system/SystemNodeManager.js";

afterEach(cleanup);

describe("SystemNodeManager", () => {
  it("loads all authoritative domains and controls terminal lifecycle without persisting token or output", async () => {
    const deviceAuthority = { pending: [{ requestId: "p1", deviceId: "phone" }], paired: [{ deviceId: "desktop", displayName: "Desktop", roles: ["operator"] }] };
    const nodeAuthority = { nodes: [{ nodeId: "node1", displayName: "Studio", connected: true, commands: ["system.info"] }] };
    const pairAuthority = { pending: [{ requestId: "np1", nodeId: "node2", displayName: "Render node" }], paired: [] };
    const worktreeAuthority = { worktrees: [{ id: "wt1", name: "review", path: "/tmp/review", branch: "review", repoRoot: "/tmp/repo", createdAt: 1, lastActiveAt: 1 }] };
    const invoke = vi.fn(async (request: { method: string; requestId: string; params: Record<string, unknown> }) => {
      const result = request.method === "device.pair.list" ? deviceAuthority
        : request.method.startsWith("device.") ? { mutation: request.method === "device.token.rotate" ? { token: "super-secret-token" } : {}, authority: deviceAuthority }
        : request.method === "node.list" ? nodeAuthority
        : request.method === "node.describe" ? nodeAuthority.nodes[0]
        : request.method === "node.rename" ? { mutation: {}, authority: { ...nodeAuthority.nodes[0], displayName: String(request.params.displayName) } }
        : request.method === "node.pair.list" ? pairAuthority
        : request.method === "environments.list" ? { environments: [{ id: "gateway", type: "local", label: "Gateway local", status: "available" }] }
        : request.method === "environments.status" ? { id: "gateway", status: "available", nodeVersion: "v24.15.0" }
        : request.method === "worktrees.list" ? worktreeAuthority
        : request.method.startsWith("worktrees.") ? { mutation: {}, authority: worktreeAuthority }
        : request.method === "terminal.list" ? { sessions: [] }
        : request.method === "terminal.open" ? { mutation: { sessionId: "term1", agentId: "main", cwd: "/workspace", shell: "/bin/zsh" }, authority: { sessions: [{ sessionId: "term1", agentId: "main", cwd: "/workspace", shell: "/bin/zsh", attached: true }] } }
        : request.method === "terminal.text" ? { text: "hello" }
        : request.method === "terminal.close" ? { mutation: {}, authority: { sessions: [] } }
        : { mutation: {}, authority: {} };
      return { method: request.method, requestId: request.requestId, ok: true as const, result };
    });
    const subscribe = vi.fn(() => vi.fn());
    const { unmount } = render(<SystemNodeManager bridge={{ invoke: invoke as never, subscribe }} />);
    expect(await screen.findByText("Desktop")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "批准设备 phone" }));
    fireEvent.click(screen.getByRole("button", { name: "轮换设备 Token desktop" }));
    fireEvent.click(screen.getByRole("button", { name: "撤销设备 Token desktop" }));
    fireEvent.click(screen.getByRole("button", { name: "移除设备 desktop" }));
    fireEvent.click(screen.getByRole("tab", { name: "Node" }));
    expect(await screen.findByText("Studio")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "查看 Node node1" }));
    expect(await screen.findByDisplayValue("Studio")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Node 显示名称" }), { target: { value: "Studio 2" } });
    fireEvent.click(screen.getByRole("button", { name: "重命名 Node" }));
    fireEvent.click(screen.getByRole("button", { name: "调用 Node node1" }));
    fireEvent.click(screen.getByRole("button", { name: "批准 Node node2" }));
    fireEvent.click(screen.getByRole("button", { name: "移除 Node node1" }));
    fireEvent.click(screen.getByRole("tab", { name: "运行环境" }));
    expect(await screen.findByText("Gateway local")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "查看运行环境 gateway" }));
    expect(await screen.findByText(/v24\.15\.0/)).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Worktree" }));
    expect(await screen.findByText("review")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Git 仓库根目录" }), { target: { value: "/tmp/repo" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Worktree 名称" }), { target: { value: "smoke" } });
    fireEvent.click(screen.getByRole("button", { name: "创建 Worktree" }));
    fireEvent.click(screen.getByRole("button", { name: "删除 Worktree wt1" }));
    fireEvent.click(screen.getByRole("button", { name: "清理 Worktree" }));
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "打开 Terminal" }));
    expect(await screen.findByText("term1")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Terminal 输入" }), { target: { value: "printf ok\\n" } });
    fireEvent.click(screen.getByRole("button", { name: "发送 Terminal 输入" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Terminal 列数" }), { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "调整 Terminal 大小" }));
    fireEvent.click(screen.getByRole("button", { name: "读取 Terminal 输出" }));
    expect(await screen.findByText("hello")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "关闭 Terminal" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "terminal.close" })));
    unmount();
    render(<SystemNodeManager bridge={{ invoke: invoke as never, subscribe }} />);
    expect(screen.queryByText("hello")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("super-secret-token");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "terminal.resize", params: { sessionId: "term1", cols: 120, rows: 30 } })));
    const terminalOpen = invoke.mock.calls.find(([request]) => request.method === "terminal.open")?.[0];
    expect(terminalOpen?.params).toEqual({ agentId: "main", cols: 100, rows: 30 });
    expect(terminalOpen?.params).not.toEqual(expect.objectContaining({ command: expect.anything(), cwd: expect.anything(), shell: expect.anything(), env: expect.anything() }));
  });
});
