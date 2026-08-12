import { createOpenClawSystemVoiceService, type OpenClawSystemVoiceOptions } from "@uclaw/adapter/dist/system-voice.js";
import { createSystemVoiceDispatcher } from "./system-voice-dispatcher.js";
import { createSystemVoiceDomainRegistration } from "./system-voice-domain.js";
import { z } from "zod";
import type { DesktopDomainIpcContext } from "../main.js";
import type { AuthorizedWebContents } from "../ipc/register-ipc.js";
import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { randomUUID } from "node:crypto";

interface TalkRunBridgeOptions {
  request(method: string, params: unknown, schema: z.ZodType): Promise<unknown>;
  onEvent(event: string, listener: (frame: { payload: unknown }) => void): () => void;
}

export interface SecureAudioFileOptions {
  cacheRoot: string;
  play(path: string): Promise<void>;
}

export async function playSecureTemporaryAudio(audioBase64: string, options: SecureAudioFileOptions): Promise<void> {
  const bytes = Buffer.from(audioBase64, "base64");
  if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) throw new Error("TTS audio payload is invalid.");
  const directory = join(options.cacheRoot, "system-voice");
  const path = join(directory, `${randomUUID()}.audio`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const [cacheRootReal, directoryReal, directoryInfo] = await Promise.all([
    realpath(options.cacheRoot),
    realpath(directory),
    lstat(directory),
  ]);
  const relativeDirectory = relative(cacheRootReal, directoryReal);
  const currentUid = process.getuid?.();
  if (
    directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory() ||
    (currentUid !== undefined && directoryInfo.uid !== currentUid) ||
    (directoryInfo.mode & 0o777) !== 0o700 ||
    relativeDirectory === "" || relativeDirectory.startsWith("..") || isAbsolute(relativeDirectory)
  ) {
    throw new Error("Secure temporary audio directory is unavailable.");
  }
  try {
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
    await options.play(path);
  } finally {
    await rm(path, { force: true });
  }
}

function assistantText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const row = message as Record<string, unknown>;
  if (typeof row.content === "string" && row.content.trim()) return row.content.trim();
  if (!Array.isArray(row.content)) return undefined;
  const text = row.content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const value = (part as Record<string, unknown>).text;
    return typeof value === "string" && value.trim() ? [value.trim()] : [];
  }).join("\n");
  return text || undefined;
}

export function createProductionTalkRunBridge(options: TalkRunBridgeOptions) {
  const pending = new Set<(reason: unknown) => void>();
  return {
    waitForTalkRun(runId: string): Promise<unknown> {
      return new Promise((resolve, reject) => {
        let settled = false;
        let fallbackStarted = false;
        let remove: () => void = () => undefined;
        let cancel: (reason: unknown) => void;
        const finish = (operation: () => void) => {
          if (settled) return;
          settled = true;
          remove();
          pending.delete(cancel);
          operation();
        };
        cancel = (reason: unknown) => finish(() => reject(reason));
        pending.add(cancel);
        remove = options.onEvent("chat", (frame) => {
          const payload = frame.payload;
          if (!payload || typeof payload !== "object") return;
          const row = payload as Record<string, unknown>;
          if (row.runId !== runId) return;
          if (row.state === "aborted") {
            finish(() => reject(new DOMException("OpenClaw Talk run aborted.", "AbortError")));
            return;
          }
          if (row.state === "error") {
            finish(() => reject(new Error("OpenClaw Talk run failed.")));
            return;
          }
          if (row.state !== "final") return;
          const text = assistantText(row.message);
          if (text) {
            finish(() => resolve(text));
            return;
          }
          startFallback();
        });
        const startFallback = () => {
          if (settled || fallbackStarted) return;
          fallbackStarted = true;
          void options.request("agent.wait", { runId, timeoutMs: 120_000 }, z.unknown()).then(
            (result) => finish(() => resolve(result)),
            () => finish(() => reject(new Error("OpenClaw Talk completion readback failed."))),
          );
        };
        queueMicrotask(startFallback);
      });
    },
    async abortTalkRun(sessionKey: string, runId: string): Promise<void> {
      await options.request("chat.abort", { sessionKey, runId }, z.unknown());
    },
    clearPending(): void {
      const reason = new DOMException("OpenClaw Talk authority closed.", "AbortError");
      for (const cancel of [...pending]) cancel(reason);
    },
  };
}

export interface ProductionSystemVoiceLifecycle {
  bindAuthorizedWebContents?(webContents: AuthorizedWebContents | undefined): void;
  onTalkEvent?(listener: (payload: unknown) => void): () => void;
  onDisconnect?(listener: () => void): () => void;
  clearPendingTalkRuns?(): void;
}

export function createProductionSystemVoiceDomain(options: OpenClawSystemVoiceOptions, lifecycle: ProductionSystemVoiceLifecycle = {}) {
  const service = createOpenClawSystemVoiceService(options);
  const registration = createSystemVoiceDomainRegistration(createSystemVoiceDispatcher(service), () => service.clearTalkSessions());
  return { installIpc(context: DesktopDomainIpcContext) {
    lifecycle.bindAuthorizedWebContents?.(context.authorizedWebContents);
    const removeTalkEvent = lifecycle.onTalkEvent?.((payload) => {
      if (!payload || typeof payload !== "object") return;
      const type = (payload as Record<string, unknown>).type;
      if (type === "close" || type === "error") { lifecycle.clearPendingTalkRuns?.(); void service.clearTalkSessions(); }
    });
    const removeDisconnect = lifecycle.onDisconnect?.(() => { lifecycle.clearPendingTalkRuns?.(); void service.clearTalkSessions(); });
    const disposeIpc = registration.installIpc?.(context);
    return () => {
      removeDisconnect?.();
      removeTalkEvent?.();
      lifecycle.bindAuthorizedWebContents?.(undefined);
      disposeIpc?.();
    };
  } };
}
