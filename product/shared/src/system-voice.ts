import { z } from "zod";
import { UClawErrorSchema } from "./errors.js";

const Id = z.string().trim().min(1).max(256);
const Empty = z.object({}).strict();
const PermissionState = z.enum(["granted", "denied", "restricted", "not-determined", "unknown"]);
export const SystemVoicePermissionsSchema = z.object({ microphone: PermissionState, notifications: PermissionState }).strict();
export type SystemVoicePermissions = z.infer<typeof SystemVoicePermissionsSchema>;
const RouteTarget = z.union([z.object({ mode: z.literal("current") }).strict(), z.object({ agentId: Id }).strict(), z.object({ sessionKey: Id }).strict()]);
export const VoiceWakeConfigSchema = z.object({ version: z.literal(1), defaultTarget: RouteTarget, routes: z.array(z.object({ trigger: z.string().trim().min(1).max(64), target: RouteTarget }).strict()).max(32), updatedAtMs: z.number().int().nonnegative().optional() }).strict();

export const SystemVoiceIpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("talk.runtime.status"), requestId: Id, params: Empty }).strict(),
  z.object({ method: z.literal("talk.session.create"), requestId: Id, params: z.object({ sessionKey: Id.optional(), mode: z.enum(["realtime", "transcription"]).default("realtime") }).strict() }).strict(),
  z.object({ method: z.literal("talk.session.close"), requestId: Id, params: z.object({ sessionId: Id }).strict() }).strict(),
  z.object({ method: z.literal("talk.client.create"), requestId: Id, params: z.object({ sessionKey: Id.optional() }).strict() }).strict(),
  z.object({ method: z.literal("talk.client.toolCall"), requestId: Id, params: z.object({ sessionKey: Id, callId: Id, name: z.literal("openclaw_agent_consult"), args: z.unknown().optional() }).strict() }).strict(),
  z.object({ method: z.literal("talk.client.abort"), requestId: Id, params: z.object({ callId: Id }).strict() }).strict(),
  z.object({ method: z.literal("talk.client.steer"), requestId: Id, params: z.object({ sessionKey: Id, text: z.string().trim().min(1).max(20_000), mode: z.enum(["status", "steer", "cancel", "followup"]).optional() }).strict() }).strict(),
  z.object({ method: z.literal("tts.status"), requestId: Id, params: Empty }).strict(),
  z.object({ method: z.literal("tts.providers"), requestId: Id, params: Empty }).strict(),
  z.object({ method: z.literal("tts.setProvider"), requestId: Id, params: z.object({ provider: Id }).strict() }).strict(),
  z.object({ method: z.literal("tts.personas"), requestId: Id, params: Empty }).strict(),
  z.object({ method: z.literal("tts.setPersona"), requestId: Id, params: z.object({ persona: Id.nullable() }).strict() }).strict(),
  z.object({ method: z.literal("tts.speak"), requestId: Id, params: z.object({ text: z.string().trim().min(1).max(20_000) }).strict() }).strict(),
  z.object({ method: z.literal("voicewake.get"), requestId: Id, params: Empty }).strict(),
  z.object({ method: z.literal("voicewake.set"), requestId: Id, params: z.object({ triggers: z.array(z.string().trim().min(1).max(64)).max(32) }).strict() }).strict(),
  z.object({ method: z.literal("voicewake.routing.get"), requestId: Id, params: Empty }).strict(),
  z.object({ method: z.literal("voicewake.routing.set"), requestId: Id, params: z.object({ config: VoiceWakeConfigSchema }).strict() }).strict(),
  z.object({ method: z.literal("push.web.status"), requestId: Id, params: Empty }).strict(),
  z.object({ method: z.literal("push.web.subscribe"), requestId: Id, params: Empty }).strict(),
  z.object({ method: z.literal("push.web.unsubscribe"), requestId: Id, params: Empty }).strict(),
  z.object({ method: z.literal("push.web.test"), requestId: Id, params: Empty }).strict(),
]);
export type SystemVoiceIpcRequest = z.infer<typeof SystemVoiceIpcRequestSchema>;
export type SystemVoiceMethod = SystemVoiceIpcRequest["method"];
const SensitiveResultKey = /(?:endpoint|auth|p256dh|audioBase64|token|secret|password|credential|api[_-]?key|private[_-]?key|authorization|cookie)/i;
function rendererSafe(value: unknown): boolean { if (Array.isArray(value)) return value.every(rendererSafe); if (!value || typeof value !== "object") return true; return Object.entries(value).every(([key, entry]) => !SensitiveResultKey.test(key) && rendererSafe(entry)); }
const RendererSafeResult = z.unknown().refine(rendererSafe, "Sensitive voice or Push result cannot cross renderer IPC");
export const TalkClientBootstrapSchema = z.object({ provider: Id, transport: z.literal("webrtc"), clientSecret: Id, offerUrl: z.literal("https://api.openai.com/v1/realtime/calls"), offerHeaders: z.record(z.string(), z.string()).optional(), sessionKey: Id, model: Id.optional(), voice: Id.optional(), expiresAt: z.number().optional() }).strict();
export type TalkClientBootstrap = z.infer<typeof TalkClientBootstrapSchema>;
export const SystemVoiceIpcResponseSchema = z.union([z.object({ method: z.literal("talk.client.create"), requestId: Id, ok: z.literal(true), result: z.object({ clientBootstrap: TalkClientBootstrapSchema, permissions: SystemVoicePermissionsSchema }).strict() }).strict(), z.object({ method: z.string(), requestId: Id, ok: z.literal(true), result: RendererSafeResult }).strict(), z.object({ method: z.string(), requestId: Id, ok: z.literal(false), error: UClawErrorSchema }).strict()]);
export type SystemVoiceIpcResponse = z.infer<typeof SystemVoiceIpcResponseSchema>;
export const SYSTEM_VOICE_IPC_CHANNEL = "uclaw:system-voice";
type Params<M extends SystemVoiceMethod> = Extract<SystemVoiceIpcRequest, { method: M }>["params"];
export interface SystemVoiceService {
  getTalkRuntimeStatus(): Promise<unknown>; createTalkSession(input: Params<"talk.session.create">): Promise<unknown>; closeTalkSession(input: Params<"talk.session.close">): Promise<unknown>; createTalkClient(input: Params<"talk.client.create">): Promise<unknown>; runTalkClientTool(input: Params<"talk.client.toolCall">): Promise<unknown>; abortTalkClientTool(input: Params<"talk.client.abort">): Promise<void>; steerTalkClient(input: Params<"talk.client.steer">): Promise<unknown>; clearTalkSessions(): Promise<void>;
  getTtsStatus(): Promise<unknown>; listTtsProviders(): Promise<unknown>; setTtsProvider(input: Params<"tts.setProvider">): Promise<unknown>; listTtsPersonas(): Promise<unknown>; setTtsPersona(input: Params<"tts.setPersona">): Promise<unknown>; speak(input: Params<"tts.speak">): Promise<unknown>;
  getVoiceWake(): Promise<unknown>; setVoiceWake(input: Params<"voicewake.set">): Promise<unknown>; getVoiceWakeRouting(): Promise<unknown>; setVoiceWakeRouting(input: Params<"voicewake.routing.set">): Promise<unknown>;
  getPushStatus(): Promise<unknown>; subscribePush(): Promise<unknown>; unsubscribePush(): Promise<unknown>; testPush(): Promise<unknown>;
}
export interface SystemVoicePermissionReader { get(): Promise<SystemVoicePermissions>; }
export interface SystemPushSubscription { endpoint: string; keys: { p256dh: string; auth: string }; }
export interface SystemPushSubscriptionAuthority { get(): Promise<SystemPushSubscription | null>; subscribe(vapidPublicKey: string): Promise<SystemPushSubscription>; unsubscribe(): Promise<void>; }
export interface SystemVoiceAudioOutput { play(input: { audioBase64: string; mimeType?: string }): Promise<void>; }
export interface SystemTalkSessionAuthority { list(): Promise<unknown[]>; record(sessionId: string, value: unknown): Promise<void>; remove(sessionId: string): Promise<void>; clear(): Promise<void>; }
