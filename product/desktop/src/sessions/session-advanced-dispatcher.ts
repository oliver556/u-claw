import {
  SessionAdvancedIpcRequestSchema,
  SessionAdvancedIpcResponseSchema,
  type SessionAdvancedService,
} from "@uclaw/shared/dist/session-advanced.js";

export function createSessionAdvancedDispatcher(service: SessionAdvancedService) {
  return async (payload: unknown) => {
    const request = SessionAdvancedIpcRequestSchema.parse(payload);
    let result;
    switch (request.method) {
      case "sessions.files.list": result = await service.listFiles(request.params); break;
      case "sessions.files.get": result = await service.getFile(request.params); break;
      case "sessions.checkpoints.list": result = await service.listCheckpoints(request.params); break;
      case "sessions.reset": result = await service.reset(request.params); break;
      case "sessions.compact": result = await service.compact(request.params); break;
      case "sessions.branch": result = await service.branch(request.params); break;
      case "sessions.restore": result = await service.restore(request.params); break;
      case "sessions.steer": result = await service.steer(request.params); break;
    }
    return SessionAdvancedIpcResponseSchema.parse({ method: request.method, requestId: request.requestId, ok: true, result });
  };
}
