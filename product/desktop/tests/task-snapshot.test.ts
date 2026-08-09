import type { Message, SessionSummary, UClawClient } from "@uclaw/shared";
import { describe, expect, it, vi } from "vitest";

import { buildTaskCenterSnapshot } from "../src/activity/task-snapshot.js";

const now = "2026-08-09T08:00:00.000Z";

function session(id: string, title: string, status: SessionSummary["status"]): SessionSummary {
  return { id, title, status, pinned: false, updatedAt: now };
}

function message(sessionId: string, id: string, runId: string, status: Message["status"], artifact = false): Message {
  return {
    id, sessionId, runId, status, role: "assistant", createdAt: now,
    blocks: artifact ? [{
      id: `block-${id}`,
      type: "file",
      file: { id: `artifact-${id}`, name: `${id}.md`, mediaType: "text/markdown", size: 42, kind: "artifact", relativePath: `outputs/${id}.md` },
    }] : [],
  };
}

function clientFixture(): UClawClient {
  const sessions = [
    session("running-session", "运行任务", "running"),
    session("waiting-session", "等待任务", "waiting-authorization"),
    session("done-session", "完成任务", "idle"),
    session("failed-session", "失败任务", "failed"),
    session("cancelled-session", "取消任务", "idle"),
  ];
  const messages: Record<string, Message[]> = {
    "running-session": [message("running-session", "running-message", "run-running", "streaming")],
    "waiting-session": [message("waiting-session", "waiting-message", "run-waiting", "streaming")],
    "done-session": [message("done-session", "done-message", "run-done", "completed", true)],
    "failed-session": [{ ...message("failed-session", "failed-message", "run-failed", "failed"), error: { code: "OPERATION_FAILED", message: "raw secret path /tmp/no", retryable: true } }],
    "cancelled-session": [message("cancelled-session", "cancelled-message", "run-cancelled", "cancelled")],
  };
  return {
    gateway: { negotiate: vi.fn(), getStatus: vi.fn(), watchStatus: vi.fn(), reconnect: vi.fn() },
    sessions: { list: vi.fn(async () => ({ items: sessions, nextCursor: null, hasMore: false })), get: vi.fn(), create: vi.fn(), remove: vi.fn() },
    chat: { list: vi.fn(async (id: string) => ({ items: messages[id] ?? [], nextCursor: null, hasMore: false })), get: vi.fn(), watch: vi.fn(), send: vi.fn(), abort: vi.fn() },
    tools: { list: vi.fn(), getCall: vi.fn() },
    approvals: { listPending: vi.fn(async () => [{
      id: "approval-1", family: "exec" as const, sessionId: "waiting-session", toolCallId: "tool-1",
      subject: { kind: "operation" as const, id: "operation-1" }, title: "Approval", description: "Approve operation",
      risk: "high" as const, permissions: [{ kind: "process" as const, scope: "managed", description: "Run" }],
      choices: ["allow-once" as const, "deny" as const], status: "pending" as const,
    }]), resolveExec: vi.fn(), resolvePlugin: vi.fn() },
    models: { list: vi.fn(), selectForSession: vi.fn() }, skills: { list: vi.fn() }, channels: { list: vi.fn() },
    files: { list: vi.fn(), readText: vi.fn() }, diagnostics: { list: vi.fn(), listLogs: vi.fn() },
  };
}

describe("buildTaskCenterSnapshot", () => {
  it("rebuilds all real task states and controlled artifacts from OpenClaw facts", async () => {
    const result = await buildTaskCenterSnapshot(clientFixture(), () => now);

    expect(Object.fromEntries(result.activity.tasks.map((task) => [task.runId, task.state]))).toEqual({
      "run-running": "running",
      "run-waiting": "waiting-input",
      "run-done": "succeeded",
      "run-failed": "failed",
      "run-cancelled": "cancelled",
    });
    expect(result.activity.tasks.find((task) => task.runId === "run-failed")?.error).toEqual({
      code: "OPERATION_FAILED", message: "Task failed.", retryable: true,
    });
    expect(result.artifacts.artifacts).toEqual([expect.objectContaining({
      id: "artifact-done-message", sessionId: "done-session", messageId: "done-message", status: "ready",
    })]);
    expect(JSON.stringify(result.artifacts)).not.toContain("relativePath");
    expect(JSON.stringify(result.artifacts)).not.toContain("outputs/");
  });

  it("filters artifacts by controlled session id", async () => {
    const result = await buildTaskCenterSnapshot(clientFixture(), () => now, "done-session");
    expect(result.artifacts.artifacts).toHaveLength(1);

    await expect(buildTaskCenterSnapshot(clientFixture(), () => now, "../escape")).rejects.toThrow();
  });

  it("still rebuilds task state when approval capability is unavailable", async () => {
    const client = clientFixture();
    client.approvals.listPending = vi.fn(async () => { throw new Error("unsupported"); });

    const result = await buildTaskCenterSnapshot(client, () => now);

    expect(result.activity.tasks.some((task) => task.runId === "run-running" && task.state === "running")).toBe(true);
  });
});
