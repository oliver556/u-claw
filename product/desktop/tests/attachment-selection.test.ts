import { AttachmentManager } from "@uclaw/adapter";
import { describe, expect, it, vi } from "vitest";

import { ATTACHMENT_IPC_CHANNEL } from "../src/ipc/channels.js";
import { registerIpc } from "../src/ipc/register-ipc.js";

describe("attachment selection IPC", () => {
  it("returns resources without selected absolute paths", async () => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>();
    const webContents = { mainFrame: {} };
    registerIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: vi.fn() },
      authorizedWebContents: webContents,
      windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
      dispatchClient: vi.fn(), attachments: new AttachmentManager(),
      selectAttachments: vi.fn(async () => [{ name: "fixture.txt", mediaType: "text/plain", size: 8, contentBase64: "Y29udHJhY3Q=" }]),
    });
    const response = await handlers.get(ATTACHMENT_IPC_CHANNEL)!({ sender: webContents, senderFrame: webContents.mainFrame }, { method: "select", requestId: "select-1", params: {} });
    expect(response).toMatchObject({ ok: true, result: [{ state: "ready", file: { name: "fixture.txt" } }] });
    expect(JSON.stringify(response)).not.toMatch(/[A-Za-z]:\\|\/Users\//);
    const attachmentId = (response as { result: Array<{ id: string }> }).result[0].id;
    await expect(handlers.get(ATTACHMENT_IPC_CHANNEL)!({ sender: webContents, senderFrame: webContents.mainFrame }, { method: "get", requestId: "get-1", params: { attachmentId } }))
      .resolves.toMatchObject({ ok: true, result: { id: attachmentId, state: "ready" } });
  });

  it("rejects renderer paths on drag-drop import", async () => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>();
    const webContents = { mainFrame: {} };
    registerIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: vi.fn() },
      authorizedWebContents: webContents,
      windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
      dispatchClient: vi.fn(), attachments: new AttachmentManager(),
    });
    await expect(handlers.get(ATTACHMENT_IPC_CHANNEL)!({ sender: webContents, senderFrame: webContents.mainFrame }, { method: "import", requestId: "drop-1", params: { path: "C:\\secret.txt" } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
