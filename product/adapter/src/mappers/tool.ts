import {
  ExecApprovalRequestSchema,
  PluginApprovalRequestSchema,
  ToolCallSchema,
  type ExecApprovalRequest,
  type PluginApprovalRequest,
  type RendererSafeValue,
  type ToolCall,
  type ToolState,
} from "@uclaw/shared";
import { z } from "zod";

const SafeValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))]);
const SummarySchema = z.record(z.string(), SafeValueSchema);

export const RawToolCallSchema = z.object({
  toolCallId: z.string().min(1),
  sessionKey: z.string().min(1),
  runId: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
  toolId: z.string().min(1),
  displayName: z.string().min(1),
  state: z.enum(["pending", "approval", "running", "done", "error", "aborted"]),
  risk: z.enum(["low", "medium", "high", "critical", "unknown"]),
  inputSummary: SummarySchema.optional(),
  outputSummary: SummarySchema.optional(),
  startedAt: z.string().min(1).optional(),
  finishedAt: z.string().min(1).optional(),
  errorMessage: z.string().min(1).optional(),
}).strict();

const PermissionSchema = z.object({
  kind: z.enum(["file-read", "file-write", "process", "network", "credential", "other"]),
  scope: z.string().min(1),
  description: z.string().min(1),
}).strict();

const ApprovalBase = {
  id: z.string().min(1),
  sessionKey: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().min(1),
  risk: z.enum(["low", "medium", "high", "critical", "unknown"]),
  permissions: z.array(PermissionSchema).min(1),
  choices: z.array(z.enum(["allow-once", "allow-session", "deny"])).min(1),
  expiresAt: z.string().min(1).optional(),
  status: z.enum(["pending", "resolved", "expired", "cancelled"]),
};

export const RawExecApprovalSchema = z.object({ ...ApprovalBase, toolCallId: z.string().min(1).optional() }).strict();
export const RawPluginApprovalSchema = z.object({ ...ApprovalBase, pluginId: z.string().min(1) }).strict();

function toolState(state: z.infer<typeof RawToolCallSchema>["state"]): ToolState {
  return ({ pending: "queued", approval: "waiting-authorization", running: "running", done: "succeeded", error: "failed", aborted: "cancelled" } as const)[state];
}

export function mapToolCall(payload: z.input<typeof RawToolCallSchema>): ToolCall {
  const raw = RawToolCallSchema.parse(payload);
  return ToolCallSchema.parse({
    id: raw.toolCallId,
    sessionId: raw.sessionKey,
    ...(raw.runId === undefined ? {} : { runId: raw.runId }),
    ...(raw.messageId === undefined ? {} : { messageId: raw.messageId }),
    toolId: raw.toolId,
    displayName: raw.displayName,
    state: toolState(raw.state),
    risk: raw.risk,
    ...(raw.inputSummary === undefined ? {} : { inputSummary: raw.inputSummary as Record<string, RendererSafeValue> }),
    ...(raw.outputSummary === undefined ? {} : { outputSummary: raw.outputSummary as Record<string, RendererSafeValue> }),
    ...(raw.startedAt === undefined ? {} : { startedAt: raw.startedAt }),
    ...(raw.finishedAt === undefined ? {} : { finishedAt: raw.finishedAt }),
    ...(raw.errorMessage === undefined ? {} : { error: { code: "OPERATION_FAILED", message: raw.errorMessage, retryable: false } }),
  });
}

export function mapExecApproval(payload: z.input<typeof RawExecApprovalSchema>): ExecApprovalRequest {
  const raw = RawExecApprovalSchema.parse(payload);
  const subjectId = raw.toolCallId ?? raw.id;
  return ExecApprovalRequestSchema.parse({
    id: raw.id,
    family: "exec",
    ...(raw.toolCallId === undefined ? {} : { toolCallId: raw.toolCallId }),
    ...(raw.sessionKey === undefined ? {} : { sessionId: raw.sessionKey }),
    subject: { kind: raw.toolCallId === undefined ? "operation" : "toolCall", id: subjectId },
    title: raw.title,
    description: raw.description,
    risk: raw.risk,
    permissions: raw.permissions,
    choices: raw.choices,
    ...(raw.expiresAt === undefined ? {} : { expiresAt: raw.expiresAt }),
    status: raw.status,
  });
}

export function mapPluginApproval(payload: z.input<typeof RawPluginApprovalSchema>): PluginApprovalRequest {
  const raw = RawPluginApprovalSchema.parse(payload);
  return PluginApprovalRequestSchema.parse({
    id: raw.id,
    family: "plugin",
    ...(raw.sessionKey === undefined ? {} : { sessionId: raw.sessionKey }),
    subject: { kind: "plugin", id: raw.pluginId },
    title: raw.title,
    description: raw.description,
    risk: raw.risk,
    permissions: raw.permissions,
    choices: raw.choices,
    ...(raw.expiresAt === undefined ? {} : { expiresAt: raw.expiresAt }),
    status: raw.status,
  });
}
