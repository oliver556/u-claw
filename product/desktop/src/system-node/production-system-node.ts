import { createOpenClawSystemNodeService, type OpenClawSystemNodeOptions } from "@uclaw/adapter/dist/system-node.js";
import { UClawErrorSchema } from "@uclaw/shared";
import type { SystemNodeService } from "@uclaw/shared/dist/system-node.js";
import { createSystemNodeDispatcher } from "./system-node-dispatcher.js";
import { createSystemNodeDomainRegistration } from "./system-node-domain.js";

function disableTerminal(service: SystemNodeService): SystemNodeService {
  const forbidden = () => Promise.reject(UClawErrorSchema.parse({
    code: "FORBIDDEN",
    message: "Terminal requires an explicitly trusted admin surface and a minimal Gateway environment.",
    retryable: false,
    recoveryActions: [],
    causeDetails: {},
  }));
  return {
    ...service,
    listTerminals: forbidden,
    openTerminal: forbidden,
    inputTerminal: forbidden,
    resizeTerminal: forbidden,
    closeTerminal: forbidden,
    attachTerminal: forbidden,
    getTerminalText: forbidden,
    subscribe: (listener) => service.subscribe((event) => {
      if (!event.event.startsWith("terminal.")) listener(event);
    }),
  };
}

export function createProductionSystemNodeDomain(options: OpenClawSystemNodeOptions) {
  const gatewayService = createOpenClawSystemNodeService(options);
  const service = disableTerminal(gatewayService);
  return createSystemNodeDomainRegistration(createSystemNodeDispatcher(service), service);
}
