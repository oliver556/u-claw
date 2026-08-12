import { describe, expect, it } from "vitest";

import { SystemNodeIpcRequestSchema, SystemNodeIpcEventSchema, SystemNodeIpcResponseSchema } from "../src/system-node.js";

describe("system node IPC contract", () => {
  it("accepts every SYS-009 through SYS-016 operation", () => {
    const requests = [
      ["device.pair.list", {}], ["device.pair.approve", { requestId: "pair-1" }], ["device.pair.reject", { requestId: "pair-1" }],
      ["device.pair.remove", { deviceId: "device-1" }], ["device.token.rotate", { deviceId: "device-1", role: "operator", scopes: ["operator.read"] }],
      ["device.token.revoke", { deviceId: "device-1", role: "operator" }], ["node.list", {}], ["node.describe", { nodeId: "node-1" }],
      ["node.rename", { nodeId: "node-1", displayName: "Studio" }], ["node.pair.list", {}], ["node.pair.approve", { requestId: "pair-2" }],
      ["node.pair.reject", { requestId: "pair-2" }], ["node.pair.remove", { nodeId: "node-1" }],
      ["node.invoke", { nodeId: "node-1", command: "system.info", params: {}, timeoutMs: 10_000, idempotencyKey: "invoke-1" }],
      ["environments.list", {}], ["environments.status", { environmentId: "gateway" }], ["worktrees.list", {}],
      ["worktrees.create", { repoRoot: "/tmp/repo", name: "review", baseRef: "main" }], ["worktrees.remove", { id: "wt-1", force: false }],
      ["worktrees.restore", { id: "wt-1" }], ["worktrees.gc", {}], ["terminal.list", {}],
      ["terminal.open", { agentId: "main", cols: 80, rows: 24 }], ["terminal.input", { sessionId: "term-1", data: "printf ok\\n" }],
      ["terminal.resize", { sessionId: "term-1", cols: 100, rows: 30 }], ["terminal.attach", { sessionId: "term-1" }],
      ["terminal.text", { sessionId: "term-1" }], ["terminal.close", { sessionId: "term-1" }],
    ];
    for (const [method, params] of requests) {
      expect(SystemNodeIpcRequestSchema.safeParse({ method, requestId: `request-${method}`, params }).success, String(method)).toBe(true);
    }
  });

  it("rejects arbitrary host execution controls and unsafe node invoke overrides", () => {
    for (const unsafe of [
      { method: "terminal.open", requestId: "unsafe-1", params: { cols: 80, rows: 24, command: "rm -rf /" } },
      { method: "terminal.open", requestId: "unsafe-2", params: { cols: 80, rows: 24, cwd: "/", shell: "/bin/zsh", env: { TOKEN: "secret" } } },
      { method: "node.invoke", requestId: "unsafe-3", params: { nodeId: "node-1", command: "system.run", idempotencyKey: "x", params: { approved: true } } },
      { method: "node.invoke", requestId: "unsafe-4", params: { nodeId: "node-1", command: "system.run", idempotencyKey: "x", params: {} } },
    ]) expect(SystemNodeIpcRequestSchema.safeParse(unsafe).success).toBe(false);
    expect(SystemNodeIpcRequestSchema.safeParse({ method: "worktrees.create", requestId: "unsafe-name", params: { repoRoot: "/tmp/repo", name: "Bad Name" } }).success).toBe(false);
  });

  it("validates only authoritative lifecycle events", () => {
    expect(SystemNodeIpcEventSchema.parse({ event: "terminal.data", payload: { sessionId: "term-1", seq: 2, data: "ok" } })).toBeTruthy();
    expect(SystemNodeIpcEventSchema.parse({ event: "terminal.exit", payload: { sessionId: "term-1", exitCode: null, signal: 15 } })).toBeTruthy();
    expect(SystemNodeIpcEventSchema.parse({ event: "node.pair.resolved", payload: { requestId: "", nodeId: "node-1", decision: "removed", ts: 1 } })).toBeTruthy();
    expect(SystemNodeIpcEventSchema.parse({ event: "device.pair.requested", payload: { requestId: "pair-1", deviceId: "device-1", publicKey: "key", remoteIp: "10.0.0.2" } })).toEqual({ event: "device.pair.requested", payload: { requestId: "pair-1", deviceId: "device-1" } });
    expect(SystemNodeIpcEventSchema.safeParse({ event: "node.event", payload: { event: "arbitrary" } }).success).toBe(false);
  });

  it("fails closed when a Gateway response contains nested secrets", () => {
    expect(SystemNodeIpcResponseSchema.safeParse({ method: "device.token.rotate", requestId: "rotate-1", ok: true, result: { nested: { api_key: "secret" } } }).success).toBe(false);
    expect(SystemNodeIpcResponseSchema.safeParse({ method: "worktrees.list", requestId: "worktree-1", ok: true, result: { worktrees: [{ path: "/tmp/repo" }] } }).success).toBe(true);
  });
});
