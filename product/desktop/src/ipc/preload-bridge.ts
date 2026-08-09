import {
  AttachmentIpcRequestSchema,
  AttachmentIpcResponseSchema,
  ClientIpcRequestSchema,
  IpcEventSchema,
  IpcResponseSchema,
  ProviderIpcRequestSchema,
  ProviderIpcResponseSchema,
  SkillIpcRequestSchema,
  SkillIpcResponseSchema,
  WindowIpcRequestSchema,
  type ClientIpcRequest,
  type IpcResponse,
  type IpcEvent,
  type WindowIpcRequest,
  type ProviderIpcRequest,
  type SkillIpcRequest,
} from "@uclaw/shared";

import {
  CLIENT_IPC_CHANNEL,
  ATTACHMENT_IPC_CHANNEL,
  CLIENT_IPC_EVENT_CHANNEL,
  WINDOW_MAXIMIZED_EVENT_CHANNEL,
  WINDOW_IPC_CHANNEL,
  PROVIDER_IPC_CHANNEL,
  SKILL_IPC_CHANNEL,
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
  const invokeAttachments = async (payload: unknown) => {
    const request = AttachmentIpcRequestSchema.parse(payload);
    const response = AttachmentIpcResponseSchema.parse(await ipcRenderer.invoke(ATTACHMENT_IPC_CHANNEL, request));
    if (response.method !== request.method || response.requestId !== request.requestId) {
      throw new Error("IPC response does not match its request.");
    }
    return response;
  };
  const invokeProviders = async (payload: unknown) => {
    const parsedRequest = ProviderIpcRequestSchema.safeParse(payload);
    if (!parsedRequest.success) throw new Error("Invalid provider IPC request.");
    const request = parsedRequest.data;
    const parsedResponse = ProviderIpcResponseSchema.safeParse(await ipcRenderer.invoke(PROVIDER_IPC_CHANNEL, request));
    if (!parsedResponse.success) throw new Error("Invalid provider IPC response.");
    const response = parsedResponse.data;
    if (response.method !== request.method || response.requestId !== request.requestId) {
      throw new Error("IPC response does not match its request.");
    }
    return response;
  };
  const invokeSkills = async (payload: unknown) => {
    const request = SkillIpcRequestSchema.parse(payload);
    const response = SkillIpcResponseSchema.parse(await ipcRenderer.invoke(SKILL_IPC_CHANNEL, request));
    if (response.method !== request.method || response.requestId !== request.requestId) {
      throw new Error("IPC response does not match its request.");
    }
    return response;
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
  const onMaximizedChange = (listener: (maximized: boolean) => void): (() => void) => {
    const receive = (_event: unknown, payload: unknown): void => {
      if (typeof payload !== "boolean") {
        reportInvalidEvent(new Error("Invalid window maximized event."));
        return;
      }
      listener(payload);
    };
    ipcRenderer.on(WINDOW_MAXIMIZED_EVENT_CHANNEL, receive);
    return () => ipcRenderer.removeListener(WINDOW_MAXIMIZED_EVENT_CHANNEL, receive);
  };

  contextBridge.exposeInMainWorld("uclaw", Object.freeze({
    window: Object.freeze({ invoke: invokeWindow, onMaximizedChange }),
    client: Object.freeze({ invoke: invokeClient, subscribe }),
    attachments: Object.freeze({ invoke: invokeAttachments }),
    providers: Object.freeze({ invoke: invokeProviders as (request: ProviderIpcRequest) => Promise<unknown> }),
    skills: Object.freeze({ invoke: invokeSkills as (request: SkillIpcRequest) => Promise<unknown> }),
  }));
}
