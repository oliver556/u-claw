import {
  MessageEventSchema,
  MessageSchema,
  UClawErrorSchema,
  type ContentBlock,
  type Message,
  type MessageEvent,
} from "@uclaw/shared";
import { z } from "zod";

const ErrorSummarySchema = z.object({
  code: z.string().optional(),
  message: z.string().min(1),
}).strict();

const RawBlockSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  text: z.string().optional(),
  format: z.enum(["plain", "markdown"]).optional(),
  code: z.string().optional(),
  language: z.string().optional(),
  filename: z.string().optional(),
  toolCallId: z.string().min(1).optional(),
  level: z.enum(["info", "warning", "error"]).optional(),
}).strict();

export const RawMessageSchema = z.object({
  id: z.string().min(1),
  sessionKey: z.string().min(1),
  runId: z.string().min(1).optional(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  status: z.enum(["queued", "streaming", "waiting-authorization", "completed", "cancelled", "failed"]),
  blocks: z.array(RawBlockSchema),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1).optional(),
  model: z.object({ id: z.string().min(1), label: z.string().min(1), providerId: z.string().min(1).optional() }).strict().optional(),
  error: ErrorSummarySchema.optional(),
}).strict();

export const RawChatEventSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("delta"), runId: z.string().min(1), sessionKey: z.string().min(1), deltaText: z.string(), replace: z.boolean().optional() }).strict(),
  z.object({ state: z.literal("final"), runId: z.string().min(1), sessionKey: z.string().min(1), message: RawMessageSchema }).strict(),
  z.object({ state: z.literal("aborted"), runId: z.string().min(1), sessionKey: z.string().min(1), errorMessage: z.string().optional() }).strict(),
  z.object({ state: z.literal("error"), runId: z.string().min(1), sessionKey: z.string().min(1), errorKind: z.string().optional(), errorMessage: z.string().min(1).optional() }).strict(),
]);

function mapBlock(input: z.infer<typeof RawBlockSchema>): ContentBlock {
  if (input.type === "text") {
    return { id: input.id, type: "text", text: z.string().parse(input.text), format: z.enum(["plain", "markdown"]).parse(input.format) };
  }
  if (input.type === "code") {
    return {
      id: input.id,
      type: "code",
      code: z.string().parse(input.code),
      ...(typeof input.language === "string" ? { language: input.language } : {}),
      ...(typeof input.filename === "string" ? { filename: input.filename } : {}),
    };
  }
  if (input.type === "tool-call") {
    return { id: input.id, type: "tool-call", toolCallId: z.string().min(1).parse(input.toolCallId) };
  }
  if (input.type === "notice") {
    return {
      id: input.id,
      type: "notice",
      level: z.enum(["info", "warning", "error"]).parse(input.level),
      text: z.string().parse(input.text),
    };
  }
  return { id: input.id, type: "unsupported", originalType: input.type, summary: "Unsupported content" };
}

function errorCode(code: string | undefined): "TIMEOUT" | "CANCELLED" | "UNKNOWN" {
  if (code === "timeout") return "TIMEOUT";
  if (code === "cancelled" || code === "aborted") return "CANCELLED";
  return "UNKNOWN";
}

export function mapMessage(payload: z.input<typeof RawMessageSchema>): Message {
  const raw = RawMessageSchema.parse(payload);
  return MessageSchema.parse({
    id: raw.id,
    sessionId: raw.sessionKey,
    ...(raw.runId === undefined ? {} : { runId: raw.runId }),
    role: raw.role,
    status: raw.status,
    blocks: raw.blocks.map(mapBlock),
    createdAt: raw.createdAt,
    ...(raw.updatedAt === undefined ? {} : { updatedAt: raw.updatedAt }),
    ...(raw.model === undefined ? {} : { model: raw.model }),
    ...(raw.error === undefined ? {} : {
      error: { code: errorCode(raw.error.code), message: raw.error.message, retryable: raw.error.code === "timeout" },
    }),
  });
}

export function mapChatEvent(payload: z.input<typeof RawChatEventSchema>): MessageEvent {
  const raw = RawChatEventSchema.parse(payload);
  if (raw.state === "delta") {
    return MessageEventSchema.parse({ type: "delta", runId: raw.runId, mode: raw.replace === true ? "replace" : "append", text: raw.deltaText });
  }
  if (raw.state === "final") {
    return MessageEventSchema.parse({ type: "final", runId: raw.runId, message: mapMessage(raw.message) });
  }
  if (raw.state === "aborted") {
    return MessageEventSchema.parse({ type: "aborted", runId: raw.runId, ...(raw.errorMessage === undefined ? {} : { reason: raw.errorMessage }) });
  }
  return MessageEventSchema.parse({
    type: "error",
    runId: raw.runId,
    error: UClawErrorSchema.parse({
      code: errorCode(raw.errorKind),
      message: raw.errorMessage ?? "OpenClaw operation failed",
      retryable: raw.errorKind === "timeout" || raw.errorKind === "rate_limit",
      recoveryActions: raw.errorKind === "timeout" ? ["retry"] : [],
      causeDetails: {},
    }),
  });
}
