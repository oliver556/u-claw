import { randomUUID } from "node:crypto";

import {
  SkillCuratorEntrySchema,
  SkillCuratorStatusSchema,
  SkillProposalInspectSchema,
  SkillProposalActionResultSchema,
  SkillProposalManifestSchema,
  SkillProposalRevisionRunSchema,
  type SkillCuratorStatus,
  type SkillProposalInspect,
  type SkillProposalManifest,
  type SkillProposalActionResult,
  type SkillProposalCreateInput,
  type SkillProposalUpdateInput,
  type SkillProposalReviseInput,
  type SkillProposalRevisionRequestInput,
  type SkillProposalRevisionRun,
  type SkillRuntimeInventory,
  type SkillRuntimeItem,
} from "@uclaw/shared";
import { z } from "zod";

import { mapOpenClawSkillStatus, RawOpenClawSkillStatusSchema } from "./openclaw-skill-status.js";

type RpcRequest = <T>(method: string, params: Record<string, unknown>, schema: z.ZodType<T>) => Promise<T>;

export interface OpenClawSkillRuntime {
  status(conflicts?: ReadonlyMap<string, readonly string[]>): Promise<SkillRuntimeInventory>;
  setEnabled(skillKey: string, enabled: boolean): Promise<SkillRuntimeItem>;
  curatorStatus(): Promise<SkillCuratorStatus>;
  curatorAction(skill: string, action: "pin" | "unpin" | "restore"): Promise<z.infer<typeof SkillCuratorEntrySchema>>;
  listProposals(): Promise<SkillProposalManifest>;
  inspectProposal(proposalId: string): Promise<SkillProposalInspect>;
  proposalAction(proposalId: string, action: "apply" | "reject" | "quarantine", reason?: string): Promise<SkillProposalActionResult>;
  createProposal(input: SkillProposalCreateInput): Promise<SkillProposalInspect>;
  updateProposal(input: SkillProposalUpdateInput): Promise<SkillProposalInspect>;
  reviseProposal(input: SkillProposalReviseInput): Promise<SkillProposalInspect>;
  requestProposalRevision(input: SkillProposalRevisionRequestInput): Promise<SkillProposalRevisionRun>;
}

const optional = (value: string | undefined, key: string): Record<string, string> => value === undefined ? {} : { [key]: value };

export function createOpenClawSkillRuntime({
  request,
  randomId = randomUUID,
}: {
  request: RpcRequest;
  randomId?: () => string;
}): OpenClawSkillRuntime {
  const status = async (conflicts: ReadonlyMap<string, readonly string[]> = new Map()) =>
    mapOpenClawSkillStatus(await request("skills.status", {}, RawOpenClawSkillStatusSchema), conflicts);
  return {
    status,
    async setEnabled(skillKey, enabled) {
      await request("skills.update", { skillKey, enabled }, z.object({ ok: z.literal(true) }).passthrough());
      const item = (await status()).skills.find((candidate) => candidate.id === skillKey &&
        !candidate.bundled && candidate.source.toLowerCase().includes("workspace"));
      if (!item || item.disabled === enabled) throw new Error("OpenClaw Skill readback mismatch.");
      return item;
    },
    curatorStatus: () => request("skills.curator.status", {}, SkillCuratorStatusSchema),
    curatorAction: (skill, action) => request(`skills.curator.${action}`, { skill }, SkillCuratorEntrySchema),
    listProposals: () => request("skills.proposals.list", {}, SkillProposalManifestSchema),
    inspectProposal: (proposalId) => request("skills.proposals.inspect", { proposalId }, SkillProposalInspectSchema),
    proposalAction: (proposalId, action, reason) => request(`skills.proposals.${action}`, {
      proposalId, ...(reason === undefined ? {} : { reason }),
    }, SkillProposalActionResultSchema),
    createProposal: (input) => request("skills.proposals.create", {
      name: input.name, description: input.description, content: input.content,
      ...optional(input.goal, "goal"), ...optional(input.evidence, "evidence"),
    }, SkillProposalInspectSchema),
    updateProposal: (input) => request("skills.proposals.update", {
      skillName: input.skillName, content: input.content,
      ...optional(input.description, "description"), ...optional(input.goal, "goal"), ...optional(input.evidence, "evidence"),
    }, SkillProposalInspectSchema),
    reviseProposal: (input) => request("skills.proposals.revise", {
      proposalId: input.proposalId, content: input.content,
      ...optional(input.description, "description"), ...optional(input.goal, "goal"), ...optional(input.evidence, "evidence"),
    }, SkillProposalInspectSchema),
    requestProposalRevision: (input) => request("skills.proposals.requestRevision", {
      proposalId: input.proposalId, instructions: input.instructions, sessionKey: input.sessionKey,
      ...optional(input.targetAgentId, "targetAgentId"), ...optional(input.sessionId, "sessionId"),
      idempotencyKey: randomId(),
    }, SkillProposalRevisionRunSchema),
  };
}
