import {
  ProviderIpcResponseSchema,
  UClawErrorSchema,
  type ProviderIpcRequest,
  type ProviderIpcResponse,
} from "@uclaw/shared";

import type { ProviderStore } from "./provider-store.js";

export function createProviderDispatcher(store: ProviderStore) {
  return async (request: ProviderIpcRequest): Promise<ProviderIpcResponse> => {
    if (request.method === "providers.verify") {
      throw UClawErrorSchema.parse({
        code: "UNAVAILABLE",
        message: "Provider connectivity verification is reserved for MODEL-005.",
        retryable: false,
        recoveryActions: [],
        causeDetails: {},
      });
    }
    let result;
    switch (request.method) {
      case "providers.list": result = await store.list(); break;
      case "providers.create": result = await store.create(request.params.provider); break;
      case "providers.update": result = await store.update(request.params.providerId, request.params.provider); break;
      case "providers.remove": result = await store.remove(request.params.providerId); break;
      case "providers.set-enabled": result = await store.setEnabled(request.params.providerId, request.params.enabled); break;
      case "providers.move": result = await store.move(request.params.providerId, request.params.direction); break;
      case "providers.select": result = await store.select(request.params.providerId); break;
      case "providers.set-api-key": result = await store.setApiKey(request.params.providerId, request.params.apiKey); break;
      case "providers.clear-api-key": result = await store.clearApiKey(request.params.providerId); break;
    }
    return ProviderIpcResponseSchema.parse({ method: request.method, requestId: request.requestId, ok: true, result });
  };
}
