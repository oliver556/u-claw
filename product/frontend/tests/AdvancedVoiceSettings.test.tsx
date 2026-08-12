// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdvancedVoiceSettings } from "../src/features/system/AdvancedVoiceSettings.js";
afterEach(cleanup);
describe("AdvancedVoiceSettings", () => {
  it("uses real method names, reads authority after operations, and clears renderer memory", async () => {
    const invoke = vi.fn(async ({ method, requestId }: { method: string; requestId: string }) => ({ method, requestId, ok: true as const, result: method === "talk.runtime.status" ? { authority: { scope: "owned-runtime", sessions: [{ sessionId: "talk-1", mode: "realtime", transport: "gateway-relay" }] } } : method === "tts.status" ? { authority: { enabled: true, provider: "system", persona: "calm" } } : method === "tts.providers" ? { authority: { providers: [{ id: "system", name: "System", configured: true }] } } : method === "tts.personas" ? { authority: { personas: [{ id: "calm", label: "Calm" }] } } : method === "voicewake.get" ? { authority: { triggers: ["openclaw"] } } : method === "voicewake.routing.get" ? { authority: { config: { version: 1, defaultTarget: { mode: "current" }, routes: [] } } } : method === "push.web.status" ? { authority: { subscribed: true } } : { mutation: {}, authority: {} } }));
    const { unmount } = render(<AdvancedVoiceSettings bridge={{ invoke: invoke as never }} />); expect(await screen.findByText("talk-1")).toBeVisible(); fireEvent.click(screen.getByRole("button", { name: "关闭 Talk 会话 talk-1" })); fireEvent.click(screen.getByRole("tab", { name: "TTS" })); const speech = await screen.findByRole("textbox", { name: "朗读文本" }); fireEvent.change(speech, { target: { value: "你好" } }); fireEvent.click(screen.getByRole("button", { name: "朗读" })); fireEvent.click(screen.getByRole("tab", { name: "Voice Wake" })); fireEvent.change(await screen.findByRole("textbox", { name: "Voice Wake 触发词" }), { target: { value: "hey u-claw" } }); fireEvent.click(screen.getByRole("button", { name: "保存 Voice Wake 触发词" })); fireEvent.click(screen.getByRole("button", { name: "保存 Voice Wake 路由" })); fireEvent.click(screen.getByRole("tab", { name: "Push" })); fireEvent.click(await screen.findByRole("button", { name: "测试 Push" })); fireEvent.click(screen.getByRole("button", { name: "取消 Push" })); await waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ method: "push.web.unsubscribe", params: {} }))); unmount(); render(<AdvancedVoiceSettings bridge={{ invoke: invoke as never }} />); expect(screen.queryByDisplayValue("你好")).not.toBeInTheDocument();
  });
  it("starts, stops, and disposes the client Talk transport", async () => {
    const stop = vi.fn();
    const startTalkClient = vi.fn(async () => ({ stop }));
    const invoke = vi.fn(async ({ method, requestId }: { method: string; requestId: string }) => ({
      method,
      requestId,
      ok: true as const,
      result: method === "talk.client.create"
        ? { clientBootstrap: { provider: "openai", transport: "webrtc", clientSecret: "short-lived", offerUrl: "https://api.openai.com/v1/realtime/calls" }, permissions: { microphone: "granted", notifications: "granted" } }
        : { authority: { sessions: [], clients: [] } },
    }));
    const { unmount } = render(<AdvancedVoiceSettings bridge={{ invoke: invoke as never }} startTalkClient={startTalkClient} />);
    fireEvent.click(await screen.findByRole("button", { name: "创建客户端 Talk 会话" }));
    expect(await screen.findByRole("button", { name: "停止客户端 Talk 会话" })).toBeVisible();
    expect(startTalkClient).toHaveBeenCalledWith(expect.objectContaining({ clientSecret: "short-lived" }), undefined, expect.objectContaining({ consult: expect.any(Function), steer: expect.any(Function) }));
    fireEvent.click(screen.getByRole("button", { name: "停止客户端 Talk 会话" }));
    expect(stop).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "创建客户端 Talk 会话" }));
    await screen.findByRole("button", { name: "停止客户端 Talk 会话" });
    unmount();
    expect(stop).toHaveBeenCalledTimes(2);
  });
  it("shows explicit OS permission denial", async () => { const invoke = vi.fn(async ({ method, requestId }: { method: string; requestId: string }) => method === "talk.session.create" ? { method, requestId, ok: false as const, error: { code: "FORBIDDEN", message: "麦克风权限被拒绝，请在系统设置中授权后重试。", retryable: false, recoveryActions: ["open-settings"], causeDetails: {} } } : { method, requestId, ok: true as const, result: { authority: {} } }); render(<AdvancedVoiceSettings bridge={{ invoke: invoke as never }} />); fireEvent.click(await screen.findByRole("button", { name: "创建 Gateway Talk 会话" })); expect(await screen.findByRole("alert")).toHaveTextContent("麦克风权限被拒绝"); });
});
