// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import type { SessionAdvancedIpcRequest, SessionAdvancedIpcResponse, SessionCheckpoint } from "@uclaw/shared/dist/session-advanced.js";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionAdvancedPanel, type SessionAdvancedBridge } from "../src/features/sessions/SessionAdvancedPanel";

const now = "2026-08-11T00:00:00.000Z";
const session = (id = "agent:main:main", title = "权威会话") => ({ id, title, updatedAt: now, pinned: false, status: "idle" as const });
const checkpoint: SessionCheckpoint = {
  checkpointId: "cp-1", sessionId: "agent:main:main", transcriptId: "transcript-before", createdAt: 1786406400000,
  reason: "manual", preCompaction: { sessionId: "transcript-before" }, postCompaction: { sessionId: "transcript-after" },
};

function success(request: SessionAdvancedIpcRequest, result: unknown): SessionAdvancedIpcResponse {
  return { method: request.method, requestId: request.requestId, ok: true, result } as SessionAdvancedIpcResponse;
}

function bridgeFixture(): SessionAdvancedBridge & { invoke: ReturnType<typeof vi.fn> } {
  return {
    invoke: vi.fn(async (request: SessionAdvancedIpcRequest) => {
      switch (request.method) {
        case "sessions.files.list": return success(request, { sessionId: request.params.sessionId, files: [{ path: "src/index.ts", name: "index.ts", kind: "modified", missing: false }] });
        case "sessions.files.get": return success(request, { sessionId: request.params.sessionId, file: { path: request.params.path, name: "index.ts", kind: "modified", missing: false, content: "export const ready = true;" } });
        case "sessions.checkpoints.list": return success(request, { sessionId: request.params.sessionId, checkpoints: [checkpoint] });
        case "sessions.reset": return success(request, { operation: "reset", session: session("agent:main:main", "重置后权威会话") });
        case "sessions.compact": return success(request, { operation: "compact", session: session(), compacted: true, checkpoints: [checkpoint] });
        case "sessions.branch": return success(request, { operation: "branch", sourceSessionId: request.params.sessionId, session: session("agent:main:branch", "分支权威会话"), checkpoint });
        case "sessions.restore": return success(request, { operation: "restore", session: session(), checkpoint });
        case "sessions.steer": return success(request, { operation: "steer", runId: "run-1", status: "accepted", session: session("agent:main:main", "引导后权威会话") });
      }
    }),
  };
}

describe("SessionAdvancedPanel", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("shows unconfigured and no-session states without invoking the bridge", () => {
    const { rerender } = render(<SessionAdvancedPanel />);
    expect(screen.getByText("会话高级操作未配置")).toBeVisible();
    const bridge = bridgeFixture();
    rerender(<SessionAdvancedPanel bridge={bridge} />);
    expect(screen.getByText("未选择会话")).toBeVisible();
    expect(bridge.invoke).not.toHaveBeenCalled();
  });

  it("loads session files and checkpoints, then reads file content from the bridge", async () => {
    const bridge = bridgeFixture();
    render(<SessionAdvancedPanel bridge={bridge} sessionId="agent:main:main" />);

    expect(screen.getByText("正在加载会话文件")).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: "读取 index.ts" }));
    expect(await screen.findByText("export const ready = true;")).toBeVisible();
    expect(screen.getByText("cp-1")).toBeVisible();
    expect(bridge.invoke.mock.calls.map(([request]) => request.method)).toEqual([
      "sessions.files.list", "sessions.checkpoints.list", "sessions.files.get",
    ]);
  });

  it("ignores stale file and checkpoint responses after switching sessions", async () => {
    const pending = new Map<string, (response: SessionAdvancedIpcResponse) => void>();
    const bridge: SessionAdvancedBridge = {
      invoke: vi.fn((request: SessionAdvancedIpcRequest) => new Promise<SessionAdvancedIpcResponse>((resolve) => {
        pending.set(`${request.params.sessionId}:${request.method}`, resolve);
      })),
    };
    const view = render(<SessionAdvancedPanel bridge={bridge} sessionId="session-old" />);
    await waitFor(() => expect(pending.has("session-old:sessions.files.list")).toBe(true));
    view.rerender(<SessionAdvancedPanel bridge={bridge} sessionId="session-new" />);
    await waitFor(() => expect(pending.has("session-new:sessions.files.list")).toBe(true));

    pending.get("session-new:sessions.files.list")?.(success({ method: "sessions.files.list", requestId: "new-files", params: { sessionId: "session-new" } }, {
      sessionId: "session-new", files: [{ path: "new.txt", name: "new.txt", kind: "read", missing: false }],
    }));
    pending.get("session-new:sessions.checkpoints.list")?.(success({ method: "sessions.checkpoints.list", requestId: "new-checkpoints", params: { sessionId: "session-new" } }, {
      sessionId: "session-new", checkpoints: [],
    }));
    expect(await screen.findByRole("button", { name: "读取 new.txt" })).toBeVisible();

    pending.get("session-old:sessions.files.list")?.(success({ method: "sessions.files.list", requestId: "old-files", params: { sessionId: "session-old" } }, {
      sessionId: "session-old", files: [{ path: "old.txt", name: "old.txt", kind: "read", missing: false }],
    }));
    pending.get("session-old:sessions.checkpoints.list")?.(success({ method: "sessions.checkpoints.list", requestId: "old-checkpoints", params: { sessionId: "session-old" } }, {
      sessionId: "session-old", checkpoints: [],
    }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "读取 old.txt" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "读取 new.txt" })).toBeVisible();
  });

  it("runs every advanced write and publishes only authoritative service readback", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const bridge = bridgeFixture();
    const onSessionReadback = vi.fn();
    render(<SessionAdvancedPanel bridge={bridge} sessionId="agent:main:main" onSessionReadback={onSessionReadback} />);
    await screen.findByText("cp-1");

    fireEvent.click(screen.getByRole("button", { name: "重置会话" }));
    await screen.findByText(/重置后权威会话/);
    fireEvent.change(screen.getByLabelText("保留最近行数"), { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: "压缩会话" }));
    await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "sessions.compact", params: { sessionId: "agent:main:main", maxLines: 200 } })));
    fireEvent.click(screen.getByRole("button", { name: "从 cp-1 创建分支" }));
    await screen.findByText(/分支权威会话/);
    fireEvent.click(screen.getByRole("button", { name: "恢复到 cp-1" }));
    await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "sessions.restore" })));
    fireEvent.change(screen.getByLabelText("引导消息"), { target: { value: "使用新约束继续" } });
    fireEvent.click(screen.getByRole("button", { name: "发送引导" }));
    await screen.findByText(/引导后权威会话/);

    expect(onSessionReadback).toHaveBeenCalledTimes(5);
    expect(onSessionReadback.mock.calls.map(([value]) => value.title)).toEqual([
      "重置后权威会话", "权威会话", "分支权威会话", "权威会话", "引导后权威会话",
    ]);
  });

  it("shows failures and locks controls while a write is busy", async () => {
    let finishReset!: (response: SessionAdvancedIpcResponse) => void;
    const bridge = bridgeFixture();
    bridge.invoke.mockImplementation(async (request: SessionAdvancedIpcRequest) => {
      if (request.method === "sessions.files.list") return { method: request.method, requestId: request.requestId, ok: false, error: { code: "OFFLINE", message: "Gateway offline", retryable: true, recoveryActions: ["reconnect"] } };
      if (request.method === "sessions.checkpoints.list") return success(request, { sessionId: request.params.sessionId, checkpoints: [] });
      if (request.method === "sessions.reset") return new Promise((resolve) => { finishReset = resolve; });
      throw new Error("unexpected method");
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SessionAdvancedPanel bridge={bridge} sessionId="agent:main:main" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Gateway offline");
    fireEvent.click(screen.getByRole("button", { name: "重置会话" }));
    expect(screen.getByRole("button", { name: "重置会话" })).toBeDisabled();
    finishReset(success({ method: "sessions.reset", requestId: "write", params: { sessionId: "agent:main:main" } }, { operation: "reset", session: session() }));
    await waitFor(() => expect(screen.getByRole("button", { name: "重置会话" })).toBeEnabled());
  });
});
