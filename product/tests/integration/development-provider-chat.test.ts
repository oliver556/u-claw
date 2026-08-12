import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { CLIENT_IPC_CHANNEL, CLIENT_IPC_EVENT_CHANNEL } from "../../desktop/src/ipc/channels.js";
import { installPreloadBridge } from "../../desktop/src/ipc/preload-bridge.js";
import { registerIpc } from "../../desktop/src/ipc/register-ipc.js";
import { createMainProcessModelRouting } from "../../desktop/src/providers/model-source-router.js";
import { createDesktopMainOptions } from "../../desktop/src/wiring/create-desktop-main-options.js";
import { createRendererClient, type RendererClientBridge } from "../../frontend/src/app/renderer-client.js";

const runRealOpenClaw = process.env.UCLAW_RUN_REAL_OPENCLAW === "1";
const runtimeRoot = resolve(process.env.UCLAW_RUNTIME_DIR ?? join(homedir(), ".uclaw"));
const openClawEntry = resolve(process.env.OPENCLAW_PACKAGE_DIR ?? join(runtimeRoot, "core/node_modules/openclaw"), "openclaw.mjs");
const nodeExecutable = resolve(process.env.OPENCLAW_NODE_BIN ?? join(runtimeRoot, "runtime/node-mac-arm64/bin/node"));
const portableSkills = resolve(import.meta.dirname, "../../../portable/skills-cn");
const roots: string[] = [];
const processes: ChildProcess[] = [];
const servers: Server[] = [];

async function stage<T>(name: string, operation: Promise<T>, timeoutMs = 20_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(`Timed out during ${name}.`)), timeoutMs); }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function reservePort(): Promise<number> {
  const server = createTcpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not reserve a Gateway port.");
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

async function waitForPort(port: number, child: ChildProcess, diagnostic: () => string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`OpenClaw Gateway exited before readiness (${child.exitCode}): ${diagnostic()}`);
    try {
      await new Promise<void>((resolveConnect, reject) => {
        const socket = connect({ host: "127.0.0.1", port });
        socket.once("connect", () => { socket.destroy(); resolveConnect(); });
        socket.once("error", reject);
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("OpenClaw Gateway readiness timed out.");
}

async function stopGateway(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("OpenClaw Gateway shutdown timed out.")), 10_000)),
  ]);
}

afterEach(async () => {
  await Promise.allSettled(processes.splice(0).map(stopGateway));
  await Promise.allSettled(servers.splice(0).map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!runRealOpenClaw)("development Provider real OpenClaw chat", () => {
  it("routes typed IPC through OpenClaw to the fixed GPT-5.6 Sol Provider and persists history", async () => {
    const apiKey = "fixture-provider-secret";
    const providerRequests: Array<{ authorization?: string; path?: string; body: Record<string, unknown> }> = [];
    const provider = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      providerRequests.push({ authorization: request.headers.authorization, path: request.url, body });
      if (body.stream !== true) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: "chatcmpl-uclaw-fixture", object: "chat.completion", created: 1, model: "gpt-5.6-sol",
          choices: [{ index: 0, message: { role: "assistant", content: "真实回复成功" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta: Record<string, unknown>, finishReason: string | null) => ({
        id: "chatcmpl-uclaw-fixture", object: "chat.completion.chunk", created: 1, model: "gpt-5.6-sol",
        choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
      });
      response.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: "" }, null))}\n\n`);
      response.write(`data: ${JSON.stringify(chunk({ content: "真实回复" }, null))}\n\n`);
      response.write(`data: ${JSON.stringify(chunk({ content: "成功" }, null))}\n\n`);
      response.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    servers.push(provider);
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const providerAddress = provider.address();
    if (providerAddress === null || typeof providerAddress === "string") throw new Error("Provider fixture did not bind.");
    const openAiModule = await import(pathToFileURL(join(dirname(openClawEntry), "node_modules", "openai", "index.mjs")).href) as {
      default: new (options: { apiKey: string; baseURL: string }) => {
        chat: { completions: { create(input: Record<string, unknown>): Promise<AsyncIterable<unknown>> } };
      };
    };
    const sdk = new openAiModule.default({ apiKey, baseURL: `http://127.0.0.1:${providerAddress.port}/v1` });
    const sdkEvents = [];
    for await (const event of await sdk.chat.completions.create({
      model: "gpt-5.6-sol", messages: [{ role: "user", content: "fixture-probe" }], stream: true,
    })) sdkEvents.push(event);
    expect(sdkEvents).toHaveLength(4);
    providerRequests.length = 0;

    const root = await mkdtemp(join(tmpdir(), "uclaw-development-chat-"));
    roots.push(root);
    const dataDir = join(root, "data");
    const cacheDir = join(root, "cache");
    const workspaceDir = join(dataDir, "workspace");
    const configPath = join(dataDir, ".openclaw", "openclaw.json");
    await Promise.all([
      mkdir(cacheDir, { recursive: true }),
      mkdir(workspaceDir, { recursive: true }),
      mkdir(dirname(configPath), { recursive: true }),
    ]);
    const gatewayToken = "fixture-gateway-token";
    await writeFile(configPath, `${JSON.stringify({
      gateway: { mode: "local", bind: "loopback", auth: { mode: "token", token: gatewayToken } },
      agents: { defaults: { workspace: workspaceDir, skipBootstrap: true } },
    }, null, 2)}\n`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      UCLAW_RUNTIME_DIR: runtimeRoot,
      UCLAW_OPENCLAW_ENTRY: openClawEntry,
      UCLAW_NODE_BIN: nodeExecutable,
      UCLAW_DATA_DIR: dataDir,
      UCLAW_CACHE_DIR: cacheDir,
      OPENCLAW_CONFIG_PATH: configPath,
      UCLAW_PORTABLE_SKILLS_DIR: portableSkills,
      UCLAW_TEST_PROVIDER_BASE_URL: `http://127.0.0.1:${providerAddress.port}/v1`,
      UCLAW_TEST_PROVIDER_API_KEY: apiKey,
      UCLAW_TEST_PROVIDER_MODEL: "gpt-5.6-sol",
    };
    const gatewayPort = await reservePort();
    const options = await createDesktopMainOptions(env);
    const launch = options.buildGatewayLaunchOptions(gatewayPort) as {
      executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
    };
    const child = options.spawn(launch.executable, launch.args, {
      cwd: launch.cwd, env: launch.env, stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as ChildProcess;
    processes.push(child);
    let gatewayStderr = "";
    let gatewayStdout = "";
    child.stderr?.on("data", (value) => { gatewayStderr = `${gatewayStderr}${String(value)}`.slice(-8_000); });
    child.stdout?.on("data", (value) => { gatewayStdout = `${gatewayStdout}${String(value)}`.slice(-8_000); });
    await stage("Gateway readiness", waitForPort(gatewayPort, child, () => gatewayStderr.trim()));
    try {
      await stage("Provider bootstrap", options.probeCapabilities(gatewayPort, new AbortController().signal));
    } catch (error) {
      throw new Error([
        error instanceof Error ? error.message : "Provider bootstrap failed.",
        `gatewayExit=${String(child.exitCode)}`,
        `gateway=${`${gatewayStdout}\n${gatewayStderr}`.trim().slice(-2_000)}`,
      ].join("\n"));
    }

    const routing = createMainProcessModelRouting({
      dataDir,
      providers: options.providers!,
      executors: options.modelSourceExecutors!,
      allowLoopbackHttp: true,
    });
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const rendererListeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>();
    const mainFrame = {};
    const webContents = {
      mainFrame,
      send(channel: string, payload: unknown) {
        for (const listener of rendererListeners.get(channel) ?? []) {
          listener(undefined, structuredClone(payload));
        }
      },
    };
    const disposeIpc = registerIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: (channel) => { handlers.delete(channel); },
      },
      authorizedWebContents: webContents,
      windowControls: { minimize() {}, toggleMaximize() {}, close() {} },
      dispatchClient: async () => { throw new Error("Unexpected fallback dispatcher."); },
      client: options.client!,
      routeChatSend: routing.routeChatSend,
    });
    let exposed: Record<string, unknown> | undefined;
    installPreloadBridge({
      contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } },
      ipcRenderer: {
        invoke: async (channel, payload) => {
          const handler = handlers.get(channel);
          if (handler === undefined) throw new Error(`Missing IPC handler: ${channel}`);
          return structuredClone(await handler(
            { sender: webContents, senderFrame: mainFrame }, structuredClone(payload),
          ));
        },
        on: (channel, listener) => {
          const listeners = rendererListeners.get(channel) ?? new Set();
          listeners.add(listener);
          rendererListeners.set(channel, listeners);
        },
        removeListener: (channel, listener) => { rendererListeners.get(channel)?.delete(listener); },
      },
    });
    const bridge = (exposed?.client ?? (() => { throw new Error("Preload client bridge was not exposed."); })()) as RendererClientBridge;
    const renderer = createRendererClient(bridge);
    const sessionId = "agent:main:main";
    const streamed = [];
    try {
      try {
        await stage("chat send", (async () => {
          for await (const event of renderer.chat.send({
            sessionId,
            clientRequestId: "development-provider-chat-1",
            blocks: [{ type: "text", text: "hi", format: "plain" }],
          })) streamed.push(event);
        })(), 90_000);
      } catch (error) {
        const diagnosticHistory = await renderer.chat.list(sessionId).catch(() => null);
        throw new Error([
          error instanceof Error ? error.message : "Chat send failed.",
          `providerRequests=${providerRequests.length}`,
          `provider=${providerRequests.map(({ path, body }) => `${path}:stream=${String(body.stream)}:messages=${Array.isArray(body.messages) ? body.messages.length : 0}:tools=${Array.isArray(body.tools) ? body.tools.length : 0}`).join("|")}`,
          `events=${streamed.map((event) => event.type).join(",")}`,
          `history=${diagnosticHistory === null ? "unavailable" : diagnosticHistory.items.map((message) => message.role).join(",")}`,
          `gatewayExit=${String(child.exitCode)}`,
          `gateway=${`${gatewayStdout}\n${gatewayStderr}`.trim().slice(-2_000)}`,
        ].join("\n"));
      }

      expect(streamed[0]?.type).toBe("started");
      expect(streamed.at(-1)?.type, JSON.stringify(streamed)).toBe("final");
      expect(streamed.slice(1, -1).every((event) => event.type === "delta")).toBe(true);
      expect(streamed.at(-1)).toMatchObject({
        type: "final",
        message: { role: "assistant", blocks: [expect.objectContaining({ text: "真实回复成功" })] },
      });
      expect(providerRequests).toHaveLength(1);
      expect(providerRequests[0]).toMatchObject({ authorization: `Bearer ${apiKey}`, body: { model: "gpt-5.6-sol" } });
      expect(JSON.stringify(providerRequests[0]?.body)).toContain("hi");

      const history = await stage("chat history", renderer.chat.list(sessionId));
      expect(history.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({ role: "assistant" }),
      ]));
      expect(JSON.stringify([streamed, history])).not.toContain(apiKey);

      expect(handlers.has(CLIENT_IPC_CHANNEL)).toBe(true);
      expect(rendererListeners.has(CLIENT_IPC_EVENT_CHANNEL)).toBe(true);
    } finally {
      renderer.dispose();
      disposeIpc();
      await options.dispose?.();
    }
  }, 120_000);
});
