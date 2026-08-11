import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { GatewayWebSocket, OpenClawClient, type WebSocketLike } from "@uclaw/adapter";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createOpenClawUsageService } from "../../adapter/src/openclaw-usage.js";
import { createOpenClawProviderExecutor } from "../../desktop/src/providers/openclaw-provider-executor.js";

const runtimeRoot = process.env.UCLAW_REAL_RUNTIME_DIR ?? join(process.env.HOME ?? "", ".uclaw");
const nodeExecutable = join(runtimeRoot, "runtime", "node-mac-arm64", "bin", "node");
const openClawEntry = join(runtimeRoot, "core", "node_modules", "openclaw", "openclaw.mjs");
const runRealOpenClaw = process.env.UCLAW_REAL_OPENCLAW === "1";
const roots: string[] = [];
const processes: ChildProcess[] = [];

afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (child.exitCode === null) child.kill("SIGINT");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForPort(port: number, child: ChildProcess, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`OpenClaw exited ${child.exitCode}: ${stderr()}`);
    const connected = await new Promise<boolean>((resolve) => {
      const socket = new Socket();
      socket.setTimeout(200);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
      socket.once("error", () => resolve(false));
      socket.connect(port, "127.0.0.1");
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`OpenClaw did not listen: ${stderr()}`);
}

describe.skipIf(!runRealOpenClaw)("real OpenClaw usage", () => {
  it("reads provider, cost and session usage and preserves real RPC failures", async () => {
    await Promise.all([access(nodeExecutable), access(openClawEntry)]);
    expect(JSON.parse(await readFile(join(dirname(openClawEntry), "package.json"), "utf8"))).toMatchObject({ version: "2026.7.1-2" });

    const root = await mkdtemp(join(tmpdir(), "uclaw-usage-real-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const workspace = join(root, "workspace");
    const configPath = join(root, "openclaw.json");
    await Promise.all([mkdir(stateDir, { recursive: true }), mkdir(workspace, { recursive: true })]);
    const token = `usage-real-${process.pid}-${Date.now()}`;
    await writeFile(configPath, `${JSON.stringify({
      gateway: { mode: "local", bind: "loopback", auth: { mode: "token", token } },
      models: {
        mode: "merge",
        providers: {
          "usage-smoke": {
            baseUrl: "https://provider.invalid/v1",
            apiKey: "usage-smoke-placeholder",
            api: "openai-completions",
            models: [{ id: "usage-model", name: "Usage Model", contextWindow: 4096, maxTokens: 1024 }],
          },
        },
      },
      agents: {
        defaults: { workspace, skipBootstrap: true, model: { primary: "usage-smoke/usage-model" } },
        list: [{ id: "main", default: true, workspace }],
      },
    }, null, 2)}\n`);
    const port = await reservePort();
    const child = spawn(nodeExecutable, [openClawEntry, "gateway", "run", "--port", String(port), "--auth", "token", "--ws-log", "compact"], {
      cwd: runtimeRoot,
      env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_GATEWAY_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
    });
    processes.push(child);
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
    await waitForPort(port, child, () => stderr);

    const transport = new GatewayWebSocket({
      url: `ws://127.0.0.1:${port}`,
      webSocketFactory: (url) => new WebSocket(url) as unknown as WebSocketLike,
      connectParams: () => ({
        client: { id: "u-claw-desktop", mode: "desktop" },
        role: "operator",
        scopes: ["operator.read", "operator.write", "operator.admin"],
        caps: ["protocol-v4"],
        auth: { token },
      }),
    });
    const client = new OpenClawClient({ transport });
    await client.gateway.negotiate();
    const service = createOpenClawUsageService({
      request: (method, params) => transport.router.request(method, params as never, z.unknown()),
    });
    const today = new Date().toISOString().slice(0, 10);

    const snapshot = await service.snapshot({ startDate: today, endDate: today });
    expect(snapshot.providerStatus).toMatchObject({ updatedAt: expect.any(Number), providers: expect.any(Array) });
    expect(snapshot.cost).toMatchObject({ updatedAt: expect.any(Number), totals: { totalTokens: 0, totalCost: 0 } });
    expect(snapshot.sessions).toMatchObject({ startDate: today, endDate: today, sessions: [], totals: { totalTokens: 0 } });

    const session = await client.sessions.create({ title: "Usage smoke" });
    const abort = new AbortController();
    const execute = createOpenClawProviderExecutor(client);
    const stream = await execute({
      sessionId: session.id,
      clientRequestId: `usage-smoke-${Date.now()}`,
      blocks: [{ type: "text", text: "Verify provider routing", format: "plain" }],
    }, {
      id: "usage-smoke",
      name: "Usage Smoke",
      enabled: true,
      baseUrl: "https://provider.invalid/v1",
      model: "usage-model",
    }, abort.signal);
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "started", sessionId: session.id },
    });
    abort.abort();
    await iterator.next();
    await expect(client.sessions.list()).resolves.toMatchObject({
      items: [expect.objectContaining({
        id: session.id,
        model: expect.objectContaining({ id: "usage-smoke/usage-model", providerId: "usage-smoke" }),
      })],
    });
    await expect(service.sessionTimeseries("agent:main:missing-session")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    transport.close();
  }, 60_000);
});
