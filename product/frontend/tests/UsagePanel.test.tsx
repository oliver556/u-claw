// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UsagePanel } from "../src/features/providers/UsagePanel.js";

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "uclaw", { configurable: true, value: undefined });
});

describe("UsagePanel", () => {
  it("shows provider attribution, OpenClaw cost, New API quota and backend timestamp", async () => {
    const invoke = vi.fn(async () => ({
      method: "usage.snapshot" as const,
      requestId: "usage-1",
      ok: true as const,
      result: {
        fetchedAt: "2026-08-12T08:00:00.000Z",
        range: { startDate: "2026-08-12", endDate: "2026-08-12" },
        openClaw: {
          providerStatus: {
            updatedAt: 1_754_982_400_000,
            providers: [{
              provider: "deepseek",
              displayName: "DeepSeek",
              windows: [{ label: "monthly", usedPercent: 25, resetAt: 1_757_664_000_000 }],
              billing: [{ type: "balance", label: "余额", amount: 12, unit: "USD" }],
              summary: "额度正常",
              plan: "Pro",
            }, {
              provider: "custom-main",
              displayName: "Custom",
              windows: [],
              error: "authentication failed",
            }],
          },
          cost: { updatedAt: 1_754_982_400_000, days: 1, daily: [], totals: { totalTokens: 150, totalCost: 0.25 } },
          sessions: {
            updatedAt: 1_754_982_400_000,
            startDate: "2026-08-12",
            endDate: "2026-08-12",
            totals: { totalTokens: 150, totalCost: 0.25 },
            sessions: [{
              key: "agent:main:session-1",
              sessionId: "session-1",
              updatedAt: 1_754_982_400_000,
              agentId: "main",
              modelProvider: "deepseek",
              model: "deepseek-v4-flash",
              usage: null,
            }],
          },
        },
        newApi: {
          source: "new-api" as const,
          userId: "usr_1",
          quota: 10_000,
          used: 2_500,
          remaining: 7_500,
          resetAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-08-12T08:00:00.000Z",
        },
      },
    }));

    render(<UsagePanel invoke={invoke} today={() => "2026-08-12"} />);

    expect(await screen.findByLabelText("Provider 归属")).toHaveTextContent(
      "deepseek / deepseek-v4-flash",
    );
    expect(screen.getByText("$0.25")).toBeInTheDocument();
    expect(screen.getByText("7,500 / 10,000")).toBeInTheDocument();
    expect(screen.getByLabelText("OpenClaw Provider 用量")).toHaveTextContent(
      "DeepSeekPro额度正常monthly25%2025-09-12 08:00:00 UTC余额12 USDCustomauthentication failed",
    );
    expect(screen.getByRole("alert", { name: "Custom Provider 错误" })).toHaveTextContent("authentication failed");
    expect(screen.getByText("2026-08-12 08:00:00 UTC")).toBeInTheDocument();
    expect(screen.getByLabelText("New API 额度")).toHaveTextContent("2026-09-01 00:00:00 UTC");
  });

  it("loads once with the default date source after state updates", async () => {
    const invoke = vi.fn(async () => ({
      method: "usage.snapshot" as const,
      requestId: "usage-default-date",
      ok: true as const,
      result: {
        fetchedAt: "2026-08-12T08:00:00.000Z",
        openClaw: {
          providerStatus: { updatedAt: 1_754_982_400_000, providers: [] },
          cost: { totals: { totalTokens: 0, totalCost: 0 } },
          sessions: { sessions: [] },
        },
        newApi: null,
      },
    }));
    Object.defineProperty(window, "uclaw", {
      configurable: true,
      value: { usage: { invoke } },
    });

    render(<UsagePanel />);
    await screen.findByRole("region", { name: "用量与成本" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("New API 额度")).toHaveTextContent("未配置");
  });

  it("requests the selected usage range", async () => {
    const invoke = vi.fn(async () => ({
      method: "usage.snapshot" as const,
      requestId: "usage-range",
      ok: true as const,
      result: {
        fetchedAt: "2026-08-12T08:00:00.000Z",
        openClaw: {
          providerStatus: { updatedAt: 1_754_982_400_000, providers: [] },
          cost: { totals: { totalTokens: 0, totalCost: 0 } },
          sessions: { sessions: [] },
        },
        newApi: null,
      },
    }));
    render(<UsagePanel invoke={invoke} today={() => "2026-08-12"} />);
    await screen.findByRole("region", { name: "用量与成本" });

    fireEvent.change(screen.getByLabelText("开始日期"), { target: { value: "2026-08-01" } });
    fireEvent.click(screen.getByRole("button", { name: "刷新用量" }));

    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith(expect.objectContaining({
      params: { startDate: "2026-08-01", endDate: "2026-08-12" },
    })));
  });

  it("shows a diagnostic error when usage bridge fails", async () => {
    render(<UsagePanel invoke={vi.fn(async () => { throw new Error("offline"); })} today={() => "2026-08-12"} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("用量读取失败");
  });

  it("shows the safe OpenClaw error code returned by IPC", async () => {
    render(<UsagePanel invoke={vi.fn(async () => ({
      method: "usage.snapshot" as const,
      requestId: "usage-protocol-error",
      ok: false as const,
      error: { code: "PROTOCOL_MAPPING_FAILED", message: "safe", retryable: false },
    }))} today={() => "2026-08-12"} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("PROTOCOL_MAPPING_FAILED");
  });

  it("loads authoritative session timeseries and logs on demand", async () => {
    const invoke = vi.fn(async (request: { method: string }) => {
      if (request.method === "usage.session-timeseries") return {
        method: request.method, requestId: "usage-timeseries", ok: true as const,
        result: { sessionId: "session-1", points: [{
          timestamp: 1_754_982_400_000,
          input: 1, output: 2, cacheRead: 0, cacheWrite: 0,
          totalTokens: 3, cost: 0.03, cumulativeTokens: 3, cumulativeCost: 0.03,
        }] },
      };
      if (request.method === "usage.session-logs") return {
        method: request.method, requestId: "usage-logs", ok: true as const,
        result: [{ timestamp: 1_754_982_400_000, role: "assistant", content: "ok", tokens: 3, cost: 0.03 }],
      };
      return {
        method: request.method, requestId: "usage-snapshot", ok: true as const,
        result: {
          fetchedAt: "2026-08-12T08:00:00.000Z",
          openClaw: {
            providerStatus: { updatedAt: 1_754_982_400_000, providers: [] },
            cost: { totals: { totalTokens: 3, totalCost: 0.03 } },
            sessions: { sessions: [{
              key: "agent:main:session-1", sessionId: "session-1", updatedAt: 1_754_982_400_000,
              agentId: "main", modelProvider: "deepseek", model: "deepseek-v4-flash", usage: null,
            }] },
          },
          newApi: null,
        },
      };
    });
    render(<UsagePanel invoke={invoke as never} today={() => "2026-08-12"} />);

    fireEvent.click(await screen.findByRole("button", { name: "查看 session-1 用量" }));

    expect(await screen.findByText(/3 tokens · \$0\.03/u)).toBeInTheDocument();
    expect(screen.getByLabelText("用量时序")).toHaveTextContent("2025-08-12 07:06:40 UTC");
    expect(screen.getByText(/assistant · 3 tokens/u)).toBeInTheDocument();
    expect(invoke.mock.calls.map(([request]) => request.method)).toEqual([
      "usage.snapshot", "usage.session-timeseries", "usage.session-logs",
    ]);
  });
});
