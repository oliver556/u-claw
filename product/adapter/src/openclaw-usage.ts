import { z } from "zod";

const totals = z.object({
  input: z.number().nonnegative(), output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(), cacheWrite: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(), totalCost: z.number().nonnegative(),
  inputCost: z.number().nonnegative(), outputCost: z.number().nonnegative(),
  cacheReadCost: z.number().nonnegative(), cacheWriteCost: z.number().nonnegative(),
  missingCostEntries: z.number().int().nonnegative(),
}).passthrough();
const providerStatus = z.object({ updatedAt: z.number().int().nonnegative(), providers: z.array(z.object({
  provider: z.string().min(1), displayName: z.string().min(1), windows: z.array(z.unknown()),
}).passthrough()) }).strict();
const cost = z.object({ updatedAt: z.number().int().nonnegative(), days: z.number().int().positive(), daily: z.array(z.unknown()), totals }).passthrough();
const sessions = z.object({
  updatedAt: z.number().int().nonnegative(), startDate: z.string(), endDate: z.string(), sessions: z.array(z.unknown()), totals,
}).passthrough();
const timeseries = z.object({ sessionId: z.string().min(1), points: z.array(z.object({
  timestamp: z.number().int().nonnegative(), input: z.number().nonnegative(), output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(), cacheWrite: z.number().nonnegative(), totalTokens: z.number().nonnegative(),
  cost: z.number().nonnegative(), cumulativeTokens: z.number().nonnegative(), cumulativeCost: z.number().nonnegative(),
}).strict()).max(200) }).strict();
const logs = z.object({ logs: z.array(z.object({
  timestamp: z.number().int().nonnegative(), role: z.enum(["user", "assistant", "tool", "toolResult"]),
  content: z.string(), tokens: z.number().nonnegative().optional(), cost: z.number().nonnegative().optional(),
}).strict()).max(200) }).strict();

export interface OpenClawUsageRequest {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export function createOpenClawUsageService({ request }: OpenClawUsageRequest) {
  return {
    async snapshot(range: { startDate: string; endDate: string }) {
      const shared = { startDate: range.startDate, endDate: range.endDate, agentScope: "all", mode: "gateway" } as const;
      const [statusResult, costResult, sessionResult] = await Promise.all([
        request("usage.status", {}),
        request("usage.cost", shared),
        request("sessions.usage", { ...shared, groupBy: "family", limit: 1000 }),
      ]);
      return {
        providerStatus: providerStatus.parse(statusResult),
        cost: cost.parse(costResult),
        sessions: sessions.parse(sessionResult),
      };
    },
    async sessionTimeseries(sessionKey: string) {
      return timeseries.parse(await request("sessions.usage.timeseries", { key: sessionKey }));
    },
    async sessionLogs(sessionKey: string) {
      return logs.parse(await request("sessions.usage.logs", { key: sessionKey, limit: 200 })).logs;
    },
  };
}
export type OpenClawUsageService = ReturnType<typeof createOpenClawUsageService>;
