import { createOpenClawSystemVoiceService, type OpenClawSystemVoiceOptions } from "@uclaw/adapter/dist/system-voice.js";
import { createSystemVoiceDispatcher } from "./system-voice-dispatcher.js";
import { createSystemVoiceDomainRegistration } from "./system-voice-domain.js";

export function createProductionSystemVoiceDomain(options: OpenClawSystemVoiceOptions) {
  const service = createOpenClawSystemVoiceService(options);
  return createSystemVoiceDomainRegistration(createSystemVoiceDispatcher(service), () => service.clearTalkSessions());
}
