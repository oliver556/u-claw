import type { BuiltinModelCredential } from "../src/providers/builtin-credential-store.js";
import {
  BuiltinServiceClientError,
  createBuiltinServiceClient,
  createUnavailableBuiltinServiceClient,
} from "../src/providers/builtin-service-client.js";
import { describe, expect, it, vi } from "vitest";

const credential = (endpoint = "https://builtin.example.test/v1/"): BuiltinModelCredential => ({
  endpoint: new URL(endpoint),
  deviceId: "dev_builtin_001",
  userId: "usr_builtin_001",
  tokenId: "tok_builtin_001",
  tokenSecret: "device-secret-that-must-not-leak",
  model: "model-a",
});

const request = {
  schemaVersion: 1 as const,
  requestId: "req_builtin_001",
  model: "model-a",
  prompt: "hello",
  maxOutputTokens: 10,
};

const responseBody = {
  schemaVersion: 1,
  requestId: request.requestId,
  output: "world",
  usage: { inputTokens: 1, outputTokens: 1 },
  serviceState: "enabled",
  serviceRevision: 2,
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function apiError(
  category: string,
  code: string,
  retryable: boolean,
  status: number,
): Response {
  return jsonResponse({ error: { category, code, message: "Fixed public message.", retryable } }, status);
}

function abortingBodyResponse(signal: AbortSignal | null | undefined): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
    },
  }), { headers: { "content-type": "application/json" } });
}

describe("builtin service client endpoint and transport policy", () => {
  it("requires HTTPS by default and permits only exact loopback HTTP with explicit opt-in", async () => {
    const secureFetch = vi.fn(async () => jsonResponse(responseBody));
    await createBuiltinServiceClient({ fetch: secureFetch }).execute(request, credential());
    expect(secureFetch).toHaveBeenCalledOnce();

    const insecure = createBuiltinServiceClient({ fetch: secureFetch });
    await expect(insecure.execute(request, credential("http://127.0.0.1:18091/v1/")))
      .rejects.toMatchObject({ category: "unavailable", code: "ENDPOINT_INSECURE" });

    const loopbackFetch = vi.fn(async () => jsonResponse(responseBody));
    const loopback = createBuiltinServiceClient({ fetch: loopbackFetch, allowLoopbackHttp: true });
    await expect(loopback.execute(request, credential("http://localhost:18091/v1/"))).resolves.toMatchObject({ output: "world" });
    await expect(loopback.execute(request, credential("http://127.0.0.2:18091/v1/")))
      .rejects.toMatchObject({ code: "ENDPOINT_INSECURE" });
  });

  it("fails closed when the client is not configured", async () => {
    const client = createUnavailableBuiltinServiceClient();
    await expect(client.execute(request, credential())).rejects.toMatchObject({
      category: "unavailable", code: "ENDPOINT_NOT_CONFIGURED", retryable: false,
    });
    await expect(client.health(credential())).rejects.toMatchObject({
      category: "unavailable", code: "ENDPOINT_NOT_CONFIGURED", retryable: false,
    });
  });

  it("sends only the device credential as Authorization and disables redirects", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit" });
      expect(init?.headers).toEqual({
        accept: "application/json",
        authorization: `Bearer ${credential().tokenSecret}`,
        "content-type": "application/json",
      });
      return jsonResponse(responseBody);
    });
    await createBuiltinServiceClient({ fetch: fetchImpl }).execute(request, credential());
  });

  it("maps request validation to a fixed error without request body details", async () => {
    const secretPrompt = "prompt-secret-that-must-not-leak";
    const client = createBuiltinServiceClient({ fetch: async () => { throw new Error("must not fetch"); } });
    const error = await client.execute({ ...request, prompt: "", unexpected: secretPrompt } as never, credential())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      category: "validation", code: "INVALID_REQUEST", retryable: false, causeDetails: {},
    });
    expect(JSON.stringify(error)).not.toContain(secretPrompt);
  });

  it("uses bounded strict JSON and removes raw response and cause details", async () => {
    const oversized = createBuiltinServiceClient({
      fetch: async () => jsonResponse(responseBody, 200, { "content-length": "9999" }),
      maxResponseBytes: 100,
    });
    await expect(oversized.execute(request, credential())).rejects.toMatchObject({
      category: "invalid-response", code: "RESPONSE_TOO_LARGE", causeDetails: {},
    });

    const secret = credential().tokenSecret;
    const malformed = createBuiltinServiceClient({ fetch: async () => new Response(`not-json-${secret}`, {
      headers: { "content-type": "application/json" },
    }) });
    const error = await malformed.execute(request, credential()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ category: "invalid-response", code: "INVALID_JSON", causeDetails: {} });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain("not-json");

    const encoder = new TextEncoder();
    const frame = JSON.stringify(responseBody);
    const outputMarker = '"world"';
    const outputOffset = frame.indexOf(outputMarker);
    const prefix = encoder.encode(frame.slice(0, outputOffset + 1));
    const suffix = encoder.encode(frame.slice(outputOffset + outputMarker.length - 1));
    const invalidUtf8 = new Uint8Array(prefix.byteLength + 1 + suffix.byteLength);
    invalidUtf8.set(prefix);
    invalidUtf8[prefix.byteLength] = 0xff;
    invalidUtf8.set(suffix, prefix.byteLength + 1);
    const invalidUtf8Client = createBuiltinServiceClient({ fetch: async () => new Response(invalidUtf8, {
      headers: { "content-type": "application/json" },
    }) });
    await expect(invalidUtf8Client.execute(request, credential())).rejects.toMatchObject({
      category: "invalid-response", code: "INVALID_JSON",
    });

    const unknown = createBuiltinServiceClient({ fetch: async () => jsonResponse({ ...responseBody, extra: true }) });
    await expect(unknown.execute(request, credential())).rejects.toMatchObject({
      category: "invalid-response", code: "INVALID_RESPONSE_BODY",
    });

    const mismatched = createBuiltinServiceClient({
      fetch: async () => jsonResponse({ ...responseBody, requestId: "req_builtin_other" }),
    });
    await expect(mismatched.execute(request, credential())).rejects.toMatchObject({
      category: "invalid-response", code: "RESPONSE_REQUEST_MISMATCH",
    });
  });
});

describe("builtin service client error classification", () => {
  it.each([
    ["authentication", "AUTHENTICATION_FAILED", false, 401],
    ["disabled", "DEVICE_DISABLED", false, 403],
    ["quota", "QUOTA_EXCEEDED", false, 429],
    ["rate-limit", "REQUEST_RATE_LIMIT_EXCEEDED", true, 429],
    ["model-permission", "MODEL_NOT_ALLOWED", false, 403],
    ["unavailable", "SERVICE_DISABLED", false, 503],
    ["unavailable", "SERVICE_MAINTENANCE", false, 503],
    ["upstream", "UPSTREAM_4XX", false, 502],
    ["upstream", "UPSTREAM_5XX", true, 502],
  ] as const)("preserves fixed %s/%s classification", async (category, code, retryable, status) => {
    const client = createBuiltinServiceClient({ fetch: async () => apiError(category, code, retryable, status) });
    const error = await client.execute(request, credential()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ category, code, retryable });
    expect(JSON.stringify(error)).not.toContain("status");
  });

  it("classifies caller abort separately and does not expose the raw network cause", async () => {
    const controller = new AbortController();
    controller.abort(new Error(`caller-${credential().tokenSecret}`));
    const client = createBuiltinServiceClient({ fetch: async () => { throw new Error("must not fetch"); } });
    const cancelled = await client.execute(request, credential(), controller.signal).catch((caught: unknown) => caught);
    expect(cancelled).toMatchObject({ category: "cancelled", code: "OPERATION_CANCELLED", retryable: false, causeDetails: {} });
    expect(JSON.stringify(cancelled)).not.toContain(credential().tokenSecret);

    const network = createBuiltinServiceClient({ fetch: async () => { throw new Error(`network-${credential().tokenSecret}`); } });
    const failed = await network.execute(request, credential()).catch((caught: unknown) => caught);
    expect(failed).toMatchObject({ category: "transport", code: "NETWORK_ERROR", retryable: true, causeDetails: {} });
    expect(JSON.stringify(failed)).not.toContain(credential().tokenSecret);
  });

  it("classifies the client timeout as counted transport failure", async () => {
    const client = createBuiltinServiceClient({
      timeoutMs: 5,
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
    });
    await expect(client.execute(request, credential())).rejects.toMatchObject({
      category: "transport", code: "TIMEOUT", retryable: true,
    });
  });

  it("preserves caller cancellation and timeout while reading the response body", async () => {
    const callerClient = createBuiltinServiceClient({
      timeoutMs: 1_000,
      fetch: async (_url, init) => abortingBodyResponse(init?.signal),
    });
    const controller = new AbortController();
    const pending = callerClient.execute(request, credential(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ category: "cancelled", code: "OPERATION_CANCELLED" });

    const timeoutClient = createBuiltinServiceClient({
      timeoutMs: 5,
      fetch: async (_url, init) => abortingBodyResponse(init?.signal),
    });
    await expect(timeoutClient.execute(request, credential())).rejects.toMatchObject({
      category: "transport", code: "TIMEOUT",
    });
  });

  it("rejects malformed error envelopes as invalid responses", async () => {
    const client = createBuiltinServiceClient({ fetch: async () => jsonResponse({ error: { category: "auth", raw: "x" } }, 401) });
    await expect(client.execute(request, credential())).rejects.toMatchObject({
      category: "invalid-response", code: "INVALID_ERROR_BODY",
    });

    const unknownCode = createBuiltinServiceClient({
      fetch: async () => apiError("authentication", "ATTACKER_CONTROLLED_CODE", false, 401),
    });
    await expect(unknownCode.execute(request, credential())).rejects.toMatchObject({
      category: "invalid-response", code: "INVALID_ERROR_BODY",
    });

    for (const response of [
      apiError("unavailable", "AUTHENTICATION_FAILED", true, 401),
      apiError("authentication", "AUTHENTICATION_FAILED", true, 401),
      apiError("authentication", "AUTHENTICATION_FAILED", false, 503),
    ]) {
      const inconsistent = createBuiltinServiceClient({ fetch: async () => response.clone() });
      await expect(inconsistent.execute(request, credential())).rejects.toMatchObject({
        category: "invalid-response", code: "INVALID_ERROR_BODY",
      });
    }
  });
});

describe("builtin service circuit breaker", () => {
  it("opens after two counted failures and fast-rejects without moving cooldown", async () => {
    let now = 1_000;
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    const client = createBuiltinServiceClient({ fetch: fetchImpl, now: () => now, circuitCooldownMs: 100 });
    await expect(client.execute(request, credential())).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    await expect(client.execute(request, credential())).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    await expect(client.execute(request, credential())).rejects.toMatchObject({ code: "CIRCUIT_OPEN" });
    now = 1_099;
    await expect(client.execute(request, credential())).rejects.toMatchObject({ code: "CIRCUIT_OPEN" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    now = 1_100;
    await expect(client.execute(request, credential())).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("allows one real half-open model probe, rejects contenders, and closes on success", async () => {
    let now = 1_000;
    let release!: (response: Response) => void;
    const probe = new Promise<Response>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error("one"))
      .mockRejectedValueOnce(new Error("two"))
      .mockImplementationOnce(async () => probe)
      .mockResolvedValue(jsonResponse(responseBody));
    const client = createBuiltinServiceClient({ fetch: fetchImpl, now: () => now, circuitCooldownMs: 100 });
    await client.execute(request, credential()).catch(() => undefined);
    await client.execute(request, credential()).catch(() => undefined);
    now = 1_100;
    const pendingProbe = client.execute(request, credential());
    await expect(client.execute(request, credential())).rejects.toMatchObject({ code: "CIRCUIT_OPEN" });
    release(jsonResponse(responseBody));
    await expect(pendingProbe).resolves.toMatchObject({ output: "world" });
    await expect(client.execute(request, credential())).resolves.toMatchObject({ output: "world" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("reopens for a full cooldown after a counted half-open failure", async () => {
    let now = 1_000;
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    const client = createBuiltinServiceClient({ fetch: fetchImpl, now: () => now, circuitCooldownMs: 100 });
    await client.execute(request, credential()).catch(() => undefined);
    await client.execute(request, credential()).catch(() => undefined);
    now = 1_100;
    await client.execute(request, credential()).catch(() => undefined);
    now = 1_199;
    await expect(client.execute(request, credential())).rejects.toMatchObject({ code: "CIRCUIT_OPEN" });
    now = 1_200;
    await expect(client.execute(request, credential())).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("does not count policy/auth failures or caller aborts", async () => {
    const responses = [
      apiError("authentication", "AUTHENTICATION_FAILED", false, 401),
      apiError("quota", "QUOTA_EXCEEDED", false, 429),
      jsonResponse(responseBody),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const client = createBuiltinServiceClient({ fetch: fetchImpl });
    await client.execute(request, credential()).catch(() => undefined);
    await client.execute(request, credential()).catch(() => undefined);
    await expect(client.execute(request, credential())).resolves.toMatchObject({ output: "world" });

    const abortingFetch = vi.fn(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const aborting = createBuiltinServiceClient({ fetch: abortingFetch, timeoutMs: 1_000 });
    for (let index = 0; index < 2; index += 1) {
      const controller = new AbortController();
      const pending = aborting.execute(request, credential(), controller.signal);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
    }
    expect(abortingFetch).toHaveBeenCalledTimes(2);
  });

  it("does not extend cooldown when the caller aborts a half-open probe", async () => {
    let now = 1_000;
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error("one"))
      .mockRejectedValueOnce(new Error("two"))
      .mockImplementationOnce(async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }))
      .mockResolvedValue(jsonResponse(responseBody));
    const client = createBuiltinServiceClient({ fetch: fetchImpl, now: () => now, circuitCooldownMs: 100 });
    await client.execute(request, credential()).catch(() => undefined);
    await client.execute(request, credential()).catch(() => undefined);
    now = 1_100;
    const controller = new AbortController();
    const pending = client.execute(request, credential(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
    await expect(client.execute(request, credential())).resolves.toMatchObject({ output: "world" });
  });

  it("does not reopen when a half-open caller abort happens during body reading", async () => {
    let now = 1_000;
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error("one"))
      .mockRejectedValueOnce(new Error("two"))
      .mockImplementationOnce(async (_url, init) => abortingBodyResponse(init?.signal))
      .mockResolvedValue(jsonResponse(responseBody));
    const client = createBuiltinServiceClient({ fetch: fetchImpl, now: () => now, circuitCooldownMs: 100 });
    await client.execute(request, credential()).catch(() => undefined);
    await client.execute(request, credential()).catch(() => undefined);
    now = 1_100;
    const controller = new AbortController();
    const pending = client.execute(request, credential(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
    await expect(client.execute(request, credential())).resolves.toMatchObject({ output: "world" });
  });

  it("ignores pre-open in-flight completion so it cannot close or extend an open circuit", async () => {
    let now = 1_000;
    let releaseSuccess!: (response: Response) => void;
    let rejectOldFailure!: (error: Error) => void;
    const oldSuccess = new Promise<Response>((resolve) => { releaseSuccess = resolve; });
    const oldFailure = new Promise<Response>((_resolve, reject) => { rejectOldFailure = reject; });
    const fetchImpl = vi.fn()
      .mockImplementationOnce(async () => oldSuccess)
      .mockImplementationOnce(async () => oldFailure)
      .mockRejectedValueOnce(new Error("counted-one"))
      .mockRejectedValueOnce(new Error("counted-two"))
      .mockResolvedValue(jsonResponse(responseBody));
    const client = createBuiltinServiceClient({ fetch: fetchImpl, now: () => now, circuitCooldownMs: 100 });
    const pendingSuccess = client.execute(request, credential());
    const pendingOldFailure = client.execute(request, credential());
    await client.execute(request, credential()).catch(() => undefined);
    await client.execute(request, credential()).catch(() => undefined);
    releaseSuccess(jsonResponse(responseBody));
    await expect(pendingSuccess).resolves.toMatchObject({ output: "world" });
    await expect(client.execute(request, credential())).rejects.toMatchObject({ code: "CIRCUIT_OPEN" });

    now = 1_050;
    rejectOldFailure(new Error("old-counted"));
    await expect(pendingOldFailure).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    now = 1_100;
    await expect(client.execute(request, credential())).resolves.toMatchObject({ output: "world" });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("counts two client timeouts and keeps authenticated health from changing an open circuit", async () => {
    let now = 1_000;
    let modelCalls = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/health")) {
        return jsonResponse({ schemaVersion: 1, acceptingBuiltin: true, state: "enabled", revision: 2 });
      }
      modelCalls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    const client = createBuiltinServiceClient({ fetch: fetchImpl, timeoutMs: 5, now: () => now, circuitCooldownMs: 100 });
    await expect(client.execute(request, credential())).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(client.execute(request, credential())).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(client.health(credential())).resolves.toMatchObject({ acceptingBuiltin: true });
    await expect(client.execute(request, credential())).rejects.toMatchObject({ code: "CIRCUIT_OPEN" });
    expect(modelCalls).toBe(2);
    now = 1_100;
  });
});

describe("BuiltinServiceClientError", () => {
  it("serializes only fixed public fields", () => {
    const error = new BuiltinServiceClientError("transport", "NETWORK_ERROR", "Builtin service request failed.", true);
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: "BuiltinServiceClientError",
      category: "transport",
      code: "NETWORK_ERROR",
      message: "Builtin service request failed.",
      retryable: true,
      causeDetails: {},
    });
  });
});
