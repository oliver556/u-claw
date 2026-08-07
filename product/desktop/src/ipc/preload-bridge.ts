import {
  ClientIpcRequestSchema,
  IpcResponseSchema,
  WindowIpcRequestSchema,
  type ClientIpcRequest,
  type IpcResponse,
  type WindowIpcRequest,
} from "@uclaw/shared";

import { CLIENT_IPC_CHANNEL, WINDOW_IPC_CHANNEL } from "./channels.js";

export interface ContextBridgeLike {
  exposeInMainWorld(name: string, api: Record<string, unknown>): void;
}

export interface IpcRendererLike {
  invoke(channel: string, payload: unknown): Promise<unknown>;
}

export interface PreloadDependencies {
  contextBridge: ContextBridgeLike;
  ipcRenderer: IpcRendererLike;
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

export function installPreloadBridge({ contextBridge, ipcRenderer }: PreloadDependencies): void {
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

  contextBridge.exposeInMainWorld("uclaw", Object.freeze({
    window: Object.freeze({ invoke: invokeWindow }),
    client: Object.freeze({ invoke: invokeClient }),
  }));
}
