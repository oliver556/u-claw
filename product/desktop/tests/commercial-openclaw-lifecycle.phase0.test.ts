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

    expect(route).toContain("await commercialProviderReadiness.wait(signal)");
    expect(route).toContain("return client.chat.send(input, signal)");
    expect(route).not.toContain("modelRouting.routeChatSend");
    expect(route).not.toContain("localApplications.route");
    expect(route).not.toContain("commercialImageChat.route");
  });

  it("keeps second-turn context in the same OpenClaw session instead of a prompt-only direct request", () => {
    const route = productionChatRouteSource();

    expect(route, "第二轮必须复用 OpenClaw session/transcript").toContain("client.chat.send(input, signal)");
    expect(route, "商业直连只发送当前 prompt，无法保留第一轮上下文").not.toContain("modelRouting.routeChatSend");
    expect(route, "本地动作正则会绕过 OpenClaw session/transcript").not.toContain("localApplications.route");
  });

  it("lets the second-turn image edit resolve the previous image from OpenClaw transcript", () => {
    const route = productionChatRouteSource();

    expect(route, "上一张图片必须由 OpenClaw Agent/tool chain 从同一 session transcript 解析").toContain("client.chat.send(input, signal)");
    expect(route, "不得由商业直连另建图片上下文").not.toContain("modelRouting.routeChatSend");
    expect(route, "不得由 U-Claw 图片 CLI 和 chat.inject 伪造图片回复").not.toContain("commercialImageChat.route");
  });

  it("does not intercept natural language local application requests before OpenClaw", () => {
    const route = productionChatRouteSource();

    expect(route).toContain("client.chat.send(input, signal)");
    expect(route).not.toContain("requestedApplication");
    expect(route).not.toContain("openPath");
    expect(route).not.toContain("local_");
  });
});
