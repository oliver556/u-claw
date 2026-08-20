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
  z.object({ id: z.string().min(1), type: z.literal("image"), url: z.string().min(1), mimeType: z.string().min(1), alt: z.string().optional() }).strict(),
  z.object({ id: z.string().min(1), type: z.literal("tool-call"), toolCallId: z.string().min(1) }).strict(),
  z.object({ id: z.string().min(1), type: z.literal("notice"), level: z.enum(["info", "warning", "error"]), text: z.string() }).strict(),
]);

const knownBlockTypes = new Set(["text", "code", "image", "tool-call", "notice"]);
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

function mapBlock(input: z.infer<typeof RawBlockSchema>, gatewayOrigin?: string): ContentBlock {
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
  if (block.type === "image") {
    return {
      id: block.id,
      type: "image",
      file: { id: block.id, name: block.alt ?? "生成的图片", mediaType: block.mimeType, size: 0, kind: "artifact" },
      ...(block.alt === undefined ? {} : { alt: block.alt }),
      ...(gatewayOrigin === undefined ? {} : { sourceUrl: `${gatewayOrigin}${block.url}` }),
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

export function mapCanonicalMessage(input: {
  id: string;
  sessionId: string;
  role: Message["role"];
  status: Message["status"];
  blocks: ContentBlock[];
  createdAt: string;
  updatedAt?: string;
  model?: Message["model"];
  error?: Message["error"];
}): Message {
  return MessageSchema.parse({
    ...input,
    blocks: input.blocks.map((block) => block.type === "text" && input.role === "assistant"
      ? { ...block, format: "markdown" as const }
      : block),
  });
}

export function mapMessage(payload: z.input<typeof RawMessageSchema>, gatewayOrigin?: string): Message {
  const raw = RawMessageSchema.parse(payload);
  return mapCanonicalMessage({
    id: raw.id,
    sessionId: raw.sessionKey,
    role: raw.role,
    status: raw.status,
    blocks: raw.blocks.map((block) => mapBlock(block, gatewayOrigin)),
    createdAt: raw.createdAt,
    ...(raw.updatedAt === undefined ? {} : { updatedAt: raw.updatedAt }),
    ...(raw.model === undefined ? {} : { model: raw.model }),
    ...(raw.error === undefined ? {} : {
      error: { code: errorCode(raw.error.code), message: raw.error.message, retryable: raw.error.code === "timeout" },
    }),
  });
}

export function mapChatEvent(payload: z.input<typeof RawChatEventSchema>, gatewayOrigin?: string): MessageEvent {
  const raw = RawChatEventSchema.parse(payload);
  if (raw.state === "delta") {
    return MessageEventSchema.parse({ type: "delta", runId: raw.runId, mode: raw.replace === true ? "replace" : "append", text: raw.deltaText });
  }
  if (raw.state === "final") {
    return MessageEventSchema.parse({ type: "final", runId: raw.runId, message: mapMessage(raw.message, gatewayOrigin) });
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
