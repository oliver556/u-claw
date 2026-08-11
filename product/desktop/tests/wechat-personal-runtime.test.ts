import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createWechatPersonalRuntime } from "../src/channels/wechat-personal-runtime.js";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==";

type GatewayAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  running: boolean;
  connected: boolean;
};

function gatewayStatus(account?: GatewayAccount) {
  return {
    ts: 1_786_129_711_211,
    channelOrder: ["openclaw-weixin"],
    channelLabels: { "openclaw-weixin": "Weixin" },
    channels: { "openclaw-weixin": { configured: account !== undefined } },
    channelAccounts: { "openclaw-weixin": account ? [account] : [] },
    channelDefaultAccountId: account ? { "openclaw-weixin": account.accountId } : {},
  };
}

describe("production personal WeChat runtime", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map(async (path) => {
      const { rm } = await import("node:fs/promises");
      await rm(path, { recursive: true, force: true });
    }));
    vi.restoreAllMocks();
  });

  async function fixture() {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-wechat-runtime-"));
    cleanup.push(dataDir);
    const pluginDir = join(dataDir, "extensions", "openclaw-weixin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "openclaw.plugin.json"), JSON.stringify({ id: "openclaw-weixin" }));
    await writeFile(join(pluginDir, "package.json"), JSON.stringify({ name: "@tencent-weixin/openclaw-weixin", version: "2.4.6" }));
    return { dataDir, pluginDir };
  }

  it("reads installed plugin and connected account from OpenClaw authority after runtime restart", async () => {
    const { dataDir, pluginDir } = await fixture();
    const accountDir = join(dataDir, "openclaw-weixin", "accounts");
    await mkdir(accountDir, { recursive: true });
    await writeFile(join(dataDir, "openclaw-weixin", "accounts.json"), JSON.stringify(["wx-account-7a2f"]));
    await writeFile(join(accountDir, "wx-account-7a2f.json"), JSON.stringify({ token: "secret-session-token", userId: "private-user" }), { mode: 0o600 });
    const requestGateway = vi.fn(async (method: string) => {
      expect(method).toBe("channels.status");
      return gatewayStatus({ accountId: "wx-account-7a2f", enabled: true, configured: true, running: true, connected: true });
    });

    const runtime = createWechatPersonalRuntime({ dataDir, pluginDir, requestGateway, renderQr: async () => png });
    await expect(runtime.capability(new AbortController().signal)).resolves.toEqual({ available: true, pluginStatus: "installed" });
    const snapshot = await runtime.status(new AbortController().signal);

    expect(snapshot).toEqual({
      status: "connected",
      loginState: "connected",
      account: { accountIdHint: "...7a2f" },
    });
    expect(JSON.stringify(snapshot)).not.toContain("secret-session-token");
    expect(requestGateway).toHaveBeenCalledWith("channels.status", { channel: "openclaw-weixin", probe: false }, expect.any(AbortSignal));
  });

  it("runs scan confirmation, writes only plugin authority, then proves connected runtime readback", async () => {
    const { dataDir, pluginDir } = await fixture();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ qrcode: "private-qr-id", qrcode_img_content: "private-qr-payload" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "confirmed",
        ilink_bot_id: "wx-account-7a2f",
        ilink_user_id: "private-user",
        bot_token: "secret-session-token",
        baseurl: "https://ilinkai.weixin.qq.com",
      }), { status: 200 }));
    const gatewayAccount = { accountId: "wx-account-7a2f", enabled: true, configured: true, running: true, connected: true };
    const requests: Array<{ method: string; params: unknown }> = [];
    const requestGateway = vi.fn(async (method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === "config.get") return { hash: "config-hash", valid: true };
      if (method === "config.patch") return { ok: true };
      if (method === "channels.start") return { ok: true };
      if (method === "channels.status") return gatewayStatus(gatewayAccount);
      throw new Error("unexpected method");
    });
    const runtime = createWechatPersonalRuntime({
      dataDir, pluginDir, fetch, requestGateway, renderQr: async (value) => {
        expect(value).toBe("private-qr-payload");
        return png;
      },
      createFlowId: () => "runtime-flow-1",
      now: () => new Date("2026-08-12T00:00:00.000Z"),
    });

    const started = await runtime.start(false, new AbortController().signal);
    const connected = await runtime.poll(started.flowId, new AbortController().signal);

    expect(started).toEqual({ flowId: "runtime-flow-1", qrImage: { kind: "data-url", value: png }, qrExpiresAt: "2026-08-12T00:05:00.000Z" });
    expect(connected).toEqual({ status: "connected", loginState: "connected", account: { accountIdHint: "...7a2f" } });
    expect(requests.map(({ method }) => method)).toEqual(["config.get", "config.patch", "channels.start", "channels.status"]);
    expect(JSON.stringify(requests)).not.toContain("secret-session-token");
    const accountPath = join(dataDir, "openclaw-weixin", "accounts", "wx-account-7a2f.json");
    expect(JSON.parse(await readFile(accountPath, "utf8"))).toEqual({ token: "secret-session-token", baseUrl: "https://ilinkai.weixin.qq.com", userId: "private-user" });
    expect((await stat(accountPath)).mode & 0o777).toBe(0o600);
    await expect(readFile(join(dataDir, ".env"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["config.patch", "channels.start", "channels.status"])("keeps the confirmed account actionable when %s fails", async (failedMethod) => {
    const { dataDir, pluginDir } = await fixture();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ qrcode: "private-qr-id", qrcode_img_content: "private-qr-payload" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "confirmed", ilink_bot_id: "wx-account-7a2f", bot_token: "secret-session-token" }), { status: 200 }));
    const requestGateway = vi.fn(async (method: string) => {
      if (method === failedMethod) throw new Error(`${failedMethod} failed`);
      if (method === "config.get") return { hash: "config-hash", valid: true };
      if (method === "channels.status") return gatewayStatus();
      return { ok: true };
    });
    const runtime = createWechatPersonalRuntime({
      dataDir, pluginDir, fetch, requestGateway, renderQr: async () => png, createFlowId: () => "runtime-flow-1",
    });

    const started = await runtime.start(false, new AbortController().signal);
    await expect(runtime.poll(started.flowId, new AbortController().signal)).resolves.toEqual({
      status: "disconnected", loginState: "error", account: { accountIdHint: "...7a2f" },
    });
  });

  it("replaces a stale account with the newly confirmed authoritative account", async () => {
    const { dataDir, pluginDir } = await fixture();
    const stateDir = join(dataDir, "openclaw-weixin");
    const accountsDir = join(stateDir, "accounts");
    await mkdir(accountsDir, { recursive: true });
    await writeFile(join(stateDir, "accounts.json"), JSON.stringify(["wx-old-1111"]));
    await writeFile(join(accountsDir, "wx-old-1111.json"), JSON.stringify({ token: "old-secret" }));
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ qrcode: "private-qr-id", qrcode_img_content: "private-qr-payload" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "confirmed", ilink_bot_id: "wx-new-2222", bot_token: "new-secret" }), { status: 200 }));
    const requestGateway = vi.fn(async (method: string) => {
      if (method === "config.get") return { hash: "config-hash", valid: true };
      if (method === "channels.status") return gatewayStatus({ accountId: "wx-new-2222", enabled: true, configured: true, running: true, connected: true });
      return { ok: true };
    });
    const runtime = createWechatPersonalRuntime({ dataDir, pluginDir, fetch, requestGateway, renderQr: async () => png });

    const started = await runtime.start(false, new AbortController().signal);
    await expect(runtime.poll(started.flowId, new AbortController().signal)).resolves.toMatchObject({ status: "connected", account: { accountIdHint: "...2222" } });
    expect(requestGateway).toHaveBeenCalledWith("channels.stop", { channel: "openclaw-weixin", accountId: "wx-old-1111" }, expect.any(AbortSignal));
    expect(JSON.parse(await readFile(join(stateDir, "accounts.json"), "utf8"))).toEqual(["wx-new-2222"]);
    await expect(readFile(join(accountsDir, "wx-old-1111.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { name: "missing token", token: undefined, blockTarget: false },
    { name: "credential write failure", token: "new-secret", blockTarget: true },
  ])("keeps the old account actionable after $name during account switching", async ({ token, blockTarget }) => {
    const { dataDir, pluginDir } = await fixture();
    const stateDir = join(dataDir, "openclaw-weixin");
    const accountsDir = join(stateDir, "accounts");
    await mkdir(accountsDir, { recursive: true });
    await writeFile(join(stateDir, "accounts.json"), JSON.stringify(["wx-old-1111"]));
    await writeFile(join(accountsDir, "wx-old-1111.json"), JSON.stringify({ token: "old-secret" }));
    if (blockTarget) await mkdir(join(accountsDir, "wx-new-2222.json"));
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ qrcode: "private-qr-id", qrcode_img_content: "private-qr-payload" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "confirmed", ilink_bot_id: "wx-new-2222", ...(token ? { bot_token: token } : {}),
      }), { status: 200 }));
    const requestGateway = vi.fn(async () => ({ ok: true }));
    const runtime = createWechatPersonalRuntime({ dataDir, pluginDir, fetch, requestGateway, renderQr: async () => png });

    const started = await runtime.start(false, new AbortController().signal);
    await expect(runtime.poll(started.flowId, new AbortController().signal)).resolves.toEqual({
      status: "disconnected", loginState: "error", account: { accountIdHint: "...1111" },
    });
    expect(requestGateway).not.toHaveBeenCalledWith("channels.stop", expect.anything(), expect.anything());
    expect(JSON.parse(await readFile(join(stateDir, "accounts.json"), "utf8"))).toEqual(["wx-old-1111"]);
    expect(JSON.parse(await readFile(join(accountsDir, "wx-old-1111.json"), "utf8"))).toEqual({ token: "old-secret" });
  });

  it("keeps the new authority when stale credential cleanup fails after index commit", async () => {
    const { dataDir, pluginDir } = await fixture();
    const stateDir = join(dataDir, "openclaw-weixin");
    const accountsDir = join(stateDir, "accounts");
    await mkdir(join(accountsDir, "wx-old-1111.json"), { recursive: true });
    await writeFile(join(stateDir, "accounts.json"), JSON.stringify(["wx-old-1111"]));
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ qrcode: "private-qr-id", qrcode_img_content: "private-qr-payload" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "confirmed", ilink_bot_id: "wx-new-2222", bot_token: "new-secret" }), { status: 200 }));
    const requestGateway = vi.fn(async (method: string) => {
      if (method === "config.get") return { hash: "config-hash", valid: true };
      if (method === "channels.status") return gatewayStatus({ accountId: "wx-new-2222", enabled: true, configured: true, running: true, connected: true });
      return { ok: true };
    });
    const runtime = createWechatPersonalRuntime({ dataDir, pluginDir, fetch, requestGateway, renderQr: async () => png });

    const started = await runtime.start(false, new AbortController().signal);
    await expect(runtime.poll(started.flowId, new AbortController().signal)).resolves.toMatchObject({
      status: "connected", account: { accountIdHint: "...2222" },
    });
    expect(JSON.parse(await readFile(join(stateDir, "accounts.json"), "utf8"))).toEqual(["wx-new-2222"]);
    expect(JSON.parse(await readFile(join(accountsDir, "wx-new-2222.json"), "utf8"))).toEqual({ token: "new-secret" });
  });

  it("refreshes, expires and cancels in-memory QR flows without persisting QR material", async () => {
    const { dataDir, pluginDir } = await fixture();
    let now = new Date("2026-08-12T00:00:00.000Z");
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ qrcode: "qr-1", qrcode_img_content: "payload-1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ qrcode: "qr-2", qrcode_img_content: "payload-2" }), { status: 200 }));
    const runtime = createWechatPersonalRuntime({
      dataDir, pluginDir, fetch, requestGateway: vi.fn(), renderQr: async () => png,
      createFlowId: () => "runtime-flow-1", now: () => now,
    });

    const started = await runtime.start(false, new AbortController().signal);
    const refreshed = await runtime.refresh(started.flowId, new AbortController().signal);
    now = new Date("2026-08-12T00:10:00.000Z");
    await expect(runtime.poll(started.flowId, new AbortController().signal)).resolves.toEqual({ status: "needs-action", loginState: "expired" });
    await runtime.cancel(started.flowId, new AbortController().signal);
    await expect(runtime.poll(started.flowId, new AbortController().signal)).rejects.toThrow("expired");
    expect(refreshed.qrExpiresAt).toBe("2026-08-12T00:05:00.000Z");

    const files = await import("node:fs/promises").then(({ readdir }) => readdir(dataDir, { recursive: true }));
    for (const file of files) {
      if (typeof file !== "string") continue;
      const content = await readFile(join(dataDir, file), "utf8").catch(() => "");
      expect(content).not.toMatch(/qr-[12]|payload-[12]/u);
    }
  });

  it("reconnects through OpenClaw and logout removes authority before a fresh runtime reads status", async () => {
    const { dataDir, pluginDir } = await fixture();
    const stateDir = join(dataDir, "openclaw-weixin");
    const accountDir = join(stateDir, "accounts");
    await mkdir(accountDir, { recursive: true });
    await writeFile(join(stateDir, "accounts.json"), JSON.stringify(["wx-account-7a2f"]));
    await writeFile(join(accountDir, "wx-account-7a2f.json"), JSON.stringify({ token: "secret-session-token" }), { mode: 0o600 });
    const methods: string[] = [];
    const requestGateway = vi.fn(async (method: string) => {
      methods.push(method);
      if (method === "channels.status") return gatewayStatus({ accountId: "wx-account-7a2f", enabled: true, configured: true, running: true, connected: true });
      return { ok: true };
    });
    const runtime = createWechatPersonalRuntime({ dataDir, pluginDir, requestGateway, renderQr: async () => png });

    await expect(runtime.reconnect(new AbortController().signal)).resolves.toMatchObject({ status: "connected", loginState: "connected" });
    await runtime.logout(new AbortController().signal);

    expect(methods).toEqual(["channels.stop", "channels.start", "channels.status", "channels.stop"]);
    await expect(readFile(join(accountDir, "wx-account-7a2f.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(join(stateDir, "accounts.json"), "utf8"))).toEqual([]);

    const restarted = createWechatPersonalRuntime({ dataDir, pluginDir, requestGateway, renderQr: async () => png });
    await expect(restarted.status(new AbortController().signal)).resolves.toEqual({ status: "not-configured", loginState: "idle" });
  });

  it("logout removes an orphaned account file even when the index omits it", async () => {
    const { dataDir, pluginDir } = await fixture();
    const stateDir = join(dataDir, "openclaw-weixin");
    const accountDir = join(stateDir, "accounts");
    await mkdir(accountDir, { recursive: true });
    await writeFile(join(stateDir, "accounts.json"), "[]");
    await writeFile(join(accountDir, "wx-orphan-7a2f.json"), JSON.stringify({ token: "orphan-secret" }));
    const requestGateway = vi.fn(async () => ({ ok: true }));
    const runtime = createWechatPersonalRuntime({ dataDir, pluginDir, requestGateway, renderQr: async () => png });

    await runtime.logout(new AbortController().signal);

    expect(requestGateway).toHaveBeenCalledWith("channels.stop", { channel: "openclaw-weixin", accountId: "wx-orphan-7a2f" }, expect.any(AbortSignal));
    await expect(readFile(join(accountDir, "wx-orphan-7a2f.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an invalid account index instead of reporting an empty authority", async () => {
    const { dataDir, pluginDir } = await fixture();
    const stateDir = join(dataDir, "openclaw-weixin");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "accounts.json"), JSON.stringify([42]));
    const runtime = createWechatPersonalRuntime({ dataDir, pluginDir, requestGateway: vi.fn(), renderQr: async () => png });

    await expect(runtime.status(new AbortController().signal)).rejects.toBeDefined();
  });

  it("rejects an accounts-directory symlink instead of writing a token outside the state root", async () => {
    const { dataDir, pluginDir } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "uclaw-wechat-outside-"));
    cleanup.push(outside);
    const stateDir = join(dataDir, "openclaw-weixin");
    await mkdir(stateDir, { recursive: true });
    await symlink(outside, join(stateDir, "accounts"));
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ qrcode: "private-qr-id", qrcode_img_content: "private-qr-payload" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "confirmed", ilink_bot_id: "wx-escape-7a2f", bot_token: "escape-secret" }), { status: 200 }));
    const runtime = createWechatPersonalRuntime({ dataDir, pluginDir, fetch, requestGateway: vi.fn(), renderQr: async () => png });

    const started = await runtime.start(false, new AbortController().signal);
    await expect(runtime.poll(started.flowId, new AbortController().signal)).rejects.toThrow(/directory|symbolic/iu);
    await expect(readFile(join(outside, "wx-escape-7a2f.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when plugin is absent and never calls login network", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-wechat-missing-"));
    cleanup.push(dataDir);
    const fetch = vi.fn();
    const runtime = createWechatPersonalRuntime({
      dataDir, pluginDir: join(dataDir, "extensions", "openclaw-weixin"), fetch,
      requestGateway: vi.fn(), renderQr: async () => png,
    });

    await expect(runtime.capability(new AbortController().signal)).resolves.toMatchObject({ available: false, pluginStatus: "missing" });
    await expect(runtime.start(false, new AbortController().signal)).rejects.toThrow("plugin");
    expect(fetch).not.toHaveBeenCalled();
  });
});
