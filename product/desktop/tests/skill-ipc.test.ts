import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SkillIpcRequestSchema } from "@uclaw/shared";

import { SKILL_IPC_CHANNEL } from "../src/ipc/channels.js";
import { installPreloadBridge } from "../src/ipc/preload-bridge.js";
import { registerIpc } from "../src/ipc/register-ipc.js";
import { createFixtureSkillHubClient } from "../src/skills/fixture-client.js";
import { createSkillDispatcher } from "../src/skills/skill-dispatcher.js";
import { createSkillService } from "../src/skills/skill-service.js";
import { formalProposalInspect, formalProposalRecord } from "./skill-proposal-fixture.js";

function skillService() {
  return {
    search: vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false, mode: "fixture" as const })),
    detail: vi.fn(), localDetail: vi.fn(), installed: vi.fn(async () => []), startInstall: vi.fn(), startInstallBundle: vi.fn(), startUpdate: vi.fn(),
    startUninstall: vi.fn(), setEnabled: vi.fn(), operation: vi.fn(), waitForOperation: vi.fn(),
    runtimeStatus: vi.fn(), curatorStatus: vi.fn(), curatorAction: vi.fn(), proposalsList: vi.fn(),
    proposalInspect: vi.fn(), proposalAction: vi.fn(), proposalCreate: vi.fn(), proposalUpdate: vi.fn(),
    proposalRevise: vi.fn(), proposalRequestRevision: vi.fn(),
  };
}

describe("Skill IPC", () => {
  it("projects a non-empty fixture catalog through the strict IPC response schema", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-skill-ipc-"));
    try {
      const dispatch = createSkillDispatcher(await createSkillService({ dataDir, client: createFixtureSkillHubClient() }));
      const response = await dispatch({ method: "skills.search", requestId: "catalog-1", params: { query: "", cursor: null, pageSize: 20 } });
      expect(response.ok).toBe(true);
      if (!response.ok || response.method !== "skills.search") throw new Error("Unexpected Skill IPC response.");
      expect(response.result.items.length).toBeGreaterThan(0);
      expect(response.result.items.every((item) => item.pricingType === "free" && !("manifest" in item))).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("routes validated Skill domain objects on one fixed channel", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const authorizedWebContents = { mainFrame: {} };
    const skills = skillService();
    registerIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: vi.fn() },
      authorizedWebContents,
      windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
      dispatchClient: vi.fn(), skills,
    });
    const event = { sender: authorizedWebContents, senderFrame: authorizedWebContents.mainFrame };
    const response = await handlers.get(SKILL_IPC_CHANNEL)!(event, {
      method: "skills.search", requestId: "skills-1", params: { query: "git", cursor: null, pageSize: 20 },
    });
    expect(skills.search).toHaveBeenCalledWith({ query: "git", cursor: null, pageSize: 20 });
    expect(response).toMatchObject({ method: "skills.search", requestId: "skills-1", ok: true });
  });

  it("routes controlled import and fixed hub actions through the coordinator", async () => {
    const skills = skillService();
    const imported = {
      slug: "one", name: "One", description: "One", version: "1.0.0", pricingType: "free", installedVersion: null,
      enabled: false, updateAvailable: false, source: { provider: "skillhub", url: "https://skillhub.cloud.tencent.com/skills" },
      permissions: [], permissionFingerprint: "abc", risk: "high", mode: "live", categories: [],
      manifest: { kind: "skill", id: "one", version: "1.0.0", entry: "SKILL.md" },
    } as const;
    const coordinator = {
      selectImport: vi.fn(async () => ({ token: "fixture-selection-token-1", fileName: "skill.zip", sizeBytes: 123 })),
      prepareImport: vi.fn(async () => imported),
      installImport: vi.fn(async () => ({ id: "op-1", slug: "one", action: "install", state: "queued", progress: 0, phase: "queued" })),
      disposeImport: vi.fn(async () => undefined),
      resolveInstall: vi.fn(async () => imported),
      openHub: vi.fn(async () => undefined),
    };
    const dispatch = createSkillDispatcher(skills, coordinator as any);
    const confirmation = { permissionFingerprint: "abc", acceptedRisk: "high" as const };

    await dispatch({ method: "skills.import-select", requestId: "s1", params: {} });
    await dispatch({ method: "skills.import-prepare", requestId: "s2", params: { token: "fixture-selection-token-1" } });
    await dispatch({ method: "skills.import-install", requestId: "s3", params: { token: "fixture-selection-token-1", confirmation } });
    await dispatch({ method: "skills.import-dispose", requestId: "s4", params: { token: "fixture-selection-token-1" } });
    await dispatch({ method: "skills.open-hub", requestId: "s5", params: {} });
    await dispatch({ method: "skills.resolve-install", requestId: "s6", params: { identity: "@alice/one" } });

    expect(coordinator.installImport).toHaveBeenCalledWith("fixture-selection-token-1", confirmation);
    expect(coordinator.openHub).toHaveBeenCalledOnce();
    expect(coordinator.resolveInstall).toHaveBeenCalledWith("@alice/one");
  });

  it("reports controlled install actions as unavailable when the coordinator is missing", async () => {
    const dispatch = createSkillDispatcher(skillService());

    await expect(dispatch({ method: "skills.open-hub", requestId: "missing-1", params: {} }))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("routes runtime, curator, and proposal methods through strict IPC", async () => {
    const skills = skillService();
    const now = "2026-08-11T00:00:00.000Z";
    skills.runtimeStatus.mockResolvedValue({ workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills", skills: [] });
    skills.curatorStatus.mockResolvedValue({ lastAttemptAtMs: null, lastSuccessAtMs: null, lastError: null, counts: { active: 0, stale: 0, archived: 0 }, skills: [], overlaps: [] });
    skills.curatorAction.mockResolvedValue({ skillFile: "SKILL.md", skillKey: "one", skillName: "one", state: "active", pinned: true, createdAtMs: 1, stateChangedAtMs: 1, lastUsedAtMs: null, useCount: 0, archivedReason: null });
    skills.proposalsList.mockResolvedValue({ schema: "openclaw.skill-workshop.proposals-manifest.v1", updatedAt: now, proposals: [] });
    const inspected = formalProposalInspect;
    skills.proposalInspect.mockResolvedValue(inspected);
    skills.proposalAction.mockResolvedValue(formalProposalRecord);
    skills.proposalCreate.mockResolvedValue(inspected);
    skills.proposalUpdate.mockResolvedValue(inspected);
    skills.proposalRevise.mockResolvedValue(inspected);
    skills.proposalRequestRevision.mockResolvedValue({ runId: "run-1", status: "started" });
    const dispatch = createSkillDispatcher(skills);
    const requests = [
      { method: "skills.runtime-status", requestId: "r1", params: {} },
      { method: "skills.curator-status", requestId: "r2", params: {} },
      { method: "skills.curator-action", requestId: "r3", params: { skill: "one", action: "pin" } },
      { method: "skills.proposals-list", requestId: "r4", params: {} },
      { method: "skills.proposal-inspect", requestId: "r5", params: { proposalId: "p1" } },
      { method: "skills.proposal-action", requestId: "r6", params: { proposalId: "p1", action: "apply", reason: null } },
      { method: "skills.proposal-create", requestId: "r7", params: { name: "one", description: "One", content: "# One", goal: null, evidence: null } },
      { method: "skills.proposal-update", requestId: "r8", params: { skillName: "one", description: null, content: "# One v2", goal: null, evidence: null } },
      { method: "skills.proposal-revise", requestId: "r9", params: { proposalId: "p1", content: "# Revised", description: null, goal: null, evidence: null } },
      { method: "skills.proposal-request-revision", requestId: "r10", params: { proposalId: "p1", instructions: "Add tests", sessionKey: "session-key", targetAgentId: null, sessionId: null } },
    ] as const;
    for (const request of requests) await expect(dispatch(request)).resolves.toMatchObject({ method: request.method, ok: true });
    expect(skills.runtimeStatus).toHaveBeenCalledOnce();
    expect(skills.curatorAction).toHaveBeenCalledWith("one", "pin");
    expect(skills.proposalAction).toHaveBeenCalledWith("p1", "apply", undefined);
    expect(skills.proposalCreate).toHaveBeenCalledWith({ name: "one", description: "One", content: "# One", goal: undefined, evidence: undefined });
    expect(skills.proposalRequestRevision).toHaveBeenCalledWith({ proposalId: "p1", instructions: "Add tests", sessionKey: "session-key", targetAgentId: undefined, sessionId: undefined });
  });

  it("routes local markdown detail by slug without accepting a renderer path", async () => {
    const skills = skillService();
    skills.localDetail.mockResolvedValue({
      slug: "one", name: "One", description: "One", markdown: "# One\n",
    });
    const dispatch = createSkillDispatcher(skills);

    await expect(dispatch({ method: "skills.local-detail", requestId: "local-1", params: { slug: "one" } } as any))
      .resolves.toMatchObject({ method: "skills.local-detail", ok: true, result: { markdown: "# One\n" } });
    expect(() => SkillIpcRequestSchema.parse({ method: "skills.local-detail", requestId: "local-2", params: { slug: "one", path: "/tmp/SKILL.md" } }))
      .toThrow();
  });

  it("rejects renderer paths and commands before dispatch", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const authorizedWebContents = { mainFrame: {} };
    const skills = skillService();
    registerIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: vi.fn() },
      authorizedWebContents,
      windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
      dispatchClient: vi.fn(), skills,
    });
    await expect(handlers.get(SKILL_IPC_CHANNEL)!({ sender: authorizedWebContents, senderFrame: authorizedWebContents.mainFrame }, {
      method: "skills.install", requestId: "bad", params: { slug: "workspace-reader", confirmation: null, path: "/tmp", command: "run" },
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(skills.startInstall).not.toHaveBeenCalled();
  });

  it("preload exposes only a parsed Skill invoke bridge", async () => {
    let api: Record<string, any> = {};
    const invoke = vi.fn(async (_channel: string, request: any) => ({ method: request.method, requestId: request.requestId, ok: true, result: { items: [], nextCursor: null, hasMore: false, mode: "fixture" } }));
    installPreloadBridge({
      contextBridge: { exposeInMainWorld: (_name, exposed) => { api = exposed; } },
      ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
    });
    expect(Object.keys(api.skills)).toEqual(["invoke"]);
    await api.skills.invoke({ method: "skills.search", requestId: "preload-1", params: { query: "", cursor: null, pageSize: 20 } });
    expect(invoke).toHaveBeenCalledWith(SKILL_IPC_CHANNEL, expect.objectContaining({ method: "skills.search" }));
    await expect(api.skills.invoke({ method: "exec", requestId: "bad", params: { command: "whoami" } })).rejects.toThrow();
  });
});
