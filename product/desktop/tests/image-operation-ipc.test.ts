import { describe, expect, it, vi } from "vitest";

import { IMAGE_OPERATION_IPC_CHANNEL } from "../src/ipc/channels.js";
import { registerIpc } from "../src/ipc/register-ipc.js";

const REQUEST = {
  method: "image.copy",
  requestId: "image-1",
  params: {
    sourceUrl: "http://127.0.0.1:18789/__openclaw__/assistant-media?source=%2Ftmp%2Fimage.png",
    suggestedName: "image.png",
  },
} as const;

function setup(dispatchImage: ((request: typeof REQUEST) => Promise<unknown>) & { dispose?: () => void }) {
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
  const authorizedWebContents = { mainFrame: {} };
  const removeHandler = vi.fn();
  const dispose = registerIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler },
    authorizedWebContents,
    windowControls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
    dispatchClient: vi.fn(),
    dispatchImage: dispatchImage as never,
  });
  return { handler: handlers.get(IMAGE_OPERATION_IPC_CHANNEL)!, authorizedWebContents, removeHandler, dispose };
}

describe("image operation IPC", () => {
  it("registers a dedicated sender-authorized channel and returns correlated responses", async () => {
    const dispatchImage = vi.fn(async (request: typeof REQUEST) => ({
      method: request.method,
      requestId: request.requestId,
      ok: true,
      result: { status: "completed" },
    }));
    const { handler, authorizedWebContents } = setup(dispatchImage);
    const event = { sender: authorizedWebContents, senderFrame: authorizedWebContents.mainFrame };

    await expect(handler(event, REQUEST)).resolves.toMatchObject({ ok: true, requestId: "image-1" });
    await expect(handler({ ...event, sender: {} }, REQUEST)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(handler({ ...event, senderFrame: {} }, REQUEST)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(dispatchImage).toHaveBeenCalledWith(REQUEST);
  });

  it("rejects invalid requests and mismatched dispatcher responses", async () => {
    const { handler, authorizedWebContents } = setup(vi.fn(async () => ({
      method: "image.save", requestId: "other", ok: true, result: { status: "completed" },
    })));
    const event = { sender: authorizedWebContents, senderFrame: authorizedWebContents.mainFrame };

    await expect(handler(event, { ...REQUEST, params: { ...REQUEST.params, sourceUrl: "https://evil.example/image.png" } }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(handler(event, REQUEST)).rejects.toMatchObject({ code: "UNKNOWN" });
  });

  it("removes the image handler on dispose", () => {
    const dispatchImage = Object.assign(vi.fn(), { dispose: vi.fn() });
    const { dispose, removeHandler } = setup(dispatchImage);
    dispose();
    expect(removeHandler).toHaveBeenCalledWith(IMAGE_OPERATION_IPC_CHANNEL);
    expect(dispatchImage.dispose).toHaveBeenCalledOnce();
  });
});
