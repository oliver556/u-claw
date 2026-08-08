import {
  IpcEventSchema,
  IpcResponseSchema,
  ApprovalRequestSchema,
  ChannelSummarySchema,
  DiagnosticSummarySchema,
  GatewayStatusWireSchema,
  MessageSchema,
  ModelSummarySchema,
  RendererSafeSummarySchema,
  SessionSchema,
  SessionSummarySchema,
  ToolCallSchema,
  UClawErrorSchema,
  UClawErrorSummarySchema,
  capabilitySetToWire,
  gatewayStatusToWire,
  normalizeKey,
  redactRendererText,
  type ClientIpcEvent,
  type ClientIpcRequest,
  type ApprovalRequest,
  type ChannelSummary,
  type DiagnosticSummary,
  type IpcResponse,
  type Message,
  type MessageEvent,
  type ModelSummary,
  type Session,
  type SessionSummary,
  type ToolCall,
  type UClawClient,
  type UClawError,
  type UClawErrorSummary,
} from "@uclaw/shared";

export interface ClientDispatcherDependencies {
  client: UClawClient;
  sendEvent(event: ClientIpcEvent): void;
}

export interface ClientDispatcher {
  (request: ClientIpcRequest): Promise<IpcResponse>;
  dispose(): void;
}

const rendererErrorMessages: Record<UClawError["code"], string> = {
  UNKNOWN: "Client operation failed.",
  INVALID_ARGUMENT: "The request is invalid.",
  NOT_FOUND: "Requested resource was not found.",
  CONFLICT: "The resource changed before this operation completed.",
  UNSUPPORTED: "This operation is not supported.",
  UNAVAILABLE: "Requested capability is unavailable.",
  TIMEOUT: "Client operation timed out.",
  CANCELLED: "Request was cancelled.",
  UNAUTHORIZED: "Authentication is required.",
  FORBIDDEN: "This operation is not allowed.",
  AUTHORIZATION_REQUIRED: "Authorization is required.",
  GATEWAY_STARTING: "Gateway is starting.",
  GATEWAY_DISCONNECTED: "Gateway is disconnected.",
  GATEWAY_FAILED: "Gateway operation failed.",
  CONTRACT_INCOMPATIBLE: "Gateway protocol is incompatible.",
  PROTOCOL_MAPPING_FAILED: "Gateway response could not be processed.",
  USB_MISSING: "The U drive is unavailable.",
  USB_READ_ONLY: "The U drive is read-only.",
  DATA_WRITE_FAILED: "Client data could not be saved.",
  FILE_OUTSIDE_ALLOWED_ROOT: "The requested file is outside the allowed workspace.",
  FILE_TOO_LARGE: "The requested file is too large.",
  FILE_TYPE_UNSUPPORTED: "The requested file type is unsupported.",
  MODEL_UNAVAILABLE: "The selected model is unavailable.",
  PROVIDER_AUTH_FAILED: "Model provider authentication failed.",
  NETWORK_UNREACHABLE: "Network is unreachable.",
  OPERATION_FAILED: "Client operation failed.",
  ALREADY_COMPLETED: "This operation is already complete.",
};

export function toRendererSafeError(error: unknown): UClawError {
  const direct = UClawErrorSchema.safeParse(error);
  if (direct.success) return rendererSafeError(direct.data);
  const nested = UClawErrorSchema.safeParse((error as { uclawError?: unknown } | null)?.uclawError);
  if (nested.success) return rendererSafeError(nested.data);
  return rendererSafeError(UClawErrorSchema.parse({
    code: "UNKNOWN", message: "Client operation failed.", retryable: false,
    recoveryActions: [], causeDetails: {},
  }));
}

function rendererSafeError(error: UClawError): UClawError {
  return UClawErrorSchema.parse({
    code: error.code,
    message: rendererErrorMessages[error.code],
    retryable: error.retryable,
    recoveryActions: error.recoveryActions,
    causeDetails: {},
  });
}

function rendererSafeErrorSummary(error: UClawErrorSummary): UClawErrorSummary {
  return UClawErrorSummarySchema.parse({
    code: error.code,
    message: rendererErrorMessages[error.code],
    retryable: error.retryable,
  });
}

function rendererSafeGatewayStatusWire(wire: ReturnType<typeof gatewayStatusToWire>) {
  return GatewayStatusWireSchema.parse({
    ...wire,
    ...(wire.error === undefined ? {} : { error: rendererSafeError(wire.error) }),
  });
}

function rendererSafeGatewayStatus(status: Awaited<ReturnType<UClawClient["gateway"]["getStatus"]>>) {
  return rendererSafeGatewayStatusWire(gatewayStatusToWire(status));
}

function rendererSafeModel(model: ModelSummary): ModelSummary {
  return ModelSummarySchema.parse({
    ...model,
    ...(model.unavailableReason === undefined ? {} : { unavailableReason: rendererSafeErrorSummary(model.unavailableReason) }),
  });
}

function rendererSafeChannel(channel: ChannelSummary): ChannelSummary {
  return ChannelSummarySchema.parse({
    ...channel,
    ...(channel.error === undefined ? {} : { error: rendererSafeErrorSummary(channel.error) }),
  });
}

function rendererSafeDiagnostic(diagnostic: DiagnosticSummary): DiagnosticSummary {
  return DiagnosticSummarySchema.parse({
    ...diagnostic,
    ...(diagnostic.error === undefined ? {} : { error: rendererSafeErrorSummary(diagnostic.error) }),
  });
}

function rendererSafeSessionSummary(session: SessionSummary): SessionSummary {
  return SessionSummarySchema.parse({
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.lastMessagePreview === undefined ? {} : { lastMessagePreview: session.lastMessagePreview }),
    ...(session.model === undefined ? {} : { model: session.model }),
    pinned: session.pinned,
    ...(session.groupId === undefined ? {} : { groupId: session.groupId }),
    status: session.status,
  });
}

function rendererSafeSession(session: Session): Session {
  return SessionSchema.parse({
    ...rendererSafeSessionSummary(session),
    ...(session.revision === undefined ? {} : { revision: session.revision }),
  });
}

function rendererSafeMessage(message: Message): Message {
  return MessageSchema.parse({
    ...message,
    ...(message.error === undefined ? {} : {
      error: (() => {
        const safe = rendererSafeError(UClawErrorSchema.parse({
          ...message.error,
          recoveryActions: [],
          causeDetails: {},
        }));
        return { code: safe.code, message: safe.message, retryable: safe.retryable };
      })(),
    }),
  });
}

function rendererSafeApproval(approval: ApprovalRequest): ApprovalRequest {
  const common = {
    id: approval.id,
    ...(approval.sessionId === undefined ? {} : { sessionId: approval.sessionId }),
    subject: {
      kind: approval.subject.kind,
      id: approval.subject.id,
      ...(approval.subject.label === undefined ? {} : {
        label: approval.family === "exec" ? "OpenClaw operation" : "OpenClaw plugin",
      }),
    },
    title: approval.family === "exec" ? "Command execution approval" : "Plugin operation approval",
    description: approval.family === "exec"
      ? "OpenClaw requests permission to run a command."
      : "OpenClaw requests permission for a plugin operation.",
    risk: approval.risk,
    permissions: approval.permissions.map((permission) => ({
      kind: permission.kind,
      scope: approval.family === "exec" ? "managed-runtime" : "managed-plugin",
      description: "Permission managed by the desktop runtime.",
    })),
    choices: approval.choices,
    ...(approval.expiresAt === undefined ? {} : { expiresAt: approval.expiresAt }),
    status: approval.status,
  };
  return ApprovalRequestSchema.parse(approval.family === "exec"
    ? { ...common, family: "exec", ...(approval.toolCallId === undefined ? {} : { toolCallId: approval.toolCallId }) }
    : { ...common, family: "plugin" });
}

function rendererSafeMessageEvent(event: MessageEvent): MessageEvent {
  if (event.type === "approval") return { ...event, approval: rendererSafeApproval(event.approval) };
  if (event.type === "tool") return { ...event, tool: rendererSafeTool(event.tool) };
  if (event.type === "error") return { ...event, error: toRendererSafeError(event.error) };
  if (event.type === "final") return { ...event, message: rendererSafeMessage(event.message) };
  if (event.type === "aborted" && event.reason !== undefined) return { ...event, reason: "Generation was stopped." };
  return event;
}

const MAX_TOOL_SUMMARY_FIELDS = 16;
const MAX_TOOL_SUMMARY_TEXT = 256;
const MAX_TOOL_SUMMARY_TEXT_TOTAL = 2_048;
const TOOL_SUMMARY_REDACTED = "[REDACTED]";
const SAFE_TOOL_SUMMARY_TEXT_KEYS = new Set(["status", "state", "outcome"]);
const SAFE_TOOL_SUMMARY_TEXT_VALUE = /^(?:pending|running|completed|failed|success|succeeded|cancelled|canceled|aborted|tests (?:passed|failed))$/i;
const SAFE_TOOL_SUMMARY_KEYS = new Set([
  ...SAFE_TOOL_SUMMARY_TEXT_KEYS,
  "configured", "success", "count", "token_count", "duration_ms", "exit_code",
]);
const SAFE_TOOL_SUMMARY_BOOLEAN_KEYS = new Set(["configured", "success"]);
const SAFE_TOOL_SUMMARY_NUMBER_RULES: Record<string, (value: number) => boolean> = {
  count: (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000,
  token_count: (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000,
  duration_ms: (value) => Number.isFinite(value) && value >= 0 && value <= 604_800_000,
  exit_code: (value) => Number.isSafeInteger(value) && value >= -65_535 && value <= 65_535,
};

function rendererSafeToolSummary(summary: unknown) {
  const projected: Record<string, string | number | boolean | null | Array<string | number | boolean | null>> = {};
  if (summary === null || typeof summary !== "object" || Array.isArray(summary)) {
    return RendererSafeSummarySchema.parse(projected);
  }

  let remainingText = MAX_TOOL_SUMMARY_TEXT_TOTAL;
  const safeText = (value: string, key: string): string | undefined => {
    if (remainingText <= 0) return undefined;
    const normalizedKey = normalizeKey(key);
    const redacted = SAFE_TOOL_SUMMARY_TEXT_KEYS.has(normalizedKey) && SAFE_TOOL_SUMMARY_TEXT_VALUE.test(value.trim())
      ? redactRendererText(value, key)
      : TOOL_SUMMARY_REDACTED;
    const limit = Math.min(MAX_TOOL_SUMMARY_TEXT, remainingText);
    const bounded = redacted.length <= limit
      ? redacted
      : limit <= 3 ? ".".repeat(limit) : redacted.slice(0, limit - 3) + "...";
    remainingText -= bounded.length;
    return bounded;
  };

  for (const [index, [rawKey, rawValue]] of Object.entries(summary).slice(0, MAX_TOOL_SUMMARY_FIELDS).entries()) {
    const safeKey = rawKey.length <= 64 && SAFE_TOOL_SUMMARY_KEYS.has(normalizeKey(rawKey));
    const key = safeKey ? rawKey : `field_${index + 1}`;
    if (!safeKey) {
      projected[key] = TOOL_SUMMARY_REDACTED;
      continue;
    }
    const normalizedKey = normalizeKey(rawKey);
    if (SAFE_TOOL_SUMMARY_TEXT_KEYS.has(normalizedKey) && typeof rawValue === "string") {
      const value = safeText(rawValue, key);
      if (value !== undefined) projected[key] = value;
    } else if (SAFE_TOOL_SUMMARY_BOOLEAN_KEYS.has(normalizedKey) && typeof rawValue === "boolean") {
      projected[key] = rawValue;
    } else if (typeof rawValue === "number" && SAFE_TOOL_SUMMARY_NUMBER_RULES[normalizedKey]?.(rawValue) === true) {
      projected[key] = rawValue;
    } else {
      projected[key] = TOOL_SUMMARY_REDACTED;
    }
  }
  return RendererSafeSummarySchema.parse(projected);
}

function rendererSafeTool(tool: ToolCall): ToolCall {
  return ToolCallSchema.parse({
    id: tool.id,
    sessionId: tool.sessionId,
    ...(tool.runId === undefined ? {} : { runId: tool.runId }),
    ...(tool.messageId === undefined ? {} : { messageId: tool.messageId }),
    toolId: tool.toolId,
    displayName: "OpenClaw tool",
    state: tool.state,
    risk: tool.risk,
    ...(tool.inputSummary === undefined ? {} : { inputSummary: rendererSafeToolSummary(tool.inputSummary) }),
    ...(tool.outputSummary === undefined ? {} : { outputSummary: rendererSafeToolSummary(tool.outputSummary) }),
    ...(tool.startedAt === undefined ? {} : { startedAt: tool.startedAt }),
    ...(tool.finishedAt === undefined ? {} : { finishedAt: tool.finishedAt }),
    ...(tool.error === undefined ? {} : {
      error: { code: tool.error.code, message: "Tool operation failed.", retryable: tool.error.retryable },
    }),
  });
}

export function toRendererSafeResponse(response: IpcResponse): IpcResponse {
  if (!response.ok) {
    return IpcResponseSchema.parse({
      method: response.method,
      requestId: response.requestId,
      ok: false,
      error: toRendererSafeError(response.error),
    });
  }

  let result: unknown = response.result;
  switch (response.method) {
    case "gateway.get-status": result = rendererSafeGatewayStatusWire(response.result); break;
    case "sessions.list": result = { ...response.result, items: response.result.items.map(rendererSafeSessionSummary) }; break;
    case "sessions.get":
    case "sessions.create": result = rendererSafeSession(response.result); break;
    case "chat.list": result = { ...response.result, items: response.result.items.map(rendererSafeMessage) }; break;
    case "chat.get": result = rendererSafeMessage(response.result); break;
    case "tools.get-call": result = rendererSafeTool(response.result); break;
    case "approvals.list-pending": result = response.result.map(rendererSafeApproval); break;
    case "models.list": result = response.result.map(rendererSafeModel); break;
    case "channels.list": result = response.result.map(rendererSafeChannel); break;
    case "diagnostics.list": result = response.result.map(rendererSafeDiagnostic); break;
  }
  return IpcResponseSchema.parse({ ...response, result });
}

export function createClientDispatcher({ client, sendEvent }: ClientDispatcherDependencies) {
  type SubscriptionState = { controller: AbortController };
  type SendState = { controller: AbortController; iterator: AsyncIterator<MessageEvent> };
  const subscriptions = new Map<string, SubscriptionState>();
  const sends = new Map<string, SendState>();
  let disposed = false;
  const emit = (event: ClientIpcEvent): void => {
    if (!disposed) sendEvent(IpcEventSchema.parse(event));
  };
  const returnIterator = async (iterator: AsyncIterator<MessageEvent>): Promise<void> => {
    try { await iterator.return?.(); } catch { /* Stream cleanup is best effort. */ }
  };

  const runSubscription = async (
    subscriptionId: string,
    state: SubscriptionState,
    source: AsyncIterable<unknown>,
    mapEvent: (payload: unknown) => ClientIpcEvent,
  ): Promise<void> => {
    let failure: UClawError | undefined;
    try {
      for await (const payload of source) {
        if (!disposed && subscriptions.get(subscriptionId) === state) emit(mapEvent(payload));
      }
    } catch (error) {
      if (!disposed && subscriptions.get(subscriptionId) === state) failure = toRendererSafeError(error);
    } finally {
      if (!disposed && subscriptions.get(subscriptionId) === state) {
        subscriptions.delete(subscriptionId);
        emit({ event: "subscription.closed", subscriptionId, ...(failure === undefined ? {} : { error: failure }) });
      }
    }
  };

  const success = (request: ClientIpcRequest, result: unknown): IpcResponse => toRendererSafeResponse(IpcResponseSchema.parse({
    method: request.method, requestId: request.requestId, ok: true, result,
  }));

  const dispatch = async (request: ClientIpcRequest): Promise<IpcResponse> => {
    try {
      switch (request.method) {
        case "gateway.negotiate": return success(request, capabilitySetToWire(await client.gateway.negotiate()));
        case "gateway.get-status": return success(request, rendererSafeGatewayStatus(await client.gateway.getStatus()));
        case "gateway.watch-status": {
          const controller = new AbortController();
          subscriptions.get(request.params.subscriptionId)?.controller.abort();
          const state = { controller };
          subscriptions.set(request.params.subscriptionId, state);
          void runSubscription(request.params.subscriptionId, state, client.gateway.watchStatus(controller.signal), (payload) => ({
            event: "gateway.status", subscriptionId: request.params.subscriptionId,
            payload: rendererSafeGatewayStatus(payload as Awaited<ReturnType<UClawClient["gateway"]["getStatus"]>>),
          }));
          return success(request, null);
        }
        case "gateway.reconnect": await client.gateway.reconnect(); return success(request, null);
        case "sessions.list": {
          const page = await client.sessions.list(request.params);
          return success(request, {
            ...page,
            items: page.items.map(rendererSafeSessionSummary),
          });
        }
        case "sessions.get": return success(request, rendererSafeSession(await client.sessions.get(request.params.sessionId)));
        case "sessions.create": return success(request, rendererSafeSession(await client.sessions.create(request.params)));
        case "sessions.rename": {
          if (client.sessions.rename === undefined) throw { code: "UNAVAILABLE", message: "Session rename is unavailable.", retryable: false, recoveryActions: [], causeDetails: {} };
          return success(request, rendererSafeSession(await client.sessions.rename(request.params.sessionId, request.params.title)));
        }
        case "sessions.remove": await client.sessions.remove(request.params.sessionId, request.params.revision); return success(request, null);
        case "chat.list": {
          const { sessionId, ...page } = request.params;
          const result = await client.chat.list(sessionId, page);
          return success(request, { ...result, items: result.items.map(rendererSafeMessage) });
        }
        case "chat.get": return success(request, rendererSafeMessage(await client.chat.get(request.params.sessionId, request.params.messageId)));
        case "chat.watch": {
          const controller = new AbortController();
          subscriptions.get(request.params.subscriptionId)?.controller.abort();
          const state = { controller };
          subscriptions.set(request.params.subscriptionId, state);
          void runSubscription(request.params.subscriptionId, state, client.chat.watch(request.params.sessionId, controller.signal), (payload) => ({
            event: "chat.watch-event", subscriptionId: request.params.subscriptionId,
            payload: rendererSafeMessageEvent(payload as MessageEvent),
          }));
          return success(request, null);
        }
        case "chat.send": {
          const controller = new AbortController();
          const iterator = client.chat.send(request.params, controller.signal)[Symbol.asyncIterator]();
          const previous = sends.get(request.params.clientRequestId);
          previous?.controller.abort();
          if (previous) void returnIterator(previous.iterator);
          const state = { controller, iterator };
          sends.set(request.params.clientRequestId, state);
          const first = await iterator.next();
          if (disposed || sends.get(request.params.clientRequestId) !== state) {
            controller.abort();
            await returnIterator(iterator);
            throw new Error("Chat stream was replaced.");
          }
          if (first.done || first.value.type !== "started") {
            if (sends.get(request.params.clientRequestId) === state) sends.delete(request.params.clientRequestId);
            controller.abort();
            await returnIterator(iterator);
            throw new Error("Chat stream did not start.");
          }
          emit({ event: "chat.send-event", clientRequestId: request.params.clientRequestId, payload: rendererSafeMessageEvent(first.value) });
          void (async () => {
            try {
              while (true) {
                const next = await iterator.next();
                if (next.done) return;
                if (!disposed && sends.get(request.params.clientRequestId) === state) {
                  emit({ event: "chat.send-event", clientRequestId: request.params.clientRequestId, payload: rendererSafeMessageEvent(next.value) });
                }
              }
            } catch (error) {
              if (!disposed && sends.get(request.params.clientRequestId) === state) emit({
                event: "chat.send-event", clientRequestId: request.params.clientRequestId,
                payload: { type: "error", runId: first.value.runId, error: toRendererSafeError(error) },
              });
            } finally {
              if (sends.get(request.params.clientRequestId) === state) sends.delete(request.params.clientRequestId);
              await returnIterator(iterator);
            }
          })();
          return success(request, { clientRequestId: request.params.clientRequestId, runId: first.value.runId });
        }
        case "chat.abort": await client.chat.abort(request.params.runId); return success(request, null);
        case "chat.cancel-stream": {
          const active = sends.get(request.params.clientRequestId);
          if (active) {
            sends.delete(request.params.clientRequestId);
            active.controller.abort();
            await returnIterator(active.iterator);
          }
          return success(request, null);
        }
        case "tools.list": return success(request, await client.tools.list());
        case "tools.get-call": return success(request, rendererSafeTool(await client.tools.getCall(request.params.toolCallId)));
        case "approvals.list-pending": return success(request, (await client.approvals.listPending(request.params.sessionId)).map(rendererSafeApproval));
        case "approvals.resolve-exec": await client.approvals.resolveExec(request.params); return success(request, null);
        case "approvals.resolve-plugin": await client.approvals.resolvePlugin(request.params); return success(request, null);
        case "models.list": return success(request, (await client.models.list()).map(rendererSafeModel));
        case "models.select-for-session": await client.models.selectForSession(request.params.sessionId, request.params.modelId); return success(request, null);
        case "skills.list": return success(request, await client.skills.list());
        case "channels.list": return success(request, (await client.channels.list()).map(rendererSafeChannel));
        case "files.list": {
          const { parentId, ...page } = request.params;
          return success(request, await client.files.list(parentId, page));
        }
        case "files.read-text": return success(request, await client.files.readText(request.params.fileId));
        case "diagnostics.list": return success(request, (await client.diagnostics.list()).map(rendererSafeDiagnostic));
        case "diagnostics.list-logs": return success(request, await client.diagnostics.listLogs(request.params));
        case "subscriptions.cancel": {
          const active = subscriptions.get(request.params.subscriptionId);
          subscriptions.delete(request.params.subscriptionId);
          active?.controller.abort();
          return success(request, null);
        }
      }
    } catch (error) {
      return IpcResponseSchema.parse({
        method: request.method, requestId: request.requestId, ok: false, error: toRendererSafeError(error),
      });
    }
  };
  dispatch.dispose = () => {
    if (disposed) return;
    disposed = true;
    const activeSubscriptions = [...subscriptions.values()];
    subscriptions.clear();
    for (const { controller } of activeSubscriptions) controller.abort();
    const activeSends = [...sends.values()];
    sends.clear();
    for (const { controller, iterator } of activeSends) {
      controller.abort();
      void returnIterator(iterator);
    }
  };
  return dispatch;
}
