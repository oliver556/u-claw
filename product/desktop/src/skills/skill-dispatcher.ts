import { SkillIpcResponseSchema, type SkillIpcRequest, type SkillIpcResponse } from "@uclaw/shared";

import type { SkillService } from "./skill-service.js";

export function createSkillDispatcher(service: SkillService) {
  return async (request: SkillIpcRequest): Promise<SkillIpcResponse> => {
    let result: unknown;
    switch (request.method) {
      case "skills.search": result = await service.search(request.params); break;
      case "skills.installed": result = await service.installed(); break;
      case "skills.detail": result = await service.detail(request.params.slug); break;
      case "skills.install": result = await service.startInstall(request.params); break;
      case "skills.update": result = await service.startUpdate(request.params); break;
      case "skills.uninstall": result = await service.startUninstall(request.params.slug); break;
      case "skills.set-enabled": result = await service.setEnabled(request.params); break;
      case "skills.operation": result = await service.operation(request.params.operationId); break;
    }
    return SkillIpcResponseSchema.parse({ method: request.method, requestId: request.requestId, ok: true, result });
  };
}
