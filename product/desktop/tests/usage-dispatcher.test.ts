import { describe, expect, it, vi } from "vitest";

import { createUsageDispatcher } from "../src/usage/usage-dispatcher.js";

const totals = {
  input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, totalCost: 0.03,
  inputCost: 0.01, outputCost: 0.02, cacheReadCost: 0, cacheWriteCost: 0, missingCostEntries: 0,
};

describe("usage dispatcher", () => {
  it("combines OpenClaw usage with authoritative New API quota and backend timestamps", async () => {
    const openClaw = {
      snapshot: vi.fn(async () => ({
        providerStatus: { updatedAt: 100, providers: [] },
        cost: { updatedAt: 101, days: 1, daily: [], totals },
        sessions: { updatedAt: 102, startDate: "2026-08-12", endDate: "2026-08-12", sessions: [], totals },
      })),
      sessionTimeseries: vi.fn(),
      sessionLogs: vi.fn(),
    };
    const getUsage = vi.fn(async () => ({
      userId: "usr_1",
      consumed: 25,
      remaining: 75,
      resetAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-08-12T07:59:00.000Z",
    }));
    const dispatch = createUsageDispatcher({
      openClaw,
      newApi: { userId: "usr_1", client: { getUsage } },
      now: () => new Date("2026-08-12T08:00:00.000Z"),
    });

    const response = await dispatch({
      method: "usage.snapshot",
      requestId: "usage-1",
      params: { startDate: "2026-08-12", endDate: "2026-08-12" },
    });

    expect(response).toMatchObject({ ok: true, result: {
      fetchedAt: "2026-08-12T08:00:00.000Z",
      newApi: { userId: "usr_1", quota: 100, used: 25, remaining: 75, updatedAt: "2026-08-12T07:59:00.000Z" },
    } });
    expect(getUsage).toHaveBeenCalledWith("usr_1");
  });

  it("resolves the current USB-bound New API user for every snapshot", async () => {
    const newApiUsage = vi.fn(async () => ({
      userId: "usr_current", consumed: 4, remaining: 6, resetAt: null,
      updatedAt: "2026-08-12T07:59:00.000Z",
    }));
    const dispatch = createUsageDispatcher({
      openClaw: {
        snapshot: async () => ({}), sessionTimeseries: vi.fn(), sessionLogs: vi.fn(),
      },
      newApiUsage,
    });

    await dispatch({ method: "usage.snapshot", requestId: "usage-current-1", params: { startDate: "2026-08-12", endDate: "2026-08-12" } });
    await dispatch({ method: "usage.snapshot", requestId: "usage-current-2", params: { startDate: "2026-08-12", endDate: "2026-08-12" } });

    expect(newApiUsage).toHaveBeenCalledTimes(2);
  });

  it("keeps OpenClaw usage available when New API is not configured", async () => {
    const dispatch = createUsageDispatcher({
      openClaw: {
        snapshot: async () => ({
          providerStatus: { updatedAt: 100, providers: [] },
          cost: { updatedAt: 101, days: 1, daily: [], totals },
          sessions: { updatedAt: 102, startDate: "2026-08-12", endDate: "2026-08-12", sessions: [], totals },
        }),
        sessionTimeseries: vi.fn(),
        sessionLogs: vi.fn(),
      },
      now: () => new Date("2026-08-12T08:00:00.000Z"),
    });

    const response = await dispatch({
      method: "usage.snapshot",
      requestId: "usage-2",
      params: { startDate: "2026-08-12", endDate: "2026-08-12" },
    });
    expect(response).toMatchObject({ ok: true, result: { newApi: null } });
  });

  it("keeps OpenClaw usage available when New API fails", async () => {
    const error = Object.assign(new Error("private upstream message"), {
      uclawError: {
        code: "NETWORK_UNREACHABLE",
        message: "private upstream message",
        retryable: true,
        recoveryActions: ["retry"],
        causeDetails: { secret: "must-not-render" },
      },
    });
    const dispatch = createUsageDispatcher({
      openClaw: {
        snapshot: async () => ({
          providerStatus: { updatedAt: 100, providers: [] },
          cost: { updatedAt: 101, days: 1, daily: [], totals },
          sessions: { updatedAt: 102, startDate: "2026-08-12", endDate: "2026-08-12", sessions: [], totals },
        }),
        sessionTimeseries: vi.fn(),
        sessionLogs: vi.fn(),
      },
      newApi: { userId: "usr_1", client: { getUsage: vi.fn(async () => { throw error; }) } },
      now: () => new Date("2026-08-12T08:00:00.000Z"),
    });

    await expect(dispatch({
      method: "usage.snapshot",
      requestId: "usage-3",
      params: { startDate: "2026-08-12", endDate: "2026-08-12" },
    })).resolves.toMatchObject({ ok: true, result: {
      openClaw: { cost: { totals: { totalTokens: 3 } } },
      newApi: {
        source: "new-api",
        updatedAt: "2026-08-12T08:00:00.000Z",
        error: { code: "NETWORK_UNREACHABLE", message: "Network is unreachable.", retryable: true, causeDetails: {} },
      },
    } });
  });
});
