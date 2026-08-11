import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { OpenClawChannelsFixtureSchema } from "../../adapter/src/index.js";

const fixturePath = resolve(import.meta.dirname, "../../adapter/fixtures/openclaw-2026.7.1-2/channels.json");
const wechatFixturePath = resolve(import.meta.dirname, "../../adapter/fixtures/openclaw-2026.7.1-2/wechat-personal.json");

describe("OpenClaw 2026.7.1-2 channel contract", () => {
  it("locks Telegram RPC shapes and unsupported external adapters", () => {
    const rawText = readFileSync(fixturePath, "utf8");
    const fixture = OpenClawChannelsFixtureSchema.parse(JSON.parse(rawText));

    expect(fixture.status.request.params).toEqual({ channel: "telegram", probe: true, timeoutMs: 10_000 });
    expect(fixture.configure.getRequest).toEqual({ method: "config.get", params: {} });
    expect(fixture.configure.patchRequest.params.baseHash).toBe(fixture.configure.getResponse.hash);
    expect(fixture.start.request.params).toEqual({ channel: "telegram", accountId: "telegram-main" });
    expect(fixture.stop.request.params).toEqual({ channel: "telegram", accountId: "telegram-main" });
    expect(fixture.unavailable).toEqual(["qq-bot", "feishu", "wecom"]);
    expect(rawText).not.toMatch(/\d{6,}:[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{8,}/u);
  });

  it("locks the external personal WeChat plugin boundary", () => {
    const rawText = readFileSync(wechatFixturePath, "utf8");
    const fixture = JSON.parse(rawText) as {
      host: { version: string; channelStatusMethod: string; webLoginProviderSelection: string };
      plugin: {
        package: string; version: string; channelId: string; gatewayMethods: string[];
        gatewayAdapterMethods: string[]; stateDirectoryPrecedence: string[];
      };
      productionCapability: string;
      desktopRuntime: {
        loginTransport: string;
        stateAuthority: string[];
        transientSecrets: string[];
      };
    };

    expect(fixture.host).toMatchObject({
      version: "2026.7.1-2",
      channelStatusMethod: "channels.status",
      webLoginProviderSelection: "gatewayMethods",
    });
    expect(fixture.plugin).toMatchObject({
      package: "@tencent-weixin/openclaw-weixin",
      version: "2.4.6",
      channelId: "openclaw-weixin",
      gatewayMethods: [],
      gatewayAdapterMethods: ["loginWithQrStart", "loginWithQrWait"],
      stateDirectoryPrecedence: ["OPENCLAW_STATE_DIR", "CLAWDBOT_STATE_DIR", "user-home/.openclaw"],
    });
    expect(fixture.plugin.gatewayAdapterMethods).not.toContain("logoutAccount");
    expect(fixture.productionCapability).toBe("desktop-controlled-http-plugin-flow");
    expect(fixture.desktopRuntime).toEqual({
      loginTransport: "ilink-https",
      stateAuthority: ["channels.status", "OPENCLAW_STATE_DIR/openclaw-weixin/accounts.json"],
      transientSecrets: ["qrcode", "flowId"],
    });
    expect(rawText).not.toMatch(/token|cookie|sessionKey|[A-Z]:\\\\|\/Users\//u);
  });
});
