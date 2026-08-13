import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createChatQueueStore, resolveChatQueuePath } from "../src/chat-queue/store.js";

const roots: string[] = [];
const now = () => new Date("2026-08-14T02:00:00.000Z");

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "uclaw-chat-queue-"));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("chat queue store", () => {
  it("lists, adds, updates, and removes FIFO items per session", async () => {
    const dataRoot = await root();
    let nextId = 0;
    const store = createChatQueueStore(dataRoot, { now, createId: () => `queue-${++nextId}` });

    const first = await store.add({ sessionId: "session-1", text: "first", attachmentIds: ["attachment-1"], idempotencyKey: "queue:key:first" });
    await expect(store.attachmentReferenceCount("attachment-1")).resolves.toBe(1);
    await expect(store.referencedAttachmentIds()).resolves.toEqual(new Set(["attachment-1"]));
    const second = await store.add({ sessionId: "session-1", text: "second", attachmentIds: [], modelId: "model-1", skillId: "skill-1", idempotencyKey: "queue:key:second" });
    await store.add({ sessionId: "session-2", text: "other", attachmentIds: [], idempotencyKey: "queue:key:other" });
    await expect(store.listSessionIds()).resolves.toEqual(["session-1", "session-2"]);

    expect((await store.list("session-1")).items.map(({ id }) => id)).toEqual([first.id, second.id]);
    expect(await store.update({ sessionId: "session-1", itemId: first.id, text: "edited", attachmentIds: ["attachment-2"] }))
      .toMatchObject({ id: first.id, text: "edited", attachmentIds: ["attachment-2"], idempotencyKey: "queue:key:first" });
    await expect(store.attachmentReferenceCount("attachment-1")).resolves.toBe(0);
    await expect(store.attachmentReferenceCount("attachment-2")).resolves.toBe(1);
    await expect(store.referencedAttachmentIds()).resolves.toEqual(new Set(["attachment-2"]));
    await store.remove("session-1", first.id);
    expect((await store.list("session-1")).items.map(({ id }) => id)).toEqual([second.id]);
    await expect(store.attachmentReferenceCount("attachment-1")).resolves.toBe(0);
    await expect(store.attachmentReferenceCount("attachment-2")).resolves.toBe(0);
  });

  it("reloads authoritative state across store instances", async () => {
    const dataRoot = await root();
    const first = createChatQueueStore(dataRoot, { now, createId: () => "queue-1" });
    const second = createChatQueueStore(dataRoot, { now, createId: () => "queue-2" });
    await first.add({ sessionId: "session-1", text: "one", attachmentIds: [], idempotencyKey: "queue:key:one" });
    expect((await second.list("session-1")).items).toHaveLength(1);
    await second.add({ sessionId: "session-1", text: "two", attachmentIds: [], idempotencyKey: "queue:key:two" });
    expect((await first.list("session-1")).items.map(({ id }) => id)).toEqual(["queue-1", "queue-2"]);
  });

  it("fails closed on corrupt persisted data", async () => {
    const dataRoot = await root();
    const path = resolveChatQueuePath(dataRoot, "session-1");
    await mkdir(join(dataRoot, "uclaw", "chat-queue"), { recursive: true });
    await writeFile(path, "{broken", "utf8");
    const store = createChatQueueStore(dataRoot, { now });
    await expect(store.list("session-1")).rejects.toThrow("could not be read");
    await expect(store.add({ sessionId: "session-1", text: "lost", attachmentIds: [], idempotencyKey: "queue:key:lost" })).rejects.toThrow("could not be read");
    expect(await readFile(path, "utf8")).toBe("{broken");
  });

  it("does not automatically claim failed items", async () => {
    const dataRoot = await root();
    const store = createChatQueueStore(dataRoot, { now, createId: () => "queue-1" });
    await store.add({ sessionId: "session-1", text: "failed", attachmentIds: [], idempotencyKey: "queue:key:failed" });
    await store.fail("session-1", "queue-1", { code: "OPERATION_FAILED", message: "failed", retryable: true });
    await expect(store.claimNext("session-1")).resolves.toBeNull();
    await expect(store.claim("session-1", "queue-1")).resolves.toMatchObject({ status: "sending", idempotencyKey: "queue:key:failed" });
  });

  it("recovers a persisted sending head with its stable idempotency key", async () => {
    const dataRoot = await root();
    const first = createChatQueueStore(dataRoot, { now, createId: () => "queue-1" });
    await first.add({ sessionId: "session-1", text: "sending", attachmentIds: [], idempotencyKey: "queue:key:recovery" });
    await first.claimNext("session-1");
    const restarted = createChatQueueStore(dataRoot, { now });
    await expect(restarted.claimNext("session-1")).resolves.toMatchObject({
      id: "queue-1", status: "sending", idempotencyKey: "queue:key:recovery",
    });
    await expect(restarted.update({ sessionId: "session-1", itemId: "queue-1", text: "too late" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(restarted.remove("session-1", "queue-1")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(restarted.acknowledge("session-1", "queue-1")).resolves.toBeUndefined();
  });

  it("serializes reference changes and atomic replacements", async () => {
    const dataRoot = await root();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const store = createChatQueueStore(dataRoot, {
      now,
      createId: (() => { let id = 0; return () => `queue-${++id}`; })(),
      replace: async (source, target) => {
        order.push(`replace-${order.length + 1}`);
        if (order.length === 1) await firstBlocked;
        const { rename } = await import("node:fs/promises");
        await rename(source, target);
      },
    });
    const first = store.add({ sessionId: "session-1", text: "one", attachmentIds: ["a-1"], idempotencyKey: "queue:key:one" });
    const second = store.add({ sessionId: "session-1", text: "two", attachmentIds: ["a-2"], idempotencyKey: "queue:key:two" });
    await vi.waitFor(() => expect(order).toEqual(["replace-1"]));
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["replace-1", "replace-2"]);
    expect((await store.list("session-1")).items).toHaveLength(2);
  });
});
