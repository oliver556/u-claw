import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { WebSocket, WebSocketServer } from "ws";

import { cleanupCaptureResources } from "./capture-cleanup.mjs";
import { prepareCaptureStateDir } from "./capture-state.mjs";

const packageDir = resolve(process.env.OPENCLAW_PACKAGE_DIR ?? join(homedir(), ".uclaw/core/node_modules/openclaw"));
const nodeBin = process.env.OPENCLAW_NODE_BIN ?? process.execPath;
const stateDir = resolve(process.env.OPENCLAW_CAPTURE_STATE_DIR ?? "/tmp/uclaw-openclaw-v4-capture");
const outputDir = resolve(process.env.OPENCLAW_CAPTURE_OUTPUT_DIR ?? join(stateDir, "capture"));
const gatewayPort = Number(process.env.OPENCLAW_CAPTURE_GATEWAY_PORT ?? 18789);
const proxyPort = Number(process.env.OPENCLAW_CAPTURE_PROXY_PORT ?? 18790);
const modelPort = Number(process.env.OPENCLAW_CAPTURE_MODEL_PORT ?? 18880);
const token = "contract-token";
const sessionKey = "agent:dev:main";
const rawFrames = [];
const gatewayEvents = [];

function timeout(ms, label) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms));
}

function waitForEvent(predicate, label, ms = 20_000) {
  const found = gatewayEvents.find(predicate);
  if (found) return Promise.resolve(found);
  return Promise.race([
    new Promise((resolveEvent) => {
      const timer = setInterval(() => {
        const event = gatewayEvents.find(predicate);
        if (!event) return;
        clearInterval(timer);
        resolveEvent(event);
      }, 20);
    }),
    timeout(ms, label),
  ]);
}

function gatewayErrorEvidence(error) {
  return {
    name: error?.name ?? "Error",
    message: error instanceof Error ? error.message : String(error),
    ...(typeof error?.gatewayCode === "string" ? { code: error.gatewayCode } : {}),
    ...(error?.details && typeof error.details === "object" ? { details: error.details } : {}),
  };
}

function sendSse(response, chunks) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function startModelServer() {
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [
        { id: "contract-model", object: "model" },
        { id: "contract-alt-model", object: "model" },
      ] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const hasToolResult = body.messages?.some((message) => message.role === "tool") === true;
    const attachmentCase = JSON.stringify(body.messages).includes("ATTACHMENT_CASE");
    const common = { id: "chatcmpl-contract", object: "chat.completion.chunk", created: 1786126000, model: "contract-model" };
    if (!hasToolResult && !attachmentCase) {
      const tool = body.tools?.find((entry) => entry.function?.name === "sessions_list") ?? body.tools?.[0];
      if (!tool) {
        sendSse(response, [
          { ...common, choices: [{ index: 0, delta: { role: "assistant", content: "[REDACTED ASSISTANT CONTENT]" }, finish_reason: null }] },
          { ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
        return;
      }
      sendSse(response, [
        { ...common, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_contract_sessions", type: "function", function: { name: tool.function.name, arguments: "{}" } }] }, finish_reason: null }] },
        { ...common, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ]);
      return;
    }
    sendSse(response, [
      { ...common, choices: [{ index: 0, delta: { role: "assistant", content: "[REDACTED ASSISTANT CONTENT]" }, finish_reason: null }] },
      { ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
  });
  server.listen(modelPort, "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function waitForChatFinal(runId) {
  return waitForEvent((event) => event.event === "chat" && event.payload?.state === "final" && event.payload?.runId === runId, `chat final ${runId}`);
}

async function captureRequest(client, method, params, options) {
  const start = rawFrames.length;
  let result;
  let error;
  try {
    result = await client.request(method, params, options);
  } catch (caught) {
    error = gatewayErrorEvidence(caught);
  }
  const requestFrame = rawFrames.slice(start).find((entry) => entry.direction === "client-to-gateway" && entry.frame?.method === method)?.frame;
  const responseFrame = requestFrame
    ? rawFrames.slice(start).find((entry) => entry.direction === "gateway-to-client" && entry.frame?.type === "res" && entry.frame?.id === requestFrame.id)?.frame
    : undefined;
  if (!requestFrame || !responseFrame) throw new Error(`Missing raw wire frame for ${method}`);
  return { requestFrame, responseFrame, ...(error ? { error } : { result }) };
}

async function captureApproval({ requester, reviewer, family, id, decision, unavailable = false }) {
  const requestedEvent = `${family}.approval.requested`;
  const requestMethod = `${family}.approval.request`;
  const listMethod = `${family}.approval.list`;
  const resolveMethod = `${family}.approval.resolve`;
  const eventStart = gatewayEvents.length;
  const requestParams = family === "exec"
    ? {
        id,
        command: `/usr/bin/printf ${id}`,
        commandArgv: ["/usr/bin/printf", id],
        cwd: "/tmp",
        host: "gateway",
        security: "allowlist",
        ask: "always",
        unavailableDecisions: ["allow-always"],
        sessionKey,
        timeoutMs: 15_000,
        twoPhase: true,
      }
    : {
        pluginId: "contract-plugin",
        title: "Contract approval",
        description: "[REDACTED OPERATION]",
        severity: "warning",
        toolName: "contract_tool",
        toolCallId: id,
        allowedDecisions: ["allow-once", "deny"],
        sessionKey,
        timeoutMs: 15_000,
        twoPhase: true,
      };
  const pending = requester.request(requestMethod, requestParams, { timeoutMs: 20_000 });
  const event = await waitForEvent((candidate) => gatewayEvents.indexOf(candidate) >= eventStart
    && candidate.event === requestedEvent
    && (family === "exec" ? candidate.payload?.id === id : candidate.payload?.request?.toolCallId === id), `${requestedEvent} ${id}`);
  const approvalId = event.payload.id;
  const listing = await captureRequest(reviewer, listMethod, {});
  const resolution = await captureRequest(reviewer, resolveMethod, { id: approvalId, decision });
  if (unavailable) {
    const cleanup = await captureRequest(reviewer, resolveMethod, { id: approvalId, decision: "deny" });
    const requestResult = await pending;
    return { event, listing, resolution, cleanup, requestResult };
  }
  const requestResult = await pending;
  return { event, listing, resolution, requestResult };
}

async function startProxy() {
  const proxy = new WebSocketServer({ host: "127.0.0.1", port: proxyPort });
  proxy.on("connection", (downstream) => {
    const upstream = new WebSocket(`ws://127.0.0.1:${gatewayPort}`, { origin: `http://127.0.0.1:${gatewayPort}` });
    const pending = [];
    downstream.on("message", (data) => {
      const text = data.toString();
      rawFrames.push({ direction: "client-to-gateway", frame: JSON.parse(text) });
      if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
      else pending.push(text);
    });
    upstream.on("open", () => {
      for (const text of pending.splice(0)) upstream.send(text);
    });
    upstream.on("message", (data) => {
      const text = data.toString();
      rawFrames.push({ direction: "gateway-to-client", frame: JSON.parse(text) });
      downstream.send(text);
    });
    upstream.on("close", (code, reason) => downstream.close(code, reason.toString()));
    downstream.on("close", () => upstream.close());
  });
  await once(proxy, "listening");
  return proxy;
}

async function main() {
  await prepareCaptureStateDir(stateDir);
  await mkdir(outputDir, { recursive: true });
  await mkdir(join(stateDir, "workspace"), { recursive: true });
  const config = {
    gateway: { mode: "local", bind: "loopback" },
    agents: {
      defaults: {
        workspace: join(stateDir, "workspace"),
        skipBootstrap: true,
        mediaMaxMb: 0.001,
        model: { primary: "contract/contract-model" },
        models: { "contract/contract-model": {}, "contract/contract-alt-model": {} },
      },
      list: [{ id: "dev", default: true, workspace: join(stateDir, "workspace") }],
    },
    models: {
      mode: "replace",
      providers: {
        contract: {
          baseUrl: `http://127.0.0.1:${modelPort}/v1`,
          apiKey: "contract-local-key",
          api: "openai-completions",
          models: ["contract-model", "contract-alt-model"].map((id) => ({
            id,
            name: id === "contract-model" ? "Contract Model" : "Contract Alt Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131_072,
            maxTokens: 8_192,
          })),
        },
      },
    },
  };
  await writeFile(join(stateDir, "openclaw.json"), `${JSON.stringify(config, null, 2)}\n`);

  let modelServer;
  let proxy;
  let gateway;
  let client;
  let requester;
  try {
    modelServer = await startModelServer();
    gateway = spawn(nodeBin, [join(packageDir, "openclaw.mjs"), "gateway", "run", "--port", String(gatewayPort), "--auth", "token", "--token", token, "--ws-log", "compact"], {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    gateway.stdout.on("data", (chunk) => process.stderr.write(chunk));
    gateway.stderr.on("data", (chunk) => process.stderr.write(chunk));

    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await new Promise((resolveConnect, reject) => {
          const socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}`);
          socket.once("open", () => { socket.close(); resolveConnect(); });
          socket.once("error", reject);
        });
        break;
      } catch {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
    }
    proxy = await startProxy();
    const { GatewayClient } = await import(pathToFileURL(join(packageDir, "dist/plugin-sdk/gateway-runtime.js")));
    const hello = new Promise((resolveHello, reject) => {
      client = new GatewayClient({
        url: `ws://127.0.0.1:${proxyPort}`,
        origin: `http://127.0.0.1:${gatewayPort}`,
        token,
        clientName: "openclaw-control-ui",
        clientVersion: "contract-capture",
        mode: "ui",
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"],
        onHelloOk: resolveHello,
        onConnectError: reject,
        onEvent: (event) => gatewayEvents.push(structuredClone(event)),
      });
      client.start();
    });
    await Promise.race([hello, timeout(10_000, "Gateway hello")]);
    const requesterHello = new Promise((resolveHello, reject) => {
      requester = new GatewayClient({
        url: `ws://127.0.0.1:${proxyPort}`,
        token,
        clientName: "gateway-client",
        clientVersion: "contract-capture",
        mode: "backend",
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"],
        onHelloOk: resolveHello,
        onConnectError: reject,
      });
      requester.start();
    });
    await Promise.race([requesterHello, timeout(10_000, "requester Gateway hello")]);
    await client.request("sessions.subscribe", {});
    await client.request("sessions.create", { key: sessionKey, agentId: "dev" });
    const sendResult = await client.request("chat.send", {
      sessionKey,
      message: "Use sessions_list exactly once, then answer done.",
      idempotencyKey: "contract-tool-run-1",
    });
    const start = await waitForEvent((event) => event.event === "session.tool" && event.payload?.data?.phase === "start", "session.tool start");
    const result = await waitForEvent((event) => event.event === "session.tool" && event.payload?.data?.phase === "result", "session.tool result");
    await waitForEvent((event) => event.event === "chat" && event.payload?.state === "final", "chat final");
    const historyEvidence = await captureRequest(client, "chat.history", { sessionKey, limit: 20 });
    const history = historyEvidence.result;
    const messageId = history.messages?.find((message) => message?.__openclaw?.id)?.__openclaw?.id;
    if (!messageId) throw new Error("chat.history did not expose a message id");
    const messageGet = await captureRequest(client, "chat.message.get", { sessionKey, messageId });
    const messageUnavailable = await captureRequest(client, "chat.message.get", { sessionKey, messageId: "message-contract-missing" });

    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
    const attachmentCases = [
      { kind: "image", attachment: { type: "image", fileName: "fixture.png", mimeType: "image/png", content: png } },
      { kind: "text", attachment: { type: "file", fileName: "fixture.txt", mimeType: "text/plain", content: Buffer.from("contract").toString("base64") } },
      { kind: "mime-mismatch", attachment: { type: "image", fileName: "fixture.png", mimeType: "not-a-mime", content: png } },
      { kind: "oversized", attachment: { type: "file", fileName: "oversized.bin", mimeType: "application/octet-stream", content: Buffer.alloc(1_049, 65).toString("base64") } },
    ];
    const attachments = [];
    for (const entry of attachmentCases) {
      const evidence = await captureRequest(client, "chat.send", {
        sessionKey,
        message: `ATTACHMENT_CASE:${entry.kind}`,
        attachments: [entry.attachment],
        idempotencyKey: `contract-attachment-${entry.kind}`,
      });
      if (evidence.result?.runId) await waitForChatFinal(evidence.result.runId);
      attachments.push({ kind: entry.kind, ...evidence });
    }

    const approvals = {
      exec: {
        allowOnce: await captureApproval({ requester, reviewer: client, family: "exec", id: "exec-contract-allow-once", decision: "allow-once" }),
        deny: await captureApproval({ requester, reviewer: client, family: "exec", id: "exec-contract-deny", decision: "deny" }),
        unavailable: await captureApproval({ requester, reviewer: client, family: "exec", id: "exec-contract-unavailable", decision: "allow-always", unavailable: true }),
      },
      plugin: {
        allowOnce: await captureApproval({ requester, reviewer: client, family: "plugin", id: "plugin-contract-allow-once", decision: "allow-once" }),
        deny: await captureApproval({ requester, reviewer: client, family: "plugin", id: "plugin-contract-deny", decision: "deny" }),
        unavailable: await captureApproval({ requester, reviewer: client, family: "plugin", id: "plugin-contract-unavailable", decision: "allow-always", unavailable: true }),
      },
    };
    const secondKey = "agent:dev:dashboard:contract-2";
    await client.request("sessions.create", { key: secondKey, agentId: "dev" });
    const rename = await captureRequest(client, "sessions.patch", { key: sessionKey, label: "Contract Renamed" });
    const model = await captureRequest(client, "sessions.patch", { key: sessionKey, model: "contract/contract-alt-model" });
    const modelReadback = await captureRequest(client, "sessions.list", {});
    const baseHash = await captureRequest(client, "sessions.patch", { key: sessionKey, label: "Should Not Apply", baseHash: "contract-stale-base-hash" });
    const sessionsPatch = {
      rename,
      model,
      modelReadback,
      baseHash,
      duplicateLabel: await captureRequest(client, "sessions.patch", { key: secondKey, label: "Contract Renamed" }),
    };
    await writeFile(join(outputDir, "session.tool.json"), `${JSON.stringify({ sendResult, start, result }, null, 2)}\n`);
    await writeFile(join(outputDir, "chat.history.json"), `${JSON.stringify(historyEvidence, null, 2)}\n`);
    await writeFile(join(outputDir, "chat.message.get.json"), `${JSON.stringify({ success: messageGet, unavailable: messageUnavailable }, null, 2)}\n`);
    await writeFile(join(outputDir, "attachments.json"), `${JSON.stringify({ cases: attachments }, null, 2)}\n`);
    await writeFile(join(outputDir, "approvals.json"), `${JSON.stringify(approvals, null, 2)}\n`);
    await writeFile(join(outputDir, "sessions.patch.json"), `${JSON.stringify(sessionsPatch, null, 2)}\n`);
    await writeFile(join(outputDir, "raw-frames.json"), `${JSON.stringify(rawFrames, null, 2)}\n`);
  } finally {
    await cleanupCaptureResources({
      requester,
      client,
      proxy,
      modelServer,
      gateway,
      writeDebug: async () => {
        await mkdir(outputDir, { recursive: true });
        await writeFile(join(outputDir, "raw-frames.debug.json"), `${JSON.stringify(rawFrames, null, 2)}\n`);
        await writeFile(join(outputDir, "gateway-events.debug.json"), `${JSON.stringify(gatewayEvents, null, 2)}\n`);
      },
    });
  }
}

await main();
