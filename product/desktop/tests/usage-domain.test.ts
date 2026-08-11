import { describe, expect, it, vi } from "vitest";

import { USAGE_IPC_CHANNEL, createUsageDomainRegistration } from "../src/usage/usage-domain.js";

describe("usage domain registration", () => {
  it("installs one sender-authorized IPC handler and removes it on dispose", async () => {
    let handler: ((event: unknown, payload: unknown) => Promise<unknown>) | undefined;
    const ipcMain = {
      handle: vi.fn((channel: string, candidate: typeof handler) => {
        expect(channel).toBe(USAGE_IPC_CHANNEL);
        handler = candidate;
      }),
      removeHandler: vi.fn(),
    };
    const dispatch = vi.fn(async (request) => ({ method: request.method, requestId: request.requestId, ok: true, result: {} }));
    const sender = { mainFrame: {} };
    const registration = createUsageDomainRegistration(dispatch);
    const dispose = registration.installIpc?.({
      ipcMain,
      authorizedWebContents: sender,
      client: {} as never,
      services: { get: () => undefined },
    });

    await expect(handler?.({ sender, senderFrame: sender.mainFrame }, {
      method: "usage.snapshot",
      requestId: "usage-domain-1",
      params: { startDate: "2026-08-12", endDate: "2026-08-12" },
    })).resolves.toMatchObject({ ok: true });
    expect(dispatch).toHaveBeenCalledOnce();

    await expect(handler?.({ sender: {}, senderFrame: sender.mainFrame }, {
      method: "usage.snapshot",
      requestId: "usage-domain-2",
      params: { startDate: "2026-08-12", endDate: "2026-08-12" },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    dispose?.();
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(USAGE_IPC_CHANNEL);
  });

  it("rejects malformed payloads before dispatch", async () => {
    let handler: ((event: unknown, payload: unknown) => Promise<unknown>) | undefined;
    const sender = { mainFrame: {} };
    createUsageDomainRegistration(vi.fn()).installIpc?.({
      ipcMain: { handle: (_channel, candidate) => { handler = candidate; }, removeHandler: vi.fn() },
      authorizedWebContents: sender,
      client: {} as never,
      services: { get: () => undefined },
    });

    await expect(handler?.({ sender, senderFrame: sender.mainFrame }, {
      method: "usage.snapshot",
      requestId: "usage-domain-3",
      params: { startDate: "bad", endDate: "2026-08-12" },
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
