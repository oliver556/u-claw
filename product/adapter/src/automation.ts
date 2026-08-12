import { z } from "zod";
import { RpcProtocolError, type JsonValue } from "./transport/rpc-router.js";

export interface AutomationService {
  listAgents(): Promise<unknown>; getAgentIdentity(input: { agentId: string }): Promise<unknown>;
  createAgent(input: { name: string; workspace: string; model?: string }): Promise<unknown>; updateAgent(input: { agentId: string; name?: string; workspace?: string; model?: string }): Promise<unknown>; deleteAgent(input: { agentId: string; deleteFiles?: boolean }): Promise<unknown>;
  listAgentFiles(input: { agentId: string }): Promise<unknown>; getAgentFile(input: { agentId: string; path: string }): Promise<unknown>; writeAgentFile(input: { agentId: string; path: string; content: string }): Promise<unknown>;
  listAgentWorkspace(input: { agentId: string; path?: string }): Promise<unknown>; getAgentWorkspace(input: { agentId: string; path: string }): Promise<unknown>;
  listCron(): Promise<unknown>; getCronStatus(): Promise<unknown>; getCron(input: { jobId: string }): Promise<unknown>;
  addCron(input: { name: string; enabled: boolean; schedule: Record<string, unknown>; payload: Record<string, unknown>; agentId?: string }): Promise<unknown>; updateCron(input: { jobId: string; name?: string; enabled?: boolean; schedule?: Record<string, unknown>; payload?: Record<string, unknown>; agentId?: string }): Promise<unknown>; removeCron(input: { jobId: string }): Promise<unknown>;
  runCron(input: { jobId: string }): Promise<unknown>; listCronRuns(input: { jobId?: string; limit?: number }): Promise<unknown>;
}

export interface AutomationRouter { request<T>(method: string, params: JsonValue, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T>; }
export interface OpenClawAutomationOptions { request?<T>(method: string, params: JsonValue, schema: z.ZodType<T>): Promise<T>; router?: AutomationRouter; requireMethod(method: string): void; }
const Any = z.unknown();
const ObjectValue = z.record(z.string(), z.unknown());

function object(value: unknown, method: string): Record<string, unknown> {
  const parsed = ObjectValue.safeParse(value);
  if (!parsed.success) throw new RpcProtocolError(method);
  return parsed.data;
}

function project(method: string, value: unknown): unknown {
  const root = object(value, method);
  if (method === "agents.list") return { agents: z.array(ObjectValue).parse(root.agents).map((agent) => ({ id: z.string().parse(agent.id), ...(typeof agent.name === "string" ? { name: agent.name } : {}), ...(typeof agent.workspace === "string" ? { workspace: agent.workspace } : {}), ...(typeof agent.model === "string" ? { model: agent.model } : agent.model && typeof agent.model === "object" && typeof (agent.model as { primary?: unknown }).primary === "string" ? { model: (agent.model as { primary: string }).primary } : {}) })) };
  if (method === "agent.identity.get") return { agentId: z.string().parse(root.agentId), ...(typeof root.name === "string" ? { name: root.name } : {}), ...(typeof root.emoji === "string" ? { emoji: root.emoji } : {}), ...(typeof root.avatar === "string" && !root.avatar.startsWith("file:") && !root.avatar.startsWith("/") ? { avatar: root.avatar } : {}) };
  if (method === "agents.files.list") return { files: z.array(ObjectValue).parse(root.files).map((file) => ({ name: z.string().parse(file.name), path: z.string().parse(file.name), ...(typeof file.missing === "boolean" ? { missing: file.missing } : {}), ...(typeof file.size === "number" ? { size: file.size } : {}), ...(typeof file.updatedAtMs === "number" ? { updatedAtMs: file.updatedAtMs } : {}) })) };
  if (method === "agents.files.get") { const file = object(root.file, method); return { file: { name: z.string().parse(file.name), path: z.string().parse(file.name), ...(typeof file.missing === "boolean" ? { missing: file.missing } : {}), ...(typeof file.size === "number" ? { size: file.size } : {}), ...(typeof file.updatedAtMs === "number" ? { updatedAtMs: file.updatedAtMs } : {}), ...(typeof file.content === "string" ? { content: file.content } : {}) } }; }
  if (method === "agents.workspace.list") return { path: typeof root.path === "string" ? root.path : "", ...(typeof root.parentPath === "string" ? { parentPath: root.parentPath } : {}), entries: z.array(ObjectValue).parse(root.entries).map((entry) => ({ path: z.string().parse(entry.path), name: z.string().parse(entry.name), kind: z.enum(["file", "directory"]).parse(entry.kind), ...(typeof entry.size === "number" ? { size: entry.size } : {}), ...(typeof entry.updatedAtMs === "number" ? { updatedAtMs: entry.updatedAtMs } : {}) })) };
  if (method === "agents.workspace.get") { const file = object(root.file, method); return { entry: { path: z.string().parse(file.path), name: z.string().parse(file.name), kind: "file", ...(typeof file.size === "number" ? { size: file.size } : {}), ...(typeof file.updatedAtMs === "number" ? { updatedAtMs: file.updatedAtMs } : {}), ...(typeof file.mimeType === "string" ? { mimeType: file.mimeType } : {}), ...(typeof file.content === "string" ? { content: file.content } : {}) } }; }
  const cronJob = (job: Record<string, unknown>) => ({ id: z.string().parse(job.id), enabled: z.boolean().parse(job.enabled), schedule: job.schedule && typeof job.schedule === "object" && (job.schedule as { kind?: unknown }).kind === "cron" ? { ...(job.schedule as Record<string, unknown>), expression: String((job.schedule as { expr?: unknown }).expr ?? "") } : job.schedule, payload: job.payload, ...(typeof job.name === "string" ? { name: job.name } : {}), ...(typeof job.displayName === "string" ? { displayName: job.displayName } : {}), ...(typeof job.agentId === "string" ? { agentId: job.agentId } : {}), ...(job.state && typeof job.state === "object" ? { state: job.state } : {}) });
  if (method === "cron.list") return { jobs: z.array(ObjectValue).parse(root.jobs).map(cronJob) };
  if (method === "cron.get") return { job: cronJob(root) };
  if (method === "cron.status") return { enabled: root.enabled === true, ...(typeof root.jobs === "number" ? { jobCount: root.jobs } : {}), ...(typeof root.jobCount === "number" ? { jobCount: root.jobCount } : {}), ...(typeof root.nextWakeAtMs === "number" ? { nextWakeAtMs: root.nextWakeAtMs } : {}) };
  if (method === "cron.runs") return { runs: Array.isArray(root.runs) ? root.runs : Array.isArray(root.entries) ? root.entries : [] };
  return root;
}

export function createOpenClawAutomationService(options: OpenClawAutomationOptions): AutomationService {
  const request = async (method: string, params: Record<string, unknown>) => {
    options.requireMethod(method);
    const value = options.request ? await options.request(method, params as JsonValue, Any) : await options.router!.request(method, params as JsonValue, Any);
    try { return project(method, value); } catch (error) { if (error instanceof RpcProtocolError) throw error; throw new RpcProtocolError(method); }
  };
  const listAgents = () => request("agents.list", {});
  const listCron = () => request("cron.list", {});
  return {
    listAgents, getAgentIdentity: (p) => request("agent.identity.get", p),
    createAgent: async (p) => { await request("agents.create", p); return listAgents(); },
    updateAgent: async (p) => { await request("agents.update", p); return listAgents(); },
    deleteAgent: async (p) => { await request("agents.delete", { ...p, deleteFiles: p.deleteFiles ?? false }); return listAgents(); },
    listAgentFiles: (p) => request("agents.files.list", p), getAgentFile: (p) => request("agents.files.get", { agentId: p.agentId, name: p.path }),
    writeAgentFile: async (p) => { await request("agents.files.set", { agentId: p.agentId, name: p.path, content: p.content }); return request("agents.files.get", { agentId: p.agentId, name: p.path }); },
    listAgentWorkspace: (p) => request("agents.workspace.list", p), getAgentWorkspace: (p) => request("agents.workspace.get", p),
    listCron, getCronStatus: () => request("cron.status", {}), getCron: (p) => request("cron.get", p),
    addCron: async (p) => { const schedule = p.schedule.kind === "cron" ? { ...p.schedule, expr: p.schedule.expression, expression: undefined } : p.schedule; await request("cron.add", { ...p, schedule, displayName: p.name }); return listCron(); },
    updateCron: async ({ jobId, ...patch }) => { const schedule = patch.schedule?.kind === "cron" ? { ...patch.schedule, expr: patch.schedule.expression, expression: undefined } : patch.schedule; await request("cron.update", { id: jobId, patch: { ...patch, ...(schedule ? { schedule } : {}), ...(patch.name ? { displayName: patch.name } : {}) } }); return listCron(); },
    removeCron: async (p) => { await request("cron.remove", p); return listCron(); },
    runCron: (p) => request("cron.run", { ...p, mode: "force" }), listCronRuns: (p) => request("cron.runs", p),
  };
}
