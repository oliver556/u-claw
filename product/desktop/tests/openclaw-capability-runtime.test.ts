import { describe, expect, it, vi } from "vitest";

import { createOpenClawCapabilityRuntime } from "../src/capabilities/openclaw-capability-runtime.js";

describe("OpenClaw capability runtime", () => {
  it("reads catalog, effective tools, commands, plugin descriptors, and approval policy from Gateway", async () => {
    const fixtures: Record<string, unknown> = {
      "tools.catalog": { agentId: "main", profiles: [], groups: [] },
      "tools.effective": { agentId: "main", profile: "coding", groups: [], notices: [] },
      "commands.list": { commands: [] },
      "plugins.uiDescriptors": { ok: true, descriptors: [] },
      "exec.approvals.get": { path: "/private/policy.json", exists: true, hash: "hash-1", file: { version: 1, defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny", autoAllowSkills: false } } },
    };
    const request = vi.fn(async (method: string) => fixtures[method]);
    const runtime = createOpenClawCapabilityRuntime({
      methods: async () => new Set(Object.keys(fixtures)),
      request,
    });

    await expect(runtime.tools({ agentId: "main", sessionKey: "agent:main:main" })).resolves.toMatchObject({
      catalog: { groups: [] }, effective: { profile: "coding", groups: [] }, commands: [],
    });
    await expect(runtime.pluginDescriptors()).resolves.toEqual([]);
    await expect(runtime.approvalsGet()).resolves.toEqual({
      hash: "hash-1", exists: true,
      policy: { security: "allowlist", ask: "on-miss", askFallback: "deny", autoAllowSkills: false },
    });
    expect(JSON.stringify(await runtime.approvalsGet())).not.toContain("/private/policy.json");
  });

  it("writes approval policy with base hash and returns authoritative readback", async () => {
    const existingFile = {
      version: 1 as const,
      defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny", autoAllowSkills: false },
      agents: { main: { allowlist: [{ pattern: "git status" }] } },
    };
    const request = vi.fn(async (method: string, params: unknown) => method === "exec.approvals.get"
      ? { path: "/private/policy.json", exists: true, hash: "hash-1", file: existingFile }
      : { path: "/private/policy.json", exists: true, hash: "hash-2", file: (params as any).file });
    const runtime = createOpenClawCapabilityRuntime({
      methods: async () => new Set(["exec.approvals.get", "exec.approvals.set"]),
      request,
    });
    const policy = { security: "deny" as const, ask: "always" as const, askFallback: "deny" as const, autoAllowSkills: false };

    await expect(runtime.approvalsSet({ baseHash: "hash-1", policy })).resolves.toEqual({ hash: "hash-2", exists: true, policy });
    expect(request).toHaveBeenCalledWith("exec.approvals.set", {
      file: { ...existingFile, defaults: policy }, baseHash: "hash-1",
    });
  });

  it("invokes only declared plugin session actions and preserves explicit failures", async () => {
    const request = vi.fn(async () => ({ ok: false, error: "Action denied", code: "FORBIDDEN" }));
    const runtime = createOpenClawCapabilityRuntime({
      methods: async () => new Set(["plugins.sessionAction"]),
      request,
    });
    await expect(runtime.pluginSessionAction({ pluginId: "calendar", actionId: "delete", sessionKey: "agent:main:main" }))
      .resolves.toEqual({ ok: false, error: "Action denied", code: "FORBIDDEN" });
  });

  it("rejects a stale approval policy without overwriting the authoritative file", async () => {
    const request = vi.fn(async () => ({
      path: "/private/policy.json", exists: true, hash: "hash-new",
      file: { version: 1, defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny", autoAllowSkills: false } },
    }));
    const runtime = createOpenClawCapabilityRuntime({
      methods: async () => new Set(["exec.approvals.get", "exec.approvals.set"]),
      request,
    });

    await expect(runtime.approvalsSet({
      baseHash: "hash-old",
      policy: { security: "deny", ask: "always", askFallback: "deny", autoAllowSkills: false },
    })).rejects.toMatchObject({ code: "CONFLICT", retryable: true });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("exec.approvals.get", {});
  });

  it("keeps catalog and effective tools available when commands.list is not declared", async () => {
    const runtime = createOpenClawCapabilityRuntime({
      methods: async () => new Set(["tools.catalog", "tools.effective"]),
      request: vi.fn(async (method: string) => method === "tools.catalog"
        ? { agentId: "main", groups: [] }
        : { agentId: "main", profile: "coding", groups: [], notices: [] }),
    });
    await expect(runtime.tools({ agentId: "main", sessionKey: "agent:main:main" }))
      .resolves.toMatchObject({ catalog: { groups: [] }, commands: [], effective: { profile: "coding" } });
  });
});
