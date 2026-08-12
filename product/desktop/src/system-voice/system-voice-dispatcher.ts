import { SystemVoiceIpcRequestSchema, SystemVoiceIpcResponseSchema, type SystemVoiceService } from "@uclaw/shared/dist/system-voice.js";

export function createSystemVoiceDispatcher(service: SystemVoiceService) {
  return async (payload: unknown) => {
    const request = SystemVoiceIpcRequestSchema.parse(payload);
    const params = request.params as never;
    let result: unknown;
    switch (request.method) {
      case "talk.runtime.status": result = await service.getTalkRuntimeStatus(); break;
      case "talk.session.create": result = await service.createTalkSession(params); break;
      case "talk.session.close": result = await service.closeTalkSession(params); break;
      case "talk.client.create": result = await service.createTalkClient(params); break;
      case "talk.client.toolCall": result = await service.runTalkClientTool(params); break;
      case "talk.client.abort": result = await service.abortTalkClientTool(params); break;
      case "talk.client.steer": result = await service.steerTalkClient(params); break;
      case "tts.status": result = await service.getTtsStatus(); break;
      case "tts.providers": result = await service.listTtsProviders(); break;
      case "tts.setProvider": result = await service.setTtsProvider(params); break;
      case "tts.personas": result = await service.listTtsPersonas(); break;
      case "tts.setPersona": result = await service.setTtsPersona(params); break;
      case "tts.speak": result = await service.speak(params); break;
      case "voicewake.get": result = await service.getVoiceWake(); break;
      case "voicewake.set": result = await service.setVoiceWake(params); break;
      case "voicewake.routing.get": result = await service.getVoiceWakeRouting(); break;
      case "voicewake.routing.set": result = await service.setVoiceWakeRouting(params); break;
      case "push.web.status": result = await service.getPushStatus(); break;
      case "push.web.subscribe": result = await service.subscribePush(); break;
      case "push.web.unsubscribe": result = await service.unsubscribePush(); break;
      case "push.web.test": result = await service.testPush(); break;
    }
    return SystemVoiceIpcResponseSchema.parse({ method: request.method, requestId: request.requestId, ok: true, result });
  };
}
