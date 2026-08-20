import { describe, expect, it, vi } from "vitest";

import type { Message, MessageEvent, SendMessageInput } from "@uclaw/shared";

import { createCommercialImageChatRouter } from "../src/providers/commercial-image-chat-router.js";

const input = (text: string): SendMessageInput => ({
  sessionId: "agent:main:image-session",
  clientRequestId: `request-${text.length}`,
  modelId: "uclaw-commercial/gpt-image-2",
  blocks: [{ type: "text", text, format: "plain" }],
});

async function* events(): AsyncIterable<MessageEvent> {
  yield { type: "started", runId: "run-image", sessionId: "agent:main:image-session" };
}

async function collect(events: AsyncIterable<MessageEvent>): Promise<MessageEvent[]> {
  const collected: MessageEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function imageMessage(sourceUrl: string): Message {
  return {
    id: "assistant-image",
    sessionId: "agent:main:image-session",
    role: "assistant",
    status: "completed",
    createdAt: "2026-08-21T00:00:00.000Z",
    blocks: [{
      id: "image-1",
      type: "image",
      file: { id: "image-1", name: "generated.png", mediaType: "image/png", size: 128, kind: "artifact" },
      sourceUrl,
    }],
  };
}

describe("commercial OpenClaw image chat router", () => {
  it("routes the first image turn through OpenClaw image inference without a reference", async () => {
    const send = vi.fn(() => events());
    const infer = vi.fn(async () => ({ path: "/controlled/generated.png", mimeType: "image/png", size: 128 }));
    const injectAssistant = vi.fn(async () => undefined);
    const generated = imageMessage("http://127.0.0.1:18789/__openclaw__/assistant-media?source=%2Fcontrolled%2Fgenerated.png");
    const list = vi.fn()
      .mockResolvedValueOnce({ items: [], hasMore: false })
      .mockResolvedValueOnce({ items: [generated], hasMore: false });
    const router = createCommercialImageChatRouter({
      chat: { send, list, injectAssistant },
      imageInference: { infer },
    });

    const routed = await router.route(input("生成一只蓝色小猫"));
    const result = await collect(routed);

    expect(send).not.toHaveBeenCalled();
    expect(infer).toHaveBeenCalledWith({
      prompt: "生成一只蓝色小猫",
      model: "uclaw-commercial/gpt-image-2",
      clientRequestId: "request-8",
    }, undefined);
    expect(result.map((event) => event.type)).toEqual(["started", "final"]);
    expect(result[1]).toMatchObject({ type: "final", message: generated });
    expect(injectAssistant).toHaveBeenCalledWith(
      "agent:main:image-session",
      "MEDIA: /controlled/generated.png",
      "uclaw-commercial-image-v1",
      undefined,
    );
  });

  it("reads the previous image from OpenClaw history and passes it to image_generate edit", async () => {
    const path = "/controlled/openclaw/media/generated.png";
    const sourceUrl = `http://127.0.0.1:18789/__openclaw__/assistant-media?source=${encodeURIComponent(path)}`;
    const send = vi.fn(() => events());
    const previous = imageMessage(sourceUrl);
    const edited = { ...imageMessage("http://127.0.0.1:18789/__openclaw__/assistant-media?source=%2Fcontrolled%2Fedited.png"), id: "assistant-edited" };
    const list = vi.fn()
      .mockResolvedValueOnce({ items: [previous], hasMore: false })
      .mockResolvedValueOnce({ items: [previous, edited], hasMore: false });
    const infer = vi.fn(async () => ({ path: "/controlled/edited.png", mimeType: "image/png", size: 128 }));
    const injectAssistant = vi.fn(async () => undefined);
    const router = createCommercialImageChatRouter({ chat: { send, list, injectAssistant }, imageInference: { infer } });

    const routed = await router.route(input("把主体颜色改成红色"));
    const result = await collect(routed);

    expect(list).toHaveBeenCalledWith("agent:main:image-session");
    expect(send).not.toHaveBeenCalled();
    expect(infer).toHaveBeenCalledWith({
      prompt: "把主体颜色改成红色",
      model: "uclaw-commercial/gpt-image-2",
      clientRequestId: "request-9",
      image: path,
    }, undefined);
    expect(result.at(-1)).toMatchObject({ type: "final", message: edited });
    expect(injectAssistant).toHaveBeenCalledWith(
      "agent:main:image-session",
      "MEDIA: /controlled/edited.png",
      "uclaw-commercial-image-v1",
      undefined,
    );
  });

  it("keeps non-image models on ordinary OpenClaw chat.send", async () => {
    const send = vi.fn(() => events());
    const list = vi.fn(async () => ({ items: [], hasMore: false }));
    const infer = vi.fn();
    const router = createCommercialImageChatRouter({
      chat: { send, list, injectAssistant: vi.fn() },
      imageInference: { infer },
    });
    const normal = { ...input("hello"), modelId: "uclaw-commercial/gpt-5.5" };

    await router.route(normal);

    expect(send).toHaveBeenCalledWith(normal, undefined);
    expect(list).not.toHaveBeenCalled();
    expect(infer).not.toHaveBeenCalled();
  });
});
