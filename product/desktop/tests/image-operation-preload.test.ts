import { describe, expect, it, vi } from "vitest";

import { IMAGE_OPERATION_IPC_CHANNEL } from "../src/ipc/channels.js";
import { installPreloadBridge } from "../src/ipc/preload-bridge.js";

const REQUEST = {
  method: "image.copy",
  requestId: "image-1",
  params: {
    sourceUrl: "http://127.0.0.1:18789/__openclaw__/assistant-media?source=%2Ftmp%2Fimage.png",
    suggestedName: "image.png",
  },
} as const;

describe("image operation preload bridge", () => {
  it("exposes only images.invoke on the dedicated channel", async () => {
    let api: Record<string, unknown> | undefined;
    const invoke = vi.fn(async () => ({ method: "image.copy", requestId: "image-1", ok: true, result: { status: "completed" } }));
    installPreloadBridge({
      contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
    });

    expect(Object.keys(api?.images as object)).toEqual(["invoke"]);
    await expect((api?.images as { invoke(request: unknown): Promise<unknown> }).invoke(REQUEST)).resolves.toMatchObject({ ok: true });
    expect(invoke).toHaveBeenCalledWith(IMAGE_OPERATION_IPC_CHANNEL, REQUEST);
  });

  it("validates requests, responses, method, and requestId", async () => {
    let api: Record<string, unknown> | undefined;
    const invoke = vi.fn();
    installPreloadBridge({
      contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
    });
    const call = (request: unknown) => (api?.images as { invoke(request: unknown): Promise<unknown> }).invoke(request);

    await expect(call({ ...REQUEST, method: "image.delete" })).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockResolvedValueOnce({ method: "image.save", requestId: "image-1", ok: true, result: { status: "completed" } });
    await expect(call(REQUEST)).rejects.toThrow("IPC response does not match its request.");
    invoke.mockResolvedValueOnce({ method: "image.copy", requestId: "other", ok: true, result: { status: "completed" } });
    await expect(call(REQUEST)).rejects.toThrow("IPC response does not match its request.");
    invoke.mockResolvedValueOnce({ method: "image.copy", requestId: "image-1", ok: true, result: { status: "unknown" } });
    await expect(call(REQUEST)).rejects.toThrow();
  });
});
