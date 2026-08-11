import { describe, expect, it } from "vitest";

import { ChannelConfigEntrySchema, ChannelDraftSchema, ChannelIpcRequestSchema, ChannelIpcResponseSchema, ChannelKindSchema, ChannelSnapshotSchema } from "../src/channels.js";

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
    expect(ChannelDraftSchema.parse({ id: "qq-main", kind: "qq-bot", name: "QQ Bot", enabled: true, mode: "app", allowFrom: ["user:1"], credentials: { appId: "1024", clientSecret: "secret" } })).toMatchObject({ kind: "qq-bot", allowFrom: ["user:1"] });
    expect(ChannelDraftSchema.safeParse({ id: "qq-main", kind: "qq-personal", name: "QQ", enabled: true, mode: "app", credentials: {} }).success).toBe(false);
    expect(ChannelDraftSchema.safeParse({ id: "qq-main", kind: "qq-bot", name: "QQ Bot", enabled: true, mode: "app", allowFrom: [""], credentials: { appId: "1024", clientSecret: "secret" } }).success).toBe(false);
  });

  it("supports Discord bot credentials as a first-class managed channel", () => {
    expect(ChannelKindSchema.safeParse("discord").success).toBe(true);
    expect(ChannelDraftSchema.parse({
      id: "discord-main", kind: "discord", name: "Discord", enabled: true,
      mode: "bot", credentials: { botToken: "discord-token" },
    }).kind).toBe("discord");
  });

  it("never accepts full credentials in renderer snapshots", () => {
    expect(ChannelSnapshotSchema.safeParse({ schemaVersion: 1, channels: [{ id: "telegram-main", kind: "telegram", name: "Telegram", mode: "bot", configured: true, enabled: true, status: "pending-verification", capability: "available", credentials: { botToken: "secret" } }] }).success).toBe(false);
  });

  it("defines cancel by operation request id", () => {
    expect(ChannelIpcRequestSchema.parse({ method: "channels.cancel", requestId: "cancel-1", params: { operationRequestId: "test-1" } })).toMatchObject({ params: { operationRequestId: "test-1" } });
  });

  it("defines logout, send, action and poll without accepting arbitrary tool arguments", () => {
    const requests = [
      { method: "channels.logout", requestId: "logout-1", params: { channelId: "discord-main" } },
      { method: "channels.send", requestId: "send-1", params: { channelId: "discord-main", target: "channel:123", message: "hello" } },
      { method: "channels.action", requestId: "action-1", params: { channelId: "discord-main", target: "channel:123", action: "react", messageId: "message-1", emoji: ":thumbsup:" } },
      { method: "channels.poll", requestId: "poll-1", params: { channelId: "discord-main", target: "channel:123", question: "Ship?", options: ["Yes", "No"], multiple: false } },
    ];
    for (const request of requests) expect(ChannelIpcRequestSchema.safeParse(request).success).toBe(true);
    expect(ChannelIpcRequestSchema.safeParse({
      method: "channels.action", requestId: "bad-action", params: { channelId: "discord-main", target: "channel:123", action: "exec", command: "rm" },
    }).success).toBe(false);
  });

  it("accepts runtime-authoritative health and activity without raw runtime details", () => {
    const parsed = ChannelSnapshotSchema.parse({
      schemaVersion: 1,
      channels: [{
        id: "discord-main", kind: "discord", name: "Discord", mode: "bot",
        configured: true, enabled: true, status: "connected", capability: "available",
        credentialHints: { botToken: "...7890" }, runtimeAuthoritative: true,
        pendingAction: "none", lastInboundAt: "2026-08-11T12:00:00.000Z",
        lastOutboundAt: "2026-08-11T12:01:00.000Z",
      }],
    });
    expect(parsed.channels[0]).toMatchObject({ runtimeAuthoritative: true, pendingAction: "none" });
    expect(ChannelSnapshotSchema.safeParse({
      ...parsed,
      channels: [{ ...parsed.channels[0], runtime: { token: "secret" } }],
    }).success).toBe(false);
  });

  it("keeps personal WeChat distinct and exposes QR lifecycle through channel IPC", () => {
    expect(ChannelKindSchema.safeParse("wechat-personal").success).toBe(true);
    const requests = [
      { method: "channels.wechat-status", requestId: "status-1", params: {} },
      { method: "channels.wechat-login-start", requestId: "start-1", params: { force: false } },
      { method: "channels.wechat-login-poll", requestId: "poll-1", params: { flowId: "flow-1", qrGeneration: 1 } },
      { method: "channels.wechat-login-refresh", requestId: "refresh-1", params: { flowId: "flow-1", qrGeneration: 1 } },
      { method: "channels.wechat-login-cancel", requestId: "cancel-1", params: { flowId: "flow-1" } },
      { method: "channels.wechat-reconnect", requestId: "reconnect-1", params: {} },
      { method: "channels.wechat-logout", requestId: "logout-1", params: {} },
    ];
    for (const request of requests) expect(ChannelIpcRequestSchema.safeParse(request).success).toBe(true);
  });

  it("accepts only renderer-safe QR images and masked account state", () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==";
    const base = {
      method: "channels.wechat-login-start",
      requestId: "start-1",
      ok: true,
      result: {
        channelId: "wechat-personal",
        status: "pending-verification",
        loginState: "awaiting-scan",
        capability: "available",
        plugin: { id: "openclaw-weixin", requiredVersion: "2.4.6", status: "installed" },
        flowId: "flow-1",
        qrGeneration: 1,
        qrExpiresAt: "2026-08-09T09:05:00.000Z",
      },
    } as const;
    expect(ChannelIpcResponseSchema.safeParse({
      ...base,
      result: { ...base.result, qrImage: { kind: "data-url", value: png } },
    }).success).toBe(true);
    expect(ChannelIpcResponseSchema.safeParse({
      ...base,
      result: { ...base.result, qrImage: { kind: "data-url", value: `data:image/png;base64,${"A".repeat(64)}` } },
    }).success).toBe(false);
    expect(ChannelIpcResponseSchema.safeParse({
      ...base,
      result: { ...base.result, qrImage: { kind: "temporary-file", id: "wechat-qr-flow-1-1" } },
    }).success).toBe(false);
    for (const value of ["/Users/name/secret.png", "C:\\Users\\name\\secret.png", "https://evil.example/qr.png", "data:text/html;base64,AAAA"]) {
      expect(ChannelIpcResponseSchema.safeParse({ ...base, result: { ...base.result, qrImage: { kind: "data-url", value } } }).success).toBe(false);
    }
    expect(ChannelIpcResponseSchema.safeParse({
      ...base,
      result: { ...base.result, loginState: "connected", status: "connected", account: { displayName: "微信账号", accountIdHint: "...7a2f" }, token: "secret" },
    }).success).toBe(false);
  });
});
