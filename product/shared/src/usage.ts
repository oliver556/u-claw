import { z } from "zod";

import { UClawErrorSchema } from "./errors.js";

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const TimestampSchema = z.string().datetime({ offset: true });
const IdentifierSchema = z.string().trim().min(1).max(512);

export const UsageRangeSchema = z.object({
  startDate: DateSchema,
  endDate: DateSchema,
}).strict().refine(({ startDate, endDate }) => startDate <= endDate, {
  message: "Usage start date must not be after end date",
  path: ["endDate"],
});
export type UsageRange = z.infer<typeof UsageRangeSchema>;

export const UsageTotalsSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  totalCost: z.number().nonnegative(),
  inputCost: z.number().nonnegative(),
  outputCost: z.number().nonnegative(),
  cacheReadCost: z.number().nonnegative(),
  cacheWriteCost: z.number().nonnegative(),
  missingCostEntries: z.number().int().nonnegative(),
}).passthrough();
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

const ProviderUsageWindowSchema = z.object({
  label: z.string().min(1),
  usedPercent: z.number().nonnegative(),
  resetAt: z.number().int().nonnegative().optional(),
}).strict();

const ProviderUsageBillingSchema = z.union([
  z.object({ type: z.literal("balance"), label: z.string().optional(), amount: z.number(), unit: z.string().min(1) }).strict(),
  z.object({ type: z.literal("spend"), label: z.string().optional(), amount: z.number(), unit: z.string().min(1), period: z.string().optional(), resetAt: z.number().int().nonnegative().optional() }).strict(),
  z.object({ type: z.literal("budget"), label: z.string().optional(), used: z.number(), limit: z.number(), unit: z.string().min(1), period: z.string().optional(), resetAt: z.number().int().nonnegative().optional() }).strict(),
]);

export const OpenClawProviderUsageStatusSchema = z.object({
  updatedAt: z.number().int().nonnegative(),
  providers: z.array(z.object({
    provider: IdentifierSchema,
    displayName: z.string().min(1),
    windows: z.array(ProviderUsageWindowSchema),
    billing: z.array(ProviderUsageBillingSchema).optional(),
    summary: z.string().optional(),
    plan: z.string().optional(),
    error: z.string().optional(),
  }).passthrough()).max(100),
}).strict();

export const OpenClawCostUsageSchema = z.object({
  updatedAt: z.number().int().nonnegative(),
  days: z.number().int().positive(),
  daily: z.array(UsageTotalsSchema.extend({ date: DateSchema })).max(3_660),
  totals: UsageTotalsSchema,
  cacheStatus: z.unknown().optional(),
}).passthrough();

export const OpenClawSessionUsageSchema = z.object({
  updatedAt: z.number().int().nonnegative(),
  startDate: DateSchema,
  endDate: DateSchema,
  sessions: z.array(z.object({
    key: IdentifierSchema,
    sessionId: IdentifierSchema,
    updatedAt: z.number().int().nonnegative(),
    agentId: IdentifierSchema,
    modelProvider: IdentifierSchema.optional(),
    model: IdentifierSchema.optional(),
    usage: UsageTotalsSchema.passthrough().nullable(),
  }).passthrough()).max(1_000),
  totals: UsageTotalsSchema,
  aggregates: z.unknown().optional(),
  cacheStatus: z.unknown().optional(),
}).passthrough();

export const OpenClawSessionTimeseriesSchema = z.object({
  sessionId: IdentifierSchema,
  points: z.array(z.object({
    timestamp: z.number().int().nonnegative(),
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
    cost: z.number().nonnegative(),
    cumulativeTokens: z.number().nonnegative(),
    cumulativeCost: z.number().nonnegative(),
  }).strict()).max(200),
}).strict();

export const OpenClawSessionUsageLogsSchema = z.object({
  logs: z.array(z.object({
    timestamp: z.number().int().nonnegative(),
    role: z.enum(["user", "assistant", "tool", "toolResult"]),
    content: z.string().max(2_001),
    tokens: z.number().nonnegative().optional(),
    cost: z.number().nonnegative().optional(),
  }).strict()).max(200),
}).strict();

export const OpenClawUsageSnapshotSchema = z.object({
  providerStatus: OpenClawProviderUsageStatusSchema,
  cost: OpenClawCostUsageSchema,
  sessions: OpenClawSessionUsageSchema,
}).strict();
export type OpenClawUsageSnapshot = z.infer<typeof OpenClawUsageSnapshotSchema>;

export const NewApiQuotaUsageSchema = z.object({
  source: z.literal("new-api"),
  userId: IdentifierSchema,
  quota: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  resetAt: TimestampSchema.nullable(),
  updatedAt: TimestampSchema,
}).strict();

export const NewApiUsageStateSchema = z.union([
  NewApiQuotaUsageSchema,
  z.object({
    source: z.literal("new-api"),
    updatedAt: TimestampSchema,
    error: UClawErrorSchema,
  }).strict(),
]).nullable();

export const UsageSnapshotSchema = z.object({
  fetchedAt: TimestampSchema,
  range: UsageRangeSchema,
  openClaw: OpenClawUsageSnapshotSchema,
  newApi: NewApiUsageStateSchema,
}).strict();
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;

export const UsageIpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("usage.snapshot"), requestId: IdentifierSchema, params: UsageRangeSchema }).strict(),
  z.object({ method: z.literal("usage.session-timeseries"), requestId: IdentifierSchema, params: z.object({ sessionKey: IdentifierSchema }).strict() }).strict(),
  z.object({ method: z.literal("usage.session-logs"), requestId: IdentifierSchema, params: z.object({ sessionKey: IdentifierSchema }).strict() }).strict(),
]);
export type UsageIpcRequest = z.infer<typeof UsageIpcRequestSchema>;

export const UsageIpcResponseSchema = z.union([
  z.object({ method: z.literal("usage.snapshot"), requestId: IdentifierSchema, ok: z.literal(true), result: UsageSnapshotSchema }).strict(),
  z.object({ method: z.literal("usage.session-timeseries"), requestId: IdentifierSchema, ok: z.literal(true), result: OpenClawSessionTimeseriesSchema }).strict(),
  z.object({ method: z.literal("usage.session-logs"), requestId: IdentifierSchema, ok: z.literal(true), result: OpenClawSessionUsageLogsSchema.shape.logs }).strict(),
  z.object({ method: z.enum(["usage.snapshot", "usage.session-timeseries", "usage.session-logs"]), requestId: IdentifierSchema, ok: z.literal(false), error: UClawErrorSchema }).strict(),
]);
export type UsageIpcResponse = z.infer<typeof UsageIpcResponseSchema>;
