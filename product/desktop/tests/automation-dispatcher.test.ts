import { describe, expect, it, vi } from "vitest";
import { createAutomationDispatcher } from "../src/automation/automation-dispatcher.js";

describe("automation dispatcher", () => {
  it("dispatches Agent and Cron requests", async () => {
    const service = { listAgents: vi.fn(async () => ({ agents: [] })), getAgentIdentity: vi.fn(), createAgent: vi.fn(), updateAgent: vi.fn(), deleteAgent: vi.fn(), listAgentFiles: vi.fn(), getAgentFile: vi.fn(), writeAgentFile: vi.fn(), listAgentWorkspace: vi.fn(), getAgentWorkspace: vi.fn(), listCron: vi.fn(async () => ({ jobs: [] })), getCronStatus: vi.fn(), getCron: vi.fn(), addCron: vi.fn(), updateCron: vi.fn(), removeCron: vi.fn(), runCron: vi.fn(), listCronRuns: vi.fn() };
    const dispatch = createAutomationDispatcher(service as never);
    await expect(dispatch({ method: "agents.list", requestId: "a-1", params: {} })).resolves.toMatchObject({ ok: true, result: { agents: [] } });
    await expect(dispatch({ method: "cron.list", requestId: "c-1", params: {} })).resolves.toMatchObject({ ok: true, result: { jobs: [] } });
  });
});
