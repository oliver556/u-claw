import { describe, expect, it } from "vitest";

import {
  CapabilityPackageKindSchema,
  SkillIpcRequestSchema,
  SkillPermissionSchema,
} from "../src/capabilities.js";

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
});
