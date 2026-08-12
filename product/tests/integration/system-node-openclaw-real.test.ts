import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GatewayWebSocket, type WebSocketLike } from "@uclaw/adapter";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenClawSystemNodeService } from "../../adapter/src/system-node.js";
import { UClawUnsupportedError } from "../../adapter/src/openclaw-client.js";

const runReal = process.env.UCLAW_REAL_OPENCLAW === "1";
const runtimeRoot = process.env.UCLAW_REAL_RUNTIME_DIR ?? join(process.env.HOME ?? "", ".uclaw");
const nodeExecutable = join(runtimeRoot, "runtime/node-mac-arm64/bin/node");
const openClawEntry = join(runtimeRoot, "core/node_modules/openclaw/openclaw.mjs");
const roots: string[] = []; const children: ChildProcess[] = [];
afterEach(async () => { for (const child of children.splice(0)) { if (child.exitCode === null) { child.kill("SIGINT"); await new Promise<void>((resolve) => child.once("close", () => resolve())); } } await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); }, 30_000);
async function port() { const server = createServer(); await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject)); const address = server.address(); const value = typeof address === "object" && address ? address.port : 0; await new Promise<void>((resolve) => server.close(() => resolve())); return value; }
async function wait(portNumber: number, child: ChildProcess) { for (let i = 0; i < 300; i += 1) { if (child.exitCode !== null) throw new Error(`Gateway exited ${child.exitCode}`); const ready = await new Promise<boolean>((resolve) => { const socket = new Socket(); socket.setTimeout(100); socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => resolve(false)); socket.once("timeout", () => { socket.destroy(); resolve(false); }); socket.connect(portNumber, "127.0.0.1"); }); if (ready) return; await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error("Gateway readiness timeout"); }

describe.skipIf(!runReal)("real OpenClaw system node", () => {
  it("uses authority for devices, nodes, environments, worktrees, and Terminal across reconnect and restart", async () => {
    await Promise.all([access(nodeExecutable), access(openClawEntry)]);
    expect(JSON.parse(await readFile(join(dirname(openClawEntry), "package.json"), "utf8"))).toMatchObject({ version: "2026.7.1-2" });
    const root = await mkdtemp(join(tmpdir(), "uclaw-system-node-real-")); roots.push(root);
    const stateDir = join(root, "state"); const workspace = join(root, "workspace"); const configPath = join(stateDir, "openclaw.json"); const repo = join(root, "repo");
    await Promise.all([mkdir(stateDir, { recursive: true }), mkdir(workspace, { recursive: true }), mkdir(repo, { recursive: true })]);
    spawnSync("git", ["init", "-b", "main"], { cwd: repo }); await writeFile(join(repo, "README.md"), "authority\n"); spawnSync("git", ["add", "README.md"], { cwd: repo }); spawnSync("git", ["-c", "user.name=U-Claw", "-c", "user.email=uclaw@example.invalid", "commit", "-m", "init"], { cwd: repo });
    const token = `system-node-${process.pid}-${Date.now()}`;
    await writeFile(configPath, JSON.stringify({ gateway: { mode: "local", bind: "loopback", auth: { mode: "token", token }, terminal: { enabled: true, detachedSessionTimeoutSeconds: 30 } }, agents: { defaults: { workspace, skipBootstrap: true }, list: [{ id: "main", default: true, workspace }] } }));
    const gatewayPort = await port();
    const connect = async () => {
      const transport = new GatewayWebSocket({ url: `ws://127.0.0.1:${gatewayPort}`, webSocketFactory: (url) => new WebSocket(url) as unknown as WebSocketLike, connectParams: () => ({ client: { id: "u-claw-desktop", mode: "desktop" }, role: "operator", scopes: ["operator.read", "operator.write", "operator.admin", "operator.pairing"], caps: ["protocol-v4"], auth: { token } }) });
      const hello = await transport.connect(); const methods = new Set(hello.features.methods);
      const service = createOpenClawSystemNodeService({ router: transport.router, requireMethod: (method) => { if (!methods.has(method)) throw new UClawUnsupportedError(method); } });
      return { transport, methods, service };
    };
    const launch = async () => { const child = spawn(nodeExecutable, [openClawEntry, "gateway", "run", "--port", String(gatewayPort), "--auth", "token", "--ws-log", "compact"], { cwd: runtimeRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_GATEWAY_TOKEN: token }, stdio: "ignore" }); children.push(child); await wait(gatewayPort, child); return { child, ...await connect() }; };
    let runtime = await launch();
    for (const method of ["device.pair.list", "node.list", "environments.list", "environments.status", "worktrees.list", "worktrees.create", "worktrees.remove", "worktrees.restore", "worktrees.gc", "terminal.list", "terminal.open", "terminal.input", "terminal.attach", "terminal.text", "terminal.close"]) expect(runtime.methods.has(method), `${method} advertised`).toBe(true);
    await expect(runtime.service.listDevices()).resolves.toMatchObject({ pending: [], paired: [] });
    await expect(runtime.service.listNodes()).resolves.toMatchObject({ nodes: [] });
    await expect(runtime.service.removeDevice({ deviceId: "missing" })).rejects.toBeTruthy();
    await expect(runtime.service.listEnvironments()).resolves.toMatchObject({ environments: [expect.objectContaining({ id: "gateway", status: "available" })] });
    await expect(runtime.service.getEnvironmentStatus({ environmentId: "gateway" })).resolves.toMatchObject({ id: "gateway", status: "available" });

    const created = await runtime.service.createWorktree({ repoRoot: repo, name: "smoke", baseRef: "main" }) as { mutation: { id: string; path: string }; authority: { worktrees: Array<{ id: string }> } };
    expect(created.authority.worktrees).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.mutation.id })]));
    await writeFile(join(created.mutation.path, "dirty.txt"), "restore-me\n");
    const removed = await runtime.service.removeWorktree({ id: created.mutation.id, force: true }) as { mutation: { snapshotRef?: string }; authority: unknown };
    expect(removed.mutation.snapshotRef).toBeTruthy();
    runtime.transport.close();
    const reconnected = await connect();
    const restored = await reconnected.service.restoreWorktree({ id: created.mutation.id }) as { mutation: { path: string }; authority: unknown };
    await expect(readFile(join(restored.mutation.path, "dirty.txt"), "utf8")).resolves.toBe("restore-me\n");
    await reconnected.service.removeWorktree({ id: created.mutation.id, force: true }); await reconnected.service.gcWorktrees();

    const terminalEvents: unknown[] = []; const unsubscribe = reconnected.service.subscribe((event) => terminalEvents.push(event));
    const opened = await reconnected.service.openTerminal({ agentId: "main", cols: 100, rows: 30 }) as { mutation: { sessionId: string }; authority: { sessions: Array<{ sessionId: string }> } };
    expect(opened.authority.sessions).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: opened.mutation.sessionId })]));
    await reconnected.service.inputTerminal({ sessionId: opened.mutation.sessionId, data: "printf 'uclaw-terminal-authority\\n'\n" });
    for (let i = 0; i < 100; i += 1) { const output = await reconnected.service.getTerminalText({ sessionId: opened.mutation.sessionId }) as { text: string }; if (output.text.includes("uclaw-terminal-authority")) break; await new Promise((resolve) => setTimeout(resolve, 20)); }
    await expect(reconnected.service.getTerminalText({ sessionId: opened.mutation.sessionId })).resolves.toMatchObject({ text: expect.stringContaining("uclaw-terminal-authority") });
    expect(terminalEvents).toEqual(expect.arrayContaining([expect.objectContaining({ event: "terminal.data" })]));
    reconnected.transport.close(); unsubscribe();
    const attachedRuntime = await connect();
    await expect(attachedRuntime.service.attachTerminal({ sessionId: opened.mutation.sessionId })).resolves.toMatchObject({ sessionId: opened.mutation.sessionId, buffer: expect.stringContaining("uclaw-terminal-authority") });
    await attachedRuntime.service.closeTerminal({ sessionId: opened.mutation.sessionId });
    await expect(attachedRuntime.service.listTerminals()).resolves.toMatchObject({ sessions: [] });
    attachedRuntime.transport.close(); runtime.child.kill("SIGINT"); await new Promise<void>((resolve) => runtime.child.once("close", () => resolve())); children.splice(children.indexOf(runtime.child), 1);
    runtime = await launch();
    await expect(runtime.service.listTerminals()).resolves.toMatchObject({ sessions: [] });
    runtime.transport.close(); reconnected.transport.close();
  }, 90_000);
});
