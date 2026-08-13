import { describe, expect, it, vi } from "vitest";
import { installActivationPreloadBridge } from "../src/ipc/preload-bridge.js";
import { registerActivationIpc } from "../src/activation/register-ipc.js";

describe("activation-only IPC", () => {
  it("preload exposes only the five uclawActivation commands", async () => { const exposed: Record<string, unknown> = {}; const invoke = vi.fn(async () => ({ state: "input" })); installActivationPreloadBridge({ contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } }, ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() } }); expect(Object.keys(exposed)).toEqual(["uclawActivation"]); expect(Object.keys(exposed.uclawActivation as object).sort()).toEqual(["cancel", "close", "commit", "preflight", "submit"]); expect(exposed).not.toHaveProperty("uclaw"); await (exposed.uclawActivation as any).commit(); expect(invoke).toHaveBeenCalledWith("activation.commit", undefined); });
  it("registers only restricted handlers and rejects foreign senders", async () => { const handlers = new Map<string, Function>(); const sender = { mainFrame: {} }; const coordinator = { preflight: vi.fn(), submit: vi.fn(), status: vi.fn(), cancel: vi.fn(), close: vi.fn() }; const registration = registerActivationIpc({ ipcMain: { handle: (c: string, h: Function) => handlers.set(c, h), removeHandler: (c: string) => handlers.delete(c) } as never, authorizedWebContents: sender as never, coordinator: coordinator as never }); expect([...handlers.keys()].sort()).toEqual(["activation.cancel", "activation.commit", "activation.preflight", "activation.submit", "window.close"]); await expect(handlers.get("activation.preflight")!({ sender: {}, senderFrame: {} })).rejects.toThrow(/Unauthorized/); registration.dispose(); expect(handlers.size).toBe(0); });

  it("strictly validates submit and maps failures to fixed safe responses", async () => {
    const handlers = new Map<string, Function>(); const sender = { mainFrame: {} };
    const coordinator = { preflight: vi.fn(), submit: vi.fn(async () => { throw new Error("raw server body secret"); }), commit: vi.fn(), cancel: vi.fn(), close: vi.fn() };
    registerActivationIpc({ ipcMain: { handle: (c: string, h: Function) => handlers.set(c, h), removeHandler: vi.fn() } as never, authorizedWebContents: sender as never, coordinator: coordinator as never, closeWindow: vi.fn() });
    const invoke = (payload: unknown) => handlers.get("activation.submit")!({ sender, senderFrame: sender.mainFrame }, payload);
    await expect(invoke({ username: "alice", activationCode: "0".repeat(26), usbFingerprint: {} })).resolves.toEqual({ state: "error", code: "INVALID_INPUT" });
    await expect(invoke({ username: "alice", activationCode: "0".repeat(26) })).resolves.toEqual({ state: "error", code: "ACTIVATION_FAILED" });
  });

  it("treats activation.commit as a read-only status query", async () => {
    const handlers = new Map<string, Function>(); const sender = { mainFrame: {} };
    const status = { state: "writing" as const };
    const coordinator = { preflight: vi.fn(), submit: vi.fn(), status: vi.fn(() => status), commit: vi.fn(), cancel: vi.fn(), close: vi.fn() };
    registerActivationIpc({ ipcMain: { handle: (c: string, h: Function) => handlers.set(c, h), removeHandler: vi.fn() } as never, authorizedWebContents: sender as never, coordinator: coordinator as never });

    await expect(handlers.get("activation.commit")!({ sender, senderFrame: sender.mainFrame }, undefined)).resolves.toEqual(status);
    expect(coordinator.status).toHaveBeenCalledOnce();
    expect(coordinator.commit).not.toHaveBeenCalled();
  });

  it("rolls back partial registration and closes only after coordinator close", async () => {
    const registered = new Map<string, Function>();
    expect(() => registerActivationIpc({ ipcMain: { handle: (c: string, h: Function) => { if (c === "activation.commit") throw new Error("duplicate"); registered.set(c, h); }, removeHandler: (c: string) => registered.delete(c) } as never, authorizedWebContents: { mainFrame: {} } as never, coordinator: {} as never, closeWindow: vi.fn() })).toThrow("duplicate");
    expect(registered.size).toBe(0);

    const order: string[] = []; const handlers = new Map<string, Function>(); const sender = { mainFrame: {} };
    const coordinator = { preflight: vi.fn(), submit: vi.fn(), commit: vi.fn(), cancel: vi.fn(), close: vi.fn(() => { order.push("coordinator"); return { state: "input" }; }) };
    registerActivationIpc({ ipcMain: { handle: (c: string, h: Function) => handlers.set(c, h), removeHandler: vi.fn() } as never, authorizedWebContents: sender as never, coordinator: coordinator as never, closeWindow: () => { order.push("window"); } });
    await handlers.get("window.close")!({ sender, senderFrame: sender.mainFrame });
    expect(order).toEqual(["coordinator", "window"]);
  });

  it("redacts failures from every authorized coordinator channel", async () => {
    const handlers = new Map<string, Function>(); const sender = { mainFrame: {} }; const raw = "Bearer private-token /private/path";
    const fail = vi.fn(() => { throw new Error(raw); });
    registerActivationIpc({ ipcMain: { handle: (c: string, h: Function) => handlers.set(c, h), removeHandler: vi.fn() } as never, authorizedWebContents: sender as never, coordinator: { preflight: fail, submit: fail, commit: fail, cancel: fail, close: fail } as never, closeWindow: vi.fn() });
    for (const channel of ["activation.preflight", "activation.commit", "activation.cancel", "window.close"]) {
      const result = await handlers.get(channel)!({ sender, senderFrame: sender.mainFrame }, undefined);
      expect(result).toEqual({ state: "error", code: "ACTIVATION_FAILED" });
      expect(JSON.stringify(result)).not.toContain(raw);
    }
  });
});
