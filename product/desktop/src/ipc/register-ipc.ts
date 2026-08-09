import {
  AttachmentIpcRequestSchema,
  AttachmentIpcResponseSchema,
  ClientIpcRequestSchema,
  IpcResponseSchema,
  ProviderIpcRequestSchema,
  ProviderIpcResponseSchema,
  UClawErrorSchema,
  WindowIpcRequestSchema,
  redactRendererText,
  type ClientIpcRequest,
  type IpcResponse,
  type UClawError,
  type UClawClient,
  type AttachmentImportInput,
  type AttachmentService,
} from "@uclaw/shared";

import { createClientDispatcher, toRendererSafeError, toRendererSafeResponse } from "./client-dispatcher.js";
import type { SessionOrganizerStore } from "../session-organizer/store.js";
import { createProviderDispatcher } from "../providers/provider-dispatcher.js";
import type { ProviderStore } from "../providers/provider-store.js";
import { createProviderNetworkService, type ProviderNetworkService } from "../providers/provider-network.js";
import { ATTACHMENT_IPC_CHANNEL, CLIENT_IPC_CHANNEL, CLIENT_IPC_EVENT_CHANNEL, PROVIDER_IPC_CHANNEL, WINDOW_IPC_CHANNEL } from "./channels.js";

export interface IpcMainLike {
  handle(channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>): void;
  removeHandler(channel: string): void;
}

export interface AuthorizedWebContents {
  mainFrame: unknown;
  send?(channel: string, payload: unknown): void;
}

export interface WindowControls {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  openAdvancedConsole?(): void | Promise<void>;
}

export interface RegisterIpcDependencies {
  ipcMain: IpcMainLike;
  authorizedWebContents: AuthorizedWebContents;
  windowControls: WindowControls;
  dispatchClient(request: ClientIpcRequest): Promise<unknown>;
  client?: UClawClient;
  organizer?: SessionOrganizerStore;
  attachments?: AttachmentService;
  selectAttachments?(): Promise<AttachmentImportInput[]>;
  providers?: ProviderStore;
  providerNetwork?: ProviderNetworkService;
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
  return toRendererSafeResponse(parsed);
}

export function registerIpc({
  ipcMain,
  authorizedWebContents,
  windowControls,
  dispatchClient,
  client,
  organizer,
  attachments,
  selectAttachments,
  providers,
  providerNetwork,
}: RegisterIpcDependencies): () => void {
  const clientDispatcher = client === undefined ? undefined : createClientDispatcher({
    client,
    organizer,
    sendEvent: (event) => authorizedWebContents.send?.(CLIENT_IPC_EVENT_CHANNEL, event),
  });
  const dispatch = clientDispatcher ?? dispatchClient;
  const providerDispatcher = providers === undefined
    ? undefined
    : createProviderDispatcher(providers, providerNetwork ?? createProviderNetworkService());
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
      if (request.method === "open-advanced-console") {
        if (!windowControls.openAdvancedConsole) throw safeError("UNAVAILABLE", "Advanced console is unavailable.");
        await windowControls.openAdvancedConsole();
      }
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
          ? toRendererSafeError(known.data)
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
      response = await dispatch(parsed.data);
    } catch (error) {
      const known = UClawErrorSchema.safeParse(error);
      return IpcResponseSchema.parse({
        method: parsed.data.method,
        requestId: parsed.data.requestId,
        ok: false,
        error: known.success
          ? toRendererSafeError(known.data)
          : safeError("UNKNOWN", "Client operation failed."),
      });
    }

    try {
      return ensureCorrelatedResponse(response, parsed.data);
    } catch {
      throw safeError("UNKNOWN", "Invalid client IPC response.");
    }
  });

  if (attachments !== undefined) ipcMain.handle(ATTACHMENT_IPC_CHANNEL, async (event, payload) => {
    authorize(event);
    const parsed = AttachmentIpcRequestSchema.safeParse(payload);
    if (!parsed.success) throw safeError("INVALID_ARGUMENT", "Invalid attachment IPC request.");
    const request = parsed.data;
    try {
      let result: unknown = null;
      if (request.method === "select") {
        if (selectAttachments === undefined) throw safeError("UNAVAILABLE", "Attachment selection is unavailable.");
        const selected = await selectAttachments();
        result = await Promise.all(selected.map((input) => attachments.import(input)));
      }
      if (request.method === "import") result = await attachments.import(request.params);
      if (request.method === "get") result = await attachments.get(request.params.attachmentId);
      if (request.method === "prepare") {
        const states = [];
        for await (const attachment of attachments.prepare(request.params.attachmentId)) states.push(attachment);
        result = states;
      }
      if (request.method === "cancel") await attachments.cancel(request.params.attachmentId);
      if (request.method === "remove") await attachments.remove(request.params.attachmentId);
      return AttachmentIpcResponseSchema.parse({ method: request.method, requestId: request.requestId, ok: true, result });
    } catch (error) {
      return AttachmentIpcResponseSchema.parse({
        method: request.method, requestId: request.requestId, ok: false,
        error: toRendererSafeError(error),
      });
    }
  });

  if (providerDispatcher !== undefined) ipcMain.handle(PROVIDER_IPC_CHANNEL, async (event, payload) => {
    authorize(event);
    const parsed = ProviderIpcRequestSchema.safeParse(payload);
    if (!parsed.success) throw safeError("INVALID_ARGUMENT", "Invalid provider IPC request.");
    try {
      return ProviderIpcResponseSchema.parse(await providerDispatcher(parsed.data));
    } catch (error) {
      return ProviderIpcResponseSchema.parse({
        method: parsed.data.method,
        requestId: parsed.data.requestId,
        ok: false,
        error: toRendererSafeError(error),
      });
    }
  });

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    clientDispatcher?.dispose();
    ipcMain.removeHandler(WINDOW_IPC_CHANNEL);
    ipcMain.removeHandler(CLIENT_IPC_CHANNEL);
    if (attachments !== undefined) ipcMain.removeHandler(ATTACHMENT_IPC_CHANNEL);
    if (providers !== undefined) ipcMain.removeHandler(PROVIDER_IPC_CHANNEL);
  };
}
