import {
  AttachmentIpcRequestSchema,
  AttachmentIpcResponseSchema,
  ChatQueueIpcRequestSchema,
  ChatQueueIpcResponseSchema,
  ClientIpcRequestSchema,
  ClientIpcResponseSchema,
  IpcResponseSchema,
  ProviderIpcRequestSchema,
  ProviderIpcResponseSchema,
  SkillIpcRequestSchema,
  SkillIpcResponseSchema,
  PluginIpcRequestSchema,
  PluginIpcResponseSchema,
  ChannelIpcRequestSchema,
  ChannelIpcResponseSchema,
  McpIpcRequestSchema,
  McpIpcResponseSchema,
  DataIpcRequestSchema,
  DataIpcResponseSchema,
  DiagnosticsIpcRequestSchema,
  DiagnosticsIpcResponseSchema,
  ReleaseIpcRequestSchema,
  ReleaseIpcResponseSchema,
  SessionAdvancedIpcRequestSchema,
  SessionAdvancedIpcResponseSchema,
  ImageOperationIpcRequestSchema,
  ImageOperationIpcResponseSchema,
  UClawErrorSchema,
  WindowIpcRequestSchema,
  redactRendererText,
  type ClientIpcRequest,
  type ClientIpcResponse,
  type UClawError,
  type UClawClient,
  type AttachmentImportInput,
  type AttachmentService,
  type DataIpcRequest,
  type DiagnosticsIpcRequest,
  type ReleaseIpcRequest,
  type MessageEvent,
  type SendMessageInput,
  type SessionAdvancedService,
  type ImageOperationIpcRequest,
} from "@uclaw/shared";

import { createClientDispatcher, toRendererSafeError, toRendererSafeResponse } from "./client-dispatcher.js";
import type { SessionOrganizerStore } from "../session-organizer/store.js";
import type { ChatQueueStore } from "../chat-queue/store.js";
import type { ChatQueueDispatcher } from "../chat-queue/dispatcher.js";
import { createProviderDispatcher } from "../providers/provider-dispatcher.js";
import type { ProviderStore } from "../providers/provider-store.js";
import { createSkillDispatcher } from "../skills/skill-dispatcher.js";
import type { SkillService } from "../skills/skill-service.js";
import type { SkillInstallCoordinator } from "../skills/skill-install-coordinator.js";
import { createPluginDispatcher } from "../plugins/plugin-dispatcher.js";
import type { PluginService } from "../plugins/plugin-service.js";
import { createProviderNetworkService, type ProviderNetworkService } from "../providers/provider-network.js";
import type { OpenClawProviderConfigBackend } from "../providers/openclaw-provider-config.js";
import { createChannelDispatcher, type ChannelRuntime } from "../channels/channel-dispatcher.js";
import type { ChannelStore } from "../channels/channel-store.js";
import { createMcpDispatcher, type McpRuntime } from "../mcp/mcp-dispatcher.js";
import type { McpStore } from "../mcp/mcp-store.js";
import type { OpenClawCapabilityRuntime } from "../capabilities/openclaw-capability-runtime.js";
import { createSessionAdvancedDispatcher } from "../sessions/session-advanced-dispatcher.js";
import { ATTACHMENT_IPC_CHANNEL, CHANNEL_IPC_CHANNEL, CHAT_QUEUE_IPC_CHANNEL, CLIENT_IPC_CHANNEL, CLIENT_IPC_EVENT_CHANNEL, DATA_IPC_CHANNEL, DIAGNOSTICS_IPC_CHANNEL, IMAGE_OPERATION_IPC_CHANNEL, MCP_IPC_CHANNEL, PLUGIN_IPC_CHANNEL, PROVIDER_IPC_CHANNEL, RELEASE_IPC_CHANNEL, SESSION_ADVANCED_IPC_CHANNEL, SKILL_IPC_CHANNEL, WINDOW_IPC_CHANNEL } from "./channels.js";

export interface IpcMainLike {
  handle(channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>): void;
  removeHandler(channel: string): void;
}

export interface AuthorizedWebContents {
  mainFrame: unknown;
  send?(channel: string, payload: unknown): void;
  executeJavaScript?(code: string, userGesture?: boolean): Promise<unknown>;
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
  chatQueue?: ChatQueueStore;
  chatQueueDispatcher?: ChatQueueDispatcher;
  selectAttachments?(): Promise<AttachmentImportInput[]>;
  providers?: ProviderStore;
  providerNetwork?: ProviderNetworkService;
  providerConfig?: OpenClawProviderConfigBackend;
  skills?: SkillService;
  skillInstallCoordinator?: SkillInstallCoordinator;
  plugins?: PluginService;
  channels?: ChannelStore;
  channelRuntime?: ChannelRuntime;
  mcp?: McpStore;
  mcpRuntime?: McpRuntime;
  capabilityRuntime?: OpenClawCapabilityRuntime;
  sessionAdvanced?: SessionAdvancedService;
  dispatchData?(request: DataIpcRequest): Promise<unknown>;
  dispatchDiagnostics?(request: DiagnosticsIpcRequest): Promise<unknown>;
  dispatchRelease?(request: ReleaseIpcRequest): Promise<unknown>;
  dispatchImage?: ((request: ImageOperationIpcRequest) => Promise<unknown>) & { dispose?: () => void };
  coordinateWrite?<T>(operation: () => Promise<T>): Promise<T>;
  diagnosticsTimeoutMs?: number;
  routeChatSend?(input: SendMessageInput, signal: AbortSignal): AsyncIterable<MessageEvent> | Promise<AsyncIterable<MessageEvent>>;
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

function ensureCorrelatedResponse(response: unknown, request: ClientIpcRequest): ClientIpcResponse {
  const parsed = ClientIpcResponseSchema.parse(response);
  if (parsed.method !== request.method || parsed.requestId !== request.requestId) {
    throw new Error("Client response correlation failed.");
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
  chatQueue,
  chatQueueDispatcher,
  selectAttachments,
  providers,
  providerNetwork,
  providerConfig,
  skills,
  skillInstallCoordinator,
  plugins,
  channels,
  channelRuntime,
  mcp,
  mcpRuntime,
  capabilityRuntime,
  sessionAdvanced,
  dispatchData,
  dispatchDiagnostics,
  dispatchRelease,
  dispatchImage,
  coordinateWrite = (operation) => operation(),
  diagnosticsTimeoutMs = 15_000,
  routeChatSend,
}: RegisterIpcDependencies): () => void {
  const providerWriteMethods = new Set([
    "providers.create", "providers.update", "providers.remove", "providers.set-enabled",
    "providers.move", "providers.select", "providers.set-api-key", "providers.clear-api-key",
    "providers.set-network", "providers.config-patch", "providers.config-apply",
  ]);
  const clientWriteMethods = new Set([
    "gateway.reconnect", "sessions.create", "sessions.rename", "sessions.remove",
    "session-organizer.set-pinned", "session-organizer.create-group", "session-organizer.rename-group",
    "session-organizer.assign-group", "chat.send", "models.select-for-session",
  ]);
  const attachmentWriteMethods = new Set(["select", "import", "prepare", "remove"]);
  const channelWriteMethods = new Set([
    "channels.create", "channels.update", "channels.remove", "channels.set-enabled", "channels.test",
    "channels.reconnect", "channels.wechat-login-start", "channels.wechat-login-refresh",
    "channels.wechat-login-cancel", "channels.wechat-reconnect", "channels.wechat-logout",
    "channels.logout", "channels.send", "channels.action", "channels.poll",
  ]);
  const mcpWriteMethods = new Set([
    "mcp.create", "mcp.update", "mcp.remove", "mcp.set-enabled", "mcp.test", "mcp.reconnect", "mcp.confirm-risk",
    "capabilities.approvals-set",
  ]);
  const pluginWriteMethods = new Set([
    "plugins.install", "plugins.update", "plugins.uninstall", "plugins.set-enabled", "plugins.session-action",
  ]);
  const diagnosticsWriteMethods = new Set(["logs.export", "logs.cleanup", "config.export"]);
  const releaseWriteMethods = new Set(["release.install", "release.rollback", "uninstall.execute"]);
  const sessionAdvancedWriteMethods = new Set([
    "sessions.reset", "sessions.compact", "sessions.branch", "sessions.restore", "sessions.steer",
  ]);
  const clientDispatcher = client === undefined ? undefined : createClientDispatcher({
    client,
    organizer,
    runMutation: coordinateWrite,
    routeChatSend,
    sendEvent: (event) => authorizedWebContents.send?.(CLIENT_IPC_EVENT_CHANNEL, event),
  });
  const dispatch = clientDispatcher ?? dispatchClient;
  const providerDispatcher = providers === undefined
    ? undefined
    : createProviderDispatcher(providers, providerNetwork ?? createProviderNetworkService(), providerConfig);
  const skillDispatcher = skills === undefined ? undefined : createSkillDispatcher(skills, skillInstallCoordinator);
  const pluginDispatcher = plugins === undefined ? undefined : createPluginDispatcher(plugins, capabilityRuntime);
  const channelDispatcher = channels === undefined || channelRuntime === undefined
    ? undefined
    : createChannelDispatcher(channels, channelRuntime);
  const mcpDispatcher = mcp === undefined || mcpRuntime === undefined ? undefined : createMcpDispatcher(mcp, mcpRuntime, capabilityRuntime);
  const sessionAdvancedDispatcher = sessionAdvanced === undefined ? undefined : createSessionAdvancedDispatcher(sessionAdvanced);
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
      const operation = () => dispatch(parsed.data);
      response = await (clientDispatcher === undefined && clientWriteMethods.has(parsed.data.method) ? coordinateWrite(operation) : operation());
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
      const invoke = async () => {
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
        return result;
      };
      const result = await (attachmentWriteMethods.has(request.method) ? coordinateWrite(invoke) : invoke());
      return AttachmentIpcResponseSchema.parse({ method: request.method, requestId: request.requestId, ok: true, result });
    } catch (error) {
      return AttachmentIpcResponseSchema.parse({
        method: request.method, requestId: request.requestId, ok: false,
        error: toRendererSafeError(error),
      });
    }
  });

  if (chatQueue !== undefined && chatQueueDispatcher !== undefined) ipcMain.handle(CHAT_QUEUE_IPC_CHANNEL, async (event, payload) => {
    authorize(event);
    const parsed = ChatQueueIpcRequestSchema.safeParse(payload);
    if (!parsed.success) throw safeError("INVALID_ARGUMENT", "Invalid chat queue IPC request.");
    const request = parsed.data;
    try {
      let result: unknown;
      if (request.method === "chat-queue.list") result = await chatQueue.list(request.params.sessionId);
      else if (request.method === "chat-queue.add") result = await chatQueue.add(request.params);
      else if (request.method === "chat-queue.update") result = await chatQueue.update(request.params);
      else if (request.method === "chat-queue.remove") {
        await chatQueue.remove(request.params.sessionId, request.params.itemId);
        result = null;
      } else result = await chatQueueDispatcher.send(request.params.sessionId, request.params.itemId);
      return ChatQueueIpcResponseSchema.parse({ method: request.method, requestId: request.requestId, ok: true, result });
    } catch (error) {
      return ChatQueueIpcResponseSchema.parse({
        method: request.method, requestId: request.requestId, ok: false, error: toRendererSafeError(error),
      });
    }
  });

  if (providerDispatcher !== undefined) ipcMain.handle(PROVIDER_IPC_CHANNEL, async (event, payload) => {
    authorize(event);
    const parsed = ProviderIpcRequestSchema.safeParse(payload);
    if (!parsed.success) throw safeError("INVALID_ARGUMENT", "Invalid provider IPC request.");
    try {
      const operation = () => providerDispatcher(parsed.data);
      return ProviderIpcResponseSchema.parse(await (providerWriteMethods.has(parsed.data.method) ? coordinateWrite(operation) : operation()));
    } catch (error) {
      return ProviderIpcResponseSchema.parse({
        method: parsed.data.method,
        requestId: parsed.data.requestId,
        ok: false,
        error: toRendererSafeError(error),
      });
    }
  });

  if (skillDispatcher !== undefined) ipcMain.handle(SKILL_IPC_CHANNEL, async (event, payload) => {
    authorize(event);
    const parsed = SkillIpcRequestSchema.safeParse(payload);
    if (!parsed.success) throw safeError("INVALID_ARGUMENT", "Invalid Skill IPC request.");
    try {
      return await skillDispatcher(parsed.data);
    } catch (error) {
      return SkillIpcResponseSchema.parse({
        method: parsed.data.method,
        requestId: parsed.data.requestId,
        ok: false,
        error: toRendererSafeError(error),
      });
    }
  });

  if (pluginDispatcher !== undefined) ipcMain.handle(PLUGIN_IPC_CHANNEL, async (event, payload) => {
    authorize(event);
    const parsed = PluginIpcRequestSchema.safeParse(payload);
    if (!parsed.success) throw safeError("INVALID_ARGUMENT", "Invalid Plugin IPC request.");
    try {
      const operation = () => pluginDispatcher(parsed.data);
      return await (pluginWriteMethods.has(parsed.data.method) ? coordinateWrite(operation) : operation());
    } catch (error) {
      return PluginIpcResponseSchema.parse({
        method: parsed.data.method,
        requestId: parsed.data.requestId,
        ok: false,
        error: toRendererSafeError(error),
      });
    }
  });

  if (channelDispatcher !== undefined) ipcMain.handle(CHANNEL_IPC_CHANNEL, async (event, payload) => {
    authorize(event);
    const parsed = ChannelIpcRequestSchema.safeParse(payload);
    if (!parsed.success) throw safeError("INVALID_ARGUMENT", "Invalid channel IPC request.");
    try {
      const operation = () => channelDispatcher(parsed.data);
      return ChannelIpcResponseSchema.parse(await (channelWriteMethods.has(parsed.data.method) ? coordinateWrite(operation) : operation()));
    } catch (error) {
      return ChannelIpcResponseSchema.parse({
        method: parsed.data.method,
        requestId: parsed.data.requestId,
        ok: false,
        error: toRendererSafeError(error),
      });
    }
  });

  if (mcpDispatcher !== undefined) ipcMain.handle(MCP_IPC_CHANNEL, async (event, payload) => {
    authorize(event);
    const parsed = McpIpcRequestSchema.safeParse(payload);
    if (!parsed.success) throw safeError("INVALID_ARGUMENT", "Invalid MCP IPC request.");
    try {
      const operation = () => mcpDispatcher(parsed.data);
      return McpIpcResponseSchema.parse(await (mcpWriteMethods.has(parsed.data.method) ? coordinateWrite(operation) : operation()));
    }
    catch (error) {
      return McpIpcResponseSchema.parse({ method: parsed.data.method, requestId: parsed.data.requestId, ok: false, error: toRendererSafeError(error) });
    }
  });

  if (sessionAdvancedDispatcher !== undefined) ipcMain.handle(SESSION_ADVANCED_IPC_CHANNEL, async (event, payload) => {
    authorize(event);
    const parsed = SessionAdvancedIpcRequestSchema.safeParse(payload);
    if (!parsed.success) throw safeError("INVALID_ARGUMENT", "Invalid Session Advanced IPC request.");
    try {
      const operation = () => sessionAdvancedDispatcher(parsed.data);
      return SessionAdvancedIpcResponseSchema.parse(await (
        sessionAdvancedWriteMethods.has(parsed.data.method) ? coordinateWrite(operation) : operation()
      ));
    } catch (error) {
      return SessionAdvancedIpcResponseSchema.parse({
        method: parsed.data.method,
        requestId: parsed.data.requestId,
        ok: false,
        error: toRendererSafeError(error),
      });
    }
  });

  if (dispatchData !== undefined) ipcMain.handle(DATA_IPC_CHANNEL, async (event, payload) => {
    authorize(event);
    const parsed = DataIpcRequestSchema.safeParse(payload);
    if (!parsed.success) throw safeError("INVALID_ARGUMENT", "Invalid data IPC request.");
    try {
      const response = DataIpcResponseSchema.parse(await dispatchData(parsed.data));
      if (response.method !== parsed.data.method || response.requestId !== parsed.data.requestId) {
        throw new Error("Data response correlation failed.");
      }
      return response;
    } catch (error) {
      const knownResponse = DataIpcResponseSchema.safeParse({
        method: parsed.data.method,
        requestId: parsed.data.requestId,
        ok: false,
        error: toRendererSafeError(error),
      });
      if (knownResponse.success) return knownResponse.data;
      throw safeError("UNKNOWN", "Invalid data IPC response.");
    }
  });

  if (dispatchDiagnostics !== undefined) ipcMain.handle(DIAGNOSTICS_IPC_CHANNEL, async (event, payload) => {
    authorize(event);
    const parsed = DiagnosticsIpcRequestSchema.safeParse(payload);
    if (!parsed.success) throw safeError("INVALID_ARGUMENT", "Invalid diagnostics IPC request.");
    const request = parsed.data;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol("diagnostics-timeout");
    try {
      const response = await Promise.race([
        diagnosticsWriteMethods.has(request.method) ? coordinateWrite(() => dispatchDiagnostics(request)) : dispatchDiagnostics(request),
        new Promise<typeof timedOut>((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout(timedOut), diagnosticsTimeoutMs);
          timer.unref?.();
        }),
      ]);
      if (response === timedOut) {
        void dispatchDiagnostics({
          method: "operations.cancel",
          requestId: `cancel-${request.requestId}`.slice(0, 128),
          params: { operationRequestId: request.requestId },
        }).catch(() => undefined);
        return DiagnosticsIpcResponseSchema.parse({
          method: request.method,
          requestId: request.requestId,
          ok: false,
          error: safeError("TIMEOUT", "诊断操作超时。", true),
        });
      }
      const correlated = DiagnosticsIpcResponseSchema.parse(response);
      if (correlated.method !== request.method || correlated.requestId !== request.requestId) throw new Error("Diagnostics response correlation failed.");
      if (Buffer.byteLength(JSON.stringify(correlated)) > 1_048_576) {
        return DiagnosticsIpcResponseSchema.parse({
          method: request.method,
          requestId: request.requestId,
          ok: false,
          error: safeError("FILE_TOO_LARGE", "诊断响应超过大小上限。"),
        });
      }
      return correlated;
    } catch {
      throw safeError("UNKNOWN", "Invalid diagnostics IPC response.");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  });

  if (dispatchRelease !== undefined) ipcMain.handle(RELEASE_IPC_CHANNEL, async (event, payload) => {
    authorize(event);
    const parsed = ReleaseIpcRequestSchema.safeParse(payload);
    if (!parsed.success) throw safeError("INVALID_ARGUMENT", "Invalid release IPC request.");
    try {
      const operation = () => dispatchRelease(parsed.data);
      const response = ReleaseIpcResponseSchema.parse(await (releaseWriteMethods.has(parsed.data.method) ? coordinateWrite(operation) : operation()));
      if (response.method !== parsed.data.method || response.requestId !== parsed.data.requestId) throw new Error("Release response correlation failed.");
      return response;
    } catch {
      throw safeError("UNKNOWN", "Invalid release IPC response.");
    }
  });

  if (dispatchImage !== undefined) ipcMain.handle(IMAGE_OPERATION_IPC_CHANNEL, async (event, payload) => {
    authorize(event);
    const parsed = ImageOperationIpcRequestSchema.safeParse(payload);
    if (!parsed.success) throw safeError("INVALID_ARGUMENT", "Invalid image operation IPC request.");
    try {
      const response = ImageOperationIpcResponseSchema.parse(await dispatchImage(parsed.data));
      if (response.method !== parsed.data.method || response.requestId !== parsed.data.requestId) throw new Error("Image response correlation failed.");
      return response;
    } catch {
      throw safeError("UNKNOWN", "Invalid image operation IPC response.");
    }
  });

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    clientDispatcher?.dispose();
    channelDispatcher?.dispose();
    mcpDispatcher?.dispose();
    ipcMain.removeHandler(WINDOW_IPC_CHANNEL);
    ipcMain.removeHandler(CLIENT_IPC_CHANNEL);
    if (attachments !== undefined) ipcMain.removeHandler(ATTACHMENT_IPC_CHANNEL);
    if (chatQueue !== undefined && chatQueueDispatcher !== undefined) ipcMain.removeHandler(CHAT_QUEUE_IPC_CHANNEL);
    if (providers !== undefined) ipcMain.removeHandler(PROVIDER_IPC_CHANNEL);
    if (skills !== undefined) ipcMain.removeHandler(SKILL_IPC_CHANNEL);
    if (plugins !== undefined) ipcMain.removeHandler(PLUGIN_IPC_CHANNEL);
    if (channelDispatcher !== undefined) ipcMain.removeHandler(CHANNEL_IPC_CHANNEL);
    if (mcpDispatcher !== undefined) ipcMain.removeHandler(MCP_IPC_CHANNEL);
    if (sessionAdvancedDispatcher !== undefined) ipcMain.removeHandler(SESSION_ADVANCED_IPC_CHANNEL);
    if (dispatchData !== undefined) ipcMain.removeHandler(DATA_IPC_CHANNEL);
    if (dispatchDiagnostics !== undefined) ipcMain.removeHandler(DIAGNOSTICS_IPC_CHANNEL);
    if (dispatchRelease !== undefined) ipcMain.removeHandler(RELEASE_IPC_CHANNEL);
    if (dispatchImage !== undefined) ipcMain.removeHandler(IMAGE_OPERATION_IPC_CHANNEL);
    dispatchImage?.dispose?.();
  };
}
