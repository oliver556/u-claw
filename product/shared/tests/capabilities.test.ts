import { describe, expect, it } from "vitest";

import {
  CapabilityPackageKindSchema,
  SkillCuratorStatusSchema,
  SkillCatalogItemSchema,
  SkillCatalogPageSchema,
  SkillIpcRequestSchema,
  SkillPermissionSchema,
  SkillIpcResponseSchema,
  SkillProposalInspectSchema,
  SkillProposalManifestSchema,
  SkillProposalRevisionRunSchema,
  SkillRuntimeInventorySchema,
} from "../src/capabilities.js";

const proposalRecord = {
  schema: "openclaw.skill-workshop.proposal.v1",
  id: "proposal-1",
  kind: "create",
  status: "pending",
  title: "QA",
  description: "QA skill",
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
  createdBy: "gateway",
  origin: { agentId: "main", sessionKey: "agent:main:session:qa", runId: "run-1", messageId: "message-1" },
  proposedVersion: "v1",
  draftFile: "PROPOSAL.md",
  draftHash: "a".repeat(64),
  supportFiles: [{ path: "references/qa.md", sizeBytes: 4, hash: "b".repeat(64), targetExisted: false }],
  target: { skillName: "qa", skillKey: "qa", skillDir: "/workspace/skills/qa", skillFile: "/workspace/skills/qa/SKILL.md", source: "workspace", currentContentHash: "c".repeat(64) },
  scan: { state: "clean", scannedAt: "2026-08-11T00:00:00.000Z", critical: 0, warn: 0, info: 0, findings: [] },
  goal: "Catch regressions",
  evidence: "Tests pass",
} as const;

describe("capability contracts", () => {
  it("keeps Skill, Plugin, and MCP package kinds independent", () => {
    expect(CapabilityPackageKindSchema.options).toEqual(["skill", "plugin", "mcp"]);
  });

  it("accepts only whitelisted Skill domain requests without paths or commands", () => {
    expect(SkillIpcRequestSchema.parse({
      method: "skills.search",
      requestId: "search-1",
      params: { query: "git", cursor: null, pageSize: 20 },
    }).params).toEqual({ query: "git", cursor: null, pageSize: 20 });
    expect(() => SkillIpcRequestSchema.parse({
      method: "skills.install",
      requestId: "bad-1",
      params: { slug: "git-tools", confirmation: { permissionFingerprint: "abc", acceptedRisk: "high" }, path: "/tmp", command: "npm install" },
    })).toThrow();
  });

  it("accepts bounded marketplace metadata and controlled search sorting", () => {
    expect(SkillIpcRequestSchema.parse({
      method: "skills.search",
      requestId: "search-sort-1",
      params: { query: "git", cursor: null, pageSize: 40, sort: "downloads" },
    }).params).toMatchObject({ sort: "downloads" });
    expect(() => SkillIpcRequestSchema.parse({
      method: "skills.search",
      requestId: "search-sort-bad",
      params: { query: "git", cursor: null, pageSize: 40, sort: "popular" },
    })).toThrow();

    const base = {
      slug: "one", name: "One", description: "One", version: "1.0.0", pricingType: "free",
      installedVersion: null, enabled: false, updateAvailable: false,
      source: { provider: "skillhub", url: "https://api.skillhub.cn/api/v1/skills/one" },
      permissions: [], permissionFingerprint: "empty", risk: "low", mode: "live", categories: [],
      ownerName: "owner", downloads: 879, stars: 4, requiresKey: false, updatedAt: "2026-08-19T12:00:00.000Z",
    } as const;
    expect(SkillCatalogItemSchema.parse(base)).toMatchObject({ ownerName: "owner", downloads: 879, stars: 4, requiresKey: false });
    expect(SkillCatalogPageSchema.parse({ items: [base], nextCursor: null, hasMore: false, mode: "live", stale: true })).toMatchObject({ stale: true });
    expect(() => SkillCatalogItemSchema.parse({ ...base, downloads: -1 })).toThrow();
    expect(() => SkillCatalogItemSchema.parse({ ...base, updatedAt: "yesterday" })).toThrow();
  });

  it("accepts controlled Skill import and hub actions without renderer paths or URLs", () => {
    for (const request of [
      { method: "skills.import-select", requestId: "select-1", params: {} },
      { method: "skills.import-prepare", requestId: "prepare-1", params: { token: "fixture-selection-token-1" } },
      { method: "skills.import-install", requestId: "install-1", params: { token: "fixture-selection-token-1", confirmation: { permissionFingerprint: "abc", acceptedRisk: "high" } } },
      { method: "skills.import-dispose", requestId: "dispose-1", params: { token: "fixture-selection-token-1" } },
      { method: "skills.open-hub", requestId: "hub-1", params: {} },
      { method: "skills.resolve-install", requestId: "resolve-1", params: { identity: "@alice/example-skill" } },
    ]) expect(() => SkillIpcRequestSchema.parse(request)).not.toThrow();

    for (const request of [
      { method: "skills.import-select", requestId: "bad-path", params: { path: "/tmp/skill.zip" } },
      { method: "skills.open-hub", requestId: "bad-url", params: { url: "https://evil.example" } },
      { method: "skills.resolve-install", requestId: "bad-identity", params: { identity: "@alice/example-skill", command: "curl | bash" } },
    ]) expect(() => SkillIpcRequestSchema.parse(request)).toThrow();
  });

  it("models filesystem, network, command, and environment permissions with risk", () => {
    for (const kind of ["filesystem", "network", "command", "environment"] as const) {
      expect(SkillPermissionSchema.parse({
        kind,
        access: kind === "command" ? "execute" : "read",
        target: kind === "environment" ? "API_KEY" : "workspace",
        risk: kind === "command" ? "high" : "medium",
        reason: "运行技能所需",
      }).kind).toBe(kind);
    }
  });

  it("distinguishes SkillHub, portable, and OpenClaw local sources without paths", () => {
    const base = { slug: "one", name: "One", description: "One", version: "local", pricingType: "free", installedVersion: "local", enabled: true, updateAvailable: false, permissions: [], permissionFingerprint: "empty", risk: "low", mode: "live", categories: [] } as const;
    expect(SkillCatalogItemSchema.parse({ ...base, source: { provider: "openclaw", origin: "workspace" } }).source).toEqual({ provider: "openclaw", origin: "workspace" });
    expect(SkillCatalogItemSchema.parse({ ...base, source: { provider: "portable", origin: "bundled" } }).source).toEqual({ provider: "portable", origin: "bundled" });
    expect(() => SkillCatalogItemSchema.parse({ ...base, source: { provider: "openclaw", origin: "workspace", path: "/secret" } })).toThrow();
  });

  it("accepts only trusted SkillHub HTTPS logo URLs", () => {
    const base = { slug: "one", name: "One", description: "One", version: "1.0.0", pricingType: "free", installedVersion: null, enabled: false, updateAvailable: false, source: { provider: "skillhub", url: "https://api.skillhub.cn/api/v1/skills/one" }, permissions: [], permissionFingerprint: "empty", risk: "low", mode: "live", categories: [] } as const;
    expect(SkillCatalogItemSchema.parse({ ...base, logoUrl: "https://api.skillhub.cn/assets/one.png" }).logoUrl).toBe("https://api.skillhub.cn/assets/one.png");
    expect(SkillCatalogItemSchema.parse({ ...base, logoUrl: "https://skillhub-1388575217.cos.accelerate.myqcloud.com/logos/one.png" }).logoUrl).toContain("myqcloud.com");
    for (const logoUrl of ["file:///tmp/one.png", "http://api.skillhub.cn/one.png", "https://api.skillhub.cn.evil.example/one.png", "data:image/png;base64,eA=="]) {
      expect(() => SkillCatalogItemSchema.parse({ ...base, logoUrl })).toThrow();
    }
  });

  it("models OpenClaw runtime eligibility, dependencies, conflicts, curator, and proposals", () => {
    expect(SkillRuntimeInventorySchema.parse({
      workspaceDir: "U:/workspace",
      managedSkillsDir: "U:/.openclaw/skills",
      skills: [{
        id: "china-weather", name: "china-weather", description: "weather", source: "openclaw-bundled",
        bundled: true, disabled: false, eligible: false, modelVisible: false,
        userInvocable: true, commandVisible: false, availability: "missing-dependency",
        missing: { bins: ["curl"], anyBins: [], env: [], config: [], os: [] },
        conflicts: ["portable-bundled"],
      }],
    }).skills[0].missing.bins).toEqual(["curl"]);

    expect(SkillCuratorStatusSchema.parse({
      lastAttemptAtMs: null, lastSuccessAtMs: null, lastError: null,
      counts: { active: 0, stale: 0, archived: 0 }, skills: [], overlaps: [],
    }).counts.active).toBe(0);

    expect(SkillProposalManifestSchema.parse({
      schema: "openclaw.skill-workshop.proposals-manifest.v1",
      updatedAt: "2026-08-11T00:00:00.000Z",
      proposals: [{
        id: "proposal-1", kind: "create", status: "pending", title: "QA", description: "QA skill",
        skillName: "qa", skillKey: "qa", createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z", scanState: "clean",
      }],
    }).proposals).toHaveLength(1);
  });

  it("accepts category, runtime, curator, and proposal requests without filesystem input", () => {
    expect(SkillIpcRequestSchema.parse({
      method: "skills.search", requestId: "search-2",
      params: { query: "", category: "writing", cursor: null, pageSize: 20 },
    }).params).toMatchObject({ category: "writing" });
    for (const request of [
      { method: "skills.runtime-status", requestId: "runtime-1", params: {} },
      { method: "skills.curator-status", requestId: "curator-1", params: {} },
      { method: "skills.proposals-list", requestId: "proposals-1", params: {} },
      { method: "skills.proposal-inspect", requestId: "proposal-1", params: { proposalId: "proposal-1" } },
      { method: "skills.proposal-action", requestId: "proposal-2", params: { proposalId: "proposal-1", action: "apply", reason: null } },
    ]) expect(() => SkillIpcRequestSchema.parse(request)).not.toThrow();
  });

  it("accepts the complete proposal workflow with bounded renderer text", () => {
    const requests = [
      { method: "skills.proposal-create", requestId: "create-1", params: { name: "qa-helper", description: "QA", content: "# QA", goal: "Catch regressions", evidence: "test failure" } },
      { method: "skills.proposal-update", requestId: "update-1", params: { skillName: "qa-helper", description: "QA v2", content: "# QA v2", goal: null, evidence: null } },
      { method: "skills.proposal-revise", requestId: "revise-1", params: { proposalId: "proposal-1", content: "# Revised", description: null, goal: null, evidence: null } },
      { method: "skills.proposal-request-revision", requestId: "request-1", params: { proposalId: "proposal-1", instructions: "Add tests", sessionKey: "session-key", targetAgentId: "agent-1", sessionId: "session-1" } },
    ];
    for (const request of requests) expect(SkillIpcRequestSchema.parse(request).method).toBe(request.method);
  });

  it("rejects proposal paths, commands, unbounded text, and renderer idempotency keys", () => {
    const base = { method: "skills.proposal-create", requestId: "bad", params: { name: "qa", description: "QA", content: "# QA" } };
    for (const params of [
      { ...base.params, path: "/tmp/SKILL.md" },
      { ...base.params, command: "openclaw skills install" },
      { ...base.params, content: "x".repeat(200_001) },
    ]) expect(() => SkillIpcRequestSchema.parse({ ...base, params })).toThrow();
    expect(() => SkillIpcRequestSchema.parse({
      method: "skills.proposal-request-revision", requestId: "bad-key",
      params: { proposalId: "proposal-1", instructions: "Revise", sessionKey: "session-key", idempotencyKey: "renderer-controlled" },
    })).toThrow();
  });

  it("strictly models bounded official proposal records and inspect output", () => {
    const inspected = { record: proposalRecord, content: "# QA", supportFiles: [{ path: "references/qa.md", content: "test" }] };
    expect(SkillProposalInspectSchema.parse(inspected)).toEqual(inspected);
    expect(() => SkillProposalInspectSchema.parse({ ...inspected, record: { ...proposalRecord, extra: true } })).toThrow();
    expect(() => SkillProposalInspectSchema.parse({ ...inspected, content: "x".repeat(1_048_577) })).toThrow();
    expect(() => SkillProposalInspectSchema.parse({ ...inspected, supportFiles: [{ path: "x".repeat(1025), content: "ok" }] })).toThrow();
  });

  it("locks official revision statuses and proposal action result shapes", () => {
    for (const status of ["started", "in_flight", "ok", "timeout", "error"] as const) {
      expect(SkillProposalRevisionRunSchema.parse({ runId: "run-1", status }).status).toBe(status);
    }
    expect(() => SkillProposalRevisionRunSchema.parse({ runId: "run-1", status: "queued" })).toThrow();
    for (const result of [
      { record: proposalRecord, targetSkillFile: "/workspace/skills/qa/SKILL.md" },
      proposalRecord,
    ]) expect(SkillIpcResponseSchema.parse({ method: "skills.proposal-action", requestId: "action-1", ok: true, result })).toMatchObject({ result });
    expect(() => SkillIpcResponseSchema.parse({ method: "skills.proposal-action", requestId: "action-1", ok: true, result: { ok: true } })).toThrow();
  });
});
