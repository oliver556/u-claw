import {
  ExecApprovalRequestSchema,
  MessageSchema,
  PluginApprovalRequestSchema,
  ToolCallSchema,
  type ExecApprovalRequest,
  type Message,
  type PluginApprovalRequest,
  type ToolCall,
} from "@uclaw/shared";
import { z } from "zod";

const JsonRecordSchema = z.record(z.string(), z.unknown());
const GatewayErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.unknown().optional(),
}).passthrough();
const SuccessFrameSchema = z.object({
  type: z.literal("res"),
  id: z.string().min(1),
  ok: z.literal(true),
  payload: z.unknown(),
}).passthrough();
const FailureFrameSchema = z.object({
  type: z.literal("res"),
  id: z.string().min(1),
  ok: z.literal(false),
  error: GatewayErrorSchema,
}).passthrough();
const ResponseFrameSchema = z.union([SuccessFrameSchema, FailureFrameSchema]);
const RequestFrameSchema = z.object({
  type: z.literal("req"),
  id: z.string().min(1),
  method: z.string().min(1),
  params: JsonRecordSchema,
}).passthrough();

const OpenClawRecordSchema = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().min(1).optional(),
  recordTimestampMs: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
}).passthrough();
const OpenClawContentBlockSchema = z.object({ type: z.string().min(1) }).passthrough();

export const OpenClawHistoryMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool", "toolResult"]),
  content: z.union([z.string(), z.array(OpenClawContentBlockSchema)]),
  timestamp: z.number().int().nonnegative(),
  provider: z.string().optional(),
  model: z.string().optional(),
  MediaPath: z.string().optional(),
  MediaPaths: z.array(z.string()).optional(),
  MediaType: z.string().optional(),
  MediaTypes: z.array(z.string()).optional(),
  __openclaw: OpenClawRecordSchema,
}).passthrough();

export const OpenClawHistoryResponseSchema = z.object({
  sessionKey: z.string().min(1),
  sessionId: z.string().min(1),
  messages: z.array(OpenClawHistoryMessageSchema),
}).passthrough();

export const OpenClawHistoryFixtureSchema = z.object({
  requestFrame: RequestFrameSchema,
  responseFrame: SuccessFrameSchema.extend({ payload: OpenClawHistoryResponseSchema }),
}).strict();

export const OpenClawMessageGetResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), message: OpenClawHistoryMessageSchema }).passthrough(),
  z.object({ ok: z.literal(false), unavailableReason: z.string().min(1) }).passthrough(),
]);

const MessageGetCaseSchema = z.object({
  requestFrame: RequestFrameSchema,
  responseFrame: SuccessFrameSchema.extend({ payload: OpenClawMessageGetResponseSchema }),
}).strict();

export const OpenClawMessageGetFixtureSchema = z.object({
  success: MessageGetCaseSchema,
  unavailable: MessageGetCaseSchema,
}).strict();

const ApprovalDecisionSchema = z.enum(["allow-once", "allow-always", "deny"]);
const NullableOptionalString = z.string().nullable().optional();
const ApprovalEventBaseSchema = z.object({
  id: z.string().min(1),
  createdAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().nonnegative(),
});

export const OpenClawExecApprovalEventSchema = ApprovalEventBaseSchema.extend({
  request: z.object({
    command: z.string().min(1).optional(),
    commandArgv: z.array(z.string()).optional(),
    cwd: NullableOptionalString,
    host: NullableOptionalString,
    security: NullableOptionalString,
    warningText: NullableOptionalString,
    toolCallId: NullableOptionalString,
    allowedDecisions: z.array(ApprovalDecisionSchema).optional(),
    sessionKey: NullableOptionalString,
  }).passthrough(),
}).passthrough();

export const OpenClawPluginApprovalEventSchema = ApprovalEventBaseSchema.extend({
  request: z.object({
    pluginId: NullableOptionalString,
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    severity: z.enum(["info", "warning", "critical"]).nullable().optional(),
    toolName: NullableOptionalString,
    toolCallId: NullableOptionalString,
    allowedDecisions: z.array(ApprovalDecisionSchema).optional(),
    sessionKey: NullableOptionalString,
  }).passthrough(),
}).passthrough();

const ApprovalEventFrameSchema = <T extends z.ZodTypeAny>(event: string, payload: T) => z.object({
  type: z.literal("event"),
  event: z.literal(event),
  payload,
}).passthrough();
const ResolutionSchema = z.object({
  requestFrame: RequestFrameSchema,
  responseFrame: ResponseFrameSchema,
}).passthrough();
const ApprovalCaseSchema = <T extends z.ZodTypeAny>(event: string, payload: T) => z.object({
  event: ApprovalEventFrameSchema(event, payload),
  listing: ResolutionSchema,
  resolution: ResolutionSchema,
}).passthrough();

export const OpenClawApprovalsFixtureSchema = z.object({
  exec: z.object({
    allowOnce: ApprovalCaseSchema("exec.approval.requested", OpenClawExecApprovalEventSchema),
    deny: ApprovalCaseSchema("exec.approval.requested", OpenClawExecApprovalEventSchema),
    unavailable: ApprovalCaseSchema("exec.approval.requested", OpenClawExecApprovalEventSchema),
  }).strict(),
  plugin: z.object({
    allowOnce: ApprovalCaseSchema("plugin.approval.requested", OpenClawPluginApprovalEventSchema),
    deny: ApprovalCaseSchema("plugin.approval.requested", OpenClawPluginApprovalEventSchema),
    unavailable: ApprovalCaseSchema("plugin.approval.requested", OpenClawPluginApprovalEventSchema),
  }).strict(),
}).strict();

export const OpenClawSessionToolPayloadSchema = z.object({
  runId: z.string().min(1),
  data: z.object({
    phase: z.enum(["start", "result"]),
    name: z.string().min(1),
    toolCallId: z.string().min(1),
    args: z.unknown().optional(),
    isError: z.boolean().optional(),
    result: z.unknown().optional(),
  }).passthrough(),
  sessionKey: z.string().min(1),
  ts: z.number().int().nonnegative(),
}).passthrough();

export const OpenClawSessionToolEventSchema = z.object({
  type: z.literal("event"),
  event: z.literal("session.tool"),
  payload: OpenClawSessionToolPayloadSchema,
}).passthrough();

export const OpenClawSessionToolFixtureSchema = z.object({
  start: OpenClawSessionToolEventSchema,
  result: OpenClawSessionToolEventSchema,
}).strict();

const PatchCaseSchema = z.object({ requestFrame: RequestFrameSchema, responseFrame: ResponseFrameSchema }).strict();
export const OpenClawSessionsPatchFixtureSchema = z.object({
  rename: PatchCaseSchema,
  model: PatchCaseSchema,
  modelReadback: PatchCaseSchema,
  baseHash: PatchCaseSchema,
  duplicateLabel: PatchCaseSchema,
}).strict();

const AttachmentSchema = z.object({
  type: z.enum(["image", "file"]),
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  content: z.string(),
}).passthrough();
const AttachmentCaseSchema = z.object({
  kind: z.enum(["image", "text", "oversized", "mime-mismatch"]),
  requestFrame: RequestFrameSchema.extend({
    method: z.literal("chat.send"),
    params: z.object({ attachments: z.array(AttachmentSchema).length(1) }).passthrough(),
  }),
  responseFrame: ResponseFrameSchema,
}).strict();
export const OpenClawAttachmentFixtureSchema = z.object({ cases: z.array(AttachmentCaseSchema) }).strict();

function toIso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function contentBlocks(message: z.infer<typeof OpenClawHistoryMessageSchema>) {
  if (typeof message.content === "string") {
    return [{ id: `${message.__openclaw.id}:text`, type: "text" as const, text: message.content, format: "plain" as const }];
  }
  return message.content.map((block, index) => {
    if (block.type === "text" && typeof block.text === "string") {
      return { id: `${message.__openclaw.id}:${index}`, type: "text" as const, text: block.text, format: "markdown" as const };
    }
    if (block.type === "toolCall" && typeof block.id === "string") {
      return { id: `${message.__openclaw.id}:${index}`, type: "tool-call" as const, toolCallId: block.id };
    }
    return { id: `${message.__openclaw.id}:${index}`, type: "unsupported" as const, originalType: block.type, summary: "Unsupported OpenClaw content" };
  });
}

export function mapOpenClawHistoryMessage(sessionKey: string, input: z.input<typeof OpenClawHistoryMessageSchema>): Message {
  const message = OpenClawHistoryMessageSchema.parse(input);
  return MessageSchema.parse({
    id: message.__openclaw.id,
    sessionId: sessionKey,
    role: message.role === "toolResult" ? "tool" : message.role,
    status: "completed",
    blocks: contentBlocks(message),
    createdAt: toIso(message.timestamp),
    ...(message.model ? { model: { id: message.model, label: message.model, ...(message.provider ? { providerId: message.provider } : {}) } } : {}),
  });
}

export function mapOpenClawHistoryResponse(input: z.input<typeof OpenClawHistoryResponseSchema>): Message[] {
  const response = OpenClawHistoryResponseSchema.parse(input);
  return response.messages.map((message) => mapOpenClawHistoryMessage(response.sessionKey, message));
}

export function mapOpenClawMessageGetResponse(
  input: z.input<typeof OpenClawMessageGetResponseSchema>,
  sessionKey?: string,
): Message | undefined {
  const response = OpenClawMessageGetResponseSchema.parse(input);
  if (!response.ok) return undefined;
  return mapOpenClawHistoryMessage(sessionKey ?? response.message.__openclaw.id, response.message);
}

function approvalChoices(decisions: readonly z.infer<typeof ApprovalDecisionSchema>[] | undefined) {
  return (decisions ?? ["allow-once", "deny"]).filter(
    (decision): decision is "allow-once" | "deny" => decision === "allow-once" || decision === "deny",
  );
}

export function mapOpenClawExecApproval(input: unknown): ExecApprovalRequest {
  const wrapped = ApprovalEventFrameSchema("exec.approval.requested", OpenClawExecApprovalEventSchema).safeParse(input);
  const event = OpenClawExecApprovalEventSchema.parse(wrapped.success ? wrapped.data.payload : input);
  const command = event.request.command ?? event.request.commandArgv?.join(" ") ?? "OpenClaw command";
  return ExecApprovalRequestSchema.parse({
    id: event.id,
    family: "exec",
    ...(event.request.sessionKey ? { sessionId: event.request.sessionKey } : {}),
    subject: { kind: "operation", id: event.id },
    title: "Approve command",
    description: command,
    risk: event.request.warningText ? "high" : "medium",
    permissions: [{ kind: "process", scope: event.request.cwd ?? event.request.host ?? "gateway", description: "Execute command" }],
    choices: approvalChoices(event.request.allowedDecisions),
    expiresAt: toIso(event.expiresAtMs),
    status: "pending",
    ...(event.request.toolCallId ? { toolCallId: event.request.toolCallId } : {}),
  });
}

export function mapOpenClawPluginApproval(input: unknown): PluginApprovalRequest {
  const wrapped = ApprovalEventFrameSchema("plugin.approval.requested", OpenClawPluginApprovalEventSchema).safeParse(input);
  const event = OpenClawPluginApprovalEventSchema.parse(wrapped.success ? wrapped.data.payload : input);
  const pluginId = event.request.pluginId ?? "unknown-plugin";
  const description = event.request.description ?? "OpenClaw plugin operation";
  return PluginApprovalRequestSchema.parse({
    id: event.id,
    family: "plugin",
    ...(event.request.sessionKey ? { sessionId: event.request.sessionKey } : {}),
    subject: { kind: "plugin", id: pluginId },
    title: event.request.title ?? "Approve plugin operation",
    description,
    risk: event.request.severity === "critical" ? "critical" : event.request.severity === "warning" ? "high" : "medium",
    permissions: [{ kind: "other", scope: event.request.toolName ?? pluginId, description }],
    choices: approvalChoices(event.request.allowedDecisions),
    expiresAt: toIso(event.expiresAtMs),
    status: "pending",
  });
}

export function mapOpenClawSessionToolEvent(input: unknown): ToolCall {
  const wrapped = OpenClawSessionToolEventSchema.safeParse(input);
  const event = OpenClawSessionToolPayloadSchema.parse(wrapped.success ? wrapped.data.payload : input);
  const failed = event.data.phase === "result" && event.data.isError === true;
  return ToolCallSchema.parse({
    id: event.data.toolCallId,
    sessionId: event.sessionKey,
    runId: event.runId,
    toolId: event.data.name,
    displayName: event.data.name,
    state: event.data.phase === "start" ? "running" : failed ? "failed" : "succeeded",
    risk: "unknown",
    ...(event.data.phase === "start" ? { startedAt: toIso(event.ts) } : { finishedAt: toIso(event.ts) }),
    ...(failed ? { error: { code: "OPERATION_FAILED", message: "OpenClaw tool call failed", retryable: false } } : {}),
  });
}

export function mapOpenClawAttachmentEvidence(input: z.input<typeof AttachmentCaseSchema>) {
  const fixture = AttachmentCaseSchema.parse(input);
  const attachment = fixture.requestFrame.params.attachments[0];
  const decodedBytes = Buffer.from(attachment.content, "base64").byteLength;
  return {
    kind: fixture.kind,
    outcome: fixture.responseFrame.ok ? "accepted" as const : "rejected" as const,
    decodedBytes,
    ...(!fixture.responseFrame.ok ? { error: fixture.responseFrame.error } : {}),
  };
}

export function mapOpenClawSessionsPatchEvidence(input: z.input<typeof OpenClawSessionsPatchFixtureSchema>) {
  const fixture = OpenClawSessionsPatchFixtureSchema.parse(input);
  const modelPayload = fixture.model.responseFrame.ok ? z.object({
    entry: z.object({
      providerOverride: z.string().min(1),
      modelOverride: z.string().min(1),
      modelOverrideSource: z.string().min(1),
    }).passthrough(),
    resolved: z.object({ model: z.string(), modelProvider: z.string() }).passthrough(),
  }).passthrough().parse(fixture.model.responseFrame.payload) : undefined;
  const readback = fixture.modelReadback.responseFrame.ok ? z.object({
    sessions: z.array(z.object({
      key: z.string().min(1),
      modelProvider: z.string().min(1),
      model: z.string().min(1),
    }).passthrough()).min(1),
  }).passthrough().parse(fixture.modelReadback.responseFrame.payload).sessions[0] : undefined;
  const baseHashError = fixture.baseHash.responseFrame.ok ? undefined : fixture.baseHash.responseFrame.error;
  return {
    renamed: fixture.rename.responseFrame.ok,
    providerOverride: modelPayload?.entry.providerOverride,
    modelOverride: modelPayload?.entry.modelOverride,
    modelOverrideSource: modelPayload?.entry.modelOverrideSource,
    readbackModelProvider: readback?.modelProvider,
    readbackModel: readback?.model,
    duplicateLabelConflict: fixture.duplicateLabel.responseFrame.ok ? undefined : fixture.duplicateLabel.responseFrame.error.code,
    baseHashAccepted: fixture.baseHash.responseFrame.ok,
    baseHashErrorCode: baseHashError?.code,
    baseHashErrorMessage: baseHashError?.message,
  };
}
