import { describe, expect, it, vi } from "vitest";

import { createOpenClawUsageService } from "../src/openclaw-usage.js";

const totals = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  totalCost: 0.03,
  inputCost: 0.01,
  outputCost: 0.02,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  missingCostEntries: 0,
};

describe("OpenClaw usage service", () => {
  it("loads provider status, cost and session usage from authoritative RPCs", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "usage.status") return { updatedAt: 100, providers: [] };
      if (method === "usage.cost") return { updatedAt: 101, days: 1, daily: [], totals };
      if (method === "sessions.usage") {
        return { updatedAt: 102, startDate: "2026-08-12", endDate: "2026-08-12", sessions: [], totals };
      }
      throw new Error(`unexpected ${method}`);
    });
    const service = createOpenClawUsageService({ request });

    const result = await service.snapshot({ startDate: "2026-08-12", endDate: "2026-08-12" });

    expect(result.providerStatus.updatedAt).toBe(100);
    expect(result.cost.updatedAt).toBe(101);
    expect(result.sessions.updatedAt).toBe(102);
    expect(request.mock.calls).toEqual(expect.arrayContaining([
      ["usage.status", {}],
      ["usage.cost", { startDate: "2026-08-12", endDate: "2026-08-12", agentScope: "all", mode: "gateway" }],
      ["sessions.usage", { startDate: "2026-08-12", endDate: "2026-08-12", agentScope: "all", groupBy: "family", mode: "gateway", limit: 1000 }],
    ]));
  });

  it("loads one session timeseries and bounded usage logs", async () => {
    const request = vi.fn(async (method: string) => method === "sessions.usage.timeseries"
      ? { sessionId: "session-1", points: [{
        timestamp: 1_754_982_400_000,
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: 0.03,
        cumulativeTokens: 3,
        cumulativeCost: 0.03,
      }] }
      : { logs: [{ timestamp: 1_754_982_400_000, role: "assistant", content: "ok", tokens: 3, cost: 0.03 }] });
    const service = createOpenClawUsageService({ request });

    await expect(service.sessionTimeseries("agent:main:session-1")).resolves.toMatchObject({ sessionId: "session-1" });
    await expect(service.sessionLogs("agent:main:session-1")).resolves.toHaveLength(1);
    expect(request).toHaveBeenNthCalledWith(1, "sessions.usage.timeseries", { key: "agent:main:session-1" });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.usage.logs", { key: "agent:main:session-1", limit: 200 });
  });
});
