import { describe, expect, it, vi } from "vitest";
import { createSystemVoiceDomainRegistration } from "../src/system-voice/system-voice-domain.js";
import { createElectronSystemVoicePermissionReader } from "../src/system-voice/electron-permissions.js";
import { UClawErrorSchema } from "@uclaw/shared";

describe("system voice desktop domain", () => {
  it("authorizes IPC sender and returns renderer-safe failures", async () => {
    let handler: ((event: unknown, payload: unknown) => Promise<unknown>) | undefined;
    const frame = {};
    const sender = { mainFrame: frame };
    createSystemVoiceDomainRegistration(vi.fn(async () => { throw UClawErrorSchema.parse({ code: "FORBIDDEN", message: "麦克风权限被拒绝", retryable: false, recoveryActions: ["open-settings"], causeDetails: {} }); })).installIpc?.({
      ipcMain: { handle: vi.fn((_channel, fn) => { handler = fn; }), removeHandler: vi.fn() }, authorizedWebContents: sender, client: {} as never, services: { get: () => undefined },
    });
    await expect(handler?.({ sender: {}, senderFrame: frame }, { method: "talk.runtime.status", requestId: "bad", params: {} })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(handler?.({ sender, senderFrame: frame }, { method: "talk.session.create", requestId: "ok", params: { mode: "realtime" } })).resolves.toMatchObject({ ok: false, error: { code: "FORBIDDEN", message: expect.stringContaining("麦克风权限被拒绝") } });
  });

  it("reads current Electron microphone and notification permission authority", async () => {
    const reader = createElectronSystemVoicePermissionReader({
      getMediaAccessStatus: vi.fn(() => "denied" as const),
      isNotificationsSupported: vi.fn(() => true),
      getNotificationPermission: vi.fn(() => "denied" as const),
    });
    await expect(reader.get()).resolves.toEqual({ microphone: "denied", notifications: "denied" });
  });
  it("clears owned Talk state when the domain is disposed", async () => {
    const removeHandler = vi.fn(); const dispose = vi.fn(async () => undefined);
    const cleanup = createSystemVoiceDomainRegistration(vi.fn(), dispose).installIpc?.({ ipcMain: { handle: vi.fn(), removeHandler }, authorizedWebContents: { mainFrame: {} }, client: {} as never, services: { get: () => undefined } });
    cleanup?.();
    expect(removeHandler).toHaveBeenCalled(); expect(dispose).toHaveBeenCalledOnce();
  });
});
