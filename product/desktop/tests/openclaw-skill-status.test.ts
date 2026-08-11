import { describe, expect, it } from "vitest";

import { mapOpenClawSkillStatus, RawOpenClawSkillStatusSchema } from "../src/skills/openclaw-skill-status.js";

describe("OpenClaw Skill status", () => {
  it("maps eligibility, missing requirements, and source without exposing paths", () => {
    const raw = RawOpenClawSkillStatusSchema.parse({
      workspaceDir: "/private/usb/workspace", managedSkillsDir: "/private/usb/.openclaw/skills",
      skills: [{ name: "china-weather", description: "weather", eligible: false, disabled: false,
        blockedByAllowlist: false, blockedByAgentFilter: false, modelVisible: false,
        userInvocable: true, commandVisible: false, source: "openclaw-bundled", bundled: true,
        missing: { bins: ["curl"], anyBins: [], env: [], config: [], os: [] } }],
    });
    expect(mapOpenClawSkillStatus(raw, new Map([["china-weather", ["portable-bundled"]]]))).toMatchObject({
      workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills",
      skills: [{ id: "china-weather", availability: "conflict", conflicts: ["portable-bundled"] }],
    });
  });

  it("rejects malformed runtime payloads", () => {
    expect(() => RawOpenClawSkillStatusSchema.parse({ workspaceDir: "/tmp", managedSkillsDir: "/tmp", skills: [{ name: "x" }] })).toThrow();
  });
});
