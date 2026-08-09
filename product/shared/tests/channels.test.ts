import { describe, expect, it } from "vitest";

import { ChannelConfigEntrySchema, ChannelDraftSchema, ChannelIpcRequestSchema, ChannelSnapshotSchema } from "../src/channels.js";

describe("channel contracts", () => {
  it("accepts persisted runtime status while keeping credentials strict", () => {
    expect(ChannelConfigEntrySchema.parse({
      id: "telegram-main", kind: "telegram", name: "Telegram", enabled: true, mode: "bot",
      credentials: { botToken: "fixture-token" }, status: "connected", lastCheckedAt: "2026-08-09T08:00:00.000Z",
    }).status).toBe("connected");
    expect(ChannelConfigEntrySchema.safeParse({
      id: "telegram-main", kind: "telegram", name: "Telegram", enabled: true, mode: "bot",
      credentials: { botToken: "fixture-token", leaked: "no" }, status: "connected",
    }).success).toBe(false);
  });
  it("requires mode-specific Feishu webhook credentials", () => {
    const base = { id: "feishu-main", kind: "feishu", name: "飞书", enabled: true, mode: "webhook" };
    expect(ChannelDraftSchema.safeParse({ ...base, credentials: { appId: "cli_x", appSecret: "secret" } }).success).toBe(false);
    expect(ChannelDraftSchema.safeParse({ ...base, credentials: { appId: "cli_x", appSecret: "secret", verificationToken: "verify", encryptKey: "encrypt" } }).success).toBe(true);
  });

  it("keeps QQ Bot distinct from personal QQ", () => {
    expect(ChannelDraftSchema.parse({ id: "qq-main", kind: "qq-bot", name: "QQ Bot", enabled: true, mode: "app", credentials: { appId: "1024", clientSecret: "secret" } }).kind).toBe("qq-bot");
    expect(ChannelDraftSchema.safeParse({ id: "qq-main", kind: "qq-personal", name: "QQ", enabled: true, mode: "app", credentials: {} }).success).toBe(false);
  });

  it("never accepts full credentials in renderer snapshots", () => {
    expect(ChannelSnapshotSchema.safeParse({ schemaVersion: 1, channels: [{ id: "telegram-main", kind: "telegram", name: "Telegram", mode: "bot", configured: true, enabled: true, status: "pending-verification", capability: "available", credentials: { botToken: "secret" } }] }).success).toBe(false);
  });

  it("defines cancel by operation request id", () => {
    expect(ChannelIpcRequestSchema.parse({ method: "channels.cancel", requestId: "cancel-1", params: { operationRequestId: "test-1" } })).toMatchObject({ params: { operationRequestId: "test-1" } });
  });
});
