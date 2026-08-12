import { PluginIpcResponseSchema, type PluginIpcRequest, type PluginIpcResponse } from "@uclaw/shared";

import type { PluginService } from "./plugin-service.js";
import type { OpenClawCapabilityRuntime } from "../capabilities/openclaw-capability-runtime.js";

export function createPluginDispatcher(
  service: PluginService,
  capabilities?: Pick<OpenClawCapabilityRuntime, "pluginDescriptors" | "pluginSessionAction">,
) {
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
      case "plugins.ui-descriptors": result = await capabilities?.pluginDescriptors(); break;
      case "plugins.session-action": result = await capabilities?.pluginSessionAction(request.params); break;
    }
    return PluginIpcResponseSchema.parse({ method: request.method, requestId: request.requestId, ok: true, result });
  };
}
