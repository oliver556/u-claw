import type { AuthorizedWebContents, IpcMainLike } from "../ipc/register-ipc.js";
import type { ActivationCoordinator } from "./coordinator.js";
import { z } from "zod";

export const ACTIVATION_IPC_CHANNELS = ["activation.preflight", "activation.submit", "activation.commit", "activation.cancel", "window.close"] as const;
const SubmitSchema = z.object({
  activationCode: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
}).strict();

const safeFailure = (code: "INVALID_INPUT" | "ACTIVATION_FAILED") => ({ state: "error" as const, code });

export function registerActivationIpc(options: { ipcMain: IpcMainLike; authorizedWebContents: AuthorizedWebContents; coordinator: ActivationCoordinator; closeWindow?: () => void }) {
  const handlers = {
    "activation.preflight": () => options.coordinator.preflight(),
    "activation.submit": async (payload: unknown) => {
      const parsed = SubmitSchema.safeParse(payload);
      if (!parsed.success) return safeFailure("INVALID_INPUT");
      try { return await options.coordinator.submit(parsed.data); }
      catch { return safeFailure("ACTIVATION_FAILED"); }
    },
    "activation.commit": () => options.coordinator.status(),
    "activation.cancel": () => options.coordinator.cancel(),
    "window.close": () => {
      const result = options.coordinator.close();
      options.closeWindow?.();
      return result;
    },
  };
  const registered: Array<(typeof ACTIVATION_IPC_CHANNELS)[number]> = [];
  try {
    for (const channel of ACTIVATION_IPC_CHANNELS) {
      options.ipcMain.handle(channel, async (event, payload) => {
        const candidate = event as { sender?: unknown; senderFrame?: unknown };
        if (candidate.sender !== options.authorizedWebContents || candidate.senderFrame !== options.authorizedWebContents.mainFrame) throw new Error("Unauthorized activation IPC sender.");
        try { return await handlers[channel](payload); }
        catch { return safeFailure("ACTIVATION_FAILED"); }
      });
      registered.push(channel);
    }
  } catch (registrationError) {
    const cleanupErrors: unknown[] = [];
    for (const channel of registered.reverse()) {
      try { options.ipcMain.removeHandler(channel); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length > 0) throw new AggregateError([registrationError, ...cleanupErrors], "Activation IPC registration and rollback failed.");
    throw registrationError;
  }
  let active = true;
  return { capabilities: ACTIVATION_IPC_CHANNELS, dispose() { if (!active) return; active = false; for (const channel of ACTIVATION_IPC_CHANNELS) options.ipcMain.removeHandler(channel); } };
}
