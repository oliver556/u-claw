import { describe, expect, it } from "vitest";

import { mapChatEvent, mapMessage } from "../src/mappers/chat.js";
import { mapOpenClawModel, RuntimeOpenClawModelsListResponseSchema } from "../src/mappers/model.js";
import { mapSession } from "../src/mappers/session.js";
import { mapExecApproval, mapPluginApproval, mapToolCall } from "../src/mappers/tool.js";

const now = "2026-08-07T12:00:00.000Z";

describe("chat mapper", () => {
  it("maps append and replace deltas", () => {
    expect(mapChatEvent({ state: "delta", runId: "run-1", sessionKey: "session-1", deltaText: "A" })).toEqual({
      type: "delta", runId: "run-1", mode: "append", text: "A",
    });
    expect(mapChatEvent({ state: "delta", runId: "run-1", sessionKey: "session-1", deltaText: "B", replace: true })).toEqual({
      type: "delta", runId: "run-1", mode: "replace", text: "B",
    });
  });

  it("maps final, error, and aborted terminal states", () => {
    const message = { id: "m-1", sessionKey: "session-1", runId: "run-1", role: "assistant" as const, status: "completed" as const, blocks: [{ id: "b-1", type: "text", text: "done", format: "markdown" as const }], createdAt: now };
    expect(mapChatEvent({ state: "final", runId: "run-1", sessionKey: "session-1", message })).toMatchObject({ type: "final", runId: "run-1" });
    expect(mapChatEvent({ state: "aborted", runId: "run-1", sessionKey: "session-1", errorMessage: "stopped" })).toEqual({ type: "aborted", runId: "run-1", reason: "stopped" });
    expect(mapChatEvent({ state: "error", runId: "run-1", sessionKey: "session-1", errorMessage: "failed" })).toMatchObject({ type: "error", runId: "run-1", error: { code: "UNKNOWN" } });
  });

  it("maps unknown content blocks to unsupported", () => {
    const futureBlock = { id: "b-1", type: "future", value: "private" };
    const message = mapMessage({ id: "m-1", sessionKey: "session-1", role: "assistant", status: "completed", blocks: [futureBlock], createdAt: now });
    expect(message.blocks[0]).toEqual({ id: "b-1", type: "unsupported", originalType: "future", summary: "Unsupported content" });
  });

  it("rejects fields from a different known block variant", () => {
    const mixedBlock = { id: "b-1", type: "text", text: "hello", format: "plain" as const, code: "forbidden" };
    const raw = { id: "m-1", sessionKey: "session-1", role: "assistant" as const, status: "completed" as const, blocks: [mixedBlock], createdAt: now };
    expect(() => mapMessage(raw)).toThrow();
  });

  it("rejects extra raw chat fields", () => {
    const raw = { id: "m-1", sessionKey: "session-1", role: "assistant" as const, status: "completed" as const, blocks: [], createdAt: now, extra: "forbidden" };
    expect(() => mapMessage(raw)).toThrow();
  });
});

describe("session and tool mappers", () => {
  it("maps only explicit OpenClaw model input capabilities", () => {
    expect(mapOpenClawModel({
      id: "vision-model", name: "Vision Model", provider: "contract", available: true,
      input: ["text", "image", "audio"],
    })).toMatchObject({
      id: "contract/vision-model", capabilities: ["text", "vision"], locality: "unknown",
    });
  });

  it("fails closed when model availability and inputs are absent", () => {
    expect(mapOpenClawModel({ id: "unknown", name: "Unknown", provider: "contract" })).toMatchObject({
      available: false,
      capabilities: ["unknown"],
      unavailableReason: { code: "MODEL_UNAVAILABLE" },
    });
  });

  it("accepts unmodeled upstream model fields at the runtime boundary", () => {
    const response = RuntimeOpenClawModelsListResponseSchema.parse({
      models: [{ id: "future", name: "Future", provider: "contract", futureField: { enabled: true } }],
    });
    expect(response.models[0]).toMatchObject({ id: "future", futureField: { enabled: true } });
  });

  it("maps validated sessions", () => {
    expect(mapSession({ sessionKey: "session-1", title: "Chat", createdAt: now, updatedAt: now, pinned: false, status: "idle" })).toMatchObject({ id: "session-1", title: "Chat" });
  });

  it("maps locked OpenClaw session rows without inventing created timestamps", () => {
    expect(mapSession({
      key: "agent:dev:main",
      label: "Release",
      updatedAt: 1786129711211,
      pinned: true,
      category: "delivery",
      hasActiveRun: true,
      modelProvider: "contract",
      model: "contract-model",
    })).toEqual({
      id: "agent:dev:main",
      title: "Release",
      updatedAt: "2026-08-07T19:08:31.211Z",
      pinned: true,
      groupId: "delivery",
      status: "running",
      model: { id: "contract/contract-model", label: "contract-model", providerId: "contract" },
    });
  });

  it("rejects extra raw session fields", () => {
    const raw = { sessionKey: "session-1", title: "Chat", createdAt: now, updatedAt: now, pinned: false, status: "idle" as const, extra: "forbidden" };
    expect(() => mapSession(raw)).toThrow();
  });

  it.each([
    ["pending", "queued"], ["approval", "waiting-authorization"], ["running", "running"],
    ["done", "succeeded"], ["error", "failed"], ["aborted", "cancelled"],
  ] as const)("maps tool state %s to %s", (state, expected) => {
    expect(mapToolCall({ toolCallId: "tool-1", sessionKey: "session-1", toolId: "exec", displayName: "Execute", state, risk: "high" }).state).toBe(expected);
  });

  it("keeps exec and plugin approval families separate", () => {
    const base = { id: "approval-1", title: "Confirm", description: "Needs access", risk: "high" as const, permissions: [{ kind: "process" as const, scope: "command", description: "Run command" }], choices: ["deny" as const], status: "pending" as const };
    expect(mapExecApproval({ ...base, toolCallId: "tool-1" })).toMatchObject({ family: "exec", subject: { kind: "toolCall" } });
    expect(mapPluginApproval({ ...base, pluginId: "plugin-1" })).toMatchObject({ family: "plugin", subject: { kind: "plugin", id: "plugin-1" } });
  });

  it("rejects extra raw tool fields", () => {
    const raw = { toolCallId: "tool-1", sessionKey: "session-1", toolId: "exec", displayName: "Execute", state: "running" as const, risk: "high" as const, extra: "forbidden" };
    expect(() => mapToolCall(raw)).toThrow();
  });

  it("rejects extra raw approval fields", () => {
    const raw = { id: "approval-1", title: "Confirm", description: "Needs access", risk: "high" as const, permissions: [{ kind: "process" as const, scope: "command", description: "Run command" }], choices: ["deny" as const], status: "pending" as const, toolCallId: "tool-1", extra: "forbidden" };
    expect(() => mapExecApproval(raw)).toThrow();
  });
});
