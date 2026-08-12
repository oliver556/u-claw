import { describe, expect, it, vi } from "vitest";

import { createOpenClawTaskArtifactService } from "../src/task-artifacts.js";

describe("OpenClaw Task and Artifact service", () => {
  it("uses authoritative RPCs and reads back after cancel and retry", async () => {
    const calls: Array<[string, unknown]> = [];
    const request = vi.fn(async (method: string, params: unknown) => {
      calls.push([method, params]);
      if (method === "tasks.list") return { tasks: [{ id: "task-1", title: "Report", status: "running", sessionId: "session-1", createdAt: "2026-08-12T08:00:00.000Z", updatedAt: "2026-08-12T08:01:00.000Z" }] };
      if (method === "tasks.get") return { task: { id: "task-1", title: "Report", status: calls.some(([name]) => name === "tasks.cancel") ? "cancelled" : "running", sessionId: "session-1", createdAt: "2026-08-12T08:00:00.000Z", updatedAt: "2026-08-12T08:01:00.000Z" } };
      if (method === "artifacts.list") return { artifacts: [{ id: "artifact-1", name: "report.md", mediaType: "text/markdown", size: 42, status: "ready", sessionId: "session-1", createdAt: "2026-08-12T08:02:00.000Z", path: "/secret/report.md" }] };
      if (method === "artifacts.get") return { artifact: { id: "artifact-1", name: "report.md", mediaType: "text/markdown", size: 42, status: "ready", sessionId: "session-1", createdAt: "2026-08-12T08:02:00.000Z", path: "/secret/report.md" } };
      if (method === "artifacts.download") return { name: "report.md", mediaType: "text/markdown", size: 6, dataBase64: "cmVwb3J0", path: "/secret/report.md" };
      return { ok: true };
    });
    const service = createOpenClawTaskArtifactService({ request: request as never, requireMethod: () => undefined });

    expect(await service.listTasks()).toHaveLength(1);
    expect((await service.getTask("task-1")).id).toBe("task-1");
    expect((await service.cancelTask("task-1")).status).toBe("cancelled");
    await service.retryTask("task-1");
    expect(await service.listArtifacts()).toEqual([expect.not.objectContaining({ path: expect.anything() })]);
    expect(await service.getArtifact("artifact-1")).not.toHaveProperty("path");
    expect(await service.downloadArtifact("artifact-1")).toMatchObject({ dataBase64: "cmVwb3J0" });
    expect(calls.map(([method]) => method)).toEqual([
      "tasks.list", "tasks.get", "tasks.cancel", "tasks.get", "tasks.retry", "tasks.get",
      "artifacts.list", "artifacts.get", "artifacts.download",
    ]);
  });

  it("subscribes directly to task events", () => {
    let listener: ((frame: { type: "event"; event: string; payload: never }) => void) | undefined;
    const onEvent = vi.fn((_event: string, next: typeof listener) => { listener = next; return vi.fn(); });
    const service = createOpenClawTaskArtifactService({ request: vi.fn() as never, requireMethod: () => undefined, onEvent });
    const received: unknown[] = [];
    const unsubscribe = service.watchTasks((event) => received.push(event));
    listener?.({ type: "event", event: "task", payload: { type: "updated", task: { id: "task-1", title: "Report", status: "succeeded", sessionId: "session-1", createdAt: "2026-08-12T08:00:00.000Z", updatedAt: "2026-08-12T08:02:00.000Z" } } as never });
    expect(onEvent).toHaveBeenCalledWith("task", expect.any(Function));
    expect(received).toHaveLength(1);
    unsubscribe();
  });
});
