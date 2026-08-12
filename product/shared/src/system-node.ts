import { z } from "zod";
import { UClawErrorSchema } from "./errors.js";

const Id = z.string().trim().min(1).max(256);
const Empty = z.object({}).strict();
const DeviceId = z.object({ deviceId: Id }).strict();
const NodeId = z.object({ nodeId: Id }).strict();
const PairRequestId = z.object({ requestId: Id }).strict();
const WorktreeId = z.object({ id: Id }).strict();
const TerminalId = z.object({ sessionId: Id }).strict();
const TerminalSize = z.object({ cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) }).strict();
const NodeInvokeParams = z.record(z.string(), z.unknown()).refine(
  (value) => !("approved" in value) && !("approvalDecision" in value) && !("rawCommand" in value),
  "Node invoke approval controls are not accepted from the renderer",
);

export const SystemNodeIpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("device.pair.list"), requestId: Id, params: Empty }).strict(),
  z.object({ method: z.literal("device.pair.approve"), requestId: Id, params: PairRequestId }).strict(),
  z.object({ method: z.literal("device.pair.reject"), requestId: Id, params: PairRequestId }).strict(),
  z.object({ method: z.literal("device.pair.remove"), requestId: Id, params: DeviceId }).strict(),
  z.object({ method: z.literal("device.token.rotate"), requestId: Id, params: DeviceId.extend({ role: Id, scopes: z.array(Id).max(64).optional() }).strict() }).strict(),
  z.object({ method: z.literal("device.token.revoke"), requestId: Id, params: DeviceId.extend({ role: Id }).strict() }).strict(),
  z.object({ method: z.literal("node.list"), requestId: Id, params: Empty }).strict(),
  z.object({ method: z.literal("node.describe"), requestId: Id, params: NodeId }).strict(),
  z.object({ method: z.literal("node.rename"), requestId: Id, params: NodeId.extend({ displayName: z.string().trim().min(1).max(120) }).strict() }).strict(),
  z.object({ method: z.literal("node.pair.list"), requestId: Id, params: Empty }).strict(),
  z.object({ method: z.literal("node.pair.approve"), requestId: Id, params: PairRequestId }).strict(),
  z.object({ method: z.literal("node.pair.reject"), requestId: Id, params: PairRequestId }).strict(),
  z.object({ method: z.literal("node.pair.remove"), requestId: Id, params: NodeId }).strict(),
  z.object({ method: z.literal("node.invoke"), requestId: Id, params: NodeId.extend({ command: z.literal("system.info"), params: NodeInvokeParams.optional(), timeoutMs: z.number().int().positive().max(120_000).optional(), idempotencyKey: Id }).strict() }).strict(),
  z.object({ method: z.literal("environments.list"), requestId: Id, params: Empty }).strict(),
  z.object({ method: z.literal("environments.status"), requestId: Id, params: z.object({ environmentId: Id }).strict() }).strict(),
  z.object({ method: z.literal("worktrees.list"), requestId: Id, params: Empty }).strict(),
  z.object({ method: z.literal("worktrees.create"), requestId: Id, params: z.object({ repoRoot: z.string().trim().min(1).max(4096), name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(), baseRef: Id.optional() }).strict() }).strict(),
  z.object({ method: z.literal("worktrees.remove"), requestId: Id, params: WorktreeId.extend({ force: z.boolean().optional() }).strict() }).strict(),
  z.object({ method: z.literal("worktrees.restore"), requestId: Id, params: WorktreeId }).strict(),
  z.object({ method: z.literal("worktrees.gc"), requestId: Id, params: Empty }).strict(),
  z.object({ method: z.literal("terminal.list"), requestId: Id, params: Empty }).strict(),
  z.object({ method: z.literal("terminal.open"), requestId: Id, params: TerminalSize.extend({ agentId: Id.optional() }).strict() }).strict(),
  z.object({ method: z.literal("terminal.input"), requestId: Id, params: TerminalId.extend({ data: z.string().min(1).max(65_536) }).strict() }).strict(),
  z.object({ method: z.literal("terminal.resize"), requestId: Id, params: TerminalId.extend(TerminalSize.shape).strict() }).strict(),
  z.object({ method: z.literal("terminal.close"), requestId: Id, params: TerminalId }).strict(),
  z.object({ method: z.literal("terminal.attach"), requestId: Id, params: TerminalId }).strict(),
  z.object({ method: z.literal("terminal.text"), requestId: Id, params: TerminalId }).strict(),
]);
export type SystemNodeIpcRequest = z.infer<typeof SystemNodeIpcRequestSchema>;
export type SystemNodeMethod = SystemNodeIpcRequest["method"];

const SensitiveResultKey = /(?:^|[_-])(?:token|secret|password|credential|credentials|api[_-]?key|private[_-]?key|authorization|cookie|public[_-]?key|remote[_-]?ip)(?:$|[_-])/i;
function isRendererSafeResult(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isRendererSafeResult);
  if (!value || typeof value !== "object") return true;
  return Object.entries(value).every(([key, entry]) => !SensitiveResultKey.test(key) && isRendererSafeResult(entry));
}
const RendererSafeResult = z.unknown().refine(isRendererSafeResult, "Sensitive Gateway result cannot cross renderer IPC");
export const SystemNodeIpcResponseSchema = z.union([
  z.object({ method: z.string(), requestId: Id, ok: z.literal(true), result: RendererSafeResult }).strict(),
  z.object({ method: z.string(), requestId: Id, ok: z.literal(false), error: UClawErrorSchema }).strict(),
]);
export type SystemNodeIpcResponse = z.infer<typeof SystemNodeIpcResponseSchema>;

const PairResolved = z.object({ requestId: z.string().max(256), decision: Id, ts: z.number().int().nonnegative() });
export const SystemNodeIpcEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("device.pair.requested"), payload: z.object({ requestId: Id, deviceId: Id }) }).strict(),
  z.object({ event: z.literal("device.pair.resolved"), payload: PairResolved.extend({ deviceId: Id }) }).strict(),
  z.object({ event: z.literal("node.pair.requested"), payload: z.object({ requestId: Id, nodeId: Id }) }).strict(),
  z.object({ event: z.literal("node.pair.resolved"), payload: PairResolved.extend({ nodeId: Id }) }).strict(),
  z.object({ event: z.literal("terminal.data"), payload: z.object({ sessionId: Id, seq: z.number().int().nonnegative(), data: z.string() }).strict() }).strict(),
  z.object({ event: z.literal("terminal.exit"), payload: z.object({ sessionId: Id, exitCode: z.number().int().nullable().optional(), signal: z.number().int().nullable().optional(), reason: Id.optional(), error: z.string().optional() }).strict() }).strict(),
]);
export type SystemNodeIpcEvent = z.infer<typeof SystemNodeIpcEventSchema>;
export const SYSTEM_NODE_IPC_CHANNEL = "uclaw:system-node";
export const SYSTEM_NODE_IPC_EVENT_CHANNEL = "uclaw:system-node-event";

type Params<M extends SystemNodeMethod> = Extract<SystemNodeIpcRequest, { method: M }>["params"];
export interface SystemNodeService {
  listDevices(): Promise<unknown>; approveDevice(input: Params<"device.pair.approve">): Promise<unknown>; rejectDevice(input: Params<"device.pair.reject">): Promise<unknown>; removeDevice(input: Params<"device.pair.remove">): Promise<unknown>;
  rotateDeviceToken(input: Params<"device.token.rotate">): Promise<unknown>; revokeDeviceToken(input: Params<"device.token.revoke">): Promise<unknown>;
  listNodes(): Promise<unknown>; describeNode(input: Params<"node.describe">): Promise<unknown>; renameNode(input: Params<"node.rename">): Promise<unknown>;
  listNodePairs(): Promise<unknown>; approveNodePair(input: Params<"node.pair.approve">): Promise<unknown>; rejectNodePair(input: Params<"node.pair.reject">): Promise<unknown>; removeNodePair(input: Params<"node.pair.remove">): Promise<unknown>; invokeNode(input: Params<"node.invoke">): Promise<unknown>;
  listEnvironments(): Promise<unknown>; getEnvironmentStatus(input: Params<"environments.status">): Promise<unknown>;
  listWorktrees(): Promise<unknown>; createWorktree(input: Params<"worktrees.create">): Promise<unknown>; removeWorktree(input: Params<"worktrees.remove">): Promise<unknown>; restoreWorktree(input: Params<"worktrees.restore">): Promise<unknown>; gcWorktrees(): Promise<unknown>;
  listTerminals(): Promise<unknown>; openTerminal(input: Params<"terminal.open">): Promise<unknown>; inputTerminal(input: Params<"terminal.input">): Promise<unknown>; resizeTerminal(input: Params<"terminal.resize">): Promise<unknown>; closeTerminal(input: Params<"terminal.close">): Promise<unknown>; attachTerminal(input: Params<"terminal.attach">): Promise<unknown>; getTerminalText(input: Params<"terminal.text">): Promise<unknown>;
  subscribe(listener: (event: SystemNodeIpcEvent) => void): () => void;
}
