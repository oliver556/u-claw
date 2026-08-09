import { mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ChannelConfigEntry, ChannelDraft, ChannelIpcRequest, WechatConnectionSnapshot } from "@uclaw/shared";
import { afterEach, describe, expect, it } from "vitest";

import { createChannelDispatcher, type ChannelRuntime } from "../../desktop/src/channels/channel-dispatcher.js";
import { createChannelStore } from "../../desktop/src/channels/channel-store.js";

interface Fixture {
  checkedAt: string;
  telegram: { id: string; name: string; botToken: string };
  unavailable: ChannelDraft[];
  wechat: {
    flowId: string; accountIdHint: string; displayName: string; portableCredential: string;
    firstQrExpiresAt: string; refreshedQrExpiresAt: string;
  };
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

  it("runs the personal WeChat fixture lifecycle and keeps state inside OPENCLAW_STATE_DIR", async () => {
    const fixture = await loadFixture();
    const root = await mkdtemp(join(tmpdir(), "uclaw-wechat-integration-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const dataDir = join(root, "portable", "data");
    const openClawStateDir = join(dataDir, "openclaw");
    const fakeHome = join(root, "user-home");
    const fakeTemp = join(root, "host-temp");
    await Promise.all([mkdir(openClawStateDir, { recursive: true }), mkdir(fakeHome), mkdir(fakeTemp)]);
    const credentialPath = join(openClawStateDir, "openclaw-weixin", "accounts.json");
    let now = new Date(fixture.checkedAt);
    let pollCount = 0;
    let statusCount = 0;
    let startCount = 0;
    const runtime: ChannelRuntime = {
      capability: () => false,
      wechat: {
        capability: async () => ({ available: true, pluginStatus: "installed" }),
        status: async () => {
          statusCount += 1;
          if (statusCount === 1) return { status: "disconnected", loginState: "idle" };
          throw new Error(`401 logged out ${fixture.wechat.portableCredential}`);
        },
        start: async () => {
          startCount += 1;
          return {
            flowId: `${fixture.wechat.flowId}-${startCount}`,
            qrImage: { kind: "data-url", value: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==" },
            qrExpiresAt: fixture.wechat.firstQrExpiresAt,
          };
        },
        poll: async () => {
          pollCount += 1;
          if (pollCount === 1) return { status: "pending-verification", loginState: "awaiting-confirmation" };
          await mkdir(join(openClawStateDir, "openclaw-weixin"), { recursive: true });
          await writeFile(credentialPath, JSON.stringify({ credential: fixture.wechat.portableCredential }), { mode: 0o600 });
          return { status: "connected", loginState: "connected", account: { displayName: fixture.wechat.displayName, accountIdHint: fixture.wechat.accountIdHint } };
        },
        refresh: async () => ({
          qrImage: { kind: "data-url", value: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" },
          qrExpiresAt: fixture.wechat.refreshedQrExpiresAt,
        }),
        cancel: async () => undefined,
        reconnect: async () => ({ status: "connected", loginState: "connected", account: { displayName: fixture.wechat.displayName, accountIdHint: fixture.wechat.accountIdHint } }),
        logout: async () => { await unlink(credentialPath); },
      },
    };
    const dispatch = createChannelDispatcher(createChannelStore({ dataDir }), runtime, { now: () => now, timeoutMs: 500 });

    const initial = await dispatch(request("channels.wechat-status", "wechat-status", {}));
    const started = await dispatch(request("channels.wechat-login-start", "wechat-start", { force: false }));
    const publicFlowId = started.ok ? (started.result as WechatConnectionSnapshot).flowId! : "";
    now = new Date(fixture.wechat.firstQrExpiresAt);
    const expired = await dispatch(request("channels.wechat-login-poll", "wechat-expired", { flowId: publicFlowId, qrGeneration: 1 }));
    const refreshed = await dispatch(request("channels.wechat-login-refresh", "wechat-refresh", { flowId: publicFlowId, qrGeneration: 1 }));
    const stale = await dispatch(request("channels.wechat-login-poll", "wechat-stale", { flowId: publicFlowId, qrGeneration: 1 }));
    const scanned = await dispatch(request("channels.wechat-login-poll", "wechat-scanned", { flowId: publicFlowId, qrGeneration: 2 }));
    const connected = await dispatch(request("channels.wechat-login-poll", "wechat-connected", { flowId: publicFlowId, qrGeneration: 2 }));
    const portableState = await readFile(credentialPath, "utf8");
    const invalid = await dispatch(request("channels.wechat-status", "wechat-invalid", {}));
    const reconnected = await dispatch(request("channels.wechat-reconnect", "wechat-reconnect", {}));
    const loggedOut = await dispatch(request("channels.wechat-logout", "wechat-logout", {}));
    const restarted = await dispatch(request("channels.wechat-login-start", "wechat-restart", { force: true }));
    const restartedFlowId = restarted.ok ? (restarted.result as WechatConnectionSnapshot).flowId! : "";
    const cancelled = await dispatch(request("channels.wechat-login-cancel", "wechat-cancel", { flowId: restartedFlowId }));

    expect(initial.ok && initial.result).toMatchObject({ status: "disconnected", loginState: "idle", capability: "available" });
    expect(started.ok && started.result).toMatchObject({ loginState: "awaiting-scan", qrGeneration: 1 });
    expect(expired.ok && expired.result).toMatchObject({ loginState: "expired", error: { code: "WECHAT_QR_EXPIRED" } });
    expect(refreshed.ok && refreshed.result).toMatchObject({ loginState: "awaiting-scan", qrGeneration: 2 });
    expect(stale.ok && stale.result).toMatchObject({ loginState: "awaiting-scan", qrGeneration: 2 });
    expect(scanned.ok && scanned.result).toMatchObject({ loginState: "awaiting-confirmation" });
    expect(connected.ok && connected.result).toMatchObject({ status: "connected", account: { accountIdHint: fixture.wechat.accountIdHint } });
    expect(invalid.ok && invalid.result).toMatchObject({ status: "auth-failed", error: { code: "WECHAT_LOGGED_OUT" } });
    expect(reconnected.ok && reconnected.result).toMatchObject({ status: "connected", loginState: "connected" });
    expect(loggedOut.ok && loggedOut.result).toMatchObject({ status: "not-configured", loginState: "logged-out" });
    expect(restarted.ok && restarted.result).toMatchObject({ flowId: restartedFlowId, loginState: "awaiting-scan" });
    expect(cancelled.ok && cancelled.result).toMatchObject({ status: "disconnected", loginState: "cancelled" });
    expect(pollCount).toBe(2);
    expect(portableState).toContain(fixture.wechat.portableCredential);
    await expect(readFile(credentialPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(fakeHome)).toEqual([]);
    expect(await readdir(fakeTemp)).toEqual([]);
    const rendered = JSON.stringify([initial, started, expired, refreshed, stale, scanned, connected, invalid, reconnected, loggedOut, restarted, cancelled]);
    expect(rendered).not.toContain(fixture.wechat.portableCredential);
    expect(rendered).not.toContain(openClawStateDir);
    expect(rendered).not.toContain(fixture.wechat.flowId);
  });
});
