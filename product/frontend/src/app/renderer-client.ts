import {
  capabilitySetFromWire,
  gatewayStatusFromWire,
  type ClientIpcEvent,
  type ClientIpcRequest,
  type IpcResponse,
  type MessageEvent,
  type SessionOrganizerService,
  type UClawClient,
  type UClawError,
} from "@uclaw/shared";

export interface RendererClientBridge {
  invoke(request: ClientIpcRequest): Promise<IpcResponse>;
  subscribe(listener: (event: ClientIpcEvent) => void): () => void;
}

export interface RendererClient extends UClawClient {
  sessionOrganizer: SessionOrganizerService;
  dispose(): void;
}

export class RendererClientError extends Error implements UClawError {
  readonly code: UClawError["code"];
  readonly retryable: boolean;
  readonly recoveryActions: UClawError["recoveryActions"];
  readonly causeDetails: UClawError["causeDetails"];
  readonly correlationId?: string;

  constructor(error: UClawError) {
    super(error.message);
    this.name = "RendererClientError";
    this.code = error.code;
    this.retryable = error.retryable;
    this.recoveryActions = error.recoveryActions;
    this.causeDetails = error.causeDetails;
    this.correlationId = error.correlationId;
  }
}

class EventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve(result: IteratorResult<T>): void;
    reject(error: RendererClientError): void;
  }> = [];
  private ended = false;
  private failure: UClawError | undefined;

  constructor(private readonly closeOnTerminalValue = false) {}

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
    if (this.closeOnTerminalValue && (
      (value as { type?: string }).type === "final" ||
      (value as { type?: string }).type === "aborted" ||
      (value as { type?: string }).type === "error"
    )) this.end();
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  cancel(): void {
    this.values.splice(0);
    this.end();
  }

  fail(error: UClawError): void {
    this.failure = error;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(new RendererClientError(error));
  }

  next(signal?: AbortSignal): Promise<IteratorResult<T>> {
    if (signal?.aborted) {
      this.cancel();
      return Promise.resolve({ value: undefined, done: true });
    }
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.failure) return Promise.reject(new RendererClientError(this.failure));
    if (this.ended || signal?.aborted) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        this.cancel();
        resolve({ value: undefined, done: true });
      };
      const waiter = {
        resolve: (result: IteratorResult<T>) => { signal?.removeEventListener("abort", onAbort); resolve(result); },
        reject: (error: RendererClientError) => { signal?.removeEventListener("abort", onAbort); reject(error); },
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${++sequence}`;

export function createRendererClient(bridge: RendererClientBridge): RendererClient {
  type SendQueueState = { queue: EventQueue<MessageEvent>; cancelStreamRequested: boolean };
  const sendQueues = new Map<string, SendQueueState>();
  const subscriptionQueues = new Map<string, EventQueue<unknown>>();
  let unsubscribe: (() => void) | undefined;
  const onEvent = (event: ClientIpcEvent): void => {
    if (event.event === "chat.send-event") sendQueues.get(event.clientRequestId)?.queue.push(event.payload);
    else if (event.event === "subscription.closed") {
      const queue = subscriptionQueues.get(event.subscriptionId);
      if (event.error) queue?.fail(event.error);
      else queue?.end();
    }
    else subscriptionQueues.get(event.subscriptionId)?.push(
      event.event === "gateway.status" ? gatewayStatusFromWire(event.payload) : event.payload,
    );
  };
  const ensureSubscribed = (): void => {
    unsubscribe ??= bridge.subscribe(onEvent);
  };

  const invokeRaw = async <T>(method: ClientIpcRequest["method"], params: object): Promise<T> => {
    const request = { method, requestId: nextId("renderer"), params } as ClientIpcRequest;
    const response = await bridge.invoke(request);
    if (!response.ok) throw new RendererClientError(response.error);
    return response.result as T;
  };
  const invoke = async <T>(method: ClientIpcRequest["method"], params: object): Promise<T> => {
    ensureSubscribed();
    return invokeRaw(method, params);
  };

  const subscribe = <T>(method: "gateway.watch-status" | "chat.watch", params: object, signal?: AbortSignal): AsyncIterable<T> => {
    const subscriptionId = nextId("subscription");
    const queue = new EventQueue<T>();
    subscriptionQueues.set(subscriptionId, queue as EventQueue<unknown>);
    return (async function* () {
      const cancel = () => {
        if (subscriptionQueues.get(subscriptionId) === queue) subscriptionQueues.delete(subscriptionId);
        queue.cancel();
        void invokeRaw("subscriptions.cancel", { subscriptionId }).catch(() => undefined);
      };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        if (signal?.aborted) return;
        await invoke(method, { ...params, subscriptionId });
        while (true) {
          const next = await queue.next(signal);
          if (next.done) return;
          yield next.value;
        }
      } finally {
        signal?.removeEventListener("abort", cancel);
        if (subscriptionQueues.get(subscriptionId) === queue) subscriptionQueues.delete(subscriptionId);
        await invokeRaw("subscriptions.cancel", { subscriptionId }).catch(() => undefined);
      }
    })();
  };

  return {
    gateway: {
      negotiate: async () => capabilitySetFromWire(await invoke("gateway.negotiate", {})),
      getStatus: async () => gatewayStatusFromWire(await invoke("gateway.get-status", {})),
      watchStatus: (signal) => subscribe("gateway.watch-status", {}, signal),
      reconnect: () => invoke("gateway.reconnect", {}),
    },
    sessions: {
      list: (page = {}) => invoke("sessions.list", page), get: (sessionId) => invoke("sessions.get", { sessionId }),
      create: (input = {}) => invoke("sessions.create", input), rename: (sessionId, title) => invoke("sessions.rename", { sessionId, title }), remove: (sessionId, revision) => invoke("sessions.remove", { sessionId, ...(revision ? { revision } : {}) }),
    },
    sessionOrganizer: {
      get: () => invoke("session-organizer.get", {}),
      setPinned: (sessionId, pinned) => invoke("session-organizer.set-pinned", { sessionId, pinned }),
      createGroup: (name) => invoke("session-organizer.create-group", { name }),
      renameGroup: (groupId, name) => invoke("session-organizer.rename-group", { groupId, name }),
      assignGroup: (sessionId, groupId) => invoke("session-organizer.assign-group", { sessionId, groupId }),
    },
    chat: {
      list: (sessionId, page = {}) => invoke("chat.list", { sessionId, ...page }),
      get: (sessionId, messageId) => invoke("chat.get", { sessionId, messageId }),
      watch: (sessionId, signal) => subscribe("chat.watch", { sessionId }, signal),
      send: (input, signal) => {
        const queue = new EventQueue<MessageEvent>(true);
        const state: SendQueueState = { queue, cancelStreamRequested: false };
        return (async function* () {
          let runId: string | undefined;
          let cancelPending: (() => void) | undefined;
          try {
            if (signal?.aborted) return;
            sendQueues.get(input.clientRequestId)?.queue.cancel();
            sendQueues.set(input.clientRequestId, state);
            const pending = invoke<{ runId: string }>("chat.send", input);
            cancelPending = () => {
              if (sendQueues.get(input.clientRequestId) !== state) {
                queue.cancel();
                return;
              }
              queue.cancel();
              state.cancelStreamRequested = true;
              void invokeRaw("chat.cancel-stream", { clientRequestId: input.clientRequestId }).catch(() => undefined);
            };
            signal?.addEventListener("abort", cancelPending, { once: true });
            let accepted: { runId: string };
            try {
              accepted = await pending;
            } catch (error) {
              if (signal?.aborted) return;
              throw error;
            }
            runId = accepted.runId;
            if (signal?.aborted) return;
            while (true) {
              const next = await queue.next(signal);
              if (next.done) return;
              yield next.value;
            }
          } finally {
            if (cancelPending) signal?.removeEventListener("abort", cancelPending);
            const ownsStream = sendQueues.get(input.clientRequestId) === state;
            if (ownsStream) sendQueues.delete(input.clientRequestId);
            if (ownsStream && signal?.aborted && runId) await invokeRaw("chat.abort", { runId }).catch(() => undefined);
            if (ownsStream && !state.cancelStreamRequested) {
              await invokeRaw("chat.cancel-stream", { clientRequestId: input.clientRequestId }).catch(() => undefined);
            }
          }
        })();
      },
      abort: (runId) => invoke("chat.abort", { runId }),
    },
    tools: { list: () => invoke("tools.list", {}), getCall: (toolCallId) => invoke("tools.get-call", { toolCallId }) },
    approvals: {
      listPending: (sessionId) => invoke("approvals.list-pending", { ...(sessionId ? { sessionId } : {}) }),
      resolveExec: (input) => invoke("approvals.resolve-exec", input), resolvePlugin: (input) => invoke("approvals.resolve-plugin", input),
    },
    models: { list: () => invoke("models.list", {}), selectForSession: (sessionId, modelId) => invoke("models.select-for-session", { sessionId, modelId }) },
    skills: { list: () => invoke("skills.list", {}) }, channels: { list: () => invoke("channels.list", {}) },
    files: { list: (parentId, page = {}) => invoke("files.list", { ...(parentId ? { parentId } : {}), ...page }), readText: (fileId) => invoke("files.read-text", { fileId }) },
    diagnostics: { list: () => invoke("diagnostics.list", {}), listLogs: (page = {}) => invoke("diagnostics.list-logs", page) },
    dispose: () => {
      unsubscribe?.();
      unsubscribe = undefined;
      for (const [subscriptionId, queue] of subscriptionQueues) {
        queue.cancel();
        void invokeRaw("subscriptions.cancel", { subscriptionId }).catch(() => undefined);
      }
      subscriptionQueues.clear();
      for (const [clientRequestId, state] of sendQueues) {
        state.queue.cancel();
        void invokeRaw("chat.cancel-stream", { clientRequestId }).catch(() => undefined);
      }
      sendQueues.clear();
    },
  };
}
