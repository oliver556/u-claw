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
  it("routes the first image turn through OpenClaw image_generate without a reference", async () => {
    const send = vi.fn(() => events());
    const router = createCommercialImageChatRouter({
      chat: { send, list: vi.fn(async () => ({ items: [], hasMore: false })) },
    });

    await router.route(input("生成一只蓝色小猫"));

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      blocks: [{
        type: "text",
        format: "plain",
        text: expect.stringMatching(/^\/tool image_generate action=generate model=uclaw-commercial\/gpt-image-2 prompt=/u),
      }],
    }), undefined);
    const [sent] = send.mock.calls[0] as unknown as [SendMessageInput, AbortSignal?];
    expect(sent.blocks[0]?.type === "text" ? sent.blocks[0].text : "").not.toContain(" image=");
  });

  it("reads the previous image from OpenClaw history and passes it to image_generate edit", async () => {
    const path = "/controlled/openclaw/media/generated.png";
    const sourceUrl = `http://127.0.0.1:18789/__openclaw__/assistant-media?source=${encodeURIComponent(path)}`;
    const send = vi.fn(() => events());
    const list = vi.fn(async () => ({ items: [imageMessage(sourceUrl)], hasMore: false }));
    const router = createCommercialImageChatRouter({ chat: { send, list } });

    await router.route(input("把主体颜色改成红色"));

    expect(list).toHaveBeenCalledWith("agent:main:image-session");
    const [sent] = send.mock.calls[0] as unknown as [SendMessageInput, AbortSignal?];
    const command = sent.blocks[0]?.type === "text" ? sent.blocks[0].text : "";
    expect(command).toContain(` image=${JSON.stringify(path)}`);
    expect(command).toContain(`prompt=${JSON.stringify("把主体颜色改成红色")}`);
  });

  it("keeps non-image models on ordinary OpenClaw chat.send", async () => {
    const send = vi.fn(() => events());
    const list = vi.fn(async () => ({ items: [], hasMore: false }));
    const router = createCommercialImageChatRouter({ chat: { send, list } });
    const normal = { ...input("hello"), modelId: "uclaw-commercial/gpt-5.5" };

    await router.route(normal);

    expect(send).toHaveBeenCalledWith(normal, undefined);
    expect(list).not.toHaveBeenCalled();
  });
});
