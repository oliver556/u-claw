import { describe, expect, it, vi } from "vitest";

import { SESSION_ADVANCED_IPC_CHANNEL } from "../src/ipc/channels.js";
import { registerIpc } from "../src/ipc/register-ipc.js";

const session = {
  id: "agent:main:main",
  title: "Authoritative",
  updatedAt: "2026-08-12T00:00:00.000Z",
  pinned: false,
  status: "idle" as const,
};

function setup() {
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
  const authorizedWebContents = { mainFrame: {} };
  const sessionAdvanced = {
    listFiles: vi.fn(async () => ({ sessionId: session.id, files: [] })),
    getFile: vi.fn(),
    listCheckpoints: vi.fn(async () => ({ sessionId: session.id, checkpoints: [] })),
    reset: vi.fn(async () => ({ operation: "reset" as const, session })),
    compact: vi.fn(), branch: vi.fn(), restore: vi.fn(), steer: vi.fn(),
  };
  const coordinated = vi.fn();
  const coordinateWrite = async <T>(operation: () => Promise<T>): Promise<T> => {
    coordinated();
    return operation();
  };
  const dispose = registerIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) },
    authorizedWebContents,
    windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
    dispatchClient: vi.fn(),
    sessionAdvanced,
    coordinateWrite,
  });
  return { handlers, authorizedWebContents, sessionAdvanced, coordinated, dispose };
}

describe("Session Advanced IPC", () => {
  it("routes reads directly and serializes mutations through coordinateWrite", async () => {
    const { handlers, authorizedWebContents, sessionAdvanced, coordinated } = setup();
    const event = { sender: authorizedWebContents, senderFrame: authorizedWebContents.mainFrame };
    await expect(handlers.get(SESSION_ADVANCED_IPC_CHANNEL)!(event, {
      method: "sessions.files.list", requestId: "files-1", params: { sessionId: session.id },
    })).resolves.toMatchObject({ ok: true, method: "sessions.files.list", requestId: "files-1" });
    expect(coordinated).not.toHaveBeenCalled();

    await expect(handlers.get(SESSION_ADVANCED_IPC_CHANNEL)!(event, {
      method: "sessions.reset", requestId: "reset-1", params: { sessionId: session.id },
    })).resolves.toMatchObject({ ok: true, method: "sessions.reset", result: { session } });
    expect(sessionAdvanced.reset).toHaveBeenCalledOnce();
    expect(coordinated).toHaveBeenCalledOnce();
  });

  it("rejects unauthorized senders and removes the fixed handler", async () => {
    const { handlers, authorizedWebContents, sessionAdvanced, dispose } = setup();
    await expect(handlers.get(SESSION_ADVANCED_IPC_CHANNEL)!({ sender: {}, senderFrame: authorizedWebContents.mainFrame }, {
      method: "sessions.files.list", requestId: "forbidden-1", params: { sessionId: session.id },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(sessionAdvanced.listFiles).not.toHaveBeenCalled();
    dispose();
    expect(handlers.has(SESSION_ADVANCED_IPC_CHANNEL)).toBe(false);
  });
});
