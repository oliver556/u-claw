import {
  IpcEventSchema,
  IpcResponseSchema,
  ApprovalRequestSchema,
  SessionSummarySchema,
  ToolCallSchema,
  UClawErrorSchema,
  capabilitySetToWire,
  gatewayStatusToWire,
  type ClientIpcEvent,
  type ClientIpcRequest,
  type ApprovalRequest,
  type IpcResponse,
  type MessageEvent,
  type ToolCall,
  type UClawClient,
  type UClawError,
} from "@uclaw/shared";

export interface ClientDispatcherDependencies {
  client: UClawClient;
  sendEvent(event: ClientIpcEvent): void;
}

export interface ClientDispatcher {
  (request: ClientIpcRequest): Promise<IpcResponse>;
  dispose(): void;
}

function normalizedError(error: unknown): UClawError {
  const direct = UClawErrorSchema.safeParse(error);
  if (direct.success) return direct.data;
  const nested = UClawErrorSchema.safeParse((error as { uclawError?: unknown } | null)?.uclawError);
  if (nested.success) return nested.data;
  return UClawErrorSchema.parse({
    code: "UNKNOWN", message: "Client operation failed.", retryable: false,
    recoveryActions: [], causeDetails: {},
  });
}

function rendererSafeApproval(approval: ApprovalRequest): ApprovalRequest {
  const common = {
    id: approval.id,
    ...(approval.sessionId === undefined ? {} : { sessionId: approval.sessionId }),
    subject: approval.subject,
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
  return event;
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
    ...(tool.inputSummary === undefined ? {} : { inputSummary: { available: true } }),
    ...(tool.outputSummary === undefined ? {} : { outputSummary: { available: true } }),
    ...(tool.startedAt === undefined ? {} : { startedAt: tool.startedAt }),
    ...(tool.finishedAt === undefined ? {} : { finishedAt: tool.finishedAt }),
    ...(tool.error === undefined ? {} : {
      error: { code: tool.error.code, message: "Tool operation failed.", retryable: tool.error.retryable },
    }),
  });
}

export function createClientDispatcher({ client, sendEvent }: ClientDispatcherDependencies) {
  const subscriptions = new Map<string, AbortController>();
  const sends = new Map<string, { controller: AbortController; iterator: AsyncIterator<MessageEvent> }>();
  const emit = (event: ClientIpcEvent): void => sendEvent(IpcEventSchema.parse(event));

  const runSubscription = async (
    subscriptionId: string,
    controller: AbortController,
    source: AsyncIterable<unknown>,
    mapEvent: (payload: unknown) => ClientIpcEvent,
  ): Promise<void> => {
    let failure: UClawError | undefined;
    try {
      for await (const payload of source) emit(mapEvent(payload));
    } catch (error) {
      failure = normalizedError(error);
    } finally {
      if (subscriptions.get(subscriptionId) === controller) {
        subscriptions.delete(subscriptionId);
        emit({ event: "subscription.closed", subscriptionId, ...(failure === undefined ? {} : { error: failure }) });
      }
    }
  };

  const success = (request: ClientIpcRequest, result: unknown): IpcResponse => IpcResponseSchema.parse({
    method: request.method, requestId: request.requestId, ok: true, result,
  });

  const dispatch = async (request: ClientIpcRequest): Promise<IpcResponse> => {
    try {
      switch (request.method) {
        case "gateway.negotiate": return success(request, capabilitySetToWire(await client.gateway.negotiate()));
        case "gateway.get-status": return success(request, gatewayStatusToWire(await client.gateway.getStatus()));
        case "gateway.watch-status": {
          const controller = new AbortController();
          subscriptions.get(request.params.subscriptionId)?.abort();
          subscriptions.set(request.params.subscriptionId, controller);
          void runSubscription(request.params.subscriptionId, controller, client.gateway.watchStatus(controller.signal), (payload) => ({
            event: "gateway.status", subscriptionId: request.params.subscriptionId,
            payload: gatewayStatusToWire(payload as Awaited<ReturnType<UClawClient["gateway"]["getStatus"]>>),
          }));
          return success(request, null);
        }
        case "gateway.reconnect": await client.gateway.reconnect(); return success(request, null);
        case "sessions.list": {
          const page = await client.sessions.list(request.params);
          return success(request, {
            ...page,
            items: page.items.map((item) => SessionSummarySchema.parse({
              id: item.id,
              title: item.title,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
              ...(item.lastMessagePreview === undefined ? {} : { lastMessagePreview: item.lastMessagePreview }),
              ...(item.model === undefined ? {} : { model: item.model }),
              pinned: item.pinned,
              ...(item.groupId === undefined ? {} : { groupId: item.groupId }),
              status: item.status,
            })),
          });
        }
        case "sessions.get": return success(request, await client.sessions.get(request.params.sessionId));
        case "sessions.create": return success(request, await client.sessions.create(request.params));
        case "sessions.remove": await client.sessions.remove(request.params.sessionId, request.params.revision); return success(request, null);
        case "chat.list": {
          const { sessionId, ...page } = request.params;
          return success(request, await client.chat.list(sessionId, page));
        }
        case "chat.get": return success(request, await client.chat.get(request.params.sessionId, request.params.messageId));
        case "chat.watch": {
          const controller = new AbortController();
          subscriptions.get(request.params.subscriptionId)?.abort();
          subscriptions.set(request.params.subscriptionId, controller);
          void runSubscription(request.params.subscriptionId, controller, client.chat.watch(request.params.sessionId, controller.signal), (payload) => ({
            event: "chat.watch-event", subscriptionId: request.params.subscriptionId,
            payload: rendererSafeMessageEvent(payload as MessageEvent),
          }));
          return success(request, null);
        }
        case "chat.send": {
          const controller = new AbortController();
          const iterator = client.chat.send(request.params, controller.signal)[Symbol.asyncIterator]();
          sends.get(request.params.clientRequestId)?.controller.abort();
          sends.set(request.params.clientRequestId, { controller, iterator });
          const first = await iterator.next();
          if (first.done || first.value.type !== "started") {
            sends.delete(request.params.clientRequestId);
            controller.abort();
            await iterator.return?.();
            throw new Error("Chat stream did not start.");
          }
          emit({ event: "chat.send-event", clientRequestId: request.params.clientRequestId, payload: rendererSafeMessageEvent(first.value) });
          void (async () => {
            try {
              while (true) {
                const next = await iterator.next();
                if (next.done) return;
                emit({ event: "chat.send-event", clientRequestId: request.params.clientRequestId, payload: rendererSafeMessageEvent(next.value) });
              }
            } catch (error) {
              emit({
                event: "chat.send-event", clientRequestId: request.params.clientRequestId,
                payload: { type: "error", runId: first.value.runId, error: normalizedError(error) },
              });
            } finally {
              if (sends.get(request.params.clientRequestId)?.iterator === iterator) sends.delete(request.params.clientRequestId);
              await iterator.return?.();
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
            await active.iterator.return?.();
          }
          return success(request, null);
        }
        case "tools.list": return success(request, await client.tools.list());
        case "tools.get-call": return success(request, rendererSafeTool(await client.tools.getCall(request.params.toolCallId)));
        case "approvals.list-pending": return success(request, (await client.approvals.listPending(request.params.sessionId)).map(rendererSafeApproval));
        case "approvals.resolve-exec": await client.approvals.resolveExec(request.params); return success(request, null);
        case "approvals.resolve-plugin": await client.approvals.resolvePlugin(request.params); return success(request, null);
        case "models.list": return success(request, await client.models.list());
        case "models.select-for-session": await client.models.selectForSession(request.params.sessionId, request.params.modelId); return success(request, null);
        case "skills.list": return success(request, await client.skills.list());
        case "channels.list": return success(request, await client.channels.list());
        case "files.list": {
          const { parentId, ...page } = request.params;
          return success(request, await client.files.list(parentId, page));
        }
        case "files.read-text": return success(request, await client.files.readText(request.params.fileId));
        case "diagnostics.list": return success(request, await client.diagnostics.list());
        case "diagnostics.list-logs": return success(request, await client.diagnostics.listLogs(request.params));
        case "subscriptions.cancel": subscriptions.get(request.params.subscriptionId)?.abort(); subscriptions.delete(request.params.subscriptionId); return success(request, null);
      }
    } catch (error) {
      return IpcResponseSchema.parse({
        method: request.method, requestId: request.requestId, ok: false, error: normalizedError(error),
      });
    }
  };
  dispatch.dispose = () => {
    for (const controller of subscriptions.values()) controller.abort();
    subscriptions.clear();
    for (const { controller, iterator } of sends.values()) {
      controller.abort();
      void iterator.return?.();
    }
    sends.clear();
  };
  return dispatch;
}
