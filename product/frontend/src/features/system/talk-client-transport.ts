import type { TalkClientBootstrap } from "@uclaw/shared/dist/system-voice.js";

export interface TalkClientTransport { stop(): void; }
export interface TalkClientControl {
  consult(input: { sessionKey: string; callId: string; name: "openclaw_agent_consult"; args?: unknown }): Promise<unknown>;
  abort?(input: { callId: string }): Promise<void>;
  steer(input: { sessionKey: string; text: string; mode?: "status" | "steer" | "cancel" | "followup" }): Promise<unknown>;
}
export interface TalkClientRuntime {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createPeer(): RTCPeerConnection;
  fetch(input: string, init: RequestInit): Promise<Response>;
  createAudio(): HTMLAudioElement;
}
const browserRuntime: TalkClientRuntime = { getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints), createPeer: () => new RTCPeerConnection(), fetch: (input, init) => fetch(input, init), createAudio: () => document.createElement("audio") };

export async function startTalkClientTransport(bootstrap: TalkClientBootstrap, runtime: TalkClientRuntime = browserRuntime, control?: TalkClientControl): Promise<TalkClientTransport> {
  const { offerUrl, offerHeaders, sessionKey } = bootstrap;
  let secret = bootstrap.clientSecret;
  bootstrap.clientSecret = "";
  const url = new URL(offerUrl);
  if (url.protocol !== "https:" || url.hostname !== "api.openai.com" || url.pathname !== "/v1/realtime/calls") throw new Error("UNSUPPORTED: Talk WebRTC endpoint is not trusted.");
  const peer = runtime.createPeer(); const media = await runtime.getUserMedia({ audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true } }); const audio = runtime.createAudio(); audio.autoplay = true; audio.hidden = true; document.body.append(audio); peer.addEventListener("track", (event) => { audio.srcObject = event.streams[0] ?? null; }); for (const track of media.getAudioTracks()) peer.addTrack(track, media); const channel = peer.createDataChannel("oai-events");
  const toolBuffers = new Map<string, { name: string; callId: string; args: string }>(); const activeConsults = new Set<string>(); let responseActive = false; let responsePending = false; let stopped = false;
  const requestResponse = () => { if (responseActive) { responsePending = true; return; } channel.send(JSON.stringify({ type: "response.create" })); };
  const sendToolOutput = (callId: string, output: unknown) => { if (channel.readyState !== "open" || stopped) return; channel.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) } })); requestResponse(); };
  channel.addEventListener("message", (event) => { void (async () => {
    if (typeof event.data !== "string") return;
    let value: Record<string, unknown>; try { value = JSON.parse(event.data) as Record<string, unknown>; } catch { return; }
    const itemId = typeof value.item_id === "string" ? value.item_id : "unknown";
    if (value.type === "response.function_call_arguments.delta") { const previous = toolBuffers.get(itemId); const delta = typeof value.delta === "string" ? value.delta : ""; toolBuffers.set(itemId, { name: previous?.name ?? String(value.name ?? ""), callId: previous?.callId ?? String(value.call_id ?? ""), args: `${previous?.args ?? ""}${delta}` }); return; }
    if (value.type === "response.created") { responseActive = true; return; } if (value.type === "response.done" || value.type === "response.cancelled") { responseActive = false; if (responsePending) { responsePending = false; requestResponse(); } return; } if (value.type !== "response.function_call_arguments.done") return;
    const buffered = toolBuffers.get(itemId); toolBuffers.delete(itemId); const name = buffered?.name || String(value.name ?? ""); const callId = buffered?.callId || String(value.call_id ?? ""); if (!callId) return;
    let args: unknown; try { args = JSON.parse(buffered?.args || String(value.arguments ?? "{}")); } catch { sendToolOutput(callId, { error: "Invalid Talk tool arguments." }); return; }
    try {
      if (!control) throw new Error("Talk control bridge is not configured.");
      if (name === "openclaw_agent_consult") { activeConsults.add(callId); try { sendToolOutput(callId, await control.consult({ sessionKey, callId, name, args })); } finally { activeConsults.delete(callId); } }
      else if (name === "openclaw_agent_control") { const input = args && typeof args === "object" ? args as Record<string, unknown> : {}; const text = [input.text, input.message, input.request, input.query].find((item) => typeof item === "string" && item.trim()) as string | undefined; const mode = input.mode; if (!text) throw new Error("Talk control text is required."); if (mode !== undefined && mode !== "status" && mode !== "steer" && mode !== "cancel" && mode !== "followup") throw new Error("Invalid Talk control mode."); const result = await control.steer({ sessionKey, text: text.trim(), ...(mode ? { mode } : {}) }); const row = result && typeof result === "object" ? result as Record<string, unknown> : {}; if (responseActive && (row.mode === "cancel" || row.suppress === true && row.mode !== "steer")) channel.send(JSON.stringify({ type: "response.cancel" })); sendToolOutput(callId, result); }
      else sendToolOutput(callId, { error: `Tool \"${name}\" is not available.` });
    } catch (error) { sendToolOutput(callId, { error: error instanceof Error ? error.message : String(error) }); }
  })(); });
  try { const offer = await peer.createOffer(); await peer.setLocalDescription(offer); const response = await runtime.fetch(offerUrl, { method: "POST", body: offer.sdp, headers: { ...offerHeaders, Authorization: `Bearer ${secret}`, "Content-Type": "application/sdp" } }); if (!response.ok) throw new Error(`Talk WebRTC setup failed (${response.status})`); await peer.setRemoteDescription({ type: "answer", sdp: await response.text() }); }
  catch (error) { for (const track of media.getTracks()) track.stop(); peer.close(); audio.remove(); throw error; }
  finally { secret = ""; }
  return { stop() { if (stopped) return; stopped = true; for (const callId of activeConsults) void control?.abort?.({ callId }); activeConsults.clear(); toolBuffers.clear(); responseActive = false; responsePending = false; channel.close(); for (const track of media.getTracks()) track.stop(); peer.close(); audio.srcObject = null; audio.remove(); } };
}
