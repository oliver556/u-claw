import { describe, expect, it, vi } from "vitest";

import { createSystemNodeDispatcher } from "../src/system-node/system-node-dispatcher.js";

describe("system node dispatcher", () => {
  it("dispatches allowed methods and preserves request correlation", async () => {
    const service = { listEnvironments: vi.fn(async () => ({ environments: [{ id: "gateway", type: "local", status: "available" }] })) };
    const dispatch = createSystemNodeDispatcher(service as never);
    await expect(dispatch({ method: "environments.list", requestId: "env-1", params: {} })).resolves.toEqual({
      method: "environments.list", requestId: "env-1", ok: true,
      result: { environments: [{ id: "gateway", type: "local", status: "available" }] },
    });
  });

  it("rejects arbitrary terminal command fields before service dispatch", async () => {
    const service = { openTerminal: vi.fn() };
    const dispatch = createSystemNodeDispatcher(service as never);
    await expect(dispatch({ method: "terminal.open", requestId: "terminal-1", params: { cols: 80, rows: 24, command: "whoami" } })).rejects.toThrow();
    expect(service.openTerminal).not.toHaveBeenCalled();
  });
});
