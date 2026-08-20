import { describe, expect, it } from "vitest";

import { mapChatEvent } from "../src/mappers/chat.js";
import {
  mapOpenClawHistoryResponse,
  mapOpenClawMessageGetResponse,
} from "../src/openclaw-v4-contract.js";

const sessionKey = "agent:main:lifecycle-contract";
const runId = "run-lifecycle-contract";
const messageId = "message-lifecycle-contract";
const timestamp = Date.parse("2026-08-20T08:00:00.000Z");

const historyMessage = {
  role: "assistant" as const,
  content: [{ type: "text", text: "权威最终内容" }],
  timestamp,
  __openclaw: {
    id: messageId,
    recordTimestampMs: timestamp,
    seq: 2,
  },
};

describe("phase 0 canonical OpenClaw chat mapper contract", () => {
  it("maps live final, history, and recovery to identical stable identity and content", () => {
    const live = mapChatEvent({
      state: "final",
      runId,
      sessionKey,
      message: {
        id: messageId,
        sessionKey,
        runId,
        role: "assistant",
        status: "completed",
        blocks: [{ id: `${messageId}:0`, type: "text", text: "权威最终内容", format: "plain" }],
        createdAt: new Date(timestamp).toISOString(),
      },
    });
    const history = mapOpenClawHistoryResponse({
      sessionKey,
      sessionId: "upstream-session",
      messages: [historyMessage],
    })[0];
    const recovery = mapOpenClawMessageGetResponse({ ok: true, message: historyMessage }, sessionKey);

    expect(live).toMatchObject({ type: "final" });
    if (live.type !== "final") throw new Error("live final contract was not mapped");
    expect(live.message).toEqual(history);
    expect(recovery).toEqual(history);
  });

  it("maps a first-turn managed image in the live final without a session switch", () => {
    const livePayload = {
      state: "final",
      runId,
      sessionKey,
      message: {
        id: messageId,
        sessionKey,
        runId,
        role: "assistant",
        status: "completed",
        blocks: [{
          id: `${messageId}:0`,
          type: "image",
          url: "/api/chat/media/outgoing/generated.png",
          mimeType: "image/png",
          alt: "首轮生成图",
        }],
        createdAt: new Date(timestamp).toISOString(),
      },
    };

    expect(() => mapChatEvent(livePayload as never)).not.toThrow();
    const mapped = mapChatEvent(livePayload as never);
    expect(mapped).toMatchObject({
      type: "final",
      message: { id: messageId, blocks: [{ type: "image" }] },
    });
  });
});
