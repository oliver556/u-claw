import { UClawUnsupportedError } from "@uclaw/adapter";
import type { UClawClient } from "@uclaw/shared";
import type { ArtifactRecord, TaskArtifactAuthority, TaskRecord } from "@uclaw/shared/dist/task-artifacts.js";

import { buildTaskCenterSnapshot } from "../activity/task-snapshot.js";

interface TaskArtifactAuthorityOptions {
  native: TaskArtifactAuthority;
  client: UClawClient;
  nativeAvailable(): boolean;
}

const taskStatus = (state: string): TaskRecord["status"] => state === "waiting-input" ? "waiting-input"
  : state === "succeeded" ? "succeeded"
    : state === "failed" ? "failed"
      : state === "cancelled" ? "cancelled" : "running";

const fallbackTask = (task: Awaited<ReturnType<typeof buildTaskCenterSnapshot>>["activity"]["tasks"][number]): TaskRecord => ({
  id: task.id,
  title: task.title,
  status: taskStatus(task.state),
  sessionId: task.sessionId,
  createdAt: task.updatedAt,
  updatedAt: task.updatedAt,
  ...(task.error === undefined ? {} : { error: task.error }),
});

const fallbackArtifact = (artifact: Awaited<ReturnType<typeof buildTaskCenterSnapshot>>["artifacts"]["artifacts"][number]): ArtifactRecord => ({
  id: artifact.id,
  name: artifact.name,
  mediaType: artifact.mediaType,
  size: artifact.size,
  status: artifact.status,
  sessionId: artifact.sessionId,
  ...(artifact.runId === undefined ? {} : { taskId: `run:${artifact.runId}` }),
  createdAt: artifact.createdAt,
});

export function createTaskArtifactAuthority(options: TaskArtifactAuthorityOptions): TaskArtifactAuthority {
  const unsupported = (method: string): never => { throw new UClawUnsupportedError(method); };
  const snapshot = (sessionId?: string) => buildTaskCenterSnapshot(options.client, undefined, sessionId);
  return {
    listTasks: async () => options.nativeAvailable() ? options.native.listTasks() : (await snapshot()).activity.tasks.map(fallbackTask),
    getTask: async (taskId) => {
      if (options.nativeAvailable()) return options.native.getTask(taskId);
      const task = (await snapshot()).activity.tasks.find((item) => item.id === taskId);
      if (!task) throw new Error("Task not found.");
      return fallbackTask(task);
    },
    cancelTask: async (taskId) => options.nativeAvailable() ? options.native.cancelTask(taskId) : unsupported("tasks.cancel"),
    retryTask: async (taskId) => options.nativeAvailable() ? options.native.retryTask(taskId) : unsupported("tasks.retry"),
    watchTasks: (listener) => options.native.watchTasks(listener),
    listArtifacts: async (sessionId) => options.nativeAvailable() ? options.native.listArtifacts(sessionId) : (await snapshot(sessionId)).artifacts.artifacts.map(fallbackArtifact),
    getArtifact: async (artifactId) => {
      if (options.nativeAvailable()) return options.native.getArtifact(artifactId);
      const artifact = (await snapshot()).artifacts.artifacts.find((item) => item.id === artifactId);
      if (!artifact) throw new Error("Artifact not found.");
      return fallbackArtifact(artifact);
    },
    downloadArtifact: async (artifactId) => options.nativeAvailable() ? options.native.downloadArtifact(artifactId) : unsupported("artifacts.download"),
  };
}
