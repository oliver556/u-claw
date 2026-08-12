import { UClawErrorSchema } from "@uclaw/shared";
import { SYSTEM_NODE_IPC_CHANNEL, SYSTEM_NODE_IPC_EVENT_CHANNEL, SystemNodeIpcEventSchema, SystemNodeIpcRequestSchema, type SystemNodeService } from "@uclaw/shared/dist/system-node.js";
import type { RegisteredDesktopDomain } from "../main.js";
import { toRendererSafeError } from "../ipc/client-dispatcher.js";

function ipcError(code: "FORBIDDEN" | "INVALID_ARGUMENT", message: string) {
  return UClawErrorSchema.parse({ code, message, retryable: false, recoveryActions: [], causeDetails: {} });
}

export function createSystemNodeDomainRegistration(dispatch: (request: unknown) => Promise<unknown>, service: SystemNodeService): RegisteredDesktopDomain {
  return { installIpc({ ipcMain, authorizedWebContents }) {
    ipcMain.handle(SYSTEM_NODE_IPC_CHANNEL, async (event, payload) => {
      const candidate = event as { sender?: unknown; senderFrame?: unknown };
      if (candidate.sender !== authorizedWebContents || candidate.senderFrame !== authorizedWebContents.mainFrame) throw ipcError("FORBIDDEN", "IPC sender is not authorized.");
      const parsed = SystemNodeIpcRequestSchema.safeParse(payload);
      if (!parsed.success) throw ipcError("INVALID_ARGUMENT", "Invalid device, Node, worktree, or Terminal request.");
      try { return await dispatch(parsed.data); }
      catch (error) { return { method: parsed.data.method, requestId: parsed.data.requestId, ok: false, error: toRendererSafeError(error) }; }
    });
    const unsubscribe = service.subscribe((event) => {
      const parsed = SystemNodeIpcEventSchema.safeParse(event);
      if (parsed.success) (authorizedWebContents as unknown as { send?: (channel: string, payload: unknown) => void }).send?.(SYSTEM_NODE_IPC_EVENT_CHANNEL, parsed.data);
    });
    return () => { unsubscribe(); ipcMain.removeHandler(SYSTEM_NODE_IPC_CHANNEL); };
  } };
}
