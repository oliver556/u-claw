// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { startTalkClientTransport } from "../src/features/system/talk-client-transport.js";
describe("Talk client WebRTC transport", () => {
  it("uses one-time credential, microphone track, SDP, and disposes all resources", async () => {
    const track = { stop: vi.fn() }; const media = { getAudioTracks: () => [track], getTracks: () => [track] }; const channel = { readyState: "open", addEventListener: vi.fn(), send: vi.fn(), close: vi.fn() }; const peer = { addEventListener: vi.fn(), addTrack: vi.fn(), createDataChannel: vi.fn(() => channel), createOffer: vi.fn(async () => ({ type: "offer", sdp: "offer-sdp" })), setLocalDescription: vi.fn(), setRemoteDescription: vi.fn(), close: vi.fn() }; const audio = document.createElement("audio"); const fetch = vi.fn(async (_url: string, init: RequestInit) => { expect(init.headers).toMatchObject({ Authorization: "Bearer short-lived" }); return new Response("answer-sdp", { status: 200 }); });
    const bootstrap = { provider: "openai", transport: "webrtc" as const, clientSecret: "short-lived", offerUrl: "https://api.openai.com/v1/realtime/calls" as const, sessionKey: "main" };
    const transport = await startTalkClientTransport(bootstrap, { getUserMedia: vi.fn(async () => media as never), createPeer: () => peer as never, fetch, createAudio: () => audio }); expect(peer.addTrack).toHaveBeenCalled(); expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "answer-sdp" }); expect(bootstrap.clientSecret).toBe(""); transport.stop(); expect(track.stop).toHaveBeenCalled(); expect(peer.close).toHaveBeenCalled(); expect(audio.isConnected).toBe(false);
  });
  it("bridges consult and control tool calls through OpenClaw and returns outputs", async () => {
    const listeners = new Map<string, (event: { data?: string }) => void>();
    const channel = { readyState: "open", addEventListener: vi.fn((type: string, listener: (event: { data?: string }) => void) => listeners.set(type, listener)), send: vi.fn(), close: vi.fn() };
    const track = { stop: vi.fn() }; const media = { getAudioTracks: () => [track], getTracks: () => [track] }; const peer = { addEventListener: vi.fn(), addTrack: vi.fn(), createDataChannel: vi.fn(() => channel), createOffer: vi.fn(async () => ({ type: "offer", sdp: "offer-sdp" })), setLocalDescription: vi.fn(), setRemoteDescription: vi.fn(), close: vi.fn() };
    const control = { consult: vi.fn(async () => ({ answer: "repo result" })), steer: vi.fn(async () => ({ ok: true, mode: "cancel" })) };
    await startTalkClientTransport({ provider: "openai", transport: "webrtc", clientSecret: "short-lived", offerUrl: "https://api.openai.com/v1/realtime/calls", sessionKey: "main" }, { getUserMedia: vi.fn(async () => media as never), createPeer: () => peer as never, fetch: vi.fn(async () => new Response("answer-sdp", { status: 200 })), createAudio: () => document.createElement("audio") }, control);
    listeners.get("message")?.({ data: JSON.stringify({ type: "response.function_call_arguments.done", item_id: "item-1", call_id: "call-1", name: "openclaw_agent_consult", arguments: JSON.stringify({ prompt: "inspect repo" }) }) });
    await vi.waitFor(() => expect(control.consult).toHaveBeenCalledWith({ sessionKey: "main", callId: "call-1", name: "openclaw_agent_consult", args: { prompt: "inspect repo" } }));
    expect(channel.send).toHaveBeenCalledWith(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "call-1", output: JSON.stringify({ answer: "repo result" }) } }));
    listeners.get("message")?.({ data: JSON.stringify({ type: "response.function_call_arguments.done", item_id: "item-2", call_id: "call-2", name: "openclaw_agent_control", arguments: JSON.stringify({ text: "stop", mode: "cancel" }) }) });
    await vi.waitFor(() => expect(control.steer).toHaveBeenCalledWith({ sessionKey: "main", text: "stop", mode: "cancel" }));
  });
  it("serializes responses, cancels suppressed control output, and aborts consults on stop", async () => {
    const listeners = new Map<string, (event: { data?: string }) => void>(); const channel = { readyState: "open", addEventListener: vi.fn((type: string, listener: (event: { data?: string }) => void) => listeners.set(type, listener)), send: vi.fn(), close: vi.fn() };
    const track = { stop: vi.fn() }; const media = { getAudioTracks: () => [track], getTracks: () => [track] }; const peer = { addEventListener: vi.fn(), addTrack: vi.fn(), createDataChannel: vi.fn(() => channel), createOffer: vi.fn(async () => ({ type: "offer", sdp: "offer-sdp" })), setLocalDescription: vi.fn(), setRemoteDescription: vi.fn(), close: vi.fn() };
    let resolveConsult!: (value: unknown) => void; const control = { consult: vi.fn(() => new Promise((resolve) => { resolveConsult = resolve; })), steer: vi.fn(async () => ({ ok: true, mode: "cancel", suppress: true })), abort: vi.fn(async () => undefined) };
    const transport = await startTalkClientTransport({ provider: "openai", transport: "webrtc", clientSecret: "secret", offerUrl: "https://api.openai.com/v1/realtime/calls", sessionKey: "main" }, { getUserMedia: vi.fn(async () => media as never), createPeer: () => peer as never, fetch: vi.fn(async () => new Response("answer", { status: 200 })), createAudio: () => document.createElement("audio") }, control);
    listeners.get("message")?.({ data: JSON.stringify({ type: "response.created" }) });
    listeners.get("message")?.({ data: JSON.stringify({ type: "response.function_call_arguments.done", item_id: "c", call_id: "consult-1", name: "openclaw_agent_consult", arguments: "{}" }) });
    await vi.waitFor(() => expect(control.consult).toHaveBeenCalled());
    listeners.get("message")?.({ data: JSON.stringify({ type: "response.function_call_arguments.done", item_id: "x", call_id: "control-1", name: "openclaw_agent_control", arguments: JSON.stringify({ message: "stop", mode: "cancel" }) }) });
    await vi.waitFor(() => expect(control.steer).toHaveBeenCalledWith({ sessionKey: "main", text: "stop", mode: "cancel" }));
    expect(channel.send).not.toHaveBeenCalledWith(JSON.stringify({ type: "response.create" }));
    transport.stop(); expect(control.abort).toHaveBeenCalledWith({ callId: "consult-1" }); resolveConsult({ answer: "late" });
  });
  it("rejects an untrusted offer endpoint before microphone access", async () => { const getUserMedia = vi.fn(); await expect(startTalkClientTransport({ provider: "openai", transport: "webrtc", clientSecret: "short-lived", offerUrl: "https://evil.invalid/v1/realtime/calls" } as never, { getUserMedia, createPeer: vi.fn() as never, fetch: vi.fn() as never, createAudio: vi.fn() as never })).rejects.toThrow("not trusted"); expect(getUserMedia).not.toHaveBeenCalled(); });
});
