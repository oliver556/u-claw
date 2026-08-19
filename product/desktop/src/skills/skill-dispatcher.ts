import { SkillIpcResponseSchema, type SkillIpcRequest, type SkillIpcResponse } from "@uclaw/shared";

import type { SkillService } from "./skill-service.js";
import type { SkillInstallCoordinator } from "./skill-install-coordinator.js";

/** Creates the validated IPC dispatcher that forwards pinned Skill identity/version inputs. */
export function createSkillDispatcher(service: SkillService, coordinator?: SkillInstallCoordinator) {
  const requireCoordinator = () => {
    if (!coordinator) {
      throw {
        code: "UNAVAILABLE",
        message: "Controlled Skill installation is unavailable.",
        retryable: false,
        recoveryActions: [],
        causeDetails: {},
      };
    }
    return coordinator;
  };
  return async (request: SkillIpcRequest): Promise<SkillIpcResponse> => {
    let result: unknown;
    switch (request.method) {
      case "skills.search": result = await service.search(request.params); break;
      case "skills.installed": result = await service.installed(); break;
      case "skills.detail": result = await service.detail(request.params.slug, request.params.expectedVersion); break;
      case "skills.local-detail": result = await service.localDetail(request.params.slug); break;
      case "skills.install": result = await service.startInstall(request.params); break;
      case "skills.update": result = await service.startUpdate(request.params); break;
      case "skills.uninstall": result = await service.startUninstall(request.params.slug); break;
      case "skills.set-enabled": result = await service.setEnabled(request.params); break;
      case "skills.operation": result = await service.operation(request.params.operationId); break;
      case "skills.runtime-status": result = await service.runtimeStatus(); break;
      case "skills.import-select": result = await requireCoordinator().selectImport(); break;
      case "skills.import-prepare": result = await requireCoordinator().prepareImport(request.params.token); break;
      case "skills.import-install": result = await requireCoordinator().installImport(request.params.token, request.params.confirmation); break;
      case "skills.import-dispose": await requireCoordinator().disposeImport(request.params.token); result = { disposed: true }; break;
      case "skills.open-hub": await requireCoordinator().openHub(); result = { opened: true }; break;
      case "skills.resolve-install": result = await requireCoordinator().resolveInstall(request.params.identity); break;
      case "skills.curator-status": result = await service.curatorStatus(); break;
      case "skills.curator-action": result = await service.curatorAction(request.params.skill, request.params.action); break;
      case "skills.proposals-list": result = await service.proposalsList(); break;
      case "skills.proposal-inspect": result = await service.proposalInspect(request.params.proposalId); break;
      case "skills.proposal-action": result = await service.proposalAction(
        request.params.proposalId, request.params.action, request.params.reason ?? undefined,
      ); break;
      case "skills.proposal-create": result = await service.proposalCreate({
        name: request.params.name, description: request.params.description, content: request.params.content,
        ...(request.params.goal ? { goal: request.params.goal } : {}),
        ...(request.params.evidence ? { evidence: request.params.evidence } : {}),
      }); break;
      case "skills.proposal-update": result = await service.proposalUpdate({
        skillName: request.params.skillName, content: request.params.content,
        ...(request.params.description ? { description: request.params.description } : {}),
        ...(request.params.goal ? { goal: request.params.goal } : {}),
        ...(request.params.evidence ? { evidence: request.params.evidence } : {}),
      }); break;
      case "skills.proposal-revise": result = await service.proposalRevise({
        proposalId: request.params.proposalId, content: request.params.content,
        ...(request.params.description ? { description: request.params.description } : {}),
        ...(request.params.goal ? { goal: request.params.goal } : {}),
        ...(request.params.evidence ? { evidence: request.params.evidence } : {}),
      }); break;
      case "skills.proposal-request-revision": result = await service.proposalRequestRevision({
        proposalId: request.params.proposalId, instructions: request.params.instructions, sessionKey: request.params.sessionKey,
        ...(request.params.targetAgentId ? { targetAgentId: request.params.targetAgentId } : {}),
        ...(request.params.sessionId ? { sessionId: request.params.sessionId } : {}),
      }); break;
    }
    return SkillIpcResponseSchema.parse({ method: request.method, requestId: request.requestId, ok: true, result });
  };
}
