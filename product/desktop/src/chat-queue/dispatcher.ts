import {
  UClawErrorSchema,
  type ChatQueueItem,
  type MessageEvent,
  type SendMessageInput,
  type UClawError,
} from "@uclaw/shared";

import type { ChatQueueStore } from "./store.js";

export interface ChatQueueDispatcher {
  sessionIdle(sessionId: string): Promise<void>;
  send(sessionId: string, itemId: string): Promise<ChatQueueItem>;
  gatewayAvailable(): Promise<void>;
  setSessionActive(sessionId: string, active: boolean): void;
  acquireSessionActivity(sessionId: string): Promise<() => void>;
}

interface ChatQueueDispatcherOptions {
  store: ChatQueueStore;
  send(input: SendMessageInput): AsyncIterable<MessageEvent> | Promise<AsyncIterable<MessageEvent>>;
  isGatewayAvailable(): boolean | Promise<boolean>;
}

function inputFor(item: ChatQueueItem): SendMessageInput {
  return {
    sessionId: item.sessionId,
    clientRequestId: item.idempotencyKey,
    blocks: [
      ...(item.text === "" ? [] : [{ type: "text" as const, text: item.text, format: "plain" as const }]),
      ...item.attachmentIds.map((attachmentId) => ({ type: "attachment" as const, attachmentId })),
    ],
    ...(item.modelId === undefined ? {} : { modelId: item.modelId }),
    ...(item.skillId === undefined ? {} : { skillId: item.skillId }),
  };
}

function disconnected(error: UClawError): boolean {
  return error.code === "GATEWAY_DISCONNECTED" || error.code === "UNAVAILABLE";
}

export function createChatQueueDispatcher(options: ChatQueueDispatcherOptions): ChatQueueDispatcher {
  const flights = new Map<string, Promise<void>>();
  const waiting = new Set<string>();
  const activeSessions = new Map<string, number>();

  const deliver = async (item: ChatQueueItem): Promise<"success" | "failed" | "offline"> => {
    try {
      const stream = await options.send(inputFor(item));
      let terminal: MessageEvent | undefined;
      for await (const event of stream) {
        if (event.type === "final" || event.type === "aborted" || event.type === "error") terminal = event;
      }
      if (terminal?.type === "final") {
        await options.store.acknowledge(item.sessionId, item.id);
        return "success";
      }
      if (terminal?.type === "error" && disconnected(terminal.error)) {
        await options.store.restore(item.sessionId, item.id);
        return "offline";
      }
      const error = terminal?.type === "error"
        ? terminal.error
        : UClawErrorSchema.parse({ code: "OPERATION_FAILED", message: terminal?.type === "aborted" ? terminal.reason ?? "Queued message was aborted." : "Queued message ended without a terminal result.", retryable: true, recoveryActions: ["retry"], causeDetails: {} });
      await options.store.fail(item.sessionId, item.id, { code: error.code, message: error.message, retryable: error.retryable });
      return "failed";
    } catch (cause) {
      const parsed = UClawErrorSchema.safeParse(cause);
      if (parsed.success && disconnected(parsed.data)) await options.store.restore(item.sessionId, item.id);
      else {
        const error = parsed.success ? parsed.data : UClawErrorSchema.parse({ code: "OPERATION_FAILED", message: "Queued message could not be sent.", retryable: true, recoveryActions: ["retry"], causeDetails: {} });
        await options.store.fail(item.sessionId, item.id, { code: error.code, message: error.message, retryable: error.retryable });
      }
      return parsed.success && disconnected(parsed.data) ? "offline" : "failed";
    }
  };

  const singleFlight = async <T>(sessionId: string, operation: () => Promise<T>): Promise<T | undefined> => {
    if (flights.has(sessionId)) {
      await flights.get(sessionId);
      return undefined;
    }
    const result = operation();
    const flight = result.then(() => undefined, () => undefined);
    flights.set(sessionId, flight);
    try {
      return await result;
    } finally {
      if (flights.get(sessionId) === flight) flights.delete(sessionId);
    }
  };

  const releaseActivity = (sessionId: string): void => {
    const remaining = Math.max(0, (activeSessions.get(sessionId) ?? 0) - 1);
    if (remaining > 0) {
      activeSessions.set(sessionId, remaining);
      return;
    }
    activeSessions.delete(sessionId);
    void (async () => {
      if (!waiting.has(sessionId)) return;
      waiting.delete(sessionId);
      await singleFlight(sessionId, async () => {
        while ((activeSessions.get(sessionId) ?? 0) === 0 && await options.isGatewayAvailable()) {
          const item = await options.store.claimNext(sessionId);
          if (!item) return;
          if (await deliver(item) === "offline") {
            waiting.add(sessionId);
            return;
          }
        }
        if ((activeSessions.get(sessionId) ?? 0) > 0 || !await options.isGatewayAvailable()) waiting.add(sessionId);
      });
    })().catch(() => waiting.add(sessionId));
  };

  return {
    sessionIdle: async (sessionId) => {
      if ((activeSessions.get(sessionId) ?? 0) > 0) {
        waiting.add(sessionId);
        return;
      }
      if (!await options.isGatewayAvailable()) {
        waiting.add(sessionId);
        return;
      }
      waiting.delete(sessionId);
      await singleFlight(sessionId, async () => {
        while (await options.isGatewayAvailable()) {
          if ((activeSessions.get(sessionId) ?? 0) > 0) {
            waiting.add(sessionId);
            return;
          }
          const item = await options.store.claimNext(sessionId);
          if (!item) return;
          if (await deliver(item) === "offline") {
            waiting.add(sessionId);
            return;
          }
        }
        waiting.add(sessionId);
      });
    },
    send: async (sessionId, itemId) => {
      const result = await singleFlight(sessionId, async () => {
        if (!await options.isGatewayAvailable()) throw UClawErrorSchema.parse({ code: "UNAVAILABLE", message: "Gateway is offline.", retryable: true, recoveryActions: ["retry"], causeDetails: {} });
        const item = await options.store.claim(sessionId, itemId);
        await deliver(item);
        return item;
      });
      if (!result) throw UClawErrorSchema.parse({ code: "CONFLICT", message: "This session already has an active queued send.", retryable: true, recoveryActions: ["retry"], causeDetails: {} });
      return result;
    },
    gatewayAvailable: async () => {
      const persisted = await options.store.listSessionIds();
      await Promise.all([...new Set([...waiting, ...persisted])].filter((sessionId) => (activeSessions.get(sessionId) ?? 0) === 0).map((sessionId) => {
        waiting.delete(sessionId);
        return singleFlight(sessionId, async () => {
          while (await options.isGatewayAvailable()) {
            if ((activeSessions.get(sessionId) ?? 0) > 0) {
              waiting.add(sessionId);
              return;
            }
            const item = await options.store.claimNext(sessionId);
            if (!item) return;
            if (await deliver(item) === "offline") {
              waiting.add(sessionId);
              return;
            }
          }
          waiting.add(sessionId);
        });
      }));
    },
    setSessionActive: (sessionId, active) => {
      if (active) {
        activeSessions.set(sessionId, (activeSessions.get(sessionId) ?? 0) + 1);
        return;
      }
      releaseActivity(sessionId);
    },
    acquireSessionActivity: async (sessionId) => {
      await flights.get(sessionId);
      activeSessions.set(sessionId, (activeSessions.get(sessionId) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseActivity(sessionId);
      };
    },
  };
}
