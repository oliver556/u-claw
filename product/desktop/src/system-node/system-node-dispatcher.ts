import { SystemNodeIpcRequestSchema, SystemNodeIpcResponseSchema, type SystemNodeService } from "@uclaw/shared/dist/system-node.js";

export function createSystemNodeDispatcher(service: SystemNodeService) {
  return async (payload: unknown) => {
    const request = SystemNodeIpcRequestSchema.parse(payload);
    const p = request.params as never;
    let result: unknown;
    switch (request.method) {
      case "device.pair.list": result = await service.listDevices(); break;
      case "device.pair.approve": result = await service.approveDevice(p); break;
      case "device.pair.reject": result = await service.rejectDevice(p); break;
      case "device.pair.remove": result = await service.removeDevice(p); break;
      case "device.token.rotate": result = await service.rotateDeviceToken(p); break;
      case "device.token.revoke": result = await service.revokeDeviceToken(p); break;
      case "node.list": result = await service.listNodes(); break;
      case "node.describe": result = await service.describeNode(p); break;
      case "node.rename": result = await service.renameNode(p); break;
      case "node.pair.list": result = await service.listNodePairs(); break;
      case "node.pair.approve": result = await service.approveNodePair(p); break;
      case "node.pair.reject": result = await service.rejectNodePair(p); break;
      case "node.pair.remove": result = await service.removeNodePair(p); break;
      case "node.invoke": result = await service.invokeNode(p); break;
      case "environments.list": result = await service.listEnvironments(); break;
      case "environments.status": result = await service.getEnvironmentStatus(p); break;
      case "worktrees.list": result = await service.listWorktrees(); break;
      case "worktrees.create": result = await service.createWorktree(p); break;
      case "worktrees.remove": result = await service.removeWorktree(p); break;
      case "worktrees.restore": result = await service.restoreWorktree(p); break;
      case "worktrees.gc": result = await service.gcWorktrees(); break;
      case "terminal.list": result = await service.listTerminals(); break;
      case "terminal.open": result = await service.openTerminal(p); break;
      case "terminal.input": result = await service.inputTerminal(p); break;
      case "terminal.resize": result = await service.resizeTerminal(p); break;
      case "terminal.close": result = await service.closeTerminal(p); break;
      case "terminal.attach": result = await service.attachTerminal(p); break;
      case "terminal.text": result = await service.getTerminalText(p); break;
    }
    return SystemNodeIpcResponseSchema.parse({ method: request.method, requestId: request.requestId, ok: true as const, result });
  };
}
