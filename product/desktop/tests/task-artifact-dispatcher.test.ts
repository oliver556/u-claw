import { describe, expect, it, vi } from "vitest";
import { createTaskArtifactDispatcher } from "../src/task-artifacts/task-artifact-dispatcher.js";

describe("Task/Artifact dispatcher", () => {
  it("dispatches authority and persists downloads before open/export", async () => {
    const authority = {
      listTasks: vi.fn(async () => []), getTask: vi.fn(), cancelTask: vi.fn(), retryTask: vi.fn(), watchTasks: vi.fn(), listArtifacts: vi.fn(async () => []), getArtifact: vi.fn(),
      downloadArtifact: vi.fn(async () => ({ artifactId: "artifact-1", name: "report.md", mediaType: "text/markdown", size: 6, dataBase64: "cmVwb3J0" })),
    };
    const files = { persist: vi.fn(async () => ({ artifactId: "artifact-1" })), open: vi.fn(), export: vi.fn() };
    const dispatch = createTaskArtifactDispatcher(authority as never, files as never);
    await dispatch({ method: "artifacts.download", requestId: "1", params: { artifactId: "artifact-1" } });
    await dispatch({ method: "artifacts.open", requestId: "2", params: { artifactId: "artifact-1" } });
    await dispatch({ method: "artifacts.export", requestId: "3", params: { artifactId: "artifact-1" } });
    expect(authority.downloadArtifact).toHaveBeenCalledWith("artifact-1");
    expect(files.persist).toHaveBeenCalledOnce();
    expect(files.open).toHaveBeenCalledWith("artifact-1");
    expect(files.export).toHaveBeenCalledWith("artifact-1");
  });
});
