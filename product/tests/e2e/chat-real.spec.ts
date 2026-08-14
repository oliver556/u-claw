import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const listeners = new Set<(event: unknown) => void>();
    const now = "2026-08-08T08:00:00.000Z";
    const session = {
      id: "session-real", title: "真实 Gateway 会话", createdAt: now, updatedAt: now,
      pinned: false, status: "idle", model: { id: "openai/gpt-5", label: "GPT-5", providerId: "openai" },
    };
    const success = (request: { method: string; requestId: string }, result: unknown) => ({
      method: request.method, requestId: request.requestId, ok: true, result,
    });
    Object.defineProperty(window, "uclaw", {
      configurable: true,
      value: {
        client: {
          subscribe(listener: (event: unknown) => void) { listeners.add(listener); return () => listeners.delete(listener); },
          async invoke(request: { method: string; requestId: string; params: Record<string, unknown> }) {
            if (request.method === "gateway.negotiate") return success(request, { protocolVersion: 4, methods: ["sessions.list", "sessions.get", "chat.history", "chat.send", "chat.abort"], events: ["chat"], features: { attachments: false, approvalResolve: false } });
            if (request.method === "gateway.watch-status") {
              setTimeout(() => listeners.forEach((listener) => listener({
                event: "gateway.status", subscriptionId: request.params.subscriptionId,
                payload: { connectionState: "ready", protocolVersion: 4, phase: "available", processAlive: true, serviceReady: true, businessAvailable: true, since: now, attempt: 0, openClawVersion: "2026.7.1-2", usb: { state: "available", dataWritable: true } },
              })), 0);
              return success(request, null);
            }
            if (request.method === "sessions.list") return success(request, { items: [session], nextCursor: null, hasMore: false });
            if (request.method === "sessions.get") return success(request, session);
            if (request.method === "chat.list") return success(request, { items: [], nextCursor: null, hasMore: false });
            if (request.method === "approvals.list-pending") return success(request, []);
            if (request.method === "chat.send") {
              const clientRequestId = request.params.clientRequestId as string;
              setTimeout(() => {
                for (const payload of [
                  { type: "started", runId: "run-real", sessionId: "session-real" },
                  { type: "delta", runId: "run-real", mode: "append", text: "真实 IPC " },
                  { type: "final", runId: "run-real", message: { id: "message-real", sessionId: "session-real", runId: "run-real", role: "assistant", status: "completed", blocks: [{ id: "block-real", type: "text", text: "真实 IPC 响应", format: "plain" }], createdAt: now } },
                ]) listeners.forEach((listener) => listener({ event: "chat.send-event", clientRequestId, payload }));
              }, 0);
              return success(request, { clientRequestId, runId: "run-real" });
            }
            if (request.method === "subscriptions.cancel" || request.method === "chat.abort" || request.method === "chat.cancel-stream") return success(request, null);
            throw new Error(`Unexpected IPC method: ${request.method}`);
          },
        },
      },
    });
  });
});

test("desktop renderer uses typed real-client bridge for model, history and streaming", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  await expect(page.getByRole("button", { name: /真实 Gateway 会话/ })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "会话模型" })).toBeVisible();
  await expect(page.getByRole("main").getByText("openai/gpt-5")).toBeVisible();
  const composer = page.getByRole("textbox", { name: "给 U-Claw 发送消息" });
  await composer.fill("走真实 IPC 主链");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByRole("main").getByText("真实 IPC 响应")).toBeVisible();
  await expect(composer).toHaveValue("");
});
