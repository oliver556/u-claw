import type { ChannelConfigEntry } from "@uclaw/shared";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { createOpenClawChannelRuntime } from "../src/openclaw-channel-runtime.js";
import type { JsonValue } from "../src/transport/rpc-router.js";

class Router {
  readonly requests: Array<{ method: string; params: JsonValue; signal?: AbortSignal }> = [];
  readonly responses = new Map<string, JsonValue[]>();

  async request<T>(method: string, params: JsonValue, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    this.requests.push({ method, params, signal });
    return schema.parse(this.responses.get(method)?.shift());
  }
}

const channel = (kind: ChannelConfigEntry["kind"], credentials: Record<string, string>, mode: ChannelConfigEntry["mode"] = "bot"): ChannelConfigEntry => ({
  id: `${kind}-main`, kind, name: kind, mode, enabled: true, credentials,
} as ChannelConfigEntry);

const status = (openClawId: string, overrides: Record<string, unknown> = {}, accountId = `${openClawId}-main`) => ({
  ts: 1_786_129_711_211,
  channelOrder: [openClawId],
  channelLabels: { [openClawId]: openClawId },
  channels: { [openClawId]: { configured: true } },
  channelAccounts: { [openClawId]: [{
    accountId, enabled: true, configured: true,
    running: true, connected: true, lastInboundAt: 1_786_129_700_000,
    lastOutboundAt: 1_786_129_710_000, ...overrides,
  }] },
  channelDefaultAccountId: { [openClawId]: accountId },
});

describe("OpenClaw multi-channel runtime", () => {
  it("maps every managed channel kind to its real OpenClaw plugin id", async () => {
    const cases = [
      ["telegram", "telegram", { botToken: "telegram-token" }, "bot"],
      ["qq-bot", "qqbot", { appId: "1024", clientSecret: "qq-secret" }, "app"],
      ["feishu", "feishu", { appId: "cli_x", appSecret: "feishu-secret" }, "websocket"],
      ["wecom", "wecom", { botId: "bot-1", secret: "wecom-secret" }, "websocket"],
      ["discord", "discord", { botToken: "discord-token" }, "bot"],
    ] as const;
    for (const [kind, openClawId, credentials, mode] of cases) {
      const router = new Router();
      router.responses.set("channels.status", [status(openClawId, {}, `${kind}-main`)]);
      const runtime = createOpenClawChannelRuntime({ router, methods: new Set(["channels.status", "channels.start", "channels.stop", "channels.logout", "config.get", "config.patch", "tools.invoke"]) });
      await expect(runtime.status(channel(kind, credentials, mode), false, new AbortController().signal)).resolves.toMatchObject({
        configured: true, enabled: true, status: "connected", runtimeAuthoritative: true,
        pendingAction: "none", lastInboundAt: "2026-08-07T19:08:20.000Z",
      });
      expect(router.requests[0]?.params).toEqual({ channel: openClawId, probe: false });
    }
  });

  it("writes config with CAS then proves authority through channels.status readback", async () => {
    const router = new Router();
    router.responses.set("config.get", [{ hash: "config-hash", valid: true }]);
    router.responses.set("config.patch", [{ ok: true }]);
    router.responses.set("channels.status", [status("discord")]);
    const runtime = createOpenClawChannelRuntime({ router, methods: new Set(["config.get", "config.patch", "channels.status"]) });
    const discord = channel("discord", { botToken: "discord-secret" });

    await runtime.configure(discord, new AbortController().signal);

    expect(router.requests.map(({ method }) => method)).toEqual(["config.get", "config.patch", "channels.status"]);
    expect(router.requests[1]?.params).toEqual({
      raw: JSON.stringify({ channels: { discord: { accounts: { "discord-main": { enabled: true, token: "discord-secret" } } } } }),
      baseHash: "config-hash",
    });
  });

  it("writes QQ Bot allowFrom into its named OpenClaw account", async () => {
    const router = new Router();
    router.responses.set("config.get", [{ hash: "config-hash", valid: true }]);
    router.responses.set("config.patch", [{ ok: true }]);
    router.responses.set("channels.status", [status("qqbot", {}, "qq-bot-main")]);
    const runtime = createOpenClawChannelRuntime({ router, methods: new Set(["config.get", "config.patch", "channels.status"]) });
    const qq = { ...channel("qq-bot", { appId: "1024", clientSecret: "qq-secret" }, "app"), allowFrom: ["user:1", "group:2"] } as ChannelConfigEntry;

    await runtime.configure(qq, new AbortController().signal);

    expect(router.requests[1]?.params).toEqual({
      raw: JSON.stringify({ channels: { qqbot: { accounts: { "qq-bot-main": { enabled: true, appId: "1024", clientSecret: "qq-secret", allowFrom: ["user:1", "group:2"] } } } } }),
      baseHash: "config-hash",
    });
  });

  it("reconciles config after the Gateway restarts during config.patch", async () => {
    const router = new Router();
    router.responses.set("config.get", [{ hash: "config-hash", valid: true }]);
    router.responses.set("channels.status", [status("discord")]);
    let reconnected = false;
    router.request = async <T>(method: string, params: JsonValue, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> => {
      router.requests.push({ method, params, signal });
      if (method === "config.patch") throw new Error("Gateway connection closed");
      if (method === "channels.status" && !reconnected) throw new Error("Gateway connection closed");
      return schema.parse(router.responses.get(method)?.shift());
    };
    const runtime = createOpenClawChannelRuntime({
      router,
      methods: new Set(["config.get", "config.patch", "channels.status"]),
      reconnect: async () => { reconnected = true; },
    });

    await expect(runtime.configure(channel("discord", { botToken: "discord-secret" }), new AbortController().signal)).resolves.toBeUndefined();
    expect(reconnected).toBe(true);
    expect(router.requests.map(({ method }) => method)).toEqual(["config.get", "config.patch", "channels.status", "channels.status", "channels.status"]);
  });

  it("uses channels.logout and the formal message tool for send, action and poll", async () => {
    const router = new Router();
    router.responses.set("channels.logout", [{ channel: "discord", accountId: "discord-main", loggedOut: true }]);
    router.responses.set("tools.invoke", [
      { ok: true, toolName: "message", output: { content: [{ type: "text", text: "sent" }] }, source: "core" },
      { ok: true, toolName: "message", output: { content: [{ type: "text", text: "reacted" }] }, source: "core" },
      { ok: true, toolName: "message", output: { content: [{ type: "text", text: "polled" }] }, source: "core" },
    ]);
    router.responses.set("channels.status", [status("discord", { configured: false, running: false, connected: false }), status("discord"), status("discord"), status("discord")]);
    const runtime = createOpenClawChannelRuntime({ router, methods: new Set(["channels.logout", "channels.status", "tools.invoke"]) });
    const discord = channel("discord", { botToken: "discord-secret" });
    const signal = new AbortController().signal;

    await runtime.logout(discord, signal);
    await runtime.send(discord, { target: "channel:123", message: "hello" }, signal);
    await runtime.action(discord, { target: "channel:123", action: "react", messageId: "message-1", emoji: ":thumbsup:" }, signal);
    await runtime.poll(discord, { target: "channel:123", question: "Ship?", options: ["Yes", "No"], multiple: false }, signal);

    expect(router.requests).toMatchObject([
      { method: "channels.logout", params: { channel: "discord", accountId: "discord-main" } },
      { method: "channels.status", params: { channel: "discord", probe: false } },
      { method: "tools.invoke", params: { name: "message", args: { action: "send", channel: "discord", accountId: "discord-main", target: "channel:123", message: "hello" } } },
      { method: "channels.status", params: { channel: "discord", probe: false } },
      { method: "tools.invoke", params: { name: "message", args: { action: "react", channel: "discord", accountId: "discord-main", target: "channel:123", messageId: "message-1", emoji: ":thumbsup:" } } },
      { method: "channels.status", params: { channel: "discord", probe: false } },
      { method: "tools.invoke", params: { name: "message", args: { action: "poll", channel: "discord", accountId: "discord-main", target: "channel:123", pollQuestion: "Ship?", pollOption: ["Yes", "No"], pollMulti: false } } },
      { method: "channels.status", params: { channel: "discord", probe: false } },
    ]);
  });

  it("does not invent success when plugin or tool runtime is unavailable", async () => {
    const router = new Router();
    router.responses.set("channels.status", [{ ...status("feishu"), channelOrder: [], channels: {}, channelAccounts: {}, channelDefaultAccountId: {} }]);
    const runtime = createOpenClawChannelRuntime({ router, methods: new Set(["channels.status"]) });
    const feishu = channel("feishu", { appId: "cli_x", appSecret: "secret" }, "websocket");
    await expect(runtime.status(feishu, true, new AbortController().signal)).resolves.toMatchObject({
      configured: false, status: "needs-action", pendingAction: "install-plugin", runtimeAuthoritative: true,
    });
    await expect(runtime.send(feishu, { target: "ou_1", message: "hello" }, new AbortController().signal)).rejects.toThrow("tools.invoke");
  });

  it("redacts upstream credential failures", async () => {
    const router = new Router();
    router.request = async () => { throw new Error("401 token discord-secret rejected"); };
    const runtime = createOpenClawChannelRuntime({ router, methods: new Set(["channels.status"]) });
    const failure = await runtime.status(channel("discord", { botToken: "discord-secret" }), true, new AbortController().signal).catch((error: unknown) => error);
    expect((failure as Error).message).toBe("Channel authentication failed");
    expect(String(failure)).not.toContain("discord-secret");
  });
});
