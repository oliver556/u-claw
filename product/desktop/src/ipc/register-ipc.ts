import {
  ClientIpcRequestSchema,
  IpcResponseSchema,
  UClawErrorSchema,
  WindowIpcRequestSchema,
  redactRendererText,
  type ClientIpcRequest,
  type IpcResponse,
  type UClawError,
} from "@uclaw/shared";

import { CLIENT_IPC_CHANNEL, WINDOW_IPC_CHANNEL } from "./channels.js";

export interface IpcMainLike {
  handle(channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>): void;
  removeHandler(channel: string): void;
}

export interface AuthorizedWebContents {
  mainFrame: unknown;
}

export interface WindowControls {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
}

export interface RegisterIpcDependencies {
  ipcMain: IpcMainLike;
  authorizedWebContents: AuthorizedWebContents;
  windowControls: WindowControls;
  dispatchClient(request: ClientIpcRequest): Promise<unknown>;
}

function safeError(
  code: UClawError["code"],
  message: string,
  retryable = false,
): UClawError {
  return UClawErrorSchema.parse({
    code,
    message: redactRendererText(message),
    retryable,
    recoveryActions: [],
    causeDetails: {},
  });
}

function ensureCorrelatedResponse(response: unknown, request: ClientIpcRequest): IpcResponse {
  const parsed = IpcResponseSchema.parse(response);
  if (parsed.method !== request.method || parsed.requestId !== request.requestId) {
    throw new Error("Client response correlation failed.");
  }
  if (WindowIpcRequestSchema.safeParse({
    method: parsed.method,
    requestId: parsed.requestId,
    params: {},
  }).success) {
    throw new Error("Client dispatcher returned a window response.");
  }
  return parsed;
}

export function registerIpc({
  ipcMain,
  authorizedWebContents,
  windowControls,
  dispatchClient,
}: RegisterIpcDependencies): () => void {
  const authorize = (event: unknown): void => {
    const candidate = event as { sender?: unknown; senderFrame?: unknown };
    if (
      candidate.sender !== authorizedWebContents ||
      candidate.senderFrame !== authorizedWebContents.mainFrame
    ) {
      throw safeError("FORBIDDEN", "IPC sender is not authorized.");
    }
  };

  ipcMain.handle(WINDOW_IPC_CHANNEL, async (event, payload) => {
    authorize(event);
    const parsed = WindowIpcRequestSchema.safeParse(payload);
    if (!parsed.success) throw safeError("INVALID_ARGUMENT", "Invalid window IPC request.");

    const request = parsed.data;
    try {
      if (request.method === "minimize") windowControls.minimize();
      if (request.method === "toggle-maximize") windowControls.toggleMaximize();
      if (request.method === "close") windowControls.close();
      return IpcResponseSchema.parse({
        method: request.method,
        requestId: request.requestId,
        ok: true,
        result: null,
      });
    } catch (error) {
      const known = UClawErrorSchema.safeParse(error);
      return IpcResponseSchema.parse({
        method: request.method,
        requestId: request.requestId,
        ok: false,
        error: known.success
          ? known.data
          : safeError("OPERATION_FAILED", "Window operation failed."),
      });
    }
  });

  ipcMain.handle(CLIENT_IPC_CHANNEL, async (event, payload) => {
    authorize(event);
    const parsed = ClientIpcRequestSchema.safeParse(payload);
    if (!parsed.success) throw safeError("INVALID_ARGUMENT", "Invalid client IPC request.");

    let response: unknown;
    try {
      response = await dispatchClient(parsed.data);
    } catch (error) {
      const known = UClawErrorSchema.safeParse(error);
      return IpcResponseSchema.parse({
        method: parsed.data.method,
        requestId: parsed.data.requestId,
        ok: false,
        error: known.success
          ? known.data
          : safeError("UNKNOWN", "Client operation failed."),
      });
    }

    try {
      return ensureCorrelatedResponse(response, parsed.data);
    } catch {
      throw safeError("UNKNOWN", "Invalid client IPC response.");
    }
  });

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    ipcMain.removeHandler(WINDOW_IPC_CHANNEL);
    ipcMain.removeHandler(CLIENT_IPC_CHANNEL);
  };
}
