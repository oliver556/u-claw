import { describe, expect, it, vi } from "vitest";

import * as desktop from "../src/index.js";

const unavailableSnapshot = {
  schemaVersion: 1, storage: { state: "healthy" as const },
  runtime: { state: "unavailable" as const, reason: "locked-runtime-no-mcp-rpc" as const },
  servers: [{
    id: "docs", name: "Docs", enabled: true, transport: "streamable-http" as const,
    endpointHint: "mcp.example.com", authentication: { type: "none" as const, configured: false as const },
    status: "unavailable" as const, capabilitySummary: { tools: 0, resources: 0, prompts: 0 }, toolNames: [], resourceSchemes: [],
  }],
};

const riskyStdioServer = (overrides: Record<string, unknown> = {}) => ({
  id: "package", name: "Package", enabled: true, transport: "stdio" as const,
  executableId: "npx" as const, args: ["@modelcontextprotocol/server-filesystem"], env: {},
  ...overrides,
});

describe("MCP dispatcher", () => {
  it("keeps configured servers, live probe, effective tools, and approval policy as separate results", async () => {
    const store = { list: vi.fn(async () => unavailableSnapshot) };
    const runtime = { capability: () => false, test: vi.fn() };
    const capabilities = {
      tools: vi.fn(async () => ({
        agentId: "main", sessionKey: "agent:main:main", catalog: { groups: [] }, commands: [],
        effective: { profile: "coding", groups: [], notices: [] },
      })),
      approvalsGet: vi.fn(async () => ({ exists: true, hash: "hash-1", policy: { security: "allowlist", ask: "on-miss", askFallback: "deny", autoAllowSkills: false } })),
      approvalsSet: vi.fn(),
    };
    const dispatch = (desktop as any).createMcpDispatcher(store, runtime, capabilities);

    await expect(dispatch({ method: "mcp.list", requestId: "list", params: {} }))
      .resolves.toMatchObject({ result: { runtime: { state: "unavailable" } } });
    await expect(dispatch({ method: "capabilities.tools", requestId: "tools", params: { agentId: "main", sessionKey: "agent:main:main" } }))
      .resolves.toMatchObject({ result: { effective: { profile: "coding" } } });
    await expect(dispatch({ method: "capabilities.approvals-get", requestId: "policy", params: {} }))
      .resolves.toMatchObject({ result: { hash: "hash-1", policy: { security: "allowlist" } } });
  });

  it("writes approval policy through the Gateway runtime with the caller base hash", async () => {
    const store = {};
    const runtime = { capability: () => false, test: vi.fn() };
    const policy = { security: "deny" as const, ask: "always" as const, askFallback: "deny" as const, autoAllowSkills: false };
    const capabilities = {
      tools: vi.fn(), approvalsGet: vi.fn(),
      approvalsSet: vi.fn(async () => ({ exists: true, hash: "hash-2", policy })),
    };
    const dispatch = (desktop as any).createMcpDispatcher(store, runtime, capabilities);

    await expect(dispatch({ method: "capabilities.approvals-set", requestId: "set", params: { baseHash: "hash-1", policy } }))
      .resolves.toMatchObject({ result: { hash: "hash-2", policy } });
    expect(capabilities.approvalsSet).toHaveBeenCalledWith({ baseHash: "hash-1", policy });
  });

  it("configures an available runtime and compensates when portable persistence fails", async () => {
    const server = { id: "docs", name: "Docs", enabled: true, transport: "streamable-http", url: "https://mcp.example.com", authentication: { type: "none" } };
    const store = {
      create: vi.fn(async () => { throw new Error("USB write failed"); }),
      getForRuntime: vi.fn(),
    };
    const runtime = {
      capability: () => true,
      configure: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      test: vi.fn(),
    };
    const dispatch = (desktop as any).createMcpDispatcher(store, runtime);
    await expect(dispatch({ method: "mcp.create", requestId: "create-1", params: { server } })).rejects.toThrow("USB write failed");
    expect(runtime.configure).toHaveBeenCalledWith(server, expect.any(AbortSignal));
    expect(runtime.start).toHaveBeenCalledWith(server, expect.any(AbortSignal));
    expect(runtime.stop).toHaveBeenCalledWith(server, expect.any(AbortSignal));
    expect(runtime.remove).toHaveBeenCalledWith(server, expect.any(AbortSignal));
  });

  it("stores an unconfirmed risky stdio create disabled without configuring runtime", async () => {
    const server = riskyStdioServer();
    const store = {
      create: vi.fn(async () => unavailableSnapshot),
      getForRuntime: vi.fn(),
    };
    const runtime = {
      capability: () => true,
      configure: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      test: vi.fn(),
    };
    const dispatch = (desktop as any).createMcpDispatcher(store, runtime);

    await expect(dispatch({ method: "mcp.create", requestId: "create-risky", params: { server } }))
      .resolves.toMatchObject({ ok: true });
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({ id: "package", enabled: false }));
    expect(runtime.configure).not.toHaveBeenCalled();
  });

  it("stores a changed risky stdio update disabled and removes the old runtime config", async () => {
    const previous = riskyStdioServer({
      args: ["@modelcontextprotocol/server-old"],
      confirmedRiskFingerprint: (desktop as any).assessMcpStdioPolicy(riskyStdioServer({ args: ["@modelcontextprotocol/server-old"] })).fingerprint,
    });
    const store = {
      getForRuntime: vi.fn(async () => previous),
      update: vi.fn(async () => unavailableSnapshot),
    };
    const runtime = {
      capability: () => true,
      configure: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      test: vi.fn(),
    };
    const dispatch = (desktop as any).createMcpDispatcher(store, runtime);

    await expect(dispatch({ method: "mcp.update", requestId: "update-risky", params: { serverId: "package", server: riskyStdioServer() } }))
      .resolves.toMatchObject({ ok: true });
    expect(runtime.configure).not.toHaveBeenCalled();
    expect(runtime.stop).toHaveBeenCalledWith(previous, expect.any(AbortSignal));
    expect(runtime.remove).toHaveBeenCalledWith(previous, expect.any(AbortSignal));
    expect(store.update).toHaveBeenCalledWith("package", expect.objectContaining({ enabled: false }));
  });

  it("rejects enabling unconfirmed risky stdio before runtime start or persistence", async () => {
    const store = {
      getForRuntime: vi.fn(async () => riskyStdioServer({ enabled: false })),
      setEnabled: vi.fn(async () => unavailableSnapshot),
    };
    const runtime = {
      capability: () => true,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      test: vi.fn(),
    };
    const dispatch = (desktop as any).createMcpDispatcher(store, runtime);

    await expect(dispatch({ method: "mcp.set-enabled", requestId: "enable-risky", params: { serverId: "package", enabled: true } }))
      .rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect(runtime.start).not.toHaveBeenCalled();
    expect(store.setEnabled).not.toHaveBeenCalled();
  });

  it("configures a confirmed risky stdio server before enabling it", async () => {
    const draft = riskyStdioServer({ enabled: false });
    const previous = { ...draft, confirmedRiskFingerprint: (desktop as any).assessMcpStdioPolicy(draft).fingerprint };
    const store = {
      getForRuntime: vi.fn(async () => previous),
      setEnabled: vi.fn(async () => unavailableSnapshot),
    };
    const runtime = {
      capability: () => true,
      configure: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      test: vi.fn(),
    };
    const dispatch = (desktop as any).createMcpDispatcher(store, runtime);
    await expect(dispatch({ method: "mcp.set-enabled", requestId: "enable-confirmed", params: { serverId: "package", enabled: true } }))
      .resolves.toMatchObject({ ok: true });
    expect(runtime.configure).toHaveBeenCalledWith(previous, expect.any(AbortSignal));
    expect(runtime.start).toHaveBeenCalledWith(previous, expect.any(AbortSignal));
    expect(store.setEnabled).toHaveBeenCalledWith("package", true);
  });

  it.each(["mcp.test", "mcp.reconnect"] as const)("rejects unconfirmed risky stdio %s before runtime calls", async (method) => {
    const store = {
      getForRuntime: vi.fn(async () => riskyStdioServer()),
      record: vi.fn(),
    };
    const runtime = {
      capability: () => true,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      test: vi.fn(),
    };
    const dispatch = (desktop as any).createMcpDispatcher(store, runtime);

    await expect(dispatch({ method, requestId: `${method}-risky`, params: { serverId: "package" } }))
      .rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect(runtime.start).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.test).not.toHaveBeenCalled();
    expect(store.record).not.toHaveBeenCalled();
  });

  it("reports locked runtime as unavailable without invoking a connection probe", async () => {
    const store = {
      list: vi.fn(async () => unavailableSnapshot),
      getForRuntime: vi.fn(async () => ({ id: "docs", enabled: true, transport: "streamable-http", url: "https://mcp.example.com", authentication: { type: "none" } })),
      record: vi.fn(async (_id: string, update: any) => ({ ...unavailableSnapshot.servers[0], ...update })),
    };
    const runtime = { capability: () => false, test: vi.fn() };
    const dispatch = (desktop as any).createMcpDispatcher(store, runtime);
    const response = await dispatch({ method: "mcp.test", requestId: "test-1", params: { serverId: "docs" } });
    expect(response).toMatchObject({ ok: true, result: { status: "unavailable", lastError: { code: "UNAVAILABLE" } } });
    expect(runtime.test).not.toHaveBeenCalled();
  });

  it("merges renderer-safe update patches with main-process-only fields", async () => {
    const previous = {
      id: "docs", name: "Docs", enabled: true, transport: "streamable-http",
      url: "https://mcp.example.com/rpc", authentication: { type: "bearer", secret: "main-only-secret" },
    };
    const store = {
      getForRuntime: vi.fn(async () => previous),
      update: vi.fn(async () => unavailableSnapshot),
    };
    const runtime = {
      capability: () => true,
      configure: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      test: vi.fn(),
    };
    const dispatch = (desktop as any).createMcpDispatcher(store, runtime);
    await dispatch({ method: "mcp.update", requestId: "update-1", params: { serverId: "docs", server: {
      id: "docs", name: "Renamed", enabled: true, transport: "streamable-http", authentication: { type: "bearer" },
    } } });
    const resolved = {
      id: "docs", name: "Renamed", enabled: true, transport: "streamable-http",
      url: "https://mcp.example.com/rpc", authentication: { type: "bearer", secret: "main-only-secret" },
    };
    expect(runtime.configure).toHaveBeenCalledWith(resolved, expect.any(AbortSignal));
    expect(runtime.start).toHaveBeenCalledWith(resolved, expect.any(AbortSignal));
    expect(store.update).toHaveBeenCalledWith("docs", resolved);
  });

  it("configures a server before reconnecting it", async () => {
    const server = { id: "docs", name: "Docs", enabled: true, transport: "streamable-http", url: "https://mcp.example.com", authentication: { type: "none" } };
    const connected = { ...unavailableSnapshot.servers[0], status: "connected" };
    const store = {
      getForRuntime: vi.fn(async () => server),
      record: vi.fn(async (_id: string, update: any) => ({ ...connected, ...update })),
    };
    const runtime = {
      capability: () => true,
      configure: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      test: vi.fn(async () => ({ status: "connected", capabilitySummary: { tools: 0, resources: 0, prompts: 0 }, toolNames: [], resourceSchemes: [] })),
    };
    const dispatch = (desktop as any).createMcpDispatcher(store, runtime);
    await expect(dispatch({ method: "mcp.reconnect", requestId: "reconnect-configure", params: { serverId: "docs" } })).resolves.toMatchObject({ ok: true });
    expect(runtime.configure).toHaveBeenCalledWith(server, expect.any(AbortSignal));
    expect(runtime.stop).toHaveBeenCalledWith(server, expect.any(AbortSignal));
    expect(runtime.start).toHaveBeenCalledWith(server, expect.any(AbortSignal));
  });

  it("rejects reconnect for a disabled server before runtime calls", async () => {
    const server = { id: "docs", name: "Docs", enabled: false, transport: "streamable-http", url: "https://mcp.example.com", authentication: { type: "none" } };
    const store = { getForRuntime: vi.fn(async () => server), record: vi.fn() };
    const runtime = { capability: () => true, configure: vi.fn(), stop: vi.fn(), start: vi.fn(), test: vi.fn() };
    const dispatch = (desktop as any).createMcpDispatcher(store, runtime);

    await expect(dispatch({ method: "mcp.reconnect", requestId: "reconnect-disabled", params: { serverId: "docs" } }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(runtime.configure).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.start).not.toHaveBeenCalled();
    expect(store.record).not.toHaveBeenCalled();
  });

  it("restores a stopped server when reconnect start fails", async () => {
    const server = { id: "docs", name: "Docs", enabled: true, transport: "streamable-http", url: "https://mcp.example.com", authentication: { type: "none" } };
    const store = { getForRuntime: vi.fn(async () => server), record: vi.fn() };
    const runtime = {
      capability: () => true,
      configure: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      start: vi.fn().mockRejectedValueOnce(new Error("restart failed")).mockResolvedValueOnce(undefined),
      test: vi.fn(),
    };
    const dispatch = (desktop as any).createMcpDispatcher(store, runtime);

    await expect(dispatch({ method: "mcp.reconnect", requestId: "reconnect-fails", params: { serverId: "docs" } }))
      .rejects.toThrow("restart failed");
    expect(runtime.start).toHaveBeenCalledTimes(2);
    expect(runtime.start).toHaveBeenLastCalledWith(server, expect.any(AbortSignal));
  });

  it("restores an enabled runtime server when portable removal fails", async () => {
    const server = { id: "docs", name: "Docs", enabled: true, transport: "streamable-http", url: "https://mcp.example.com", authentication: { type: "none" } };
    const store = {
      getForRuntime: vi.fn(async () => server),
      remove: vi.fn(async () => { throw new Error("USB write failed"); }),
    };
    const runtime = {
      capability: () => true,
      remove: vi.fn(async () => undefined),
      configure: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
    };
    const dispatch = (desktop as any).createMcpDispatcher(store, runtime);

    await expect(dispatch({ method: "mcp.remove", requestId: "remove-fails", params: { serverId: "docs", confirmed: true } }))
      .rejects.toThrow("USB write failed");
    expect(runtime.configure).toHaveBeenCalledWith(server, expect.any(AbortSignal));
    expect(runtime.start).toHaveBeenCalledWith(server, expect.any(AbortSignal));
  });

  it("serializes lifecycle operations for the same server ID", async () => {
    const server = { id: "docs", name: "Docs", enabled: true, transport: "streamable-http", url: "https://mcp.example.com", authentication: { type: "none" } };
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    const store = {
      getForRuntime: vi.fn(async () => server),
      setEnabled: vi.fn(async () => unavailableSnapshot),
      remove: vi.fn(async () => unavailableSnapshot),
    };
    const runtime = {
      capability: () => true,
      stop: vi.fn(async () => stopGate),
      start: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      configure: vi.fn(async () => undefined),
      test: vi.fn(),
    };
    const dispatch = (desktop as any).createMcpDispatcher(store, runtime);
    const disabling = dispatch({ method: "mcp.set-enabled", requestId: "disable-first", params: { serverId: "docs", enabled: false } });
    await vi.waitFor(() => expect(runtime.stop).toHaveBeenCalledTimes(1));
    const removing = dispatch({ method: "mcp.remove", requestId: "remove-second", params: { serverId: "docs", confirmed: true } });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getForRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.remove).not.toHaveBeenCalled();
    releaseStop();
    await expect(Promise.all([disabling, removing])).resolves.toHaveLength(2);
    expect(store.getForRuntime).toHaveBeenCalledTimes(2);
    expect(runtime.remove).toHaveBeenCalledTimes(1);
  });

  it("cancels a queued connection test before it can touch runtime or storage", async () => {
    const server = { id: "docs", name: "Docs", enabled: true, transport: "streamable-http", url: "https://mcp.example.com", authentication: { type: "none" } };
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    const store = {
      getForRuntime: vi.fn(async () => server),
      setEnabled: vi.fn(async () => unavailableSnapshot),
      record: vi.fn(),
    };
    const runtime = {
      capability: () => true,
      stop: vi.fn(async () => stopGate),
      start: vi.fn(async () => undefined),
      test: vi.fn(),
    };
    const dispatch = (desktop as any).createMcpDispatcher(store, runtime);
    const disabling = dispatch({ method: "mcp.set-enabled", requestId: "disable-blocking", params: { serverId: "docs", enabled: false } });
    await vi.waitFor(() => expect(runtime.stop).toHaveBeenCalledTimes(1));
    const queued = dispatch({ method: "mcp.test", requestId: "queued-test", params: { serverId: "docs" } });

    await expect(dispatch({ method: "mcp.cancel", requestId: "cancel-queued", params: { operationRequestId: "queued-test" } }))
      .resolves.toMatchObject({ ok: true });
    releaseStop();
    await expect(disabling).resolves.toMatchObject({ ok: true });
    await expect(queued).rejects.toMatchObject({ code: "CANCELLED" });
    expect(runtime.test).not.toHaveBeenCalled();
    expect(store.record).not.toHaveBeenCalled();
  });

  it("rejects MCP server ID changes before touching runtime or storage", async () => {
    const store = {
      getForRuntime: vi.fn(async () => ({
        id: "docs", name: "Docs", enabled: true, transport: "streamable-http",
        url: "https://mcp.example.com/rpc", authentication: { type: "none" },
      })),
      update: vi.fn(),
    };
    const runtime = { capability: () => true, configure: vi.fn(), test: vi.fn() };
    const dispatch = (desktop as any).createMcpDispatcher(store, runtime);
    await expect(dispatch({ method: "mcp.update", requestId: "rename-1", params: { serverId: "docs", server: {
      id: "renamed", name: "Docs", enabled: true, transport: "streamable-http", authentication: { type: "none" },
    } } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(runtime.configure).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
  });

  it("records handshake capabilities and supports cancellation", async () => {
    let signal: AbortSignal | undefined;
    const connected = { ...unavailableSnapshot.servers[0], status: "connected", capabilitySummary: { tools: 1, resources: 1, prompts: 0 }, toolNames: ["search"], resourceSchemes: ["docs"] };
    const store = {
      list: vi.fn(async () => ({ ...unavailableSnapshot, runtime: { state: "available" }, servers: [connected] })),
      getForRuntime: vi.fn(async () => ({ id: "docs", name: "Docs", enabled: true, transport: "streamable-http", url: "https://mcp.example.com", authentication: { type: "none" } })),
      record: vi.fn(async (_id: string, update: any) => ({ ...connected, ...update })),
    };
    const runtime = {
      capability: () => true,
      test: vi.fn((_server: unknown, operationSignal: AbortSignal) => {
        signal = operationSignal;
        return new Promise((resolve) => operationSignal.addEventListener("abort", () => resolve({ status: "error", error: { code: "CANCELLED", message: "cancelled", retryable: true, recoveryActions: ["retry"], causeDetails: {} } }), { once: true }));
      }),
    };
    const dispatch = (desktop as any).createMcpDispatcher(store, runtime);
    const pending = dispatch({ method: "mcp.test", requestId: "test-active", params: { serverId: "docs" } });
    await vi.waitFor(() => expect(signal).toBeDefined());
    const cancelled = await dispatch({ method: "mcp.cancel", requestId: "cancel-1", params: { operationRequestId: "test-active" } });
    expect(cancelled).toMatchObject({ ok: true, result: null });
    await expect(pending).resolves.toMatchObject({ ok: true, result: { lastError: { code: "CANCELLED" } } });
    expect(signal?.aborted).toBe(true);
  });
});
