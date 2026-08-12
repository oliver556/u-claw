import { UClawErrorSchema } from "@uclaw/shared";
import { SYSTEM_VOICE_IPC_CHANNEL, SystemVoiceIpcRequestSchema } from "@uclaw/shared/dist/system-voice.js";
import type { RegisteredDesktopDomain } from "../main.js";
import { toRendererSafeError } from "../ipc/client-dispatcher.js";

function ipcError(code: "FORBIDDEN" | "INVALID_ARGUMENT", message: string) {
  return UClawErrorSchema.parse({ code, message, retryable: false, recoveryActions: [], causeDetails: {} });
}

export function createSystemVoiceDomainRegistration(dispatch: (request: unknown) => Promise<unknown>, dispose?: () => void | Promise<void>): RegisteredDesktopDomain {
  return { installIpc({ ipcMain, authorizedWebContents }) {
    ipcMain.handle(SYSTEM_VOICE_IPC_CHANNEL, async (event, payload) => {
      const candidate = event as { sender?: unknown; senderFrame?: unknown };
      if (candidate.sender !== authorizedWebContents || candidate.senderFrame !== authorizedWebContents.mainFrame) throw ipcError("FORBIDDEN", "IPC sender is not authorized.");
      const parsed = SystemVoiceIpcRequestSchema.safeParse(payload);
      if (!parsed.success) throw ipcError("INVALID_ARGUMENT", "Invalid Talk, TTS, Voice Wake, or Push request.");
      try { return await dispatch(parsed.data); }
      catch (error) {
        const known = UClawErrorSchema.safeParse(error);
        const permissionDenied = known.success && known.data.code === "FORBIDDEN" && known.data.recoveryActions.includes("open-settings");
        const safeError = permissionDenied
          ? UClawErrorSchema.parse({ ...known.data, message: known.data.message.includes("通知") ? "通知权限被拒绝，请在系统设置中授权后重试。" : "麦克风权限被拒绝，请在系统设置中授权后重试。", causeDetails: {} })
          : toRendererSafeError(error);
        return { method: parsed.data.method, requestId: parsed.data.requestId, ok: false, error: safeError };
      }
    });
    return () => { ipcMain.removeHandler(SYSTEM_VOICE_IPC_CHANNEL); void dispose?.(); };
  } };
}
