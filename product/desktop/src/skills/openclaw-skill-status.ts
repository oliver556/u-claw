import { SkillRuntimeInventorySchema, type SkillRuntimeInventory } from "@uclaw/shared";
import { z } from "zod";

const MissingSchema = z.object({
  bins: z.array(z.string()), anyBins: z.array(z.string()), env: z.array(z.string()),
  config: z.array(z.string()), os: z.array(z.string()),
}).strict();

export const RawOpenClawSkillStatusSchema = z.object({
  workspaceDir: z.string().min(1), managedSkillsDir: z.string().min(1),
  skills: z.array(z.object({
    name: z.string().min(1), description: z.string().optional(), eligible: z.boolean(), disabled: z.boolean(),
    blockedByAllowlist: z.boolean(), blockedByAgentFilter: z.boolean(), modelVisible: z.boolean(),
    userInvocable: z.boolean(), commandVisible: z.boolean(), source: z.string().min(1), bundled: z.boolean(),
    missing: MissingSchema,
  }).passthrough()),
}).passthrough();
export type RawOpenClawSkillStatus = z.infer<typeof RawOpenClawSkillStatusSchema>;

export function mapOpenClawSkillStatus(
  raw: RawOpenClawSkillStatus,
  conflicts: ReadonlyMap<string, readonly string[]> = new Map(),
): SkillRuntimeInventory {
  return SkillRuntimeInventorySchema.parse({
    workspaceDir: "OpenClaw workspace",
    managedSkillsDir: "OpenClaw managed skills",
    skills: raw.skills.map((skill) => {
      const collision = conflicts.get(skill.name) ?? [];
      const missing = Object.values(skill.missing).some((items) => items.length > 0);
      const availability = collision.length > 0 ? "conflict"
        : skill.disabled ? "disabled"
          : skill.eligible ? "available"
            : missing || skill.blockedByAllowlist || skill.blockedByAgentFilter ? "missing-dependency" : "error";
      return {
        id: skill.name, name: skill.name, description: skill.description, source: skill.source,
        bundled: skill.bundled, disabled: skill.disabled, eligible: skill.eligible,
        modelVisible: skill.modelVisible, userInvocable: skill.userInvocable, commandVisible: skill.commandVisible,
        availability, missing: skill.missing, conflicts: [...collision],
      };
    }),
  });
}
