import { describe, expect, it, vi } from "vitest";

import type { ChatQueueItem, MessageEvent } from "@uclaw/shared";

import { createChatQueueDispatcher } from "../src/chat-queue/dispatcher.js";
import { CHAT_QUEUE_IPC_CHANNEL } from "../src/ipc/channels.js";
import { registerIpc } from "../src/ipc/register-ipc.js";

const item = (status: ChatQueueItem["status"] = "queued"): ChatQueueItem => ({
  id: "queue-1", sessionId: "session-1", text: "next", attachmentIds: ["attachment-1"],
  modelId: "model-1", skillId: "skill-1", status, idempotencyKey: "queue:key:stable",
  createdAt: "2026-08-14T02:00:00.000Z", updatedAt: "2026-08-14T02:00:00.000Z",
  ...(status === "failed" ? { error: { code: "OPERATION_FAILED", message: "failed", retryable: true } } : {}),
});

async function* events(...values: MessageEvent[]): AsyncIterable<MessageEvent> {
  yield* values;
}

const finalEvent = (): MessageEvent => ({
  type: "final", runId: "run-1", message: {
    id: "message-1", sessionId: "session-1", runId: "run-1", role: "assistant", status: "completed",
    blocks: [], createdAt: "2026-08-14T02:00:00.000Z",
  },
});

describe("chat queue dispatcher", () => {
  it("registers authorized queue CRUD and send IPC", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const webContents = { mainFrame: {} };
    const queue = {
      list: vi.fn(async () => ({ schemaVersion: 1, sessionId: "session-1", items: [] })),
      add: vi.fn(async () => item()), update: vi.fn(async () => item()), remove: vi.fn(async () => undefined),
    };
    const dispatcher = { send: vi.fn(async () => item()), sessionIdle: vi.fn(), gatewayAvailable: vi.fn(), setSessionActive: vi.fn(), acquireSessionActivity: vi.fn(async () => vi.fn()) };
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => handlers.set(channel, handler)),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    };
    const dispose = registerIpc({
      ipcMain, authorizedWebContents: webContents,
      windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
      dispatchClient: vi.fn(), chatQueue: queue as any, chatQueueDispatcher: dispatcher,
    });
    expect(CHAT_QUEUE_IPC_CHANNEL).toBe("uclaw:chat-queue");
    const event = { sender: webContents, senderFrame: webContents.mainFrame };
    await expect(handlers.get(CHAT_QUEUE_IPC_CHANNEL)!(event, { method: "chat-queue.list", requestId: "list-1", params: { sessionId: "session-1" } }))
      .resolves.toMatchObject({ method: "chat-queue.list", requestId: "list-1", ok: true, result: { items: [] } });
    await handlers.get(CHAT_QUEUE_IPC_CHANNEL)!(event, { method: "chat-queue.add", requestId: "add-1", params: { sessionId: "session-1", text: "next", attachmentIds: ["attachment-1"], idempotencyKey: "queue:key:stable" } });
    await handlers.get(CHAT_QUEUE_IPC_CHANNEL)!(event, { method: "chat-queue.update", requestId: "update-1", params: { sessionId: "session-1", itemId: "queue-1", text: "edited" } });
    await handlers.get(CHAT_QUEUE_IPC_CHANNEL)!(event, { method: "chat-queue.remove", requestId: "remove-1", params: { sessionId: "session-1", itemId: "queue-1" } });
    await expect(handlers.get(CHAT_QUEUE_IPC_CHANNEL)!(event, { method: "chat-queue.send", requestId: "send-1", params: { sessionId: "session-1", itemId: "queue-1" } }))
      .resolves.toMatchObject({ method: "chat-queue.send", requestId: "send-1", ok: true, result: { id: "queue-1" } });
    expect(queue.add).toHaveBeenCalledOnce();
    expect(queue.update).toHaveBeenCalledOnce();
    expect(queue.remove).toHaveBeenCalledWith("session-1", "queue-1");
    await expect(handlers.get(CHAT_QUEUE_IPC_CHANNEL)!({ sender: {}, senderFrame: {} }, { method: "chat-queue.list", requestId: "bad", params: { sessionId: "session-1" } }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    dispose();
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(CHAT_QUEUE_IPC_CHANNEL);
  });

  it("takes the FIFO head after a session becomes idle and acknowledges terminal success", async () => {
    const store = {
      claimNext: vi.fn().mockResolvedValueOnce(item("sending")).mockResolvedValueOnce(null), acknowledge: vi.fn(async () => undefined),
      fail: vi.fn(), restore: vi.fn(), claim: vi.fn(), listSessionIds: vi.fn(async () => []),
    };
    const send = vi.fn((input: any) => events(finalEvent()));
    const dispatcher = createChatQueueDispatcher({ store: store as any, send, isGatewayAvailable: async () => true });
    await dispatcher.sessionIdle("session-1");
    expect(store.claimNext).toHaveBeenCalledWith("session-1");
    expect(send).toHaveBeenCalledWith({
      sessionId: "session-1", clientRequestId: "queue:key:stable", modelId: "model-1", skillId: "skill-1",
      blocks: [{ type: "text", text: "next", format: "plain" }, { type: "attachment", attachmentId: "attachment-1" }],
    });
    expect(store.acknowledge).toHaveBeenCalledWith("session-1", "queue-1");
  });

  it("continues FIFO dispatch after each queued terminal result", async () => {
    const first = item("sending");
    const second = { ...item("sending"), id: "queue-2", text: "after", idempotencyKey: "queue:key:after" };
    const store = {
      claimNext: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce(null),
      acknowledge: vi.fn(async () => undefined), fail: vi.fn(), restore: vi.fn(), claim: vi.fn(),
      listSessionIds: vi.fn(async () => []),
    };
    const send = vi.fn((input: any) => events(finalEvent()));
    const dispatcher = createChatQueueDispatcher({ store: store as any, send, isGatewayAvailable: async () => true });
    await dispatcher.sessionIdle("session-1");
    expect(send.mock.calls.map(([input]) => input.clientRequestId)).toEqual(["queue:key:stable", "queue:key:after"]);
    expect(store.acknowledge).toHaveBeenCalledTimes(2);
  });

  it("retains terminal failures and retries with the stable idempotency key", async () => {
    const store = {
      claimNext: vi.fn(), claim: vi.fn(async () => item("sending")), acknowledge: vi.fn(),
      fail: vi.fn(async () => undefined), restore: vi.fn(),
      listSessionIds: vi.fn(async () => []),
    };
    const send = vi.fn((input: any) => events({ type: "error", runId: "run-1", error: { code: "OPERATION_FAILED", message: "boom", retryable: true, recoveryActions: [], causeDetails: {} } }));
    const dispatcher = createChatQueueDispatcher({ store: store as any, send, isGatewayAvailable: async () => true });
    await dispatcher.send("session-1", "queue-1");
    await dispatcher.send("session-1", "queue-1");
    expect(store.fail).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([input]) => input.clientRequestId)).toEqual(["queue:key:stable", "queue:key:stable"]);
  });

  it("waits while Gateway is offline without changing queue state", async () => {
    const store = { claimNext: vi.fn(), claim: vi.fn(), acknowledge: vi.fn(), fail: vi.fn(), restore: vi.fn(), listSessionIds: vi.fn(async () => []) };
    const send = vi.fn();
    const dispatcher = createChatQueueDispatcher({ store: store as any, send, isGatewayAvailable: async () => false });
    await dispatcher.sessionIdle("session-1");
    expect(store.claimNext).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("retries waiting sessions when Gateway becomes available", async () => {
    let available = false;
    const store = {
      claimNext: vi.fn().mockResolvedValueOnce(item("sending")).mockResolvedValueOnce(null), claim: vi.fn(),
      acknowledge: vi.fn(async () => undefined), fail: vi.fn(), restore: vi.fn(),
      listSessionIds: vi.fn(async () => ["session-1"]),
    };
    const send = vi.fn(() => events(finalEvent()));
    const dispatcher = createChatQueueDispatcher({ store: store as any, send, isGatewayAvailable: async () => available });
    await dispatcher.sessionIdle("session-1");
    available = true;
    await dispatcher.gatewayAvailable();
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.acknowledge).toHaveBeenCalledWith("session-1", "queue-1");
  });

  it("restores a claimed item when transport disconnects", async () => {
    const store = {
      claimNext: vi.fn().mockResolvedValueOnce(item("sending")).mockResolvedValueOnce(null), claim: vi.fn(), acknowledge: vi.fn(), fail: vi.fn(),
      restore: vi.fn(async () => undefined),
      listSessionIds: vi.fn(async () => []),
    };
    const send = vi.fn(() => events({ type: "error", runId: "run-1", error: { code: "GATEWAY_DISCONNECTED", message: "offline", retryable: true, recoveryActions: [], causeDetails: {} } }));
    const dispatcher = createChatQueueDispatcher({ store: store as any, send, isGatewayAvailable: async () => true });
    await dispatcher.sessionIdle("session-1");
    expect(store.restore).toHaveBeenCalledWith("session-1", "queue-1");
    expect(store.fail).not.toHaveBeenCalled();
  });

  it("allows only one dispatch flight per session", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const store = {
      claimNext: vi.fn().mockResolvedValueOnce(item("sending")).mockResolvedValueOnce(null), claim: vi.fn(), acknowledge: vi.fn(async () => undefined), fail: vi.fn(), restore: vi.fn(),
      listSessionIds: vi.fn(async () => []),
    };
    const send = vi.fn(async function* () { await blocked; yield finalEvent(); });
    const dispatcher = createChatQueueDispatcher({ store: store as any, send, isGatewayAvailable: async () => true });
    const first = dispatcher.sessionIdle("session-1");
    const second = dispatcher.sessionIdle("session-1");
    await vi.waitFor(() => expect(store.claimNext).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not send queued work while an active session flight is running", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const store = {
      claimNext: vi.fn().mockResolvedValueOnce(item("sending")).mockResolvedValueOnce(null),
      claim: vi.fn(async () => item("sending")), acknowledge: vi.fn(async () => undefined), fail: vi.fn(), restore: vi.fn(),
      listSessionIds: vi.fn(async () => []),
    };
    const send = vi.fn(async function* () { await blocked; yield finalEvent(); });
    const dispatcher = createChatQueueDispatcher({ store: store as any, send, isGatewayAvailable: async () => true });
    dispatcher.setSessionActive("session-1", true);
    await dispatcher.sessionIdle("session-1");
    expect(store.claimNext).not.toHaveBeenCalled();
    dispatcher.setSessionActive("session-1", false);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    release();
  });

  it("keeps session active until every overlapping send completes", async () => {
    const store = {
      claimNext: vi.fn().mockResolvedValueOnce(item("sending")).mockResolvedValueOnce(null), claim: vi.fn(),
      acknowledge: vi.fn(async () => undefined), fail: vi.fn(), restore: vi.fn(), listSessionIds: vi.fn(async () => []),
    };
    const send = vi.fn(() => events(finalEvent()));
    const dispatcher = createChatQueueDispatcher({ store: store as any, send, isGatewayAvailable: async () => true });
    dispatcher.setSessionActive("session-1", true);
    dispatcher.setSessionActive("session-1", true);
    await dispatcher.sessionIdle("session-1");
    dispatcher.setSessionActive("session-1", false);
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    dispatcher.setSessionActive("session-1", false);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  });
});
