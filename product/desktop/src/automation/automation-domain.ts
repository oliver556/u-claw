import { AUTOMATION_IPC_CHANNEL, AutomationIpcRequestSchema, UClawErrorSchema } from "@uclaw/shared";
import type { RegisteredDesktopDomain } from "../main.js";
import { toRendererSafeError } from "../ipc/client-dispatcher.js";

function ipcError(code: "FORBIDDEN" | "INVALID_ARGUMENT", message: string) {
  return UClawErrorSchema.parse({ code, message, retryable: false, recoveryActions: [], causeDetails: {} });
}

export function createAutomationDomainRegistration(dispatch: (request: unknown) => Promise<unknown>): RegisteredDesktopDomain {
  return { installIpc({ ipcMain, authorizedWebContents }) {
    ipcMain.handle(AUTOMATION_IPC_CHANNEL, async (event, payload) => {
      const candidate = event as { sender?: unknown; senderFrame?: unknown };
      if (candidate.sender !== authorizedWebContents || candidate.senderFrame !== authorizedWebContents.mainFrame) throw ipcError("FORBIDDEN", "IPC sender is not authorized.");
      const parsed = AutomationIpcRequestSchema.safeParse(payload);
      if (!parsed.success) throw ipcError("INVALID_ARGUMENT", "Invalid Agent/Cron IPC request.");
      try { return await dispatch(parsed.data); }
      catch (error) { return { method: parsed.data.method, requestId: parsed.data.requestId, ok: false, error: toRendererSafeError(error) }; }
    });
    return () => ipcMain.removeHandler(AUTOMATION_IPC_CHANNEL);
  } };
}
