import { ReleaseIpcResponseSchema, type ReleaseIpcRequest } from "@uclaw/shared";

import type { ReleaseService } from "./release-service.js";

export function createReleaseDispatcher(service: ReleaseService) {
  return async (request: ReleaseIpcRequest) => {
    let result: unknown;
    switch (request.method) {
      case "release.check": result = await service.check(request.params.channel); break;
      case "release.retry": result = await service.retry(); break;
      case "release.cancel-check": result = service.cancelCheck(); break;
      case "release.install": result = service.install(request.params.updateId, request.params.previewToken, request.params.confirmed); break;
      case "release.operation": result = service.operation(request.params.operationId); break;
      case "release.cancel": result = service.cancel(request.params.operationId); break;
      case "release.recovery": result = await service.recover(); break;
      case "uninstall.preview": result = await service.previewUninstall(); break;
      case "uninstall.execute": result = service.executeUninstall(request.params.scopeIds, request.params.previewToken, request.params.confirmed); break;
    }
    return ReleaseIpcResponseSchema.parse({ method: request.method, requestId: request.requestId, ok: true, result });
  };
}
