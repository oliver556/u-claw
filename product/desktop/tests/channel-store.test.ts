import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import * as desktop from "../src/index.js";

describe("channel store", () => {
  it("writes credentials under the portable data directory and returns hints only", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-channels-"));
    const store = (desktop as any).createChannelStore({ dataDir });
    const snapshot = await store.create({ id: "telegram-main", kind: "telegram", name: "Telegram", enabled: true, mode: "bot", credentials: { botToken: "123456:very-secret-token" } });
    expect(snapshot.channels[0].credentialHints).toEqual({ botToken: "...oken" });
    expect(JSON.stringify(snapshot)).not.toContain("very-secret-token");
    expect(await readFile(join(dataDir, "channels", "channel-config.v1.json"), "utf8")).toContain("very-secret-token");
  });

  it("serializes concurrent mutations without losing entries", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-channels-"));
    const store = (desktop as any).createChannelStore({ dataDir });
    await Promise.all([
      store.create({ id: "telegram-main", kind: "telegram", name: "Telegram", enabled: true, mode: "bot", credentials: { botToken: "a" } }),
      store.create({ id: "qq-main", kind: "qq-bot", name: "QQ Bot", enabled: true, mode: "app", credentials: { appId: "1", clientSecret: "b" } }),
    ]);
    expect((await store.list()).channels.map((channel: { id: string }) => channel.id).sort()).toEqual(["qq-main", "telegram-main"]);
    expect((await store.list()).channels.find((channel: { id: string }) => channel.id === "telegram-main").credentialHints.botToken).toBe("...****");
  });

  it("does not treat corrupt or unreadable channel config as an empty document", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-channels-"));
    const configPath = join(dataDir, "channels", "channel-config.v1.json");
    await mkdir(join(dataDir, "channels"), { recursive: true });
    await writeFile(configPath, "{not-json", "utf8");
    const store = (desktop as any).createChannelStore({ dataDir });
    await expect(store.list()).rejects.toMatchObject({ code: "OPERATION_FAILED" });
    await expect(store.create({ id: "telegram-main", kind: "telegram", name: "Telegram", enabled: true, mode: "bot", credentials: { botToken: "new-secret" } })).rejects.toMatchObject({ code: "OPERATION_FAILED" });
    expect(await readFile(configPath, "utf8")).toBe("{not-json");
  });

  it("forces unavailable adapters to needs-action even with stale connected state", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-channels-"));
    const configPath = join(dataDir, "channels", "channel-config.v1.json");
    await mkdir(join(dataDir, "channels"), { recursive: true });
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, channels: [{
      id: "feishu-main", kind: "feishu", name: "Feishu", mode: "websocket", enabled: true,
      credentials: { appId: "fixture-app", appSecret: "fixture-secret" }, status: "connected",
    }] }), "utf8");
    const store = (desktop as any).createChannelStore({ dataDir });
    expect((await store.list()).channels[0]).toMatchObject({
      capability: "unavailable", status: "needs-action",
      error: { code: "CAPABILITY_UNAVAILABLE", category: "capability" },
    });
  });
});
