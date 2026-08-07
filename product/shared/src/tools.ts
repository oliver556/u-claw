import { z } from "zod";

import { ISODateTimeSchema, ResourceRefSchema } from "./common.js";
import { RendererSafeSummarySchema, UClawErrorSummarySchema } from "./errors.js";

export const ToolStateSchema = z.enum([
  "queued",
  "waiting-authorization",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type ToolState = z.infer<typeof ToolStateSchema>;

export const ToolRiskSchema = z.enum(["low", "medium", "high", "critical", "unknown"]);
export type ToolRisk = z.infer<typeof ToolRiskSchema>;

export const ToolCallSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    runId: z.string().min(1).optional(),
    messageId: z.string().min(1).optional(),
    toolId: z.string().min(1),
    displayName: z.string().min(1),
    state: ToolStateSchema,
    risk: ToolRiskSchema,
    inputSummary: RendererSafeSummarySchema.optional(),
    outputSummary: RendererSafeSummarySchema.optional(),
    startedAt: ISODateTimeSchema.optional(),
    finishedAt: ISODateTimeSchema.optional(),
    error: UClawErrorSummarySchema.optional(),
  })
  .strict();
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ApprovalPermissionSchema = z
  .object({
    kind: z.enum(["file-read", "file-write", "process", "network", "credential", "other"]),
    scope: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();
export type ApprovalPermission = z.infer<typeof ApprovalPermissionSchema>;

export const ApprovalDecisionSchema = z.enum(["allow-once", "allow-session", "deny"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

const ApprovalRequestBaseSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  subject: ResourceRefSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  risk: ToolRiskSchema,
  permissions: z.array(ApprovalPermissionSchema).min(1),
  choices: z.array(ApprovalDecisionSchema).min(1),
  expiresAt: ISODateTimeSchema.optional(),
  status: z.enum(["pending", "resolved", "expired", "cancelled"]),
}).strict();

export const ExecApprovalRequestSchema = ApprovalRequestBaseSchema.extend({
  family: z.literal("exec"),
  toolCallId: z.string().min(1).optional(),
}).strict();
export type ExecApprovalRequest = z.infer<typeof ExecApprovalRequestSchema>;

export const PluginApprovalRequestSchema = ApprovalRequestBaseSchema.extend({
  family: z.literal("plugin"),
  subject: ResourceRefSchema.extend({ kind: z.literal("plugin") }),
}).strict();
export type PluginApprovalRequest = z.infer<typeof PluginApprovalRequestSchema>;

export const ApprovalRequestSchema = z.discriminatedUnion("family", [
  ExecApprovalRequestSchema,
  PluginApprovalRequestSchema,
]);
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ExecApprovalRefSchema = z
  .object({ family: z.literal("exec"), id: z.string().min(1) })
  .strict();
export type ExecApprovalRef = z.infer<typeof ExecApprovalRefSchema>;

export const PluginApprovalRefSchema = z
  .object({ family: z.literal("plugin"), id: z.string().min(1) })
  .strict();
export type PluginApprovalRef = z.infer<typeof PluginApprovalRefSchema>;

export const ApprovalRefSchema = z.discriminatedUnion("family", [
  ExecApprovalRefSchema,
  PluginApprovalRefSchema,
]);
export type ApprovalRef = z.infer<typeof ApprovalRefSchema>;

export function toApprovalRef(request: ApprovalRequest): ApprovalRef {
  return ApprovalRefSchema.parse({ family: request.family, id: request.id });
}

export const ResolveExecApprovalInputSchema = z
  .object({
    ref: ExecApprovalRefSchema,
    decision: ApprovalDecisionSchema,
  })
  .strict();
export type ResolveExecApprovalInput = z.infer<typeof ResolveExecApprovalInputSchema>;

export const ResolvePluginApprovalInputSchema = z
  .object({
    ref: PluginApprovalRefSchema,
    decision: ApprovalDecisionSchema,
  })
  .strict();
export type ResolvePluginApprovalInput = z.infer<typeof ResolvePluginApprovalInputSchema>;
