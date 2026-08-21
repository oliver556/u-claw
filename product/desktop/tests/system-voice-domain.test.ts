import { describe, expect, it, vi } from "vitest";
import { createSystemVoiceDomainRegistration } from "../src/system-voice/system-voice-domain.js";
import { createElectronSystemVoicePermissionReader } from "../src/system-voice/electron-permissions.js";
import { createProductionSystemVoiceDomain, createProductionTalkRunBridge, playSecureTemporaryAudio } from "../src/system-voice/production-system-voice.js";
import { chmod, mkdir, mkdtemp, readFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("waits for correlated chat final text and removes the listener", async () => {
    let chatListener: ((frame: { payload: unknown }) => void) | undefined;
    const remove = vi.fn();
    const request = vi.fn();
    const bridge = createProductionTalkRunBridge({
      request,
      onEvent: vi.fn((event, listener) => { expect(event).toBe("chat"); chatListener = listener as never; return remove; }),
    });
    const waiting = bridge.waitForTalkRun("run-1");
    chatListener?.({ payload: { runId: "other", state: "final", message: { content: [{ type: "text", text: "wrong" }] } } });
    chatListener?.({ payload: { runId: "run-1", state: "final", message: { content: [{ type: "text", text: "done" }] } } });
    await expect(waiting).resolves.toBe("done");
    expect(request).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledOnce();
  });

  it("falls back to agent.wait and aborts with exact sessionKey and runId", async () => {
    let chatListener: ((frame: { payload: unknown }) => void) | undefined;
    const request = vi.fn(async (method: string) => method === "agent.wait" ? { status: "completed" } : {});
    const bridge = createProductionTalkRunBridge({ request, onEvent: (_event, listener) => { chatListener = listener as never; return () => undefined; } });
    const waiting = bridge.waitForTalkRun("run-2");
    chatListener?.({ payload: { runId: "run-2", state: "final", message: null } });
    await expect(waiting).resolves.toEqual({ status: "completed" });
    expect(request).toHaveBeenCalledWith("agent.wait", { runId: "run-2", timeoutMs: 120_000 }, expect.anything());
    await bridge.abortTalkRun("agent:main:main", "run-2");
    expect(request).toHaveBeenCalledWith("chat.abort", { sessionKey: "agent:main:main", runId: "run-2" }, expect.anything());
  });

  it("rejects and unsubscribes pending Talk waiters during authority cleanup", async () => {
    const remove = vi.fn();
    let rejectWait!: (reason: unknown) => void;
    const bridge = createProductionTalkRunBridge({
      request: vi.fn(() => new Promise((_resolve, reject) => { rejectWait = reject; })),
      onEvent: () => remove,
    });
    const waiting = bridge.waitForTalkRun("run-pending");
    await Promise.resolve();
    bridge.clearPending();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(remove).toHaveBeenCalledOnce();
    rejectWait(new Error("late"));
  });

  it("clears owned Talk authority on talk close/error and Gateway disconnect", async () => {
    const clear = vi.fn(async () => undefined);
    let talkEvent: ((payload: unknown) => void) | undefined;
    let disconnect: (() => void) | undefined;
    const registration = createProductionSystemVoiceDomain({
      request: vi.fn(), requireMethod: vi.fn(), permissions: { get: async () => ({ microphone: "unknown", notifications: "restricted" }) },
      talkSessions: { list: async () => [], record: async () => undefined, remove: async () => undefined, clear },
    }, {
      onTalkEvent: (listener) => { talkEvent = listener; return () => undefined; },
      onDisconnect: (listener) => { disconnect = listener; return () => undefined; },
    });
    const dispose = registration.installIpc?.({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }, authorizedWebContents: { mainFrame: {} }, client: {} as never, services: { get: () => undefined } });
    talkEvent?.({ type: "audio" });
    expect(clear).not.toHaveBeenCalled();
    talkEvent?.({ type: "close" });
    talkEvent?.({ type: "error" });
    disconnect?.();
    await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(3));
    dispose?.();
  });

  it("plays TTS from a private temporary file and deletes it after playback", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-system-voice-audio-"));
    let audioPath = "";
    await playSecureTemporaryAudio(Buffer.from("audio").toString("base64"), { cacheRoot: root, play: async (path) => {
      audioPath = path;
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
      await expect(readFile(path, "utf8")).resolves.toBe("audio");
    } });
    await expect(stat(audioPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked temporary audio directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-system-voice-audio-"));
    const outside = await mkdtemp(join(tmpdir(), "uclaw-system-voice-outside-"));
    await symlink(outside, join(root, "system-voice"));
    const play = vi.fn();
    await expect(playSecureTemporaryAudio(Buffer.from("audio").toString("base64"), { cacheRoot: root, play })).rejects.toThrow(/temporary audio directory/i);
    expect(play).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("rejects a temporary audio directory with broad permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-system-voice-audio-"));
    const directory = join(root, "system-voice");
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o755);
    const play = vi.fn();
    await expect(playSecureTemporaryAudio(Buffer.from("audio").toString("base64"), { cacheRoot: root, play })).rejects.toThrow(/temporary audio directory/i);
    expect(play).not.toHaveBeenCalled();
  });
});
