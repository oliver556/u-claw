import { PluginIpcResponseSchema, type PluginIpcRequest, type PluginIpcResponse } from "@uclaw/shared";

import type { PluginService } from "./plugin-service.js";

export function createPluginDispatcher(service: PluginService) {
  return async (request: PluginIpcRequest): Promise<PluginIpcResponse> => {
    let result: unknown;
    switch (request.method) {
      case "plugins.search": result = await service.search(request.params); break;
      case "plugins.installed": result = await service.installed(); break;
      case "plugins.detail": result = await service.detail(request.params.slug); break;
      case "plugins.install": result = await service.startInstall(request.params); break;
      case "plugins.update": result = await service.startUpdate(request.params); break;
      case "plugins.uninstall": result = await service.startUninstall(request.params.slug); break;
      case "plugins.set-enabled": result = await service.setEnabled(request.params); break;
      case "plugins.operation": result = await service.operation(request.params.operationId); break;
    }
    return PluginIpcResponseSchema.parse({ method: request.method, requestId: request.requestId, ok: true, result });
  };
}
