import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ChannelConfigEntry, ChannelDraft, ChannelIpcRequest } from "@uclaw/shared";
import { afterEach, describe, expect, it } from "vitest";

import { createChannelDispatcher, type ChannelRuntime } from "../../desktop/src/channels/channel-dispatcher.js";
import { createChannelStore } from "../../desktop/src/channels/channel-store.js";

interface Fixture {
  checkedAt: string;
  telegram: { id: string; name: string; botToken: string };
  unavailable: ChannelDraft[];
}

const fixturePath = resolve(import.meta.dirname, "fixtures/channel-runtime.json");
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => Promise.all(cleanup.splice(0).map((dispose) => dispose())));

async function loadFixture(): Promise<Fixture> {
  return JSON.parse(await readFile(fixturePath, "utf8")) as Fixture;
}

function request(method: ChannelIpcRequest["method"], requestId: string, params: Record<string, unknown>): ChannelIpcRequest {
  return { method, requestId, params } as ChannelIpcRequest;
}

describe("channel runtime fixture boundary", () => {
  it("runs Telegram lifecycle through the available runtime without returning its token", async () => {
    const fixture = await loadFixture();
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-channel-integration-"));
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
    const calls: Array<{ operation: string; channel: ChannelConfigEntry }> = [];
    const runtime: ChannelRuntime = {
      capability: (kind) => kind === "telegram",
      configure: async (channel) => { calls.push({ operation: "configure", channel }); },
      test: async (channel) => {
        calls.push({ operation: "test", channel });
        return { status: "connected" };
      },
      start: async (channel) => { calls.push({ operation: "start", channel }); },
      stop: async (channel) => { calls.push({ operation: "stop", channel }); },
    };
    const dispatch = createChannelDispatcher(createChannelStore({ dataDir }), runtime, {
      now: () => new Date(fixture.checkedAt),
      timeoutMs: 500,
    });
    const channel: ChannelDraft = {
      id: fixture.telegram.id,
      kind: "telegram",
      name: fixture.telegram.name,
      mode: "bot",
      enabled: true,
      credentials: { botToken: fixture.telegram.botToken },
    };

    const created = await dispatch(request("channels.create", "create-telegram", { channel }));
    const tested = await dispatch(request("channels.test", "test-telegram", { channelId: channel.id }));
    const reconnected = await dispatch(request("channels.reconnect", "reconnect-telegram", { channelId: channel.id }));
    const disabled = await dispatch(request("channels.set-enabled", "disable-telegram", { channelId: channel.id, enabled: false }));

    expect(created.ok && created.result).toMatchObject({ channels: [{ id: channel.id, capability: "available", status: "pending-verification" }] });
    expect(tested.ok && tested.result).toMatchObject({ channelId: channel.id, status: "connected", checkedAt: fixture.checkedAt });
    expect(reconnected.ok && reconnected.result).toMatchObject({ channelId: channel.id, status: "connecting", checkedAt: fixture.checkedAt });
    expect(disabled.ok && disabled.result).toMatchObject({ channels: [{ id: channel.id, enabled: false }] });
    expect(calls.map(({ operation }) => operation)).toEqual(["configure", "test", "stop", "start", "stop"]);
    expect(calls.every(({ channel: called }) => called.kind === "telegram" && called.credentials.botToken === fixture.telegram.botToken)).toBe(true);

    const rendered = JSON.stringify([created, tested, reconnected, disabled]);
    expect(rendered).not.toContain(fixture.telegram.botToken);
    expect(rendered).not.toContain('"credentials":');
    expect(await readFile(join(dataDir, "channels", "channel-config.v1.json"), "utf8")).toContain(fixture.telegram.botToken);
  });

  it("keeps external QQ Bot, Feishu, and WeCom plugins explicitly unavailable", async () => {
    const fixture = await loadFixture();
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-channel-integration-"));
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
    const runtimeCalls: ChannelConfigEntry[] = [];
    const runtime: ChannelRuntime = {
      capability: (kind) => kind === "telegram",
      test: async (channel) => {
        runtimeCalls.push(channel);
        return { status: "connected" };
      },
    };
    const dispatch = createChannelDispatcher(createChannelStore({ dataDir }), runtime, {
      now: () => new Date(fixture.checkedAt),
      timeoutMs: 500,
    });

    for (const channel of fixture.unavailable) {
      const created = await dispatch(request("channels.create", `create-${channel.id}`, { channel }));
      expect(created.ok && created.result).toMatchObject({
        channels: expect.arrayContaining([
          expect.objectContaining({ id: channel.id, capability: "unavailable", status: "needs-action" }),
        ]),
      });
      const tested = await dispatch(request("channels.test", `test-${channel.id}`, { channelId: channel.id }));
      expect(tested.ok && tested.result).toMatchObject({
        channelId: channel.id,
        status: "needs-action",
        checkedAt: fixture.checkedAt,
        error: { category: "capability", code: "CAPABILITY_UNAVAILABLE", retryable: false },
      });
      const rendered = JSON.stringify([created, tested]);
      for (const secret of Object.values(channel.credentials)) expect(rendered).not.toContain(secret);
      expect(rendered).not.toContain('"credentials":');
    }

    expect(runtimeCalls).toEqual([]);
  });
});
