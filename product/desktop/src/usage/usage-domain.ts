import { UClawErrorSchema } from "@uclaw/shared";
import { z } from "zod";

import { toRendererSafeError } from "../ipc/client-dispatcher.js";
import { USAGE_IPC_CHANNEL } from "../ipc/channels.js";
import type { RegisteredDesktopDomain } from "../main.js";

export { USAGE_IPC_CHANNEL } from "../ipc/channels.js";

const identifier = z.string().trim().min(1).max(512);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const range = z.object({ startDate: date, endDate: date }).strict()
  .refine(({ startDate, endDate }) => startDate <= endDate, { path: ["endDate"] });
const requestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("usage.snapshot"), requestId: identifier, params: range }).strict(),
  z.object({ method: z.literal("usage.session-timeseries"), requestId: identifier, params: z.object({ sessionKey: identifier }).strict() }).strict(),
  z.object({ method: z.literal("usage.session-logs"), requestId: identifier, params: z.object({ sessionKey: identifier }).strict() }).strict(),
]);
type Request = z.infer<typeof requestSchema>;

function ipcError(code: "FORBIDDEN" | "INVALID_ARGUMENT", message: string) {
  return UClawErrorSchema.parse({ code, message, retryable: false, recoveryActions: [], causeDetails: {} });
}

export function createUsageDomainRegistration(dispatch: (request: Request) => Promise<unknown>): RegisteredDesktopDomain {
  return {
    installIpc({ ipcMain, authorizedWebContents }) {
      ipcMain.handle(USAGE_IPC_CHANNEL, async (event, payload) => {
        const candidate = event as { sender?: unknown; senderFrame?: unknown };
        if (candidate.sender !== authorizedWebContents || candidate.senderFrame !== authorizedWebContents.mainFrame) {
          throw ipcError("FORBIDDEN", "IPC sender is not authorized.");
        }
        const parsed = requestSchema.safeParse(payload);
        if (!parsed.success) throw ipcError("INVALID_ARGUMENT", "Invalid usage IPC request.");
        try {
          return await dispatch(parsed.data);
        } catch (error) {
          return {
            method: parsed.data.method,
            requestId: parsed.data.requestId,
            ok: false,
            error: toRendererSafeError(error),
          };
        }
      });
      return () => ipcMain.removeHandler(USAGE_IPC_CHANNEL);
    },
  };
}
