import { describe, expect, it, vi } from "vitest";
import { createOpenClawSystemVoiceService } from "../src/system-voice.js";

const permission = { get: vi.fn(async () => ({ microphone: "granted" as const, notifications: "granted" as const })) };
function pushAuthority() { let current: { endpoint: string; keys: { p256dh: string; auth: string } } | null = null; return { get: vi.fn(async () => current), subscribe: vi.fn(async () => current = { endpoint: "https://push.example/sub", keys: { p256dh: "public-key", auth: "auth-key" } }), unsubscribe: vi.fn(async () => { current = null; }) }; }
describe("OpenClaw system voice service", () => {
  it("reports only Gateway sessions owned by this service instance", async () => {
    const request = vi.fn(async (method: string) => method === "talk.session.create" ? { sessionId: "talk-1", mode: "realtime", transport: "gateway-relay" } : {});
    const service = createOpenClawSystemVoiceService({ request, requireMethod: vi.fn(), permissions: permission });
    await expect(service.getTalkRuntimeStatus()).resolves.toEqual({ authority: { scope: "owned-runtime", sessions: [] }, permissions: { microphone: "granted", notifications: "granted" } });
    await service.createTalkSession({ mode: "realtime" });
    await expect(service.getTalkRuntimeStatus()).resolves.toMatchObject({ authority: { scope: "owned-runtime", sessions: [{ sessionId: "talk-1" }] } });
  });
  it("clears owned Talk sessions on Gateway disconnect", async () => {
    const authority = { list: vi.fn(async () => [] as unknown[]), record: vi.fn(async () => undefined), remove: vi.fn(async () => undefined), clear: vi.fn(async () => undefined) };
    const service = createOpenClawSystemVoiceService({ request: vi.fn(), requireMethod: vi.fn(), permissions: permission, talkSessions: authority });
    await service.clearTalkSessions();
    expect(authority.clear).toHaveBeenCalledOnce();
  });
  it("bridges client tool calls and steering through locked OpenClaw methods", async () => {
    const request = vi.fn(async (method: string) => method === "talk.client.toolCall" ? { runId: "run-1", idempotencyKey: "idem-1" } : { ok: true, mode: "cancel", sessionKey: "main", active: false, message: "cancelled", speak: false, show: true, suppress: true });
    const waitForTalkRun = vi.fn(async () => ({ result: "done" })); const service = createOpenClawSystemVoiceService({ request, requireMethod: vi.fn(), permissions: permission, waitForTalkRun });
    await expect(service.runTalkClientTool({ sessionKey: "main", callId: "call-1", name: "openclaw_agent_consult", args: { prompt: "inspect" } })).resolves.toEqual({ result: "done" });
    expect(waitForTalkRun).toHaveBeenCalledWith("run-1");
    await expect(service.steerTalkClient({ sessionKey: "main", text: "stop", mode: "cancel" })).resolves.toMatchObject({ ok: true, mode: "cancel" });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["talk.client.toolCall", "talk.client.steer"]);
  });
  it("aborts the accepted OpenClaw run by client call id", async () => {
    let release!: (value: unknown) => void; const request = vi.fn(async () => ({ runId: "run-1", idempotencyKey: "idem-1" })); const abortTalkRun = vi.fn(async () => undefined);
    const waitForTalkRun = vi.fn(() => new Promise((resolve) => { release = resolve; })); const service = createOpenClawSystemVoiceService({ request, requireMethod: vi.fn(), permissions: permission, waitForTalkRun, abortTalkRun });
    const running = service.runTalkClientTool({ sessionKey: "main", callId: "call-1", name: "openclaw_agent_consult", args: {} }); await vi.waitFor(() => expect(waitForTalkRun).toHaveBeenCalledWith("run-1"));
    await service.abortTalkClientTool({ callId: "call-1" }); expect(abortTalkRun).toHaveBeenCalledWith("main", "run-1"); release({ status: "cancelled" }); await running;
  });
  it("normalizes the locked OpenClaw default WebRTC offer endpoint", async () => {
    const service = createOpenClawSystemVoiceService({ request: vi.fn(async () => ({ provider: "openai", transport: "webrtc", clientSecret: "short-lived" })), requireMethod: vi.fn(), permissions: permission });
    await expect(service.createTalkClient({ sessionKey: "main" })).resolves.toMatchObject({ clientBootstrap: { sessionKey: "main", offerUrl: "https://api.openai.com/v1/realtime/calls" } });
  });
  it("uses locked OpenClaw RPC names and reads authority after writes", async () => {
    const request = vi.fn(async (method: string) => method === "talk.session.create" ? { sessionId: "talk-1", mode: "realtime", transport: "gateway-relay" } : method === "push.web.vapidPublicKey" ? { vapidPublicKey: "vapid-public" } : method === "voicewake.get" ? { triggers: ["openclaw"] } : method === "voicewake.routing.get" ? { config: { version: 1, defaultTarget: { mode: "current" }, routes: [] } } : method === "tts.status" ? { enabled: true, provider: "system" } : method === "push.web.subscribe" ? { subscriptionId: "sub-1" } : {});
    const requireMethod = vi.fn(); const service = createOpenClawSystemVoiceService({ request, requireMethod, permissions: permission, pushSubscription: pushAuthority() });
    await service.createTalkSession({ mode: "realtime" }); await service.setTtsProvider({ provider: "system" }); await service.setVoiceWake({ triggers: ["openclaw"] }); await service.subscribePush();
    expect(request.mock.calls.map(([method]) => method)).toEqual(["talk.session.create", "tts.setProvider", "tts.status", "voicewake.set", "voicewake.get", "push.web.vapidPublicKey", "push.web.subscribe"]);
    expect(requireMethod.mock.calls.map(([method]) => method)).not.toContain("push.web.vapidPublicKey");
  });
  it("checks current OS permissions with explicit errors", async () => {
    const request = vi.fn(); const service = createOpenClawSystemVoiceService({ request, requireMethod: vi.fn(), permissions: { get: vi.fn(async () => ({ microphone: "denied" as const, notifications: "denied" as const })) }, pushSubscription: pushAuthority() });
    await expect(service.createTalkSession({ mode: "realtime" })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("麦克风权限被拒绝") });
    await expect(service.testPush()).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("通知权限被拒绝") }); expect(request).not.toHaveBeenCalled();
  });
  it("blocks unknown permission authority instead of silently proceeding", async () => {
    const request = vi.fn(); const service = createOpenClawSystemVoiceService({ request, requireMethod: vi.fn(), permissions: { get: vi.fn(async () => ({ microphone: "unknown" as const, notifications: "not-determined" as const })) } });
    await expect(service.createTalkSession({ mode: "realtime" })).rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" }); await expect(service.testPush()).rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" }); expect(request).not.toHaveBeenCalled();
  });
  it("keeps Push endpoint, keys, VAPID key, and TTS audio outside renderer results", async () => {
    const request = vi.fn(async (method: string) => method === "push.web.vapidPublicKey" ? { vapidPublicKey: "vapid-public" } : method === "push.web.subscribe" ? { subscriptionId: "sub-1" } : method === "tts.speak" ? { audioBase64: "secret-audio", provider: "system", mimeType: "audio/wav" } : { enabled: true, provider: "system" });
    const audioOutput = { play: vi.fn(async () => undefined) }; const service = createOpenClawSystemVoiceService({ request, requireMethod: vi.fn(), permissions: permission, pushSubscription: pushAuthority(), audioOutput });
    expect(JSON.stringify(await service.subscribePush())).not.toMatch(/endpoint|auth-key|public-key|vapid-public/);
    expect(JSON.stringify(await service.speak({ text: "hello" }))).not.toContain("secret-audio");
    expect(audioOutput.play).toHaveBeenCalledWith({ audioBase64: "secret-audio", mimeType: "audio/wav" });
  });
  it("does not report a resolved Push RPC with no delivered notification as success", async () => {
    const request = vi.fn(async () => ({ results: [{ ok: false, reason: "network" }] }));
    const service = createOpenClawSystemVoiceService({ request, requireMethod: vi.fn(), permissions: permission, pushSubscription: pushAuthority() });
    await expect(service.testPush()).rejects.toMatchObject({ code: "OPERATION_FAILED", message: "Push 测试通知投递失败。" });
  });
  it("rolls back the OS subscription when Gateway registration fails", async () => {
    const authority = pushAuthority(); const request = vi.fn(async (method: string) => method === "push.web.vapidPublicKey" ? { vapidPublicKey: "vapid" } : Promise.reject(new Error("register failed")));
    const service = createOpenClawSystemVoiceService({ request, requireMethod: vi.fn(), permissions: permission, pushSubscription: authority }); await expect(service.subscribePush()).rejects.toThrow("register failed"); expect(authority.unsubscribe).toHaveBeenCalledOnce(); await expect(authority.get()).resolves.toBeNull();
  });
});
