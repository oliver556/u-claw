import { TaskArtifactIpcRequestSchema, type TaskArtifactAuthority } from "@uclaw/shared/dist/task-artifacts.js";
import type { TaskArtifactFileService } from "./task-artifact-files.js";

export function createTaskArtifactDispatcher(authority: TaskArtifactAuthority, files: TaskArtifactFileService) {
  return async (payload: unknown) => {
    const request = TaskArtifactIpcRequestSchema.parse(payload);
    const p = request.params as { taskId?: string; artifactId?: string; sessionId?: string };
    let result: unknown;
    switch (request.method) {
      case "tasks.list": result = await authority.listTasks(); break;
      case "tasks.get": result = await authority.getTask(p.taskId!); break;
      case "tasks.cancel": result = await authority.cancelTask(p.taskId!); break;
      case "tasks.retry": result = await authority.retryTask(p.taskId!); break;
      case "artifacts.list": result = await authority.listArtifacts(p.sessionId); break;
      case "artifacts.get": result = await authority.getArtifact(p.artifactId!); break;
      case "artifacts.download": result = await files.persist(await authority.downloadArtifact(p.artifactId!)); break;
      case "artifacts.open": await files.open(p.artifactId!); result = null; break;
      case "artifacts.export": await files.export(p.artifactId!); result = null; break;
    }
    return { method: request.method, requestId: request.requestId, ok: true as const, result };
  };
}
