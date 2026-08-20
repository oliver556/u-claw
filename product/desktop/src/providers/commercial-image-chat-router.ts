import {
  MessageEventSchema,
  UClawErrorSchema,
  type Message,
  type MessageEvent,
  type SendMessageInput,
} from "@uclaw/shared";

const COMMERCIAL_IMAGE_MODEL = "uclaw-commercial/gpt-image-2";

interface CommercialImageChatClient {
  chat: {
    list(sessionId: string): Promise<{ items: Message[]; hasMore: boolean }>;
    send(input: SendMessageInput, signal?: AbortSignal): AsyncIterable<MessageEvent>;
    injectAssistant(sessionId: string, message: string, label: "uclaw-commercial-image-v1", signal?: AbortSignal): Promise<void>;
  };
  imageInference: {
    infer(input: {
      prompt: string;
      model: string;
      clientRequestId: string;
      image?: string;
    }, signal?: AbortSignal): Promise<{ path: string; mimeType: string; size: number }>;
  };
  sessionModel?(sessionId: string): Promise<string | undefined>;
}

const IMAGE_WAIT_TIMEOUT_MS = 180_000;
const IMAGE_POLL_INTERVAL_MS = 500;

function controlledAssistantMediaPath(sourceUrl: string | undefined): string | undefined {
  if (sourceUrl === undefined) return undefined;
  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !/^\d+$/u.test(url.port)
      || url.pathname !== "/__openclaw__/assistant-media") return undefined;
    const source = url.searchParams.get("source")?.trim();
    if (source === undefined || source === "" || source.includes("\0")) return undefined;
    if (!source.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(source)) return undefined;
    return source;
  } catch {
    return undefined;
  }
}

function latestHistoryImage(messages: readonly Message[]): string | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]!;
    if (message.role !== "assistant" || message.status !== "completed") continue;
    for (let blockIndex = message.blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = message.blocks[blockIndex]!;
      if (block.type !== "image") continue;
      const source = controlledAssistantMediaPath(block.sourceUrl);
      if (source !== undefined) return source;
    }
  }
  return undefined;
}

function assistantImageMessageIds(messages: readonly Message[]): Set<string> {
  return new Set(messages.filter((message) => message.role === "assistant"
    && message.status === "completed"
    && message.blocks.some((block) => block.type === "image")).map((message) => message.id));
}

function latestNewImageMessage(messages: readonly Message[], previousIds: ReadonlySet<string>): Message | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (previousIds.has(message.id) || message.role !== "assistant" || message.status !== "completed") continue;
    if (message.blocks.some((block) => block.type === "image")) return message;
  }
  return undefined;
}

function waitForPoll(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(signal.reason ?? new Error("Aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, IMAGE_POLL_INTERVAL_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function errorEvent(runId: string, code: "UNKNOWN" | "TIMEOUT", message: string): MessageEvent {
  return MessageEventSchema.parse({
    type: "error",
    runId,
    error: UClawErrorSchema.parse({ code, message, retryable: true }),
  });
}

export function createCommercialImageChatRouter(client: CommercialImageChatClient) {
  return {
    async route(input: SendMessageInput, signal?: AbortSignal): Promise<AsyncIterable<MessageEvent>> {
      const modelId = input.modelId ?? await client.sessionModel?.(input.sessionId);
      if (modelId !== COMMERCIAL_IMAGE_MODEL) return client.chat.send(input, signal);
      const prompt = input.blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n").trim();
      if (prompt === "") return client.chat.send(input, signal);
      const history = await client.chat.list(input.sessionId);
      const image = latestHistoryImage(history.items);
      const previousImageMessageIds = assistantImageMessageIds(history.items);
      const runId = `commercial-image-${input.clientRequestId}`;
      return (async function* (): AsyncIterable<MessageEvent> {
        yield MessageEventSchema.parse({ type: "started", runId, sessionId: input.sessionId });
        let generatedPath: string;
        try {
          generatedPath = (await client.imageInference.infer({
            prompt,
            model: COMMERCIAL_IMAGE_MODEL,
            clientRequestId: input.clientRequestId,
            ...(image === undefined ? {} : { image }),
          }, signal)).path;
        } catch {
          if (signal?.aborted === true) {
            yield MessageEventSchema.parse({ type: "aborted", runId, reason: "Cancelled" });
            return;
          }
          yield errorEvent(runId, "UNKNOWN", "OpenClaw image inference failed.");
          return;
        }
        const deadline = Date.now() + IMAGE_WAIT_TIMEOUT_MS;
        try {
          await client.chat.injectAssistant(input.sessionId, `MEDIA: ${generatedPath}`, "uclaw-commercial-image-v1", signal);
        } catch {
          if (signal?.aborted === true) {
            yield MessageEventSchema.parse({ type: "aborted", runId, reason: "Cancelled" });
            return;
          }
          yield errorEvent(runId, "UNKNOWN", "OpenClaw image transcript injection failed.");
          return;
        }
        while (Date.now() < deadline) {
          if (signal?.aborted === true) {
            yield MessageEventSchema.parse({ type: "aborted", runId, reason: "Cancelled" });
            return;
          }
          const messages = await client.chat.list(input.sessionId);
          const generated = latestNewImageMessage(messages.items, previousImageMessageIds);
          if (generated !== undefined) {
            yield MessageEventSchema.parse({ type: "final", runId, message: { ...generated, runId } });
            return;
          }
          try {
            await waitForPoll(signal);
          } catch {
            yield MessageEventSchema.parse({ type: "aborted", runId, reason: "Cancelled" });
            return;
          }
        }
        yield errorEvent(runId, "TIMEOUT", "OpenClaw image generation did not enter session history before timeout.");
      })();
    },
  };
}
