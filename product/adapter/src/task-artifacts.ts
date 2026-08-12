import { z } from "zod";
import {
  ArtifactDownloadSchema,
  ArtifactRecordSchema,
  TaskEventSchema,
  TaskRecordSchema,
  type ArtifactDownload,
  type ArtifactRecord,
  type TaskArtifactAuthority,
  type TaskEvent,
  type TaskRecord,
} from "@uclaw/shared/dist/task-artifacts.js";
import { RpcProtocolError, type EventFrame, type JsonValue } from "./transport/rpc-router.js";

const AnySchema = z.unknown();
const ObjectSchema = z.record(z.string(), z.unknown());

export interface TaskArtifactRouter {
  request<T>(method: string, params: JsonValue, schema: z.ZodType<T>): Promise<T>;
  onEvent(event: string, listener: (frame: EventFrame) => void): () => void;
}

export interface OpenClawTaskArtifactOptions {
  request?<T>(method: string, params: JsonValue, schema: z.ZodType<T>): Promise<T>;
  onEvent?(event: string, listener: (frame: EventFrame) => void): () => void;
  router?: TaskArtifactRouter;
  requireMethod(method: string): void;
}

function object(value: unknown, method: string): Record<string, unknown> {
  const result = ObjectSchema.safeParse(value);
  if (!result.success) throw new RpcProtocolError(method);
  return result.data;
}

function iso(value: unknown): string {
  if (typeof value === "string") return new Date(value).toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  throw new Error("timestamp missing");
}

function task(value: unknown, method: string): TaskRecord {
  const raw = object(value, method);
  return TaskRecordSchema.parse({
    id: raw.id,
    title: raw.title ?? raw.name ?? raw.id,
    status: raw.status ?? raw.state,
    ...(typeof raw.sessionId === "string" ? { sessionId: raw.sessionId } : typeof raw.sessionKey === "string" ? { sessionId: raw.sessionKey } : {}),
    createdAt: iso(raw.createdAt ?? raw.createdAtMs ?? raw.updatedAt ?? raw.updatedAtMs),
    updatedAt: iso(raw.updatedAt ?? raw.updatedAtMs ?? raw.createdAt ?? raw.createdAtMs),
    ...(typeof raw.progress === "number" ? { progress: raw.progress } : {}),
    ...(raw.error && typeof raw.error === "object" ? { error: raw.error } : {}),
  });
}

function artifact(value: unknown, method: string): ArtifactRecord {
  const raw = object(value, method);
  return ArtifactRecordSchema.parse({
    id: raw.id,
    name: raw.name ?? raw.filename,
    mediaType: raw.mediaType ?? raw.mimeType ?? "application/octet-stream",
    size: raw.size ?? raw.bytes ?? 0,
    status: raw.status ?? "ready",
    ...(typeof raw.sessionId === "string" ? { sessionId: raw.sessionId } : typeof raw.sessionKey === "string" ? { sessionId: raw.sessionKey } : {}),
    ...(typeof raw.taskId === "string" ? { taskId: raw.taskId } : {}),
    createdAt: iso(raw.createdAt ?? raw.createdAtMs ?? raw.updatedAt ?? raw.updatedAtMs),
  });
}

export function createOpenClawTaskArtifactService(options: OpenClawTaskArtifactOptions): TaskArtifactAuthority {
  const request = async (method: string, params: Record<string, unknown>) => {
    options.requireMethod(method);
    return options.request ? options.request(method, params as JsonValue, AnySchema) : options.router!.request(method, params as JsonValue, AnySchema);
  };
  const readTask = async (id: string) => task(object(await request("tasks.get", { taskId: id }), "tasks.get").task, "tasks.get");
  return {
    listTasks: async () => {
      const root = object(await request("tasks.list", {}), "tasks.list");
      return z.array(z.unknown()).parse(root.tasks).map((value) => task(value, "tasks.list"));
    },
    getTask: readTask,
    cancelTask: async (taskId) => { await request("tasks.cancel", { taskId }); return readTask(taskId); },
    retryTask: async (taskId) => { await request("tasks.retry", { taskId }); return readTask(taskId); },
    watchTasks(listener) {
      const onEvent = options.onEvent ?? options.router?.onEvent.bind(options.router);
      if (!onEvent) throw new Error("Task event transport is unavailable.");
      return onEvent("task", (frame) => {
        const raw = object(frame.payload, "task");
        const event: TaskEvent = TaskEventSchema.parse({ type: raw.type ?? "updated", task: task(raw.task ?? raw, "task") });
        listener(event);
      });
    },
    listArtifacts: async (sessionId) => {
      const root = object(await request("artifacts.list", { ...(sessionId ? { sessionId } : {}) }), "artifacts.list");
      return z.array(z.unknown()).parse(root.artifacts).map((value) => artifact(value, "artifacts.list"));
    },
    getArtifact: async (artifactId) => artifact(object(await request("artifacts.get", { artifactId }), "artifacts.get").artifact, "artifacts.get"),
    downloadArtifact: async (artifactId): Promise<ArtifactDownload> => {
      const raw = object(await request("artifacts.download", { artifactId }), "artifacts.download");
      return ArtifactDownloadSchema.parse({ artifactId, name: raw.name ?? raw.filename, mediaType: raw.mediaType ?? raw.mimeType ?? "application/octet-stream", size: raw.size ?? raw.bytes, dataBase64: raw.dataBase64 ?? raw.contentBase64 });
    },
  };
}
