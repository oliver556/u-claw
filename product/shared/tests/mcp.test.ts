import { describe, expect, it } from "vitest";

import * as shared from "../src/index.js";

type Schema = { safeParse(value: unknown): { success: boolean }; parse(value: unknown): unknown };

describe("MCP contracts", () => {
  const api = shared as unknown as Record<string, unknown>;

  it("rejects an empty MCP URL without throwing from safeParse", () => {
    const schema = api.McpServerDraftSchema as Schema;
    const value = {
      id: "empty-url", name: "Empty URL", enabled: true, transport: "streamable-http",
      url: "", authentication: { type: "none" },
    };
    expect(() => schema.safeParse(value)).not.toThrow();
    expect(schema.safeParse(value).success).toBe(false);
  });

  it("rejects unsupported legacy SSE transport", () => {
    const schema = api.McpServerDraftSchema as Schema;
    expect(schema.safeParse({
      id: "legacy-sse", name: "Legacy SSE", enabled: true, transport: "sse",
      url: "https://mcp.example.com/sse", authentication: { type: "none" },
    }).success).toBe(false);
  });

  it("keeps MCP lifecycle independent and whitelists supported transports", () => {
    const request = api.McpIpcRequestSchema as Schema;
    expect(request.parse({ method: "mcp.list", requestId: "list-1", params: {} })).toBeTruthy();
    expect(request.parse({ method: "mcp.create", requestId: "create-1", params: { server: {
      id: "docs", name: "Docs", enabled: true, transport: "streamable-http",
      url: "https://mcp.example.com/rpc", authentication: { type: "bearer", secret: "one-use-secret" },
    } } })).toBeTruthy();
    expect(request.safeParse({ method: "skills.create", requestId: "wrong-domain", params: {} }).success).toBe(false);
    expect(request.safeParse({ method: "mcp.create", requestId: "unsupported", params: { server: {
      id: "ws", name: "WebSocket", enabled: true, transport: "websocket", url: "wss://example.com",
    } } }).success).toBe(false);
  });

  it("uses controlled stdio executable contracts and explicit risk confirmation", () => {
    const request = api.McpIpcRequestSchema as Schema;
    expect(request.parse({ method: "mcp.create", requestId: "stdio-1", params: { server: {
      id: "filesystem", name: "Filesystem", enabled: true, transport: "stdio",
      executableId: "node", args: ["server.js"], env: { MCP_MODE: "read-only" },
    } } })).toBeTruthy();
    expect(request.safeParse({ method: "mcp.create", requestId: "self-confirmed", params: { server: {
      id: "filesystem", name: "Filesystem", enabled: true, transport: "stdio",
      executableId: "node", args: ["server.js"], env: {}, riskConfirmed: true,
    } } }).success).toBe(false);
    expect(request.safeParse({ method: "mcp.create", requestId: "raw-command", params: { server: {
      id: "bad", name: "Bad", enabled: true, transport: "stdio", command: "sh -c whoami",
    } } }).success).toBe(false);
    expect(request.safeParse({ method: "mcp.create", requestId: "raw-path", params: { server: {
      id: "bad", name: "Bad", enabled: true, transport: "stdio", executableId: "/tmp/node", args: [],
    } } }).success).toBe(false);
    expect(request.parse({ method: "mcp.confirm-risk", requestId: "confirm-1", params: {
      serverId: "filesystem", fingerprint: "sha256:fixture-risk", confirmed: true,
    } })).toBeTruthy();
  });

  it("publishes status and capability summaries without secrets, paths, or tool bodies", () => {
    const response = api.McpIpcResponseSchema as Schema;
    const snapshot = {
      schemaVersion: 1, runtime: { state: "unavailable", reason: "locked-runtime-no-mcp-rpc" },
      servers: [{
        id: "docs", name: "Docs", enabled: true, transport: "streamable-http",
        endpointHint: "mcp.example.com", authentication: { type: "bearer", configured: true, hint: "...cret" },
        status: "unavailable", capabilitySummary: { tools: 2, resources: 1, prompts: 0 },
        toolNames: ["search", "read"], resourceSchemes: ["docs"], lastError: { code: "UNAVAILABLE", message: "Runtime MCP RPC unavailable.", retryable: false },
      }],
    };
    expect(response.parse({ method: "mcp.list", requestId: "list-1", ok: true, result: snapshot })).toBeTruthy();
    expect(response.safeParse({ method: "mcp.list", requestId: "leak-1", ok: true, result: {
      ...snapshot, servers: [{ ...snapshot.servers[0], authentication: { type: "bearer", secret: "leak" } }],
    } }).success).toBe(false);
    expect(response.safeParse({ method: "mcp.list", requestId: "body-1", ok: true, result: {
      ...snapshot, servers: [{ ...snapshot.servers[0], tools: [{ name: "read", arguments: { path: "/secret" } }] }],
    } }).success).toBe(false);
  });

  it("defines test, reconnect, enable, delete, and cancellation operations", () => {
    const request = api.McpIpcRequestSchema as Schema;
    for (const value of [
      { method: "mcp.test", requestId: "test-1", params: { serverId: "docs" } },
      { method: "mcp.reconnect", requestId: "reconnect-1", params: { serverId: "docs" } },
      { method: "mcp.set-enabled", requestId: "enable-1", params: { serverId: "docs", enabled: false } },
      { method: "mcp.remove", requestId: "remove-1", params: { serverId: "docs", confirmed: true } },
      { method: "mcp.cancel", requestId: "cancel-1", params: { operationRequestId: "test-1" } },
    ]) expect(request.parse(value)).toBeTruthy();
  });

  it("defines distinct tool catalog, effective projection, command, and approval policy operations", () => {
    const request = api.McpIpcRequestSchema as Schema;
    const response = api.McpIpcResponseSchema as Schema;
    for (const value of [
      { method: "capabilities.tools", requestId: "tools-1", params: { agentId: "main", sessionKey: "agent:main:main" } },
      { method: "capabilities.approvals-get", requestId: "policy-1", params: {} },
      { method: "capabilities.approvals-set", requestId: "policy-2", params: {
        baseHash: "hash-1", policy: { security: "allowlist", ask: "on-miss", askFallback: "deny", autoAllowSkills: false },
      } },
    ]) expect(request.parse(value)).toBeTruthy();
    expect(response.parse({
      method: "capabilities.tools", requestId: "tools-1", ok: true, result: {
        agentId: "main", sessionKey: "agent:main:main",
        catalog: { groups: [{ id: "core", label: "Core", source: "core", tools: [{ id: "read", label: "Read", description: "Read files", source: "core", defaultProfiles: ["coding"] }] }] },
        commands: [{ name: "status", description: "Show status", source: "native", scope: "both", acceptsArgs: false }],
        effective: { profile: "coding", groups: [{ id: "mcp", label: "MCP", source: "mcp", tools: [{ id: "docs.search", label: "Search", description: "Search docs", source: "mcp" }] }], notices: [] },
      },
    })).toBeTruthy();
  });

  it("redacts sensitive text from the tool projection before it reaches renderer", () => {
    const response = api.McpIpcResponseSchema as { parse(value: unknown): any };
    const parsed = response.parse({
      method: "capabilities.tools", requestId: "tools-redaction", ok: true, result: {
        agentId: "main", sessionKey: "agent:main:main",
        catalog: { groups: [{ id: "core", label: "Authorization: Bearer catalog-secret", source: "core", tools: [{
          id: "read", label: "Read", description: "token=tool-secret", source: "core",
          tags: ["api_key=tag-secret"], defaultProfiles: ["coding"],
        }] }] },
        commands: [{ name: "status", description: "password=command-secret", source: "native", scope: "both", acceptsArgs: false }],
        effective: { profile: "coding", groups: [{ id: "mcp", label: "MCP", source: "mcp", tools: [] }], notices: [{
          id: "notice", severity: "warning", message: "Authorization: Bearer notice-secret",
        }] },
      },
    });
    expect(JSON.stringify(parsed)).not.toContain("secret");
    expect(JSON.stringify(parsed)).toContain("[REDACTED]");
  });

  it("allows renderer-safe update patches to preserve main-process-only fields", () => {
    const request = api.McpIpcRequestSchema as Schema;
    expect(request.parse({ method: "mcp.update", requestId: "update-http", params: {
      serverId: "docs",
      server: {
        id: "docs", name: "Renamed docs", enabled: true, transport: "streamable-http",
        authentication: { type: "bearer" },
      },
    } })).toBeTruthy();
    expect(request.parse({ method: "mcp.update", requestId: "update-stdio", params: {
      serverId: "local",
      server: {
        id: "local", name: "Renamed local", enabled: true, transport: "stdio",
        executableId: "node",
      },
    } })).toBeTruthy();
  });

  it.each([
    "ftp://example.com/mcp",
    "http://example.com/mcp",
    "https://user:secret@example.com/mcp",
    "https://example.com/mcp?token=secret",
    "https://example.com/mcp#private",
    "https://169.254.169.254/mcp",
    "https://10.0.0.2/mcp",
  ])("rejects unsafe remote MCP URL: %s", (url) => {
    const draft = api.McpServerDraftSchema as Schema;
    expect(draft.safeParse({ id: "remote", name: "Remote", enabled: true, transport: "streamable-http", url, authentication: { type: "none" } }).success).toBe(false);
  });

  it.each(["https://example.com/mcp", "http://127.0.0.1:3000/mcp", "http://localhost:3000/mcp", "http://[::1]:3000/mcp"])(
    "accepts a safe MCP URL: %s",
    (url) => {
      const draft = api.McpServerDraftSchema as Schema;
      expect(draft.safeParse({ id: "remote", name: "Remote", enabled: true, transport: "streamable-http", url, authentication: { type: "none" } }).success).toBe(true);
    },
  );
});
