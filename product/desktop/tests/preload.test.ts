import { describe, expect, it, vi } from "vitest";

import { CLIENT_IPC_CHANNEL, WINDOW_IPC_CHANNEL } from "../src/ipc/channels.js";
import { installPreloadBridge } from "../src/ipc/preload-bridge.js";

describe("installPreloadBridge", () => {
  it("exposes only fixed window and client invokers", async () => {
    const invoke = vi.fn(async (_channel: string, request: unknown) => {
      const { method, requestId } = request as { method: string; requestId: string };
      return { method, requestId, ok: true, result: null };
    });
    let api: Record<string, unknown> | undefined;

    installPreloadBridge({
      contextBridge: {
        exposeInMainWorld: (_name, exposed) => {
          api = exposed;
        },
      },
      ipcRenderer: { invoke },
    });

    expect(Object.keys(api ?? {})).toEqual(["window", "client"]);
    expect(api).not.toHaveProperty("ipcRenderer");
    expect(api).not.toHaveProperty("invoke");

    await (api?.window as { invoke: (request: unknown) => Promise<unknown> }).invoke({
      method: "minimize",
      requestId: "window-1",
      params: {},
    });
    expect(invoke).toHaveBeenLastCalledWith(WINDOW_IPC_CHANNEL, expect.any(Object));

    await expect(
      (api?.client as { invoke: (request: unknown) => Promise<unknown> }).invoke({
        method: "exec",
        requestId: "client-1",
        params: { command: "rm -rf /" },
      }),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalledWith(CLIENT_IPC_CHANNEL, expect.objectContaining({ method: "exec" }));
  });
});
