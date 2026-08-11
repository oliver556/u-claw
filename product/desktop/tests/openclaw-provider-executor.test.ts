import { describe, expect, it, vi } from "vitest";

import { createOpenClawProviderExecutor } from "../src/providers/openclaw-provider-executor.js";

describe("OpenClaw provider executor", () => {
  it.each([
    { id: "deepseek", templateId: "deepseek" as const, source: "domestic" },
    { id: "custom-main", templateId: undefined, source: "custom" },
  ])("writes and reads back $source session model before real chat", async ({ id, templateId }) => {
    const events = (async function* () { yield { type: "started", runId: "run-1", sessionId: "session-1" } as const; })();
    const selectForSession = vi.fn(async () => undefined);
    const send = vi.fn(() => events);
    const executor = createOpenClawProviderExecutor({
      models: { selectForSession },
      chat: { send },
    });

    const result = await executor({
      sessionId: "session-1",
      clientRequestId: "request-1",
      blocks: [{ type: "text", text: "hello", format: "plain" }],
    }, {
      id,
      ...(templateId === undefined ? {} : { templateId }),
      name: id,
      enabled: true,
      baseUrl: "https://provider.example/v1",
      model: "model-1",
      apiKey: "secret",
    });

    expect(result).toBe(events);
    expect(selectForSession).toHaveBeenCalledWith("session-1", `${id}/model-1`);
    expect(send).toHaveBeenCalledOnce();
    expect(selectForSession.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!);
  });

  it("does not send or fall back when OpenClaw rejects provider selection", async () => {
    const selectForSession = vi.fn(async () => { throw new Error("provider unavailable"); });
    const send = vi.fn();
    const executor = createOpenClawProviderExecutor({ models: { selectForSession }, chat: { send } });

    await expect(executor({
      sessionId: "session-1",
      clientRequestId: "request-1",
      blocks: [{ type: "text", text: "hello", format: "plain" }],
    }, {
      id: "custom-main",
      name: "Custom",
      enabled: true,
      baseUrl: "https://provider.example/v1",
      model: "model-1",
    })).rejects.toThrow("provider unavailable");
    expect(send).not.toHaveBeenCalled();
  });
});
