import type { Message, SessionSummary, UClawClient } from "@uclaw/shared";
import type { TaskArtifactAuthority } from "@uclaw/shared/dist/task-artifacts.js";
import { describe, expect, it, vi } from "vitest";

import { createTaskArtifactAuthority } from "../src/task-artifacts/task-artifact-authority.js";

const timestamp = "2026-08-13T08:00:00.000Z";

function fallbackClient(): UClawClient {
  const session: SessionSummary = { id: "session-1", title: "真实会话任务", status: "running", pinned: false, updatedAt: timestamp };
  const message: Message = { id: "message-1", sessionId: session.id, runId: "run-1", role: "assistant", status: "streaming", createdAt: timestamp, blocks: [] };
  return {
    gateway: { negotiate: vi.fn(), getStatus: vi.fn(), watchStatus: vi.fn(), reconnect: vi.fn() },
    sessions: { list: vi.fn(async () => ({ items: [session], nextCursor: null, hasMore: false })), get: vi.fn(), create: vi.fn(), remove: vi.fn() },
    chat: { list: vi.fn(async () => ({ items: [message], nextCursor: null, hasMore: false })), get: vi.fn(), watch: vi.fn(), send: vi.fn(), abort: vi.fn() },
    tools: { list: vi.fn(), getCall: vi.fn() }, approvals: { listPending: vi.fn(async () => []), resolveExec: vi.fn(), resolvePlugin: vi.fn() },
    models: { list: vi.fn(), selectForSession: vi.fn() }, skills: { list: vi.fn() }, channels: { list: vi.fn() }, files: { list: vi.fn(), readText: vi.fn() }, diagnostics: { list: vi.fn(), listLogs: vi.fn() },
  };
}

function nativeAuthority(): TaskArtifactAuthority {
  return {
    listTasks: vi.fn(async () => [{ id: "native-task", title: "原生任务", status: "running" as const, createdAt: timestamp, updatedAt: timestamp }]),
    getTask: vi.fn(), cancelTask: vi.fn(), retryTask: vi.fn(), watchTasks: vi.fn(() => () => undefined),
    listArtifacts: vi.fn(async () => []), getArtifact: vi.fn(), downloadArtifact: vi.fn(),
  };
}

describe("createTaskArtifactAuthority", () => {
  it("prefers native OpenClaw Task and Artifact RPC", async () => {
    const native = nativeAuthority();
    const authority = createTaskArtifactAuthority({ native, client: fallbackClient(), nativeAvailable: () => true });

    await expect(authority.listTasks()).resolves.toEqual([expect.objectContaining({ id: "native-task" })]);
    expect(native.listTasks).toHaveBeenCalledOnce();
  });

  it("builds read-only task records from the same Gateway when native RPC is unavailable", async () => {
    const native = nativeAuthority();
    const authority = createTaskArtifactAuthority({ native, client: fallbackClient(), nativeAvailable: () => false });

    await expect(authority.listTasks()).resolves.toEqual([expect.objectContaining({ id: "run:run-1", title: "真实会话任务", status: "running" })]);
    await expect(authority.getTask("run:run-1")).resolves.toEqual(expect.objectContaining({ id: "run:run-1" }));
    expect(native.listTasks).not.toHaveBeenCalled();
  });

  it("fails closed for Task and Artifact writes in fallback mode", async () => {
    const authority = createTaskArtifactAuthority({ native: nativeAuthority(), client: fallbackClient(), nativeAvailable: () => false });

    await expect(authority.cancelTask("run:run-1")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(authority.retryTask("run:run-1")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(authority.downloadArtifact("artifact-1")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
});
