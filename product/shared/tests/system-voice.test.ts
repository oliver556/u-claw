import { describe, expect, it } from "vitest";

import { SystemVoiceIpcRequestSchema, SystemVoiceIpcResponseSchema } from "../src/system-voice.js";

describe("system voice contract", () => {
  it("accepts Talk, TTS, Voice Wake, and Push operations", () => {
    const requests = [
      { method: "talk.session.create", requestId: "1", params: { mode: "realtime" } },
      { method: "talk.client.create", requestId: "2", params: { sessionKey: "agent:main:main" } },
      { method: "tts.speak", requestId: "3", params: { text: "hello" } },
      { method: "voicewake.set", requestId: "4", params: { triggers: ["Hey U-Claw"] } },
      { method: "voicewake.routing.set", requestId: "5", params: { config: { version: 1, defaultTarget: { mode: "current" }, routes: [{ trigger: "Hey U-Claw", target: { agentId: "main" } }] } } },
      { method: "push.web.subscribe", requestId: "6", params: {} },
      { method: "push.web.unsubscribe", requestId: "7", params: {} },
      { method: "push.web.test", requestId: "8", params: {} },
    ];
    for (const request of requests) expect(SystemVoiceIpcRequestSchema.parse(request)).toEqual(request);
  });

  it("rejects renderer permission claims and sensitive Gateway results", () => {
    expect(() => SystemVoiceIpcRequestSchema.parse({ method: "talk.session.create", requestId: "1", params: { microphoneGranted: true } })).toThrow();
    expect(() => SystemVoiceIpcRequestSchema.parse({ method: "push.web.subscribe", requestId: "2", params: { endpoint: "https://push.example/secret" } })).toThrow();
    expect(() => SystemVoiceIpcResponseSchema.parse({ method: "push.web.subscribe", requestId: "2", ok: true, result: { endpoint: "https://push.example/secret", auth: "secret" } })).toThrow();
    expect(() => SystemVoiceIpcResponseSchema.parse({ method: "talk.client.create", requestId: "3", ok: true, result: { clientSecret: "bypass" } })).toThrow();
  });
});
