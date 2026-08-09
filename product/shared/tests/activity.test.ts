import { describe, expect, it } from "vitest";

import {
  ArtifactSnapshotSchema,
  TaskActivitySnapshotSchema,
} from "../src/activity.js";

describe("task activity contracts", () => {
  it("accepts a versioned OpenClaw-derived task snapshot", () => {
    expect(TaskActivitySnapshotSchema.parse({
      contractVersion: 1,
      generatedAt: "2026-08-09T08:00:00.000Z",
      source: "openclaw",
      tasks: [{
        id: "run:run-1",
        sessionId: "session-1",
        sessionTitle: "发布检查",
        runId: "run-1",
        title: "发布检查",
        state: "waiting-input",
        updatedAt: "2026-08-09T08:00:00.000Z",
        error: { code: "AUTHORIZATION_REQUIRED", message: "Authorization is required.", retryable: true },
      }],
    }).tasks[0]?.state).toBe("waiting-input");
  });

  it.each(["../secret.txt", "/etc/passwd", "C:\\secret.txt", "folder/file.txt", "file:///tmp/a"])(
    "rejects unsafe artifact domain id %s",
    (id) => {
      expect(() => ArtifactSnapshotSchema.parse({
        contractVersion: 1,
        generatedAt: "2026-08-09T08:00:00.000Z",
        source: "openclaw",
        artifacts: [{
          id,
          sessionId: "session-1",
          messageId: "message-1",
          name: "report.md",
          mediaType: "text/markdown",
          size: 12,
          createdAt: "2026-08-09T08:00:00.000Z",
          status: "ready",
        }],
      })).toThrow();
    },
  );

  it("does not allow renderer-visible paths in artifact entries", () => {
    expect(() => ArtifactSnapshotSchema.parse({
      contractVersion: 1,
      generatedAt: "2026-08-09T08:00:00.000Z",
      source: "openclaw",
      artifacts: [{
        id: "artifact-1",
        sessionId: "session-1",
        messageId: "message-1",
        name: "report.md",
        mediaType: "text/markdown",
        size: 12,
        createdAt: "2026-08-09T08:00:00.000Z",
        status: "ready",
        relativePath: "outputs/report.md",
      }],
    })).toThrow();
  });
});
