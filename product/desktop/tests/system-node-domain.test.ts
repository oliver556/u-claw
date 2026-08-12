import { describe, expect, it, vi } from "vitest";
import { SYSTEM_NODE_IPC_CHANNEL, SYSTEM_NODE_IPC_EVENT_CHANNEL } from "@uclaw/shared/dist/system-node.js";
import { createSystemNodeDomainRegistration } from "../src/system-node/system-node-domain.js";
import { createProductionSystemNodeDomain } from "../src/system-node/production-system-node.js";

describe("system node IPC domain", () => {
  it("authorizes request sender, validates input, and forwards validated events", async () => {
    let handler: ((event: unknown, payload: unknown) => Promise<unknown>) | undefined;
    const sent: unknown[] = [];
    const frame = {};
    const sender = { mainFrame: frame, send: (channel: string, payload: unknown) => sent.push({ channel, payload }) };
    let publish: ((event: never) => void) | undefined;
    const service = { subscribe: vi.fn((listener: typeof publish) => { publish = listener; return vi.fn(); }) };
    createSystemNodeDomainRegistration(vi.fn(async () => ({ ok: true })), service as never).installIpc?.({
      ipcMain: { handle: vi.fn((_channel, fn) => { handler = fn; }), removeHandler: vi.fn() }, authorizedWebContents: sender, client: {} as never, services: { get: () => undefined },
    });
    await expect(handler?.({ sender: {}, senderFrame: frame }, { method: "environments.list", requestId: "e1", params: {} })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(handler?.({ sender, senderFrame: frame }, { method: "terminal.open", requestId: "e2", params: { cols: 80, rows: 24, shell: "/bin/zsh" } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    publish?.({ event: "terminal.data", payload: { sessionId: "t1", seq: 1, data: "ok" } } as never);
    expect(sent).toEqual([{ channel: SYSTEM_NODE_IPC_EVENT_CHANNEL, payload: { event: "terminal.data", payload: { sessionId: "t1", seq: 1, data: "ok" } } }]);
    expect(handler).toBeDefined();
    expect(SYSTEM_NODE_IPC_CHANNEL).toBe("uclaw:system-node");
  });

  it("keeps host Terminal access disabled unless production wiring explicitly trusts the admin surface", async () => {
    const request = vi.fn(async () => ({ sessions: [] }));
    const listeners = new Map<string, (frame: { payload: unknown }) => void>();
    const options = { request, onEvent: vi.fn((event: string, listener: (frame: { payload: unknown }) => void) => { listeners.set(event, listener); return vi.fn(); }), requireMethod: vi.fn() };
    let defaultHandler: ((event: unknown, payload: unknown) => Promise<unknown>) | undefined;
    const frame = {};
    const sender = { mainFrame: frame, send: vi.fn() };
    createProductionSystemNodeDomain(options).installIpc?.({
      ipcMain: { handle: vi.fn((_channel, fn) => { defaultHandler = fn; }), removeHandler: vi.fn() }, authorizedWebContents: sender, client: {} as never, services: { get: () => undefined },
    });
    listeners.get("terminal.data")?.({ payload: { sessionId: "term-1", seq: 1, data: "secret" } });
    listeners.get("device.pair.requested")?.({ payload: { requestId: "pair-1", deviceId: "device-1" } });

    await expect(defaultHandler?.({ sender, senderFrame: frame }, { method: "terminal.list", requestId: "blocked", params: {} })).resolves.toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(request).not.toHaveBeenCalled();
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenCalledWith(SYSTEM_NODE_IPC_EVENT_CHANNEL, expect.objectContaining({ event: "device.pair.requested" }));

    let injectedHandler: ((event: unknown, payload: unknown) => Promise<unknown>) | undefined;
    createProductionSystemNodeDomain({ ...options, trustedAdminTerminal: true, gatewayEnvironment: { PATH: "/usr/bin" } } as never).installIpc?.({
      ipcMain: { handle: vi.fn((_channel, fn) => { injectedHandler = fn; }), removeHandler: vi.fn() }, authorizedWebContents: sender, client: {} as never, services: { get: () => undefined },
    });
    await expect(injectedHandler?.({ sender, senderFrame: frame }, { method: "terminal.list", requestId: "injected", params: {} })).resolves.toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(request).not.toHaveBeenCalled();
  });
});
