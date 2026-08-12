import { describe, expect, it, vi } from "vitest";

import { createOpenClawSystemNodeService } from "../src/system-node.js";

describe("OpenClaw system node service", () => {
  it("uses exact RPC methods and reads authority after every mutation", async () => {
    const request = vi.fn(async (method: string) => method.endsWith(".list") ? { pending: [], paired: [], nodes: [], worktrees: [], sessions: [] } : { ok: true });
    const service = createOpenClawSystemNodeService({ request, requireMethod: () => undefined, onEvent: () => () => undefined });

    await service.approveDevice({ requestId: "pair-1" });
    await service.renameNode({ nodeId: "node-1", displayName: "Studio" });
    await service.removeWorktree({ id: "wt-1", force: true });
    await service.closeTerminal({ sessionId: "term-1" });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "device.pair.approve", "device.pair.list",
      "node.rename", "node.describe",
      "worktrees.remove", "worktrees.list",
      "terminal.close", "terminal.list",
    ]);
  });

  it("does not expose node.event and blocks approval override payloads", async () => {
    const request = vi.fn();
    const service = createOpenClawSystemNodeService({ request, requireMethod: () => undefined, onEvent: () => () => undefined });
    await expect(service.invokeNode({ nodeId: "node-1", command: "system.run", params: { approved: true }, idempotencyKey: "invoke-1" } as never)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(service.invokeNode({ nodeId: "node-1", command: "system.run", params: {}, idempotencyKey: "invoke-2" } as never)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(request).not.toHaveBeenCalled();
    expect(service).not.toHaveProperty("nodeEvent");
  });

  it("removes secrets from every Gateway result before it can cross IPC", async () => {
    const service = createOpenClawSystemNodeService({
      request: vi.fn(async (method: string) => method === "device.token.rotate"
        ? { deviceId: "device-1", role: "operator", scopes: ["operator.read"], token: "plain-token", apiKey: "secret", gatewayToken: "secret", nested: { value: "secret" } }
        : { pending: [], paired: [{ deviceId: "device-1", remoteIp: "127.0.0.1", publicKey: "key", role: "operator" }] }),
      requireMethod: () => undefined,
      onEvent: () => () => undefined,
    });
    await expect(service.rotateDeviceToken({ deviceId: "device-1", role: "operator" })).resolves.toEqual({
      mutation: { deviceId: "device-1", role: "operator", scopes: ["operator.read"] },
      authority: { pending: [], paired: [{ deviceId: "device-1", role: "operator" }] },
    });
  });

  it("streams terminal and pairing events and disposes subscriptions", () => {
    const listeners = new Map<string, (frame: { payload: unknown }) => void>();
    const removers: string[] = [];
    const service = createOpenClawSystemNodeService({ request: vi.fn(), requireMethod: () => undefined, onEvent: (event, listener) => { listeners.set(event, listener); return () => removers.push(event); } });
    const received: unknown[] = [];
    const dispose = service.subscribe((event) => received.push(event));
    listeners.get("terminal.data")?.({ payload: { sessionId: "term-1", seq: 1, data: "hello" } });
    listeners.get("node.pair.resolved")?.({ payload: { requestId: "p1", nodeId: "n1", decision: "approved", ts: 1 } });
    expect(received).toHaveLength(2);
    dispose();
    expect(removers).toContain("terminal.data");
  });
});
