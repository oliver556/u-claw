import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as desktop from "../src/index.js";

const servers: Server[] = [];

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("provider network service", () => {
  it("executes bounded JSON requests through the safe provider network path", async () => {
    const baseUrl = await fixture((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: "safe response" } }] }));
    });
    const client = (desktop as any).createProviderHttpClient({ timeoutMs: 1_000, maxResponseBytes: 1_024 });

    await expect(client.requestJson({
      url: `${baseUrl}/v1/chat/completions`,
      init: { method: "POST", body: "{}" },
    })).resolves.toMatchObject({ choices: [{ message: { content: "safe response" } }] });
    await expect(client.requestJson({
      url: "http://169.254.169.254/latest/meta-data",
      init: { method: "GET" },
    })).rejects.toThrow("UNSAFE_TARGET");
  });

  it("cancels provider response bodies on HTTP failure and size overflow", async () => {
    const cancelled = vi.fn();
    const proxyFetch = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("upstream failure"));
        controller.close();
      },
      cancel: cancelled,
    }), { status: 502 }));
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const client = (desktop as any).createProviderHttpClient({ lookup, proxyFetch, maxResponseBytes: 1_024 });

    await expect(client.requestJson({
      url: "https://models.example.com/v1/chat/completions",
      network: { httpProxy: null, httpsProxy: "https://proxy.example.com", noProxy: [] },
      init: { method: "POST", body: "{}" },
    })).rejects.toThrow("Provider request failed");
    expect(cancelled).toHaveBeenCalledOnce();

    const overflowCancelled = vi.fn();
    proxyFetch.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(2_048));
      },
      cancel: overflowCancelled,
    }), { status: 200 }));
    await expect(client.requestJson({
      url: "https://models.example.com/v1/chat/completions",
      network: { httpProxy: null, httpsProxy: "https://proxy.example.com", noProxy: [] },
      init: { method: "POST", body: "{}" },
    })).rejects.toThrow("too large");
    expect(overflowCancelled).toHaveBeenCalledOnce();
  });

  it("discovers models only from explicitly configured loopback targets", async () => {
    const baseUrl = await fixture((request, response) => {
      expect(request.url).toBe("/api/tags");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }));
    });
    const create = (desktop as any).createProviderNetworkService;
    expect(create).toBeTypeOf("function");
    const service = create({ discoveryTargets: [{ source: "ollama", baseUrl }] });
    await expect(service.discover("discover-1")).resolves.toEqual({
      state: "ready",
      models: [{ id: "llama3.2:latest", label: "llama3.2:latest", source: "ollama", baseUrl: `${baseUrl}/v1` }],
    });
  });

  it("returns an empty state when supported local services are unavailable", async () => {
    const service = (desktop as any).createProviderNetworkService({
      discoveryTargets: [{ source: "ollama", baseUrl: "http://127.0.0.1:1" }],
      discoveryTimeoutMs: 100,
    });
    await expect(service.discover("discover-empty")).resolves.toEqual({ state: "empty", models: [] });
  });

  it("sends a minimal request and never returns secrets or request/response payloads", async () => {
    const apiKey = "sk-fixture-private-12345678";
    const baseUrl = await fixture((request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe(`Bearer ${apiKey}`);
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk; });
      request.on("end", () => {
        expect(JSON.parse(body)).toEqual({ model: "fixture-model", messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false });
        response.end(JSON.stringify({ choices: [{ message: { content: "fixture-secret-response" } }] }));
      });
    });
    const service = (desktop as any).createProviderNetworkService();
    const result = await service.verify("verify-safe", { id: "fixture", enabled: true, name: "Fixture", baseUrl: `${baseUrl}/v1`, model: "fixture-model", apiKey });
    expect(result).toEqual({ state: "succeeded", category: "ok", code: "OK", message: "连接成功。", retryable: false });
    expect(JSON.stringify(result)).not.toMatch(/fixture-private|fixture-secret-response|authorization|messages|headers|body/iu);
  });

  it.each([
    [401, "authentication", "PROVIDER_AUTH_FAILED", false],
    [429, "rate-limit", "NETWORK_UNREACHABLE", true],
    [404, "model-not-found", "MODEL_UNAVAILABLE", false],
  ])("classifies HTTP %s without exposing response text", async (status, category, code, retryable) => {
    const baseUrl = await fixture((_request, response) => {
      response.statusCode = status as number;
      response.end("server-secret-body sk-hidden-key");
    });
    const service = (desktop as any).createProviderNetworkService();
    const result = await service.verify(`verify-${status}`, { id: "fixture", enabled: true, name: "Fixture", baseUrl: `${baseUrl}/v1`, model: "missing" });
    expect(result).toMatchObject({ state: "failed", category, code, retryable });
    expect(JSON.stringify(result)).not.toMatch(/server-secret-body|sk-hidden-key/u);
  });

  it("distinguishes DNS, TLS, and proxy failures", async () => {
    const dnsService = (desktop as any).createProviderNetworkService({
      lookup: vi.fn(async () => { throw Object.assign(new Error("secret DNS detail"), { code: "ENOTFOUND" }); }),
    });
    await expect(dnsService.verify("verify-dns", { id: "dns", enabled: true, name: "DNS", baseUrl: "https://missing.example.com/v1", model: "model" }))
      .resolves.toEqual({ state: "failed", category: "dns", code: "NETWORK_UNREACHABLE", message: "DNS 解析失败。", retryable: true });

    const plainHttp = await fixture((_request, response) => response.end("not TLS"));
    const tlsUrl = plainHttp.replace("http:", "https:");
    const tlsService = (desktop as any).createProviderNetworkService();
    await expect(tlsService.verify("verify-tls", { id: "tls", enabled: true, name: "TLS", baseUrl: `${tlsUrl}/v1`, model: "model" }))
      .resolves.toMatchObject({ state: "failed", category: "tls", code: "NETWORK_UNREACHABLE" });

    const proxyFetch = vi.fn(async () => new Response(null, { status: 407 }));
    const proxyService = (desktop as any).createProviderNetworkService({
      lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
      proxyFetch,
    });
    await expect(proxyService.verify("verify-proxy", { id: "proxy", enabled: true, name: "Proxy", baseUrl: "https://models.example.com/v1", model: "model" }, {
      httpProxy: null, httpsProxy: "http://127.0.0.1:8080", noProxy: ["localhost", "127.0.0.1", "::1"],
    })).resolves.toEqual({ state: "failed", category: "proxy", code: "NETWORK_UNREACHABLE", message: "代理连接失败。", retryable: true });
    expect(proxyFetch).toHaveBeenCalledOnce();
  });

  it("classifies timeout and supports cancellation", async () => {
    const baseUrl = await fixture(() => undefined);
    const service = (desktop as any).createProviderNetworkService({ verifyTimeoutMs: 40 });
    await expect(service.verify("verify-timeout", { id: "fixture", enabled: true, name: "Fixture", baseUrl: `${baseUrl}/v1`, model: "slow" }))
      .resolves.toMatchObject({ state: "failed", category: "timeout", code: "TIMEOUT", retryable: true });
    const pending = service.verify("verify-cancel", { id: "fixture", enabled: true, name: "Fixture", baseUrl: `${baseUrl}/v1`, model: "slow" });
    expect(service.cancel("verify-cancel")).toBe(true);
    await expect(pending).resolves.toMatchObject({ state: "failed", category: "cancelled", code: "CANCELLED", retryable: true });
  });

  it("blocks metadata, private networks, and dangerous protocols", async () => {
    const service = (desktop as any).createProviderNetworkService();
    for (const baseUrl of ["http://169.254.169.254/v1", "https://10.0.0.2/v1", "https://192.168.1.10/v1", "file:///tmp/provider"]) {
      await expect(service.verify("verify-unsafe", { id: "unsafe", enabled: true, name: "Unsafe", baseUrl, model: "model" }))
        .resolves.toMatchObject({ state: "failed", category: "unsafe-target", code: "INVALID_ARGUMENT", retryable: false });
    }
  });

  it("treats bracketed IPv6 loopback as local without sending it to DNS", async () => {
    const lookup = vi.fn(async () => { throw Object.assign(new Error("must not resolve an IP literal"), { code: "ENOTFOUND" }); });
    const service = (desktop as any).createProviderNetworkService({ lookup, verifyTimeoutMs: 100 });
    await expect(service.verify("verify-ipv6-loopback", { id: "ipv6", enabled: true, name: "IPv6", baseUrl: "http://[::1]:1/v1", model: "model" }))
      .resolves.toMatchObject({ state: "failed", category: "network", code: "NETWORK_UNREACHABLE" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("limits concurrent operations", async () => {
    const baseUrl = await fixture(() => undefined);
    const service = (desktop as any).createProviderNetworkService({ maxConcurrent: 1, verifyTimeoutMs: 500 });
    const first = service.verify("verify-first", { id: "fixture", enabled: true, name: "Fixture", baseUrl: `${baseUrl}/v1`, model: "slow" });
    await expect(service.verify("verify-second", { id: "fixture", enabled: true, name: "Fixture", baseUrl: `${baseUrl}/v1`, model: "slow" }))
      .resolves.toMatchObject({ state: "failed", category: "busy", code: "UNAVAILABLE", retryable: true });
    service.cancel("verify-first");
    await first;
  });

  it("bypasses proxy for loopback by default", async () => {
    const baseUrl = await fixture((_request, response) => response.end("{}"));
    const proxyFetch = vi.fn(async () => { throw new Error("proxy must not be used"); });
    const service = (desktop as any).createProviderNetworkService({ proxyFetch });
    const result = await service.verify("verify-local", { id: "local", enabled: true, name: "Local", baseUrl: `${baseUrl}/v1`, model: "local" }, {
      httpProxy: "http://proxy.example.com:8080", httpsProxy: null, noProxy: ["localhost", "127.0.0.1", "::1"],
    });
    expect(result.state).toBe("succeeded");
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it("rejects a proxy hostname that resolves to a private target", async () => {
    const lookup = vi.fn(async (hostname: string) => hostname === "private-proxy.example.com"
      ? [{ address: "169.254.169.254", family: 4 }]
      : [{ address: "93.184.216.34", family: 4 }]);
    const proxyFetch = vi.fn();
    const service = (desktop as any).createProviderNetworkService({ lookup, proxyFetch });
    await expect(service.verify("verify-private-proxy", { id: "remote", enabled: true, name: "Remote", baseUrl: "https://models.example.com/v1", model: "model" }, {
      httpProxy: null, httpsProxy: "http://private-proxy.example.com:8080", noProxy: ["localhost", "127.0.0.1", "::1"],
    })).resolves.toMatchObject({ state: "failed", category: "unsafe-target", code: "INVALID_ARGUMENT" });
    expect(proxyFetch).not.toHaveBeenCalled();
  });
});
