import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { OpenClawChannelsFixtureSchema } from "../../adapter/src/index.js";

const fixturePath = resolve(import.meta.dirname, "../../adapter/fixtures/openclaw-2026.7.1-2/channels.json");

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
});
