import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as desktop from "../src/index.js";

describe("MCP protocol probe", () => {
  const servers: Array<ReturnType<typeof createServer>> = [];
  afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

  async function fixture(handler: (request: IncomingMessage, response: ServerResponse, payload: any) => void) {
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => handler(request, response, JSON.parse(body)));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/mcp`;
  }

  const remote = (url: string) => ({ id: "fixture", name: "Fixture", enabled: true, transport: "streamable-http", url, authentication: { type: "none" } });

  function rpcResponse(init: RequestInit, resultFor: (method: string, params: any) => unknown): Response {
    const payload = JSON.parse(String(init.body));
    if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: resultFor(payload.method, payload.params) }), {
      headers: { "content-type": "application/json" },
    });
  }

  it("performs MCP handshake and returns only capability summaries", async () => {
    const methods: string[] = [];
    const url = await fixture((_request, response, payload) => {
      methods.push(payload.method);
      response.setHeader("content-type", "application/json");
      const result = payload.method === "initialize"
        ? { protocolVersion: "2025-06-18", serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {}, resources: {} } }
        : payload.method === "tools/list"
          ? { tools: [{ name: "search", description: "body must stay main-only", inputSchema: { secret: "no-renderer" } }] }
          : { resources: [{ uri: "docs://guide/private", name: "Guide", text: "no-renderer" }] };
      response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
    });
    const probe = (desktop as any).createMcpProtocolProbe({ timeoutMs: 1_000 });
    const result = await probe.test(remote(url), new AbortController().signal);
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list", "resources/list"]);
    expect(result).toEqual({ status: "connected", capabilitySummary: { tools: 1, resources: 1, prompts: 0 }, toolNames: ["search"], resourceSchemes: ["docs"] });
    expect(JSON.stringify(result)).not.toMatch(/no-renderer|private|inputSchema/u);
  });

  it("preserves Streamable HTTP session headers and selects the matching SSE response", async () => {
    const url = await fixture((request, response, payload) => {
      if (payload.method === "initialize") {
        response.setHeader("mcp-session-id", "fixture-session");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "fixture", version: "1" } } }));
        return;
      }
      if (request.headers["mcp-session-id"] !== "fixture-session" || request.headers["mcp-protocol-version"] !== "2025-06-18") {
        response.statusCode = 400;
        response.end("missing session");
        return;
      }
      if (payload.method === "notifications/initialized") { response.statusCode = 202; response.end(); return; }
      const result = payload.method === "tools/list" ? { tools: [{ name: "session_tool" }] } : { resources: [] };
      response.setHeader("content-type", "text/event-stream");
      response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: payload.id, result })}\n\n`);
    });
    const probe = (desktop as any).createMcpProtocolProbe({ timeoutMs: 1_000 });
    await expect(probe.test(remote(url), new AbortController().signal)).resolves.toMatchObject({
      status: "connected", toolNames: ["session_tool"],
    });
  });

  it("handshakes with a controlled stdio executable", async () => {
    const runtimeRoot = fileURLToPath(new URL("./fixtures/", import.meta.url));
    const probe = (desktop as any).createMcpProtocolProbe({
      timeoutMs: 1_000, runtimeRoot, executables: { node: process.execPath },
    });
    const result = await probe.test({
      id: "stdio", name: "stdio", enabled: true, transport: "stdio", executableId: "node",
      args: ["mcp-stdio-server.mjs"], env: {},
    }, new AbortController().signal);
    expect(result).toEqual({ status: "connected", capabilitySummary: { tools: 1, resources: 1, prompts: 0 }, toolNames: ["fixture_search"], resourceSchemes: ["fixture"] });
  });

  it("classifies timeout and cancellation without response contents", async () => {
    const url = await fixture(() => undefined);
    const probe = (desktop as any).createMcpProtocolProbe({ timeoutMs: 40 });
    await expect(probe.test(remote(url), new AbortController().signal)).resolves.toMatchObject({ status: "error", error: { code: "TIMEOUT", retryable: true } });
    const controller = new AbortController();
    const pending = probe.test(remote(url), controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ status: "error", error: { code: "CANCELLED", retryable: true } });
  });

  it("bounds and cancels DNS resolution before opening a connection", async () => {
    const lookup = vi.fn(() => new Promise<never>(() => undefined));
    const request = vi.fn();
    const timed = (desktop as any).createMcpProtocolProbe({ timeoutMs: 30, lookup, request });
    await expect(timed.test(remote("https://mcp.example.com/rpc"), new AbortController().signal)).resolves.toMatchObject({
      status: "error", error: { code: "TIMEOUT" },
    });
    const controller = new AbortController();
    const cancellable = (desktop as any).createMcpProtocolProbe({ timeoutMs: 1_000, lookup, request });
    const pending = cancellable.test(remote("https://mcp.example.com/rpc"), controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ status: "error", error: { code: "CANCELLED" } });
    expect(request).not.toHaveBeenCalled();
  });

  it("blocks SSRF before fetch and limits response size", async () => {
    const fetch = vi.fn();
    const probe = (desktop as any).createMcpProtocolProbe({
      fetch, lookup: vi.fn(async () => [{ address: "169.254.169.254", family: 4 }]),
    });
    await expect(probe.test(remote("https://metadata.example.com/mcp"), new AbortController().signal))
      .resolves.toMatchObject({ status: "error", error: { code: "FORBIDDEN", retryable: false } });
    expect(fetch).not.toHaveBeenCalled();

    const url = await fixture((_request, response) => response.end("x".repeat(2_000)));
    const limited = (desktop as any).createMcpProtocolProbe({ maxResponseBytes: 1_024 });
    await expect(limited.test(remote(url), new AbortController().signal))
      .resolves.toMatchObject({ status: "error", error: { code: "OPERATION_FAILED", retryable: false } });
  });

  it("pins validated DNS, disables redirects, and honors MCP proxy NO_PROXY policy", async () => {
    const request = vi.fn(async (_url: URL, init: RequestInit, _address: string, _proxyUrl?: URL) => rpcResponse(init, (method) => method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fixture", version: "1" } }
      : {}));
    const lookup = vi.fn(async (hostname: string) => [{
      address: hostname === "proxy.example.net" ? "1.1.1.1" : "8.8.8.8",
      family: 4,
    }]);
    const throughProxy = (desktop as any).createMcpProtocolProbe({
      lookup, request,
      network: { httpsProxy: "https://proxy.example.net", httpProxy: null, noProxy: [] },
    });
    await throughProxy.test(remote("https://mcp.example.com/rpc"), new AbortController().signal);
    expect(request).toHaveBeenCalled();
    expect(request.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    expect(request.mock.calls[0]?.[2]).toBe("8.8.8.8");
    expect(String(request.mock.calls[0]?.[3])).toBe("https://proxy.example.net/");

    request.mockClear();
    const direct = (desktop as any).createMcpProtocolProbe({
      lookup, request,
      network: { httpsProxy: "https://proxy.example.net", httpProxy: null, noProxy: [".example.com"] },
    });
    await direct.test(remote("https://mcp.example.com/rpc"), new AbortController().signal);
    expect(request.mock.calls[0]?.[2]).toBe("8.8.8.8");
    expect(request.mock.calls[0]?.[3]).toBeUndefined();
  });

  it("rejects redirects without forwarding authentication", async () => {
    const request = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://other.example/mcp" } }));
    const probe = (desktop as any).createMcpProtocolProbe({
      request,
      lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]),
    });
    const result = await probe.test({
      ...remote("https://mcp.example.com/rpc"),
      authentication: { type: "bearer", secret: "must-not-forward" },
    }, new AbortController().signal);
    expect(result).toMatchObject({ status: "error", error: { code: "FORBIDDEN" } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("blocks non-public documentation ranges before any request", async () => {
    const request = vi.fn();
    const probe = (desktop as any).createMcpProtocolProbe({
      request,
      lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
    });
    await expect(probe.test(remote("https://mcp.example.com/rpc"), new AbortController().signal)).resolves.toMatchObject({
      status: "error", error: { code: "FORBIDDEN" },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("blocks IPv4-mapped IPv6 loopback addresses before any request", async () => {
    const request = vi.fn();
    const probe = (desktop as any).createMcpProtocolProbe({
      request,
      lookup: vi.fn(async () => [{ address: "::ffff:7f00:1", family: 6 }]),
    });
    await expect(probe.test(remote("https://mcp.example.com/rpc"), new AbortController().signal)).resolves.toMatchObject({
      status: "error", error: { code: "FORBIDDEN" },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("paginates tools, resources, and prompts while truncating renderer names only", async () => {
    const request = vi.fn(async (_url: URL, init: RequestInit, _address: string, _proxyUrl?: URL) => rpcResponse(init, (method, params) => {
      if (method === "initialize") return {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "fixture", version: "1" },
      };
      const second = params?.cursor === "next";
      if (method === "tools/list") return second
        ? { tools: Array.from({ length: 2 }, (_, index) => ({ name: `tail-${index}` })) }
        : { tools: Array.from({ length: 100 }, (_, index) => ({ name: `tool-${index}` })), nextCursor: "next" };
      if (method === "resources/list") return second
        ? { resources: [{ uri: "git://two" }] }
        : { resources: [{ uri: "docs://one" }], nextCursor: "next" };
      if (method === "prompts/list") return second
        ? { prompts: [{ name: "second" }] }
        : { prompts: [{ name: "first" }], nextCursor: "next" };
      return {};
    }));
    const probe = (desktop as any).createMcpProtocolProbe({
      request,
      lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]),
    });
    await expect(probe.test(remote("https://mcp.example.com/rpc"), new AbortController().signal)).resolves.toMatchObject({
      status: "connected",
      capabilitySummary: { tools: 102, resources: 2, prompts: 2 },
      toolNames: expect.arrayContaining(["tool-0", "tool-99"]),
      resourceSchemes: ["docs", "git"],
    });
  });

  it("does not claim OpenClaw MCP availability without real RPC methods", () => {
    const runtime = (desktop as any).createOpenClawMcpRuntime(undefined, { test: vi.fn() });
    expect(runtime.capability()).toBe(false);
    expect(runtime.reason()).toBe("locked-runtime-no-mcp-rpc");
  });

  it("combines typed Gateway configuration with the Electron protocol probe", async () => {
    const configuration = {
      configure: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const probe = { test: vi.fn(async () => ({
      status: "connected" as const,
      capabilitySummary: { tools: 1, resources: 0, prompts: 0 },
      toolNames: ["calendar.read"],
      resourceSchemes: [],
    })) };
    const runtime = (desktop as any).createOpenClawMcpRuntime(configuration, probe);
    const server = remote("https://mcp.example.com/rpc");
    const signal = new AbortController().signal;

    expect(runtime.capability()).toBe(true);
    await expect(runtime.test(server, signal)).resolves.toMatchObject({ status: "connected", toolNames: ["calendar.read"] });
    await runtime.configure(server, signal);
    await runtime.stop(server, signal);
    await runtime.start(server, signal);
    await runtime.remove(server, signal);
    expect(probe.test).toHaveBeenCalledWith(server, signal);
    expect(configuration.configure).toHaveBeenCalledWith(server, signal);
    expect(configuration.stop).toHaveBeenCalledWith(server, signal);
    expect(configuration.start).toHaveBeenCalledWith(server, signal);
    expect(configuration.remove).toHaveBeenCalledWith(server, signal);
  });

  it("sanitizes OpenClaw MCP errors before they can reach storage or renderer", async () => {
    const configuration = Object.fromEntries(["configure", "remove", "start", "stop"].map((name) => [name, vi.fn(async () => undefined)]));
    const runtime = (desktop as any).createOpenClawMcpRuntime(configuration, {
      test: vi.fn(async () => ({
        status: "error",
        error: { code: "OPERATION_FAILED", message: "Bearer top-secret /Users/name/private tool arguments", retryable: true, recoveryActions: ["retry"], causeDetails: { body: "secret" } },
      })),
    });
    const result = await runtime.test(remote("https://mcp.example.com/rpc"), new AbortController().signal);
    expect(result).toMatchObject({ status: "error", error: { code: "OPERATION_FAILED", retryable: true } });
    expect(JSON.stringify(result)).not.toMatch(/top-secret|Users\/name|tool arguments|body/u);
  });
});
