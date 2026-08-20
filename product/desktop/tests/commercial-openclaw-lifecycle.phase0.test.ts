import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const mainSource = readFileSync(resolve(import.meta.dirname, "../src/main.ts"), "utf8");

function productionChatRouteSource(): string {
  const start = mainSource.indexOf("const routeChatSend =");
  const end = mainSource.indexOf("const chatQueueDispatcher", start);
  if (start < 0 || end < 0) throw new Error("production routeChatSend composition was not found");
  return mainSource.slice(start, end);
}

describe("phase 0 commercial OpenClaw chat lifecycle contract", () => {
  it("routes commercial chat through observable OpenClaw chat.send", () => {
    const route = productionChatRouteSource();

    expect(route).toContain("client.chat.send(input, signal)");
    expect(route).not.toContain("modelRouting.routeChatSend");
  });

  it("keeps second-turn context in the same OpenClaw session instead of a prompt-only direct request", () => {
    const route = productionChatRouteSource();

    expect(route, "第二轮必须复用 OpenClaw session/transcript").toContain("client.chat.send(input, signal)");
    expect(route, "商业直连只发送当前 prompt，无法保留第一轮上下文").not.toContain("modelRouting.routeChatSend");
  });

  it("lets the second-turn image edit resolve the previous image from OpenClaw transcript", () => {
    const route = productionChatRouteSource();

    expect(route, "上一张图片必须由同一 OpenClaw session 的 transcript 提供").toContain("client.chat.send(input, signal)");
    expect(route, "不得由商业直连另建图片上下文").not.toContain("modelRouting.routeChatSend");
  });
});
