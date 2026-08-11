import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { GatewayWebSocket, type WebSocketLike } from "@uclaw/adapter";
import type { ChannelConfigEntry } from "@uclaw/shared";
import { afterEach, describe, expect, it } from "vitest";

import { createOpenClawChannelRuntime } from "../../adapter/src/openclaw-channel-runtime.js";

const runRealOpenClaw = process.env.UCLAW_RUN_REAL_OPENCLAW === "1";
const runtimeRoot = resolve(process.env.UCLAW_RUNTIME_DIR ?? join(homedir(), ".uclaw"));
const openClawEntry = resolve(process.env.OPENCLAW_PACKAGE_DIR ?? join(runtimeRoot, "core/node_modules/openclaw"), "openclaw.mjs");
const nodeExecutable = resolve(process.env.OPENCLAW_NODE_BIN ?? join(runtimeRoot, "runtime/node-mac-arm64/bin/node"));
const roots: string[] = [];
const processes: ChildProcess[] = [];

async function reservePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not reserve a Gateway port.");
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

async function waitForPort(port: number, child: ChildProcess, diagnostic: () => string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`OpenClaw Gateway exited before readiness (${child.exitCode ?? child.signalCode}): ${diagnostic()}`);
    }
    try {
      await new Promise<void>((resolveConnect, reject) => {
        const socket = connect({ host: "127.0.0.1", port });
        socket.once("connect", () => { socket.destroy(); resolveConnect(); });
        socket.once("error", reject);
      });
      return;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
  throw new Error(`OpenClaw Gateway readiness timed out: ${diagnostic()}`);
}

async function stopGateway(child: ChildProcess): Promise<void> {
  const index = processes.indexOf(child);
  if (index >= 0) processes.splice(index, 1);
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("OpenClaw Gateway shutdown timed out.")), 10_000)),
  ]);
}

afterEach(async () => {
  await Promise.allSettled(processes.splice(0).map(stopGateway));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe.skipIf(!runRealOpenClaw)("real OpenClaw channel runtime", () => {
  it("persists managed channel config across Gateway restart and reports external failures honestly", async () => {
    const packageJson = JSON.parse(await readFile(join(dirname(openClawEntry), "package.json"), "utf8")) as { name: string; version: string };
    expect(packageJson).toMatchObject({ name: "openclaw", version: "2026.7.1-2" });

    const root = await mkdtemp(join(tmpdir(), "uclaw-channels-real-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const configPath = join(stateDir, "openclaw.json");
    await mkdir(stateDir, { recursive: true });
    const gatewayToken = "uclaw-real-channel-gateway-token";
    await writeFile(configPath, `${JSON.stringify({
      gateway: { mode: "local", bind: "loopback", auth: { mode: "token", token: gatewayToken } },
      agents: { defaults: { workspace: join(root, "workspace"), skipBootstrap: true } },
      plugins: { entries: { qqbot: { enabled: true } } },
    }, null, 2)}\n`, { mode: 0o600 });

    const port = await reservePort();
    const launch = async () => {
      const child = spawn(nodeExecutable, [openClawEntry, "gateway", "run", "--port", String(port), "--auth", "token", "--ws-log", "compact"], {
        cwd: runtimeRoot,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_GATEWAY_TOKEN: gatewayToken },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let diagnostic = "";
      child.stdout?.on("data", (chunk) => { diagnostic = `${diagnostic}${String(chunk)}`.slice(-8_000); });
      child.stderr?.on("data", (chunk) => { diagnostic = `${diagnostic}${String(chunk)}`.slice(-8_000); });
      processes.push(child);
      await waitForPort(port, child, () => diagnostic.trim());
      const createTransport = () => new GatewayWebSocket({
        url: `ws://127.0.0.1:${port}`,
        webSocketFactory: (url) => new (globalThis.WebSocket as unknown as new (target: string) => WebSocketLike)(url),
        connectParams: () => ({
          client: { id: "u-claw-desktop", mode: "desktop" }, role: "operator",
          scopes: ["operator.read", "operator.write", "operator.admin"], caps: ["protocol-v4"],
          auth: { token: gatewayToken },
        }),
      });
      let activeTransport = createTransport();
      const hello = await activeTransport.connect();
      const reconnect = async (signal: AbortSignal) => {
        activeTransport.close();
        let lastError: unknown;
        for (let attempt = 0; attempt < 200 && !signal.aborted; attempt += 1) {
          try {
            const next = createTransport();
            await next.connect();
            activeTransport = next;
            return;
          } catch (error) {
            lastError = error;
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
          }
        }
        throw lastError instanceof Error ? lastError : new Error("OpenClaw Gateway reconnect timed out.");
      };
      const runtime = createOpenClawChannelRuntime({
        router: { request: (method, params, schema, signal) => activeTransport.router.request(method, params, schema, signal) },
        methods: new Set(hello.features.methods),
        reconnect,
      });
      return { child, closeTransport: () => activeTransport.close(), runtime };
    };

    const channels: ChannelConfigEntry[] = [
      { id: "telegram-main", kind: "telegram", name: "Telegram", mode: "bot", enabled: false, credentials: { botToken: "123456789:telegram-real-smoke-token" } },
      { id: "qq-bot-main", kind: "qq-bot", name: "QQ Bot", mode: "app", enabled: false, allowFrom: ["user:allowed"], credentials: { appId: "1024", clientSecret: "qq-real-smoke-secret" } },
    ];

    let running = await launch();
    for (const channel of channels) await running.runtime.configure(channel, new AbortController().signal);
    const firstReadback = await Promise.all(channels.map((channel) => running.runtime.status(channel, false, new AbortController().signal)));
    expect(firstReadback).toEqual(expect.arrayContaining([
      expect.objectContaining({ configured: true, enabled: false, runtimeAuthoritative: true }),
    ]));
    const unavailable = [
      { id: "feishu-main", kind: "feishu", name: "Feishu", mode: "websocket", enabled: false, credentials: { appId: "cli_real_smoke", appSecret: "feishu-real-smoke-secret" } },
      { id: "wecom-main", kind: "wecom", name: "WeCom", mode: "websocket", enabled: false, credentials: { botId: "bot", secret: "wecom-real-smoke-secret" } },
      { id: "discord-main", kind: "discord", name: "Discord", mode: "bot", enabled: false, credentials: { botToken: "discord-real-smoke-token" } },
    ] as const satisfies ChannelConfigEntry[];
    for (const channel of unavailable) {
      await expect(running.runtime.status(channel, false, new AbortController().signal)).resolves.toMatchObject({
        configured: false, status: "needs-action", pendingAction: "install-plugin", runtimeAuthoritative: true,
      });
    }

    running.closeTransport();
    await stopGateway(running.child);
    running = await launch();
    const restartedReadback = await Promise.all(channels.map((channel) => running.runtime.status(channel, false, new AbortController().signal)));
    expect(restartedReadback.every((entry) => entry.configured && !entry.enabled && entry.runtimeAuthoritative)).toBe(true);

    const sendFailure = await running.runtime.send(channels[1]!, { target: "user:missing", message: "must-not-send" }, new AbortController().signal).catch((error: unknown) => error);
    await running.runtime.logout(channels[0]!, new AbortController().signal);
    const logoutReadback = await running.runtime.status(channels[0]!, false, new AbortController().signal);
    expect(sendFailure).toBeInstanceOf(Error);
    expect(logoutReadback).toMatchObject({ configured: false, status: "not-configured", runtimeAuthoritative: true });
    const rendered = JSON.stringify({ restartedReadback, sendFailure: String(sendFailure), logoutReadback });
    for (const secret of channels.flatMap((channel) => Object.values(channel.credentials))) expect(rendered).not.toContain(secret);
    for (const secret of unavailable.flatMap((channel) => Object.values(channel.credentials))) expect(rendered).not.toContain(secret);

    const persisted = await readFile(configPath, "utf8");
    expect(persisted).toContain('"allowFrom"');
    expect(persisted).toContain('"user:allowed"');
    expect((await stat(configPath)).mode & 0o077).toBe(0);
  }, 90_000);
});
