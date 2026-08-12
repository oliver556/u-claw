import { describe, expect, it, vi } from "vitest";

import { createOpenClawAutomationService } from "../src/automation.js";
import { UClawUnsupportedError } from "../src/openclaw-client.js";

describe("OpenClaw Agent/Cron automation service", () => {
  it("maps every AUTO-001 through AUTO-007 RPC and reads authority after writes", async () => {
    const calls: string[] = [];
    const request = vi.fn(async (method: string) => {
      calls.push(method);
      if (method === "agents.list") return { agents: [{ id: "writer", name: "Writer", workspace: "/tmp/writer", model: { primary: "openai/gpt-5" } }] };
      if (method === "agent.identity.get") return { agentId: "writer", name: "Writer", emoji: "W" };
      if (method === "agents.files.list") return { workspace: "/private/secret", files: [{ path: "/private/secret/AGENTS.md", name: "AGENTS.md", size: 4 }] };
      if (method === "agents.files.get") return { workspace: "/private/secret", file: { path: "/private/secret/AGENTS.md", name: "AGENTS.md", size: 4, content: "rule" } };
      if (method === "agents.workspace.list") return { entries: [{ path: "src", name: "src", kind: "directory" }] };
      if (method === "agents.workspace.get") return { file: { path: "README.md", name: "README.md", content: "readme" } };
      if (method === "cron.list") return { jobs: [{ id: "daily", name: "Daily", enabled: true, schedule: { kind: "cron", expression: "0 9 * * *" }, payload: { kind: "agentTurn", message: "report" } }] };
      if (method === "cron.status") return { enabled: true, jobCount: 1, nextWakeAtMs: 1000 };
      if (method === "cron.get") return { id: "daily", name: "Daily", enabled: true, schedule: { kind: "cron", expr: "0 9 * * *" }, payload: { kind: "agentTurn", message: "report" } };
      if (method === "cron.runs") return { runs: [{ id: "run-1", jobId: "daily", status: "ok", startedAt: 1 }] };
      return { ok: true, id: "daily" };
    });
    const service = createOpenClawAutomationService({ request: request as never, requireMethod: () => undefined });

    await service.listAgents(); await service.getAgentIdentity({ agentId: "writer" });
    await service.createAgent({ name: "Writer", workspace: "/tmp/writer" });
    await service.updateAgent({ agentId: "writer", name: "Writer 2" });
    await service.deleteAgent({ agentId: "writer" });
    await service.listAgentFiles({ agentId: "writer" });
    expect(await service.getAgentFile({ agentId: "writer", path: "AGENTS.md" })).toEqual({ file: { path: "AGENTS.md", name: "AGENTS.md", size: 4, content: "rule" } });
    await service.writeAgentFile({ agentId: "writer", path: "AGENTS.md", content: "rule" });
    await service.listAgentWorkspace({ agentId: "writer" });
    await service.getAgentWorkspace({ agentId: "writer", path: "README.md" });
    await service.listCron(); await service.getCronStatus(); await service.getCron({ jobId: "daily" });
    await service.addCron({ name: "Daily", enabled: true, schedule: { kind: "cron", expression: "0 9 * * *" }, payload: { kind: "agentTurn", message: "report" } });
    await service.updateCron({ jobId: "daily", name: "Daily 2" });
    await service.removeCron({ jobId: "daily" });
    await service.runCron({ jobId: "daily" }); await service.listCronRuns({ jobId: "daily" });

    expect(calls).toEqual(expect.arrayContaining([
      "agents.list", "agent.identity.get", "agents.create", "agents.update", "agents.delete",
      "agents.files.list", "agents.files.get", "agents.files.set", "agents.workspace.list", "agents.workspace.get",
      "cron.list", "cron.status", "cron.get", "cron.add", "cron.update", "cron.remove", "cron.run", "cron.runs",
    ]));
    expect(calls.filter((method) => method === "agents.list")).toHaveLength(4);
    expect(calls.filter((method) => method === "agents.files.get")).toHaveLength(2);
    expect(calls.filter((method) => method === "cron.list")).toHaveLength(4);
    expect(request).toHaveBeenCalledWith(
      "agents.delete",
      { agentId: "writer", deleteFiles: false },
      expect.anything(),
    );
    expect(request).toHaveBeenCalledWith(
      "agents.update",
      { agentId: "writer", name: "Writer 2" },
      expect.anything(),
    );
  });

  it("returns precise unsupported before calling a method not advertised by locked OpenClaw", async () => {
    const requireMethod = vi.fn((method: string) => { throw new UClawUnsupportedError(method); });
    const request = vi.fn();
    const service = createOpenClawAutomationService({ request: request as never, requireMethod });
    await expect(service.listAgents()).rejects.toMatchObject({ code: "UNSUPPORTED", uclawError: { causeDetails: { capability: "agents.list" } } });
    expect(request).not.toHaveBeenCalled();
  });
});
