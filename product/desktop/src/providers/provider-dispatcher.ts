import {
  DEFAULT_PROVIDER_NETWORK_SETTINGS,
  ProviderIpcResponseSchema,
  type ProviderIpcRequest,
  type ProviderIpcResponse,
} from "@uclaw/shared";

import type { ProviderStore } from "./provider-store.js";
import { createProviderNetworkService } from "./provider-network.js";

export function createProviderDispatcher(store: ProviderStore, network = createProviderNetworkService()) {
  return async (request: ProviderIpcRequest): Promise<ProviderIpcResponse> => {
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
      case "providers.set-network": result = await store.setNetwork(request.params.network); break;
      case "providers.discover-local": result = await network.discover(request.requestId); break;
      case "providers.verify": {
        const [provider, snapshot] = await Promise.all([store.getForRuntime(request.params.providerId), store.list()]);
        result = await network.verify(request.requestId, provider, snapshot.network ?? DEFAULT_PROVIDER_NETWORK_SETTINGS);
        break;
      }
      case "providers.cancel":
        network.cancel(request.params.operationRequestId);
        result = null;
        break;
    }
    return ProviderIpcResponseSchema.parse({ method: request.method, requestId: request.requestId, ok: true, result });
  };
}
