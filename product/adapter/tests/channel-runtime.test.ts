import type { ChannelConfigEntry } from "@uclaw/shared";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { OpenClawClient, type OpenClawTransport } from "../src/openclaw-client.js";
import type { HelloOk } from "../src/transport/gateway-websocket.js";
import type { EventFrame, JsonValue } from "../src/transport/rpc-router.js";

class ChannelTransport implements OpenClawTransport {
  state = "idle" as const;
  readonly requests: Array<{ method: string; params: JsonValue; signal?: AbortSignal }> = [];
  readonly responses = new Map<string, JsonValue[]>();
  readonly errors = new Map<string, Error[]>();

  async connect(): Promise<HelloOk> {
    return {
      type: "hello-ok",
      protocol: 4,
      server: { version: "2026.7.1-2" },
      features: { methods: ["config.get", "config.patch", "channels.status", "channels.start", "channels.stop"], events: [] },
      policy: { maxPayload: 65_536, maxBufferedBytes: 131_072 },
    };
  }

  close(): void {}

  readonly router = {
    request: async <T>(method: string, params: JsonValue, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> => {
      this.requests.push({ method, params, signal });
      const error = this.errors.get(method)?.shift();
      if (error !== undefined) throw error;
      return schema.parse(this.responses.get(method)?.shift());
    },
    onEvent: (_event: string, _listener: (frame: EventFrame) => void) => () => undefined,
    onSequenceGap: (_listener: (gap: { expected: number; received: number }) => void) => () => undefined,
    onClose: (_listener: (error: Error) => void) => () => undefined,
    resetSequence: (_sourceSequence?: number) => undefined,
  };
}

const telegram = (botToken = "fixture.telegram.token"): ChannelConfigEntry => ({
  id: "telegram-main",
  kind: "telegram",
  mode: "bot",
  name: "Telegram",
  enabled: true,
  credentials: { botToken },
});

describe("OpenClawClient channel runtime", () => {
  it("maps channels.status into renderer-safe Telegram summaries", async () => {
    const transport = new ChannelTransport();
    transport.responses.set("channels.status", [{
      ts: 1_786_129_711_211,
      channelOrder: ["telegram"],
      channelLabels: { telegram: "Telegram" },
      channels: { telegram: { configured: true } },
      channelAccounts: { telegram: [{ accountId: "default", enabled: true, configured: true, running: true, connected: true }] },
      channelDefaultAccountId: { telegram: "default" },
    }]);
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    await expect(client.channels.list()).resolves.toEqual([{
      id: "telegram",
      kind: "telegram",
      name: "Telegram",
      configured: true,
      enabled: true,
      state: "connected",
      accountLabel: "default",
      credential: { configured: true },
    }]);
    expect(transport.requests.at(-1)).toMatchObject({ method: "channels.status", params: { channel: "telegram", probe: false } });
  });

  it("patches only Telegram config with current config hash and forwards cancellation", async () => {
    const transport = new ChannelTransport();
    transport.responses.set("config.get", [{ hash: "fixture-config-hash", valid: true }]);
    transport.responses.set("config.patch", [{ ok: true }]);
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    const controller = new AbortController();

    await client.channels.configure(telegram(), controller.signal);

    expect(transport.requests).toEqual([
      { method: "config.get", params: {}, signal: controller.signal },
      {
        method: "config.patch",
        params: {
          raw: JSON.stringify({ channels: { telegram: { accounts: { "telegram-main": { enabled: true, botToken: "fixture.telegram.token" } } } } }),
          baseHash: "fixture-config-hash",
        },
        signal: controller.signal,
      },
    ]);
  });

  it("maps Telegram probe status and never returns upstream error text", async () => {
    const transport = new ChannelTransport();
    transport.responses.set("channels.status", [
      {
        ts: 1_786_129_711_211,
        channelOrder: ["telegram"],
        channelLabels: { telegram: "Telegram" },
        channels: { telegram: { configured: true } },
        channelAccounts: {
          telegram: [{ accountId: "telegram-main", enabled: true, configured: true, running: false, connected: false, lastError: "401 token fixture.telegram.token rejected" }],
        },
        channelDefaultAccountId: { telegram: "telegram-main" },
      },
    ]);
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    const signal = new AbortController().signal;

    await expect(client.channels.test(telegram(), signal)).resolves.toEqual({
      status: "auth-failed",
      error: { category: "authentication", code: "AUTHENTICATION_FAILED", message: "渠道鉴权失败。", retryable: false },
    });
    expect(transport.requests.at(-1)).toEqual({
      method: "channels.status",
      params: { channel: "telegram", probe: true, timeoutMs: 10_000 },
      signal,
    });
  });

  it("starts, stops, removes Telegram and rejects unsupported channel capabilities", async () => {
    const transport = new ChannelTransport();
    transport.responses.set("channels.start", [{ channel: "telegram", accountId: "telegram-main", started: true }]);
    transport.responses.set("channels.stop", [{ channel: "telegram", accountId: "telegram-main", stopped: true }]);
    transport.responses.set("config.get", [{ hash: "remove-hash", valid: true }]);
    transport.responses.set("config.patch", [{ ok: true }]);
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    const signal = new AbortController().signal;

    expect(client.channels.capability("telegram")).toBe(true);
    expect(client.channels.capability("qq-bot")).toBe(false);
    expect(client.channels.capability("feishu")).toBe(false);
    expect(client.channels.capability("wecom")).toBe(false);
    await client.channels.start(telegram(), signal);
    await client.channels.stop(telegram(), signal);
    await client.channels.remove(telegram(), signal);

    expect(transport.requests.slice(-4)).toEqual([
      { method: "channels.start", params: { channel: "telegram", accountId: "telegram-main" }, signal },
      { method: "channels.stop", params: { channel: "telegram", accountId: "telegram-main" }, signal },
      { method: "config.get", params: {}, signal },
      { method: "config.patch", params: { raw: JSON.stringify({ channels: { telegram: { accounts: { "telegram-main": null } } } }), baseHash: "remove-hash" }, signal },
    ]);
  });

  it("does not report Telegram capability before all lifecycle RPC methods are negotiated", async () => {
    const transport = new ChannelTransport();
    transport.connect = async () => ({
      type: "hello-ok", protocol: 4, server: { version: "2026.7.1-2" },
      features: { methods: ["channels.status"], events: [] },
      policy: { maxPayload: 65_536, maxBufferedBytes: 131_072 },
    });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    expect(client.channels.capability("telegram")).toBe(false);
  });

  it("detects the locked personal WeChat plugin but keeps unsafe QR RPC unavailable", async () => {
    const transport = new ChannelTransport();
    transport.responses.set("channels.status", [{
      ts: 1, channelOrder: ["openclaw-weixin"], channelLabels: { "openclaw-weixin": "Weixin" },
      channels: { "openclaw-weixin": { configured: false } }, channelAccounts: { "openclaw-weixin": [] }, channelDefaultAccountId: {},
    }]);
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    const signal = new AbortController().signal;

    await expect(client.channels.wechat.capability(signal)).resolves.toEqual({
      available: false,
      pluginStatus: "installed",
      reason: "OpenClaw 2026.7.1-2 无法安全定向个人微信扫码，且插件 2.4.6 未提供退出 RPC。",
    });
    expect(transport.requests.at(-1)).toEqual({ method: "channels.status", params: { channel: "openclaw-weixin", probe: false }, signal });
  });

  it("reports personal WeChat plugin missing from channel status", async () => {
    const transport = new ChannelTransport();
    transport.responses.set("channels.status", [{ ts: 1, channelOrder: [], channelLabels: {}, channels: {}, channelAccounts: {}, channelDefaultAccountId: {} }]);
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    await expect(client.channels.wechat.capability(new AbortController().signal)).resolves.toMatchObject({ available: false, pluginStatus: "missing" });
  });

  it("prefers a live connected account over a stale lastError", async () => {
    const transport = new ChannelTransport();
    transport.responses.set("channels.status", [{
      ts: 1, channelOrder: ["telegram"], channelLabels: { telegram: "Telegram" }, channels: { telegram: {} },
      channelAccounts: { telegram: [{ accountId: "telegram-main", configured: true, running: true, connected: true, lastError: "401 stale token error" }] },
      channelDefaultAccountId: { telegram: "telegram-main" },
    }]);
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    await expect(client.channels.test(telegram(), new AbortController().signal)).resolves.toEqual({ status: "connected" });
  });

  it("redacts credentials from channel RPC failures", async () => {
    const transport = new ChannelTransport();
    transport.errors.set("config.get", [new Error("401 botToken fixture.telegram.token rejected")]);
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();

    const failure = await client.channels.configure(telegram(), new AbortController().signal).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Channel authentication failed");
    expect(JSON.stringify(failure)).not.toContain("fixture.telegram.token");
  });
});
