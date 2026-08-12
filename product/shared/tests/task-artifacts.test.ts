import { describe, expect, it } from "vitest";

import {
  ArtifactIpcRequestSchema,
  ArtifactRecordSchema,
  TaskEventSchema,
  TaskIpcRequestSchema,
  TaskRecordSchema,
} from "../src/task-artifacts.js";

describe("Task and Artifact contracts", () => {
  it("accepts authoritative task states and task events", () => {
    expect(TaskRecordSchema.parse({
      id: "task-1", title: "生成报告", status: "running", sessionId: "session-1",
      createdAt: "2026-08-12T08:00:00.000Z", updatedAt: "2026-08-12T08:01:00.000Z",
    }).status).toBe("running");
    expect(TaskEventSchema.parse({
      type: "updated", task: { id: "task-1", title: "生成报告", status: "succeeded", sessionId: "session-1", createdAt: "2026-08-12T08:00:00.000Z", updatedAt: "2026-08-12T08:02:00.000Z" },
    }).task.status).toBe("succeeded");
  });

  it("keeps filesystem paths out of renderer Artifact records", () => {
    const artifact = { id: "artifact-1", name: "report.md", mediaType: "text/markdown", size: 42, status: "ready", sessionId: "session-1", createdAt: "2026-08-12T08:02:00.000Z" };
    expect(ArtifactRecordSchema.parse(artifact)).toEqual(artifact);
    expect(() => ArtifactRecordSchema.parse({ ...artifact, path: "/private/report.md" })).toThrow();
  });

  it("validates every AUTO-008 through AUTO-014 IPC operation", () => {
    for (const request of [
      { method: "tasks.list", requestId: "1", params: {} },
      { method: "tasks.get", requestId: "2", params: { taskId: "task-1" } },
      { method: "tasks.cancel", requestId: "3", params: { taskId: "task-1" } },
      { method: "tasks.retry", requestId: "4", params: { taskId: "task-1" } },
    ]) expect(TaskIpcRequestSchema.parse(request)).toBeTruthy();
    for (const request of [
      { method: "artifacts.list", requestId: "5", params: {} },
      { method: "artifacts.get", requestId: "6", params: { artifactId: "artifact-1" } },
      { method: "artifacts.download", requestId: "7", params: { artifactId: "artifact-1" } },
      { method: "artifacts.open", requestId: "8", params: { artifactId: "artifact-1" } },
      { method: "artifacts.export", requestId: "9", params: { artifactId: "artifact-1" } },
    ]) expect(ArtifactIpcRequestSchema.parse(request)).toBeTruthy();
  });
});
