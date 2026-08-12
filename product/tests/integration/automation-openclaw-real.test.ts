import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GatewayWebSocket, type WebSocketLike } from "@uclaw/adapter";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createOpenClawAutomationService } from "../../adapter/src/automation.js";
import { UClawUnsupportedError } from "../../adapter/src/openclaw-client.js";

const runReal = process.env.UCLAW_REAL_OPENCLAW === "1";
const runtimeRoot = process.env.UCLAW_REAL_RUNTIME_DIR ?? join(process.env.HOME ?? "", ".uclaw");
const nodeExecutable = join(runtimeRoot, "runtime/node-mac-arm64/bin/node");
const openClawEntry = join(runtimeRoot, "core/node_modules/openclaw/openclaw.mjs");
const roots: string[] = []; const children: ChildProcess[] = [];
afterEach(async () => { for (const child of children.splice(0)) { if (child.exitCode === null) child.kill("SIGINT"); await new Promise<void>((resolve) => child.once("close", () => resolve())); } await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function port() { const server = createServer(); await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject)); const address = server.address(); const value = typeof address === "object" && address ? address.port : 0; await new Promise<void>((resolve) => server.close(() => resolve())); return value; }
async function wait(portNumber: number, child: ChildProcess) { for (let i = 0; i < 300; i += 1) { if (child.exitCode !== null) throw new Error(`Gateway exited ${child.exitCode}`); const ready = await new Promise<boolean>((resolve) => { const socket = new Socket(); socket.setTimeout(100); socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => resolve(false)); socket.once("timeout", () => { socket.destroy(); resolve(false); }); socket.connect(portNumber, "127.0.0.1"); }); if (ready) return; await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error("Gateway readiness timeout"); }

describe.skipIf(!runReal)("real OpenClaw Agent/Cron", () => {
  it("uses advertised authority, persists Agent files and Cron jobs across Gateway restart", async () => {
    await Promise.all([access(nodeExecutable), access(openClawEntry)]);
    expect(JSON.parse(await readFile(join(dirname(openClawEntry), "package.json"), "utf8"))).toMatchObject({ version: "2026.7.1-2" });
    const root = await mkdtemp(join(tmpdir(), "uclaw-automation-real-")); roots.push(root);
    const stateDir = join(root, "state"); const workspace = join(root, "workspace"); const configPath = join(stateDir, "openclaw.json");
    await Promise.all([mkdir(stateDir, { recursive: true }), mkdir(workspace, { recursive: true })]);
    const token = `automation-${process.pid}-${Date.now()}`;
    await writeFile(configPath, JSON.stringify({ gateway: { mode: "local", bind: "loopback", auth: { mode: "token", token } }, agents: { defaults: { workspace, skipBootstrap: true }, list: [{ id: "main", default: true, workspace }] } }));
    const gatewayPort = await port();
    const launch = async () => { const child = spawn(nodeExecutable, [openClawEntry, "gateway", "run", "--port", String(gatewayPort), "--auth", "token", "--ws-log", "compact"], { cwd: runtimeRoot, env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_GATEWAY_TOKEN: token }, stdio: "ignore" }); children.push(child); await wait(gatewayPort, child); const transport = new GatewayWebSocket({ url: `ws://127.0.0.1:${gatewayPort}`, webSocketFactory: (url) => new WebSocket(url) as unknown as WebSocketLike, connectParams: () => ({ client: { id: "u-claw-desktop", mode: "desktop" }, role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"], caps: ["protocol-v4"], auth: { token } }) }); const hello = await transport.connect(); const methods = new Set(hello.features.methods); const service = createOpenClawAutomationService({ router: transport.router, requireMethod: (method) => { if (!methods.has(method)) throw new UClawUnsupportedError(method); } }); return { child, transport, methods, service }; };
    let runtime = await launch();
    const required = ["agents.list", "agent.identity.get", "agents.create", "agents.update", "agents.delete", "agents.files.list", "agents.files.get", "agents.files.set", "agents.workspace.list", "agents.workspace.get", "cron.list", "cron.status", "cron.get", "cron.add", "cron.update", "cron.remove", "cron.run", "cron.runs"];
    for (const method of required) expect(runtime.methods.has(method), `${method} advertised`).toBe(true);
    await expect(runtime.service.listAgents()).resolves.toMatchObject({ agents: [expect.objectContaining({ id: "main" })] });
    const smokeWorkspace = join(root, "smoke-agent");
    await runtime.service.createAgent({ name: "smoke-agent", workspace: smokeWorkspace });
    const updatedWorkspace = join(root, "smoke-agent-updated");
    await runtime.service.updateAgent({ agentId: "smoke-agent", name: "Smoke Agent Updated", workspace: updatedWorkspace, model: "openai/gpt-5" });
    await expect(runtime.service.listAgents()).resolves.toMatchObject({ agents: expect.arrayContaining([expect.objectContaining({ id: "smoke-agent", workspace: updatedWorkspace, model: "openai/gpt-5" })]) });
    await runtime.service.deleteAgent({ agentId: "smoke-agent", deleteFiles: false });
    await expect(access(smokeWorkspace)).resolves.toBeUndefined();
    await expect(runtime.service.getAgentIdentity({ agentId: "main" })).resolves.toBeTruthy();
    await runtime.service.writeAgentFile({ agentId: "main", path: "AGENTS.md", content: "authoritative-agent-rule" });
    await expect(runtime.service.getAgentFile({ agentId: "main", path: "AGENTS.md" })).resolves.toMatchObject({ file: { content: "authoritative-agent-rule" } });
    await expect(runtime.service.listAgentWorkspace({ agentId: "main" })).resolves.toMatchObject({ entries: expect.any(Array) });
    const added = await runtime.service.addCron({ name: "Smoke", enabled: true, schedule: { kind: "cron", expression: "0 9 * * *" }, payload: { kind: "agentTurn", message: "smoke" }, agentId: "main" }) as { jobs?: Array<{ id: string }> };
    const job = added.jobs?.[0]; expect(job?.id).toBeTruthy();
    await expect(runtime.service.getCron({ jobId: job!.id })).resolves.toBeTruthy();
    await expect(runtime.service.runCron({ jobId: job!.id })).resolves.toBeTruthy();
    await expect(runtime.service.listCronRuns({ jobId: job!.id })).resolves.toBeTruthy();
    await runtime.service.updateCron({ jobId: job!.id, name: "Smoke updated", enabled: false });
    await expect(runtime.service.getCron({ jobId: job!.id })).resolves.toMatchObject({ job: { enabled: false } });
    runtime.transport.close(); runtime.child.kill("SIGINT"); await new Promise<void>((resolve) => runtime.child.once("close", () => resolve())); children.splice(children.indexOf(runtime.child), 1);
    runtime = await launch();
    await expect(runtime.service.getAgentFile({ agentId: "main", path: "AGENTS.md" })).resolves.toMatchObject({ file: { content: "authoritative-agent-rule" } });
    await expect(runtime.service.getCron({ jobId: job!.id })).resolves.toBeTruthy(); await runtime.service.removeCron({ jobId: job!.id }); runtime.transport.close();
  }, 60_000);
});
