import type { SkillProposalInspect, SkillProposalRecord } from "@uclaw/shared";

export const formalProposalRecord: SkillProposalRecord = {
  schema: "openclaw.skill-workshop.proposal.v1", id: "proposal-1", kind: "create", status: "pending",
  title: "Weather", description: "Weather skill", createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z",
  createdBy: "gateway", origin: { agentId: "main", sessionKey: "agent:main:weather", runId: "run-1", messageId: "message-1" },
  proposedVersion: "v1", draftFile: "PROPOSAL.md", draftHash: "a".repeat(64),
  supportFiles: [{ path: "references/weather.md", sizeBytes: 7, hash: "b".repeat(64), targetExisted: false }],
  target: { skillName: "china-weather", skillKey: "china-weather", skillDir: "/workspace/skills/china-weather", skillFile: "/workspace/skills/china-weather/SKILL.md", source: "workspace", currentContentHash: "c".repeat(64) },
  scan: { state: "clean", scannedAt: "2026-08-12T00:00:00.000Z", critical: 0, warn: 0, info: 0, findings: [] },
  goal: "Current weather", evidence: "User request",
};

export const formalProposalInspect: SkillProposalInspect = { record: formalProposalRecord, content: "# Weather", supportFiles: [{ path: "references/weather.md", content: "Weather" }] };
