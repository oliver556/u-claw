import { describe, expect, it } from "vitest";

import {
  NewApiUsageStateSchema,
  UsageIpcRequestSchema,
  UsageSnapshotSchema,
} from "../src/usage.js";

describe("usage contracts", () => {
  it("accepts one authoritative OpenClaw and New API usage snapshot", () => {
    const snapshot = UsageSnapshotSchema.parse({
      fetchedAt: "2026-08-12T08:00:00.000Z",
      range: { startDate: "2026-08-01", endDate: "2026-08-12" },
      openClaw: {
        providerStatus: {
          updatedAt: 1_754_982_400_000,
          providers: [{
            provider: "deepseek",
            displayName: "DeepSeek",
            windows: [{ label: "monthly", usedPercent: 25, resetAt: 1_757_664_000_000 }],
          }],
        },
        cost: {
          updatedAt: 1_754_982_400_000,
          days: 12,
          daily: [],
          totals: {
            input: 100,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 150,
            totalCost: 0.25,
            inputCost: 0.1,
            outputCost: 0.15,
            cacheReadCost: 0,
            cacheWriteCost: 0,
            missingCostEntries: 0,
          },
        },
        sessions: {
          updatedAt: 1_754_982_400_000,
          startDate: "2026-08-01",
          endDate: "2026-08-12",
          sessions: [{
            key: "agent:main:session-1",
            sessionId: "session-1",
            updatedAt: 1_754_982_400_000,
            agentId: "main",
            modelProvider: "deepseek",
            model: "deepseek-v4-flash",
            usage: null,
          }],
          totals: {
            input: 100,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 150,
            totalCost: 0.25,
            inputCost: 0.1,
            outputCost: 0.15,
            cacheReadCost: 0,
            cacheWriteCost: 0,
            missingCostEntries: 0,
          },
        },
      },
      newApi: {
        source: "new-api",
        userId: "usr_1",
        quota: 10_000,
        used: 2_500,
        remaining: 7_500,
        resetAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-08-12T08:00:00.000Z",
      },
    });

    expect(snapshot.openClaw.sessions.sessions[0]?.modelProvider).toBe("deepseek");
    expect(snapshot.newApi && !("error" in snapshot.newApi) ? snapshot.newApi.remaining : undefined).toBe(7_500);
  });

  it("rejects invalid ranges and unbounded session detail requests", () => {
    expect(UsageIpcRequestSchema.safeParse({
      method: "usage.snapshot",
      requestId: "usage-1",
      params: { startDate: "2026-08-12", endDate: "2026-08-01" },
    }).success).toBe(false);
    expect(UsageIpcRequestSchema.safeParse({
      method: "usage.session-timeseries",
      requestId: "usage-2",
      params: { sessionKey: "" },
    }).success).toBe(false);
  });

  it("accepts a safe independent New API error state", () => {
    expect(NewApiUsageStateSchema.parse({
      source: "new-api",
      updatedAt: "2026-08-12T08:00:00.000Z",
      error: {
        code: "NETWORK_UNREACHABLE",
        message: "Network is unreachable.",
        retryable: true,
        recoveryActions: ["retry"],
        causeDetails: {},
      },
    })).toMatchObject({ error: { code: "NETWORK_UNREACHABLE" } });
  });
});
