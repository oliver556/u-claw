import type { Message, MessageEvent, SendMessageInput } from "@uclaw/shared";

const COMMERCIAL_IMAGE_MODEL = "uclaw-commercial/gpt-image-2";

interface CommercialImageChatClient {
  chat: {
    list(sessionId: string): Promise<{ items: Message[]; hasMore: boolean }>;
    send(input: SendMessageInput, signal?: AbortSignal): AsyncIterable<MessageEvent>;
  };
  sessionModel?(sessionId: string): Promise<string | undefined>;
}

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

function imageGenerateCommand(prompt: string, image?: string): string {
  return `/tool image_generate action=generate model=${COMMERCIAL_IMAGE_MODEL} prompt=${JSON.stringify(prompt)}`
    + (image === undefined ? "" : ` image=${JSON.stringify(image)}`);
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
      return client.chat.send({
        ...input,
        blocks: [{ type: "text", text: imageGenerateCommand(prompt, image), format: "plain" }],
      }, signal);
    },
  };
}
