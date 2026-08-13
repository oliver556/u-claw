import { describe, expect, it } from "vitest";

import {
  ChatQueueAddRequestSchema,
  ChatQueueDocumentSchema,
  ChatQueueItemSchema,
  ChatQueueRemoveRequestSchema,
  ChatQueueSendRequestSchema,
  ChatQueueUpdateRequestSchema,
} from "../src/index.js";

const queuedItem = {
  id: "queue-1",
  sessionId: "session-1",
  text: "继续分析这个视频",
  attachmentIds: ["attachment-1"],
  modelId: "model-1",
  skillId: "skill-1",
  status: "queued",
  idempotencyKey: "queue:session-1:item-1",
  createdAt: "2026-08-13T10:00:00.000Z",
  updatedAt: "2026-08-13T10:00:00.000Z",
} as const;

describe("chat queue contracts", () => {
  it("keeps text, attachment references, model, skill, status, and a stable idempotency key together", () => {
    expect(ChatQueueItemSchema.parse(queuedItem)).toEqual(queuedItem);
    expect(() => ChatQueueItemSchema.parse({ ...queuedItem, idempotencyKey: "short" })).toThrow();
    expect(() => ChatQueueItemSchema.parse({ ...queuedItem, attachmentIds: ["attachment-1", "attachment-1"] })).toThrow();
  });

  it("models a versioned per-session FIFO document", () => {
    expect(ChatQueueDocumentSchema.parse({
      schemaVersion: 1,
      sessionId: "session-1",
      items: [queuedItem],
    })).toMatchObject({ schemaVersion: 1, sessionId: "session-1", items: [{ id: "queue-1" }] });
    expect(() => ChatQueueDocumentSchema.parse({
      schemaVersion: 1,
      sessionId: "other-session",
      items: [queuedItem],
    })).toThrow();
  });

  it("defines strict add, update, remove, and send requests", () => {
    expect(ChatQueueAddRequestSchema.parse({
      sessionId: "session-1",
      text: queuedItem.text,
      attachmentIds: queuedItem.attachmentIds,
      modelId: queuedItem.modelId,
      skillId: queuedItem.skillId,
      idempotencyKey: queuedItem.idempotencyKey,
    })).toBeTruthy();
    expect(ChatQueueUpdateRequestSchema.parse({
      sessionId: "session-1",
      itemId: "queue-1",
      text: "更新后的消息",
      attachmentIds: [],
    })).toBeTruthy();
    expect(ChatQueueRemoveRequestSchema.parse({ sessionId: "session-1", itemId: "queue-1" })).toBeTruthy();
    expect(ChatQueueSendRequestSchema.parse({ sessionId: "session-1", itemId: "queue-1" })).toBeTruthy();
    expect(() => ChatQueueUpdateRequestSchema.parse({
      sessionId: "session-1",
      itemId: "queue-1",
      idempotencyKey: "replacement-key",
    })).toThrow();
  });

  it("retains a retryable failure without changing the idempotency key", () => {
    expect(ChatQueueItemSchema.parse({
      ...queuedItem,
      status: "failed",
      error: { code: "UNAVAILABLE", message: "Gateway 离线", retryable: true },
    })).toMatchObject({
      status: "failed",
      idempotencyKey: queuedItem.idempotencyKey,
      error: { code: "UNAVAILABLE", retryable: true },
    });
  });
});
