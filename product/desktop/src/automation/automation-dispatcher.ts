import { AutomationIpcRequestSchema, type AutomationService } from "@uclaw/shared";

export function createAutomationDispatcher(service: AutomationService) {
  return async (payload: unknown) => {
    const request = AutomationIpcRequestSchema.parse(payload);
    const p = request.params as never;
    let result: unknown;
    switch (request.method) {
      case "agents.list": result = await service.listAgents(); break;
      case "agent.identity.get": result = await service.getAgentIdentity(p); break;
      case "agents.create": result = await service.createAgent(p); break;
      case "agents.update": result = await service.updateAgent(p); break;
      case "agents.delete": result = await service.deleteAgent(p); break;
      case "agents.files.list": result = await service.listAgentFiles(p); break;
      case "agents.files.get": result = await service.getAgentFile(p); break;
      case "agents.files.set": result = await service.writeAgentFile(p); break;
      case "agents.workspace.list": result = await service.listAgentWorkspace(p); break;
      case "agents.workspace.get": result = await service.getAgentWorkspace(p); break;
      case "cron.list": result = await service.listCron(); break;
      case "cron.status": result = await service.getCronStatus(); break;
      case "cron.get": result = await service.getCron(p); break;
      case "cron.add": result = await service.addCron(p); break;
      case "cron.update": result = await service.updateCron(p); break;
      case "cron.remove": result = await service.removeCron(p); break;
      case "cron.run": result = await service.runCron(p); break;
      case "cron.runs": result = await service.listCronRuns(p); break;
    }
    return { method: request.method, requestId: request.requestId, ok: true as const, result };
  };
}
