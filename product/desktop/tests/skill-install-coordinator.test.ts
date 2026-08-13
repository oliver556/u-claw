import { describe, expect, it, vi } from "vitest";

import { createSkillInstallCoordinator } from "../src/skills/skill-install-coordinator.js";

const detail = {
  slug: "useful-skill", name: "Useful Skill", description: "Useful", version: "1.0.0",
  pricingType: "free", installedVersion: null, enabled: false, updateAvailable: false,
  source: { provider: "skillhub", url: "https://skillhub.cloud.tencent.com/skills" },
  permissions: [], permissionFingerprint: "empty", risk: "high", mode: "live", categories: [],
  manifest: { kind: "skill", id: "useful-skill", version: "1.0.0", entry: "SKILL.md" },
} as const;

describe("SkillInstallCoordinator", () => {
  it("keeps a prepared ZIP inert until explicit confirmation", async () => {
    const validated = { manifest: detail.manifest, files: [{ path: "SKILL.md", content: Buffer.from("skill") }] };
    const imports = {
      select: vi.fn(), dispose: vi.fn(),
      prepare: vi.fn(async () => ({ detail, validated })),
    };
    const skills = { startInstallBundle: vi.fn(async () => ({ id: "op-1", slug: detail.slug, action: "install", state: "queued", progress: 0, phase: "queued" })) };
    const coordinator = createSkillInstallCoordinator({ imports: imports as any, skills: skills as any, openExternal: vi.fn() });

    await expect(coordinator.prepareImport("selection-token-1")).resolves.toEqual(detail);
    expect(skills.startInstallBundle).not.toHaveBeenCalled();

    const confirmation = { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk };
    await coordinator.installImport("selection-token-1", confirmation);
    expect(skills.startInstallBundle).toHaveBeenCalledWith({ detail, validated, confirmation });
    await expect(coordinator.installImport("selection-token-1", confirmation)).rejects.toThrow(/expired|used/i);
  });

  it("opens only the fixed Tencent SkillHub discovery URL", async () => {
    const openExternal = vi.fn(async () => undefined);
    const coordinator = createSkillInstallCoordinator({ imports: {} as any, skills: {} as any, openExternal });
    await coordinator.openHub();
    expect(openExternal).toHaveBeenCalledWith("https://skillhub.cloud.tencent.com/skills");
  });
});
