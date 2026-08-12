import { z } from "zod";
import { UClawErrorSchema } from "./errors.js";

const Id = z.string().trim().min(1).max(256);
const Empty = z.object({}).strict();
const SafePath = z.string().trim().min(1).max(1024).refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").some((part) => part === "" || part === "." || part === ".."), "Path must stay inside the Agent workspace");
const AgentId = z.object({ agentId: Id }).strict();
const AgentPath = z.object({ agentId: Id, path: SafePath }).strict();

export const AgentSummarySchema = z.object({ id: Id, name: z.string().min(1).optional(), workspace: z.string().optional(), model: z.string().optional() }).passthrough();
export const AgentIdentitySchema = z.object({ agentId: Id, name: z.string().optional(), emoji: z.string().optional(), avatar: z.string().optional() }).passthrough();
export const AgentFileSchema = z.object({ name: z.string().min(1), path: z.string().min(1), missing: z.boolean().optional(), size: z.number().int().nonnegative().optional(), updatedAtMs: z.number().int().nonnegative().optional(), content: z.string().optional() }).passthrough();
export const AgentWorkspaceEntrySchema = z.object({ name: z.string().min(1), path: z.string().min(1), kind: z.enum(["file", "directory"]), size: z.number().int().nonnegative().optional(), updatedAtMs: z.number().int().nonnegative().optional(), content: z.string().optional(), mimeType: z.string().optional(), dataBase64: z.string().optional() }).passthrough();
export type AgentSummary = z.infer<typeof AgentSummarySchema>;
export type AgentFile = z.infer<typeof AgentFileSchema>;
export type AgentWorkspaceEntry = z.infer<typeof AgentWorkspaceEntrySchema>;

export const CronScheduleSchema = z.union([
  z.object({ kind: z.literal("cron"), expression: z.string().min(1), tz: z.string().optional() }).passthrough(),
  z.object({ kind: z.literal("every"), everyMs: z.number().int().positive(), anchorMs: z.number().int().nonnegative().optional() }).passthrough(),
  z.object({ kind: z.literal("at"), at: z.string().min(1).optional(), atMs: z.number().int().nonnegative().optional() }).passthrough(),
]);
export const CronPayloadSchema = z.object({ kind: z.string().min(1), message: z.string().optional() }).passthrough();
export const CronJobSchema = z.object({ id: Id, name: z.string().min(1).optional(), displayName: z.string().min(1).optional(), enabled: z.boolean(), schedule: CronScheduleSchema, payload: CronPayloadSchema, agentId: z.string().optional(), state: z.unknown().optional() }).passthrough();
export const CronRunSchema = z.object({ id: z.string().optional(), jobId: Id, status: z.string().min(1), startedAt: z.number().int().nonnegative().optional(), ts: z.number().int().nonnegative().optional(), durationMs: z.number().int().nonnegative().optional(), error: z.string().optional() }).passthrough();
export type CronJob = z.infer<typeof CronJobSchema>;
export type CronRun = z.infer<typeof CronRunSchema>;

const AgentCreate = z.object({ name: z.string().trim().min(1).max(120), workspace: z.string().trim().min(1), model: z.string().optional() }).strict();
const AgentUpdate = AgentCreate.partial().extend({ agentId: Id }).strict();
const CronCreate = z.object({ name: z.string().trim().min(1).max(120), enabled: z.boolean(), schedule: CronScheduleSchema, payload: CronPayloadSchema, agentId: Id.optional() }).strict();
const CronUpdate = CronCreate.partial().extend({ jobId: Id }).strict();

export const AutomationIpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("agents.list"), requestId: Id, params: Empty }).strict(),
  z.object({ method: z.literal("agent.identity.get"), requestId: Id, params: AgentId }).strict(),
  z.object({ method: z.literal("agents.create"), requestId: Id, params: AgentCreate }).strict(),
  z.object({ method: z.literal("agents.update"), requestId: Id, params: AgentUpdate }).strict(),
  z.object({ method: z.literal("agents.delete"), requestId: Id, params: AgentId.extend({ deleteFiles: z.boolean().default(false) }).strict() }).strict(),
  z.object({ method: z.literal("agents.files.list"), requestId: Id, params: AgentId }).strict(),
  z.object({ method: z.literal("agents.files.get"), requestId: Id, params: AgentPath }).strict(),
  z.object({ method: z.literal("agents.files.set"), requestId: Id, params: AgentPath.extend({ content: z.string().max(1_000_000) }).strict() }).strict(),
  z.object({ method: z.literal("agents.workspace.list"), requestId: Id, params: z.object({ agentId: Id, path: SafePath.optional() }).strict() }).strict(),
  z.object({ method: z.literal("agents.workspace.get"), requestId: Id, params: AgentPath }).strict(),
  z.object({ method: z.literal("cron.list"), requestId: Id, params: Empty }).strict(),
  z.object({ method: z.literal("cron.status"), requestId: Id, params: Empty }).strict(),
  z.object({ method: z.literal("cron.get"), requestId: Id, params: z.object({ jobId: Id }).strict() }).strict(),
  z.object({ method: z.literal("cron.add"), requestId: Id, params: CronCreate }).strict(),
  z.object({ method: z.literal("cron.update"), requestId: Id, params: CronUpdate }).strict(),
  z.object({ method: z.literal("cron.remove"), requestId: Id, params: z.object({ jobId: Id }).strict() }).strict(),
  z.object({ method: z.literal("cron.run"), requestId: Id, params: z.object({ jobId: Id }).strict() }).strict(),
  z.object({ method: z.literal("cron.runs"), requestId: Id, params: z.object({ jobId: Id.optional(), limit: z.number().int().positive().max(200).optional() }).strict() }).strict(),
]);
export type AutomationIpcRequest = z.infer<typeof AutomationIpcRequestSchema>;
export type AutomationMethod = AutomationIpcRequest["method"];

export const AutomationIpcResponseSchema = z.union([
  z.object({ method: z.string(), requestId: Id, ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ method: z.string(), requestId: Id, ok: z.literal(false), error: UClawErrorSchema }).strict(),
]);
export type AutomationIpcResponse = z.infer<typeof AutomationIpcResponseSchema>;
export const AUTOMATION_IPC_CHANNEL = "uclaw:automation";

export interface AutomationService {
  listAgents(): Promise<unknown>; getAgentIdentity(input: { agentId: string }): Promise<unknown>;
  createAgent(input: z.infer<typeof AgentCreate>): Promise<unknown>; updateAgent(input: z.infer<typeof AgentUpdate>): Promise<unknown>; deleteAgent(input: { agentId: string; deleteFiles?: boolean }): Promise<unknown>;
  listAgentFiles(input: { agentId: string }): Promise<unknown>; getAgentFile(input: { agentId: string; path: string }): Promise<unknown>; writeAgentFile(input: { agentId: string; path: string; content: string }): Promise<unknown>;
  listAgentWorkspace(input: { agentId: string; path?: string }): Promise<unknown>; getAgentWorkspace(input: { agentId: string; path: string }): Promise<unknown>;
  listCron(): Promise<unknown>; getCronStatus(): Promise<unknown>; getCron(input: { jobId: string }): Promise<unknown>;
  addCron(input: z.infer<typeof CronCreate>): Promise<unknown>; updateCron(input: z.infer<typeof CronUpdate>): Promise<unknown>; removeCron(input: { jobId: string }): Promise<unknown>;
  runCron(input: { jobId: string }): Promise<unknown>; listCronRuns(input: { jobId?: string; limit?: number }): Promise<unknown>;
}
