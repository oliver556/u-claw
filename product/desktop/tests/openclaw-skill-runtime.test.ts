import { describe, expect, it, vi } from "vitest";

import { createOpenClawSkillRuntime } from "../src/skills/openclaw-skill-runtime.js";
import { formalProposalInspect, formalProposalRecord } from "./skill-proposal-fixture.js";

const status = (disabled = false) => ({
  workspaceDir: "/usb/workspace", managedSkillsDir: "/usb/.openclaw/skills",
  skills: [{ name: "china-weather", description: "天气", eligible: !disabled, disabled,
    blockedByAllowlist: false, blockedByAgentFilter: false, modelVisible: !disabled,
    userInvocable: true, commandVisible: !disabled, source: "workspace", bundled: false,
    missing: { bins: [], anyBins: [], env: [], config: [], os: [] } }],
});

describe("OpenClaw Skill runtime", () => {
  it("calls skills.status and verifies enable changes by readback", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(status(false))
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce(status(true));
    const runtime = createOpenClawSkillRuntime({ request });
    await expect(runtime.status()).resolves.toMatchObject({ skills: [{ disabled: false }] });
    await expect(runtime.setEnabled("china-weather", false)).resolves.toMatchObject({ disabled: true });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["skills.status", "skills.update", "skills.status"]);
  });

  it("fails when OpenClaw readback disagrees", async () => {
    const request = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValue(status(false));
    await expect(createOpenClawSkillRuntime({ request, readbackAttempts: 4, waitForReadback: async () => undefined }).setEnabled("china-weather", false))
      .rejects.toThrow("readback");
  });

  it("waits for an eventually consistent Skill enablement readback", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce(status(false))
      .mockResolvedValueOnce(status(false))
      .mockResolvedValueOnce(status(false))
      .mockResolvedValueOnce(status(true));

    await expect(createOpenClawSkillRuntime({ request, waitForReadback: async () => undefined }).setEnabled("china-weather", false))
      .resolves.toMatchObject({ disabled: true });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "skills.update", "skills.status", "skills.status", "skills.status", "skills.status",
    ]);
  });

  it("reads back the nonbundled workspace Skill when a bundled namesake appears first", async () => {
    const readback = status(true);
    readback.skills.unshift({ ...readback.skills[0], source: "openclaw-bundled", bundled: true, disabled: false, eligible: true });
    const request = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(readback);
    await expect(createOpenClawSkillRuntime({ request }).setEnabled("china-weather", false))
      .resolves.toMatchObject({ source: "workspace", bundled: false, disabled: true });
  });

  it("passes curator and proposal operations through exact locked methods", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ lastAttemptAtMs: null, lastSuccessAtMs: null, lastError: null, counts: { active: 0, stale: 0, archived: 0 }, skills: [], overlaps: [] })
      .mockResolvedValueOnce({ schema: "openclaw.skill-workshop.proposals-manifest.v1", updatedAt: "2026-08-11T00:00:00.000Z", proposals: [] });
    const runtime = createOpenClawSkillRuntime({ request });
    await runtime.curatorStatus();
    await runtime.listProposals();
    expect(request.mock.calls.map(([method]) => method)).toEqual(["skills.curator.status", "skills.proposals.list"]);
  });

  it("calls every proposal authoring RPC with exact params", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(formalProposalInspect)
      .mockResolvedValueOnce(formalProposalInspect)
      .mockResolvedValueOnce(formalProposalInspect)
      .mockResolvedValueOnce({ runId: "run-1", status: "started" });
    const runtime = createOpenClawSkillRuntime({ request: request as any, randomId: () => "desktop-idempotency" });
    await runtime.createProposal({ name: "qa", description: "QA skill", content: "# QA", goal: "quality", evidence: "failure" });
    await runtime.updateProposal({ skillName: "qa", description: "QA v2", content: "# QA v2", goal: "quality", evidence: "review" });
    await runtime.reviseProposal({ proposalId: "proposal-1", content: "# Revised", description: "fixed", goal: "quality", evidence: "tests" });
    await runtime.requestProposalRevision({ proposalId: "proposal-1", instructions: "Add tests", sessionKey: "skill-session", targetAgentId: "agent-1", sessionId: "session-1" });

    expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ["skills.proposals.create", { name: "qa", description: "QA skill", content: "# QA", goal: "quality", evidence: "failure" }],
      ["skills.proposals.update", { skillName: "qa", description: "QA v2", content: "# QA v2", goal: "quality", evidence: "review" }],
      ["skills.proposals.revise", { proposalId: "proposal-1", content: "# Revised", description: "fixed", goal: "quality", evidence: "tests" }],
      ["skills.proposals.requestRevision", { proposalId: "proposal-1", instructions: "Add tests", sessionKey: "skill-session", targetAgentId: "agent-1", sessionId: "session-1", idempotencyKey: "desktop-idempotency" }],
    ]);
  });

  it("validates formal proposal action and revision responses", async () => {
    const request = vi.fn(async (method: string, _params: unknown, schema: { parse(value: unknown): unknown }) => schema.parse(
      method === "skills.proposals.apply" ? { record: formalProposalRecord, targetSkillFile: formalProposalRecord.target.skillFile }
        : method === "skills.proposals.requestRevision" ? { runId: "run-1", status: "started" }
          : formalProposalRecord,
    ));
    const runtime = createOpenClawSkillRuntime({ request: request as any, randomId: () => "desktop-idempotency" });
    await expect(runtime.proposalAction("proposal-1", "apply")).resolves.toMatchObject({ targetSkillFile: formalProposalRecord.target.skillFile });
    await expect(runtime.proposalAction("proposal-1", "reject")).resolves.toMatchObject({ id: "proposal-1" });
    await expect(runtime.requestProposalRevision({ proposalId: "proposal-1", instructions: "Revise", sessionKey: "session" })).resolves.toEqual({ runId: "run-1", status: "started" });
  });
});
