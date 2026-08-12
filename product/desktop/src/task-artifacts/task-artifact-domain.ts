import {
  TASK_ARTIFACT_EVENT_CHANNEL,
  TASK_ARTIFACT_IPC_CHANNEL,
  TaskArtifactIpcEventSchema,
  TaskArtifactIpcRequestSchema,
  type TaskArtifactAuthority,
} from "@uclaw/shared/dist/task-artifacts.js";
import { UClawErrorSchema } from "@uclaw/shared/dist/errors.js";
import type { RegisteredDesktopDomain } from "../main.js";
import { toRendererSafeError } from "../ipc/client-dispatcher.js";

const ipcError = (code: "FORBIDDEN" | "INVALID_ARGUMENT", message: string) => UClawErrorSchema.parse({ code, message, retryable: false, recoveryActions: [], causeDetails: {} });

export function createTaskArtifactDomainRegistration(authority: TaskArtifactAuthority, dispatch: (request: unknown) => Promise<unknown>): RegisteredDesktopDomain {
  return { installIpc({ ipcMain, authorizedWebContents }) {
    if (!authorizedWebContents.send) throw new Error("Authorized renderer does not support Task events.");
    const send = authorizedWebContents.send.bind(authorizedWebContents);
    const stopEvents = authority.watchTasks((payload) => {
      send(TASK_ARTIFACT_EVENT_CHANNEL, TaskArtifactIpcEventSchema.parse({ event: "task", payload }));
    });
    ipcMain.handle(TASK_ARTIFACT_IPC_CHANNEL, async (event, payload) => {
      const candidate = event as { sender?: unknown; senderFrame?: unknown };
      if (candidate.sender !== authorizedWebContents || candidate.senderFrame !== authorizedWebContents.mainFrame) throw ipcError("FORBIDDEN", "IPC sender is not authorized.");
      const parsed = TaskArtifactIpcRequestSchema.safeParse(payload);
      if (!parsed.success) throw ipcError("INVALID_ARGUMENT", "Invalid Task/Artifact IPC request.");
      try { return await dispatch(parsed.data); }
      catch (error) { return { method: parsed.data.method, requestId: parsed.data.requestId, ok: false, error: toRendererSafeError(error) }; }
    });
    return () => { stopEvents(); ipcMain.removeHandler(TASK_ARTIFACT_IPC_CHANNEL); };
  } };
}
