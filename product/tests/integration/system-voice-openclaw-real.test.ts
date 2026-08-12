import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GatewayWebSocket, type WebSocketLike } from "@uclaw/adapter";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createOpenClawSystemVoiceService } from "../../adapter/src/system-voice.js";
import { UClawUnsupportedError } from "../../adapter/src/openclaw-client.js";

const runReal = process.env.UCLAW_REAL_OPENCLAW === "1";
const runtimeRoot = process.env.UCLAW_REAL_RUNTIME_DIR ?? join(process.env.HOME ?? "", ".uclaw");
const nodeExecutable = join(runtimeRoot, "runtime/node-mac-arm64/bin/node");
const openClawEntry = join(runtimeRoot, "core/node_modules/openclaw/openclaw.mjs");
const roots: string[] = []; const children: ChildProcess[] = [];
afterEach(async () => { for (const child of children.splice(0)) { if (child.exitCode === null) child.kill("SIGINT"); await new Promise<void>((resolve) => child.once("close", () => resolve())); } await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); }, 30_000);
async function freePort() { const server = createServer(); await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject)); const address = server.address(); const value = typeof address === "object" && address ? address.port : 0; await new Promise<void>((resolve) => server.close(() => resolve())); return value; }
async function waitForPort(port: number, child: ChildProcess) { for (let i = 0; i < 300; i += 1) { if (child.exitCode !== null) throw new Error(`Gateway exited ${child.exitCode}`); const ready = await new Promise<boolean>((resolve) => { const socket = new Socket(); socket.setTimeout(100); socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => resolve(false)); socket.once("timeout", () => { socket.destroy(); resolve(false); }); socket.connect(port, "127.0.0.1"); }); if (ready) return; await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error("Gateway readiness timeout"); }

describe.skipIf(!runReal)("real OpenClaw Talk/TTS/Voice Wake/Push", () => {
  it("uses advertised locked methods and authoritative isolated state", async () => {
    await Promise.all([access(nodeExecutable), access(openClawEntry)]);
    expect(JSON.parse(await readFile(join(dirname(openClawEntry), "package.json"), "utf8"))).toMatchObject({ version: "2026.7.1-2" });
    const root = await mkdtemp(join(tmpdir(), "uclaw-system-voice-real-")); roots.push(root); const stateDir = join(root, "state"); const workspace = join(root, "workspace"); await Promise.all([mkdir(stateDir), mkdir(workspace)]); const configPath = join(stateDir, "openclaw.json"); const token = `system-voice-${process.pid}-${Date.now()}`;
    await writeFile(configPath, JSON.stringify({ gateway: { mode: "local", bind: "loopback", auth: { mode: "token", token } }, agents: { defaults: { workspace, skipBootstrap: true }, list: [{ id: "main", default: true, workspace }] }, messages: { tts: { provider: "system", personas: { calm: { label: "Calm", provider: "system" } } } } }));
    const port = await freePort(); const child = spawn(nodeExecutable, [openClawEntry, "gateway", "run", "--port", String(port), "--auth", "token", "--ws-log", "compact"], { cwd: runtimeRoot, env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_GATEWAY_TOKEN: token }, stdio: "ignore" }); children.push(child); await waitForPort(port, child);
    const transport = new GatewayWebSocket({ url: `ws://127.0.0.1:${port}`, webSocketFactory: (url) => new WebSocket(url) as unknown as WebSocketLike, connectParams: () => ({ client: { id: "u-claw-desktop", mode: "desktop" }, role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"], caps: ["protocol-v4"], auth: { token } }) });
    const hello = await transport.connect(); const methods = new Set(hello.features.methods); const required = ["talk.catalog", "talk.session.create", "talk.session.close", "talk.client.create", "tts.status", "tts.providers", "tts.personas", "tts.setProvider", "tts.setPersona", "tts.speak", "voicewake.get", "voicewake.set", "voicewake.routing.get", "voicewake.routing.set"];
    for (const method of required) expect(methods.has(method), `${method} advertised`).toBe(true);
    const request = (method: string, params: unknown, schema: z.ZodType) => transport.router.request(method, params as never, schema);
    let pushSubscription: { endpoint: string; keys: { p256dh: string; auth: string } } | null = null;
    let playedBytes = 0; const service = createOpenClawSystemVoiceService({ request, requireMethod: (method) => { if (!methods.has(method)) throw new UClawUnsupportedError(method); }, permissions: { get: async () => ({ microphone: "granted", notifications: "granted" }) }, audioOutput: { play: async ({ audioBase64 }) => { playedBytes = Buffer.from(audioBase64, "base64").byteLength; } }, pushSubscription: { get: async () => pushSubscription, subscribe: async () => pushSubscription = { endpoint: "https://push.example.invalid/uclaw-smoke", keys: { p256dh: "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", auth: "AAAAAAAAAAAAAAAAAAAAAA" } }, unsubscribe: async () => { pushSubscription = null; } } });
    await expect(service.getTtsStatus()).resolves.toMatchObject({ authority: { provider: "system" } }); await expect(service.listTtsProviders()).resolves.toMatchObject({ authority: { providers: expect.any(Array) } }); await expect(service.listTtsPersonas()).resolves.toMatchObject({ authority: { personas: expect.any(Array) } }); const spoken = await service.speak({ text: "U-Claw smoke" }) as { mutation: { provider: string }; authority: { provider: string } }; expect(spoken.mutation.provider).toBeTruthy(); expect(spoken.authority.provider).toBe("system"); expect(playedBytes).toBeGreaterThan(0); expect(JSON.stringify(spoken)).not.toContain("audioBase64");
    await service.setVoiceWake({ triggers: ["uclaw smoke"] }); await expect(service.getVoiceWake()).resolves.toMatchObject({ authority: { triggers: ["uclaw smoke"] } });
    const config = { version: 1 as const, defaultTarget: { agentId: "main" }, routes: [{ trigger: "uclaw smoke", target: { agentId: "main" } }] }; await service.setVoiceWakeRouting({ config }); await expect(service.getVoiceWakeRouting()).resolves.toMatchObject({ authority: { config: { defaultTarget: { agentId: "main" } } } });
    expect(await request("talk.catalog", {}, z.unknown())).toBeTruthy();
    const created = await service.createTalkSession({ mode: "realtime" }) as { mutation: { sessionId: string }; authority: { sessions: Array<{ sessionId: string }> } }; expect(created.authority.sessions).toEqual([expect.objectContaining({ sessionId: created.mutation.sessionId })]); const closed = await service.closeTalkSession({ sessionId: created.mutation.sessionId }) as { authority: { sessions: unknown[] } }; expect(closed.authority.sessions).toEqual([]);
    expect(methods.has("push.web.vapidPublicKey")).toBe(false); await expect(request("push.web.vapidPublicKey", {}, z.unknown())).resolves.toMatchObject({ vapidPublicKey: expect.any(String) }); await expect(service.subscribePush()).resolves.toMatchObject({ authority: { subscribed: true } }); await expect(service.testPush()).rejects.toBeTruthy(); await expect(service.unsubscribePush()).resolves.toMatchObject({ authority: { subscribed: false } }); transport.close();
  }, 60_000);
});
