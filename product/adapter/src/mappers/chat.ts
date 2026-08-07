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

const KnownRawBlockSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string().min(1), type: z.literal("text"), text: z.string(), format: z.enum(["plain", "markdown"]) }).strict(),
  z.object({ id: z.string().min(1), type: z.literal("code"), code: z.string(), language: z.string().optional(), filename: z.string().optional() }).strict(),
  z.object({ id: z.string().min(1), type: z.literal("tool-call"), toolCallId: z.string().min(1) }).strict(),
  z.object({ id: z.string().min(1), type: z.literal("notice"), level: z.enum(["info", "warning", "error"]), text: z.string() }).strict(),
]);

const knownBlockTypes = new Set(["text", "code", "tool-call", "notice"]);
const UnknownRawBlockSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1).refine((type) => !knownBlockTypes.has(type), "Known block must match its schema"),
}).strip().transform(({ id, type }) => ({ id, type }));

const RawBlockSchema = z.union([KnownRawBlockSchema, UnknownRawBlockSchema]);

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
  const known = KnownRawBlockSchema.safeParse(input);
  if (!known.success) {
    return { id: input.id, type: "unsupported", originalType: input.type, summary: "Unsupported content" };
  }
  const block = known.data;
  if (block.type === "text") {
    return { id: block.id, type: "text", text: block.text, format: block.format };
  }
  if (block.type === "code") {
    return {
      id: block.id,
      type: "code",
      code: block.code,
      ...(block.language === undefined ? {} : { language: block.language }),
      ...(block.filename === undefined ? {} : { filename: block.filename }),
    };
  }
  if (block.type === "tool-call") {
    return { id: block.id, type: "tool-call", toolCallId: block.toolCallId };
  }
  return { id: block.id, type: "notice", level: block.level, text: block.text };
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
