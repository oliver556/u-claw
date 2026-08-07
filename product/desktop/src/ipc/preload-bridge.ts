import {
  ClientIpcRequestSchema,
  IpcEventSchema,
  IpcResponseSchema,
  WindowIpcRequestSchema,
  type ClientIpcRequest,
  type IpcResponse,
  type IpcEvent,
  type WindowIpcRequest,
} from "@uclaw/shared";

import {
  CLIENT_IPC_CHANNEL,
  CLIENT_IPC_EVENT_CHANNEL,
  WINDOW_IPC_CHANNEL,
} from "./channels.js";

export interface ContextBridgeLike {
  exposeInMainWorld(name: string, api: Record<string, unknown>): void;
}

export interface IpcRendererLike {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}

export interface PreloadDependencies {
  contextBridge: ContextBridgeLike;
  ipcRenderer: IpcRendererLike;
  reportInvalidEvent?(error: Error): void;
}

function validateCorrelatedResponse(
  response: unknown,
  request: WindowIpcRequest | ClientIpcRequest,
): IpcResponse {
  const parsed = IpcResponseSchema.parse(response);
  if (parsed.method !== request.method || parsed.requestId !== request.requestId) {
    throw new Error("IPC response does not match its request.");
  }
  return parsed;
}

export function installPreloadBridge({
  contextBridge,
  ipcRenderer,
  reportInvalidEvent = () => undefined,
}: PreloadDependencies): void {
  const invokeWindow = async (payload: unknown): Promise<IpcResponse> => {
    const request = WindowIpcRequestSchema.parse(payload);
    const response = await ipcRenderer.invoke(WINDOW_IPC_CHANNEL, request);
    return validateCorrelatedResponse(response, request);
  };
  const invokeClient = async (payload: unknown): Promise<IpcResponse> => {
    const request = ClientIpcRequestSchema.parse(payload);
    const response = await ipcRenderer.invoke(CLIENT_IPC_CHANNEL, request);
    return validateCorrelatedResponse(response, request);
  };
  const subscribe = (listener: (event: IpcEvent) => void): (() => void) => {
    const receive = (_event: unknown, payload: unknown): void => {
      const parsed = IpcEventSchema.safeParse(payload);
      if (!parsed.success) {
        reportInvalidEvent(new Error("Invalid client IPC event."));
        return;
      }
      listener(parsed.data);
    };
    ipcRenderer.on(CLIENT_IPC_EVENT_CHANNEL, receive);
    return () => ipcRenderer.removeListener(CLIENT_IPC_EVENT_CHANNEL, receive);
  };

  contextBridge.exposeInMainWorld("uclaw", Object.freeze({
    window: Object.freeze({ invoke: invokeWindow }),
    client: Object.freeze({ invoke: invokeClient, subscribe }),
  }));
}
