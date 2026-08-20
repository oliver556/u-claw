import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createActivationClient } from "../src/activation/client.js";
import { ActivationClientError } from "../src/activation/errors.js";
import { readActivationServiceConfiguration } from "../src/wiring/environment.js";

const request = {
  activationCode: "TESTTESTTESTTESTTESTTEST12",
  usbFingerprint: { version: "uclaw-usb-v1" as const, sha256: "a".repeat(64) },
  clientVersion: "1.0.0",
  idempotencyKey: "activation:test:001",
};

const response = {
  activationId: "activation-001",
  deviceId: "device-001",
  licenseId: "license-001",
  license: {
    schemaVersion: 1,
    usernameId: "username-001",
    deviceId: "device-001",
    licenseId: "license-001",
    usbFingerprint: { scheme: "uclaw-usb-v1", sha256: "a".repeat(64) },
    startupSecretProof: {
      algorithm: "sha256-salt-v1",
      startupSecretSalt: "b".repeat(32),
      startupSecretHash: "c".repeat(64),
    },
    notBefore: "2026-08-13T00:00:00Z",
    expiresAt: "2027-08-13T00:00:00Z",
    revision: 1,
    signature: { algorithm: "ed25519", keyId: "activation-key", value: "s".repeat(80) },
  },
  startupCredential: {
    schemaVersion: 1,
    deviceId: "device-001",
    licenseId: "license-001",
    startupSecret: "x".repeat(32),
  },
  builtinCredential: {
    schemaVersion: 2,
    deviceId: "device-001",
    licenseId: "license-001",
    endpoint: "https://license.example.test/model-api/",
    deviceToken: `uclaw_dt_${"A".repeat(43)}`,
  },
  status: "active",
};

const jsonResponse = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});

describe("activation service configuration", () => {
  const rawPublicKey = () => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");

  it("fails closed when endpoint or trust roots are missing", () => {
    expect(() => readActivationServiceConfiguration({})).toThrow(/not configured/i);
    expect(() => readActivationServiceConfiguration({
      UCLAW_ACTIVATION_TRUSTED_PUBLIC_KEYS: JSON.stringify({ "activation-key": rawPublicKey() }),
    })).toThrow(/not configured/i);
  });

  it("accepts only a credential-free HTTPS endpoint and valid Ed25519 public keys", () => {
    expect(() => readActivationServiceConfiguration({
      UCLAW_ACTIVATION_ENDPOINT: "http://activation.example.test/",
      UCLAW_ACTIVATION_TRUSTED_PUBLIC_KEYS: JSON.stringify({ "activation-key": rawPublicKey() }),
    })).toThrow(/invalid/i);
    expect(() => readActivationServiceConfiguration({
      UCLAW_ACTIVATION_ENDPOINT: "https://user:secret@activation.example.test/",
      UCLAW_ACTIVATION_TRUSTED_PUBLIC_KEYS: JSON.stringify({ "activation-key": rawPublicKey() }),
    })).toThrow(/invalid/i);
    expect(readActivationServiceConfiguration({
      UCLAW_ACTIVATION_ENDPOINT: "https://activation.example.test/api",
      UCLAW_ACTIVATION_TRUSTED_PUBLIC_KEYS: JSON.stringify({ "activation-key": rawPublicKey() }),
    })).toMatchObject({ endpoint: new URL("https://activation.example.test/api/") });
  });
});

describe("activation client", () => {
  it("rejects non-HTTPS endpoints before making a request", () => {
    expect(() => createActivationClient({ endpoint: "http://activation.example.test/" })).toThrow(/HTTPS/i);
  });

  it("rejects redirects and configures connection, body, and total deadlines", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://other.example.test/" } }));
    const createDispatcher = vi.fn(() => ({ close: vi.fn(async () => undefined) } as never));
    const client = createActivationClient({ endpoint: "https://activation.example.test/", fetch, createDispatcher, connectTimeoutMs: 1_500, requestTimeoutMs: 4_000 });

    await expect(client.activate(request)).rejects.toMatchObject({ code: "REDIRECT_REJECTED", retryable: false });
    expect(createDispatcher).toHaveBeenCalledWith(expect.objectContaining({ connectTimeout: 1_500, headersTimeout: 4_000, bodyTimeout: 4_000 }));
    expect(fetch).toHaveBeenCalledWith(new URL("https://activation.example.test/v1/activations"), expect.objectContaining({
      redirect: "error",
      signal: expect.any(AbortSignal),
    }));
  });

  it("projects an undici redirect cause without retrying or exposing transport messages", async () => {
    const redirectDetail = "unexpected redirect to https://secret.example.test/token";
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: new Error(redirectDetail, { cause: new Error("socket detail must stay private") }),
      });
    });
    const client = createActivationClient({ endpoint: "https://activation.example.test/", fetch });

    const error = await client.activate(request).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "REDIRECT_REJECTED", retryable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(error)).not.toContain(redirectDetail);
    expect(JSON.stringify(error)).not.toContain(redirectDetail);
  });

  it("does not classify unrelated redirect wording as an undici redirect rejection", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: new Error("redirect proxy unavailable") });
    });
    const client = createActivationClient({ endpoint: "https://activation.example.test/", fetch });

    await expect(client.activate(request)).rejects.toMatchObject({ code: "NETWORK_ERROR", retryable: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing content type", {}],
    ["invalid content type", { "content-type": "text/plain" }],
    ["invalid content length", { "content-type": "application/json", "content-length": "not-a-number" }],
    ["oversized content length", { "content-type": "application/json", "content-length": "999999" }],
  ])("cancels the response body before rejecting %s", async (_name, headers) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from("private remote body")); },
      cancel() { cancelled = true; },
    });
    const fetch = vi.fn(async () => new Response(body, { status: 500, headers }));
    const client = createActivationClient({ endpoint: "https://activation.example.test/", fetch, maxResponseBytes: 64 });

    await expect(client.activate(request)).rejects.toMatchObject({ code: "INVALID_RESPONSE", retryable: false });
    expect(cancelled).toBe(true);
  });

  it("strictly validates successful responses", async () => {
    const fetch = vi.fn(async () => jsonResponse({ ...response, unexpected: true }));
    const client = createActivationClient({ endpoint: "https://activation.example.test/", fetch });
    await expect(client.activate(request)).rejects.toMatchObject({ code: "INVALID_RESPONSE", retryable: false });
  });

  it("retries a retryable response once with the same idempotency key", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ requestId: "request-001", activationId: null, code: "SERVICE_BUSY", stage: null, retryable: true, supportCode: "BUSY-01" }, 503))
      .mockResolvedValueOnce(jsonResponse(response));
    const client = createActivationClient({ endpoint: "https://activation.example.test/", fetch });

    await expect(client.activate(request)).resolves.toMatchObject({ activationId: "activation-001" });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of fetch.mock.calls) {
      expect(init).toMatchObject({ headers: expect.objectContaining({ "idempotency-key": request.idempotencyKey }) });
      expect(JSON.parse(String(init?.body))).toMatchObject({ idempotencyKey: request.idempotencyKey });
    }
  });

  it("shares one total timeout budget across the initial request and retry", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const fetch = vi.fn((_url: string | URL, init: RequestInit) => new Promise<Response>((resolve, reject) => {
        signals.push(init.signal as AbortSignal);
        if (fetch.mock.calls.length === 1) {
          setTimeout(() => resolve(jsonResponse({
            requestId: "request-001", activationId: null, code: "SERVICE_BUSY", stage: null,
            retryable: true, supportCode: "BUSY-01",
          }, 503)), 700);
          return;
        }
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }));
      const client = createActivationClient({ endpoint: "https://activation.example.test/", fetch, requestTimeoutMs: 1_000 });
      const activation = client.activate(request);

      await vi.advanceTimersByTimeAsync(700);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(signals[1]).toBe(signals[0]);
      await vi.advanceTimersByTimeAsync(299);
      await expect(Promise.race([activation.then(() => "settled", () => "settled"), Promise.resolve("pending")])).resolves.toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      await expect(activation).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["USERNAME_NOT_FOUND", "ACTIVATION_CODE_INVALID"])("projects %s to the same public authentication error", async (code) => {
    const fetch = vi.fn(async () => jsonResponse({
      requestId: "request-001", activationId: null, code, stage: "failed_before_bind", retryable: false, supportCode: "AUTH-01",
    }, 400));
    const client = createActivationClient({ endpoint: "https://activation.example.test/", fetch });

    const error = await client.activate(request).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "ACTIVATION_INVALID", retryable: false, status: 400, stage: "failed_before_bind", activationId: null });
    expect(String(error)).toContain("Activation code is incorrect.");
    expect(`${String(error)}${JSON.stringify(error)}`).not.toMatch(/username|用户名/iu);
    expect(JSON.stringify(error)).not.toContain(request.activationCode);
  });

  it("preserves server-bound error metadata", async () => {
    const fetch = vi.fn(async () => jsonResponse({
      requestId: "request-001", activationId: "activation-001", code: "ACTIVATION_SERVICE_UNAVAILABLE",
      stage: "server_bound", retryable: true, supportCode: "ACT-SVC-001",
    }, 503));
    const client = createActivationClient({ endpoint: "https://activation.example.test/", fetch });
    await expect(client.activate(request)).rejects.toMatchObject({ stage: "server_bound", activationId: "activation-001" });
  });

  it("never includes an invalid remote body in projected errors", async () => {
    const rawSecret = "Authorization: Bearer server-secret database=/private/db";
    const fetch = vi.fn(async () => new Response(rawSecret, { status: 500, headers: { "content-type": "text/plain" } }));
    const client = createActivationClient({ endpoint: "https://activation.example.test/", fetch });
    const error = await client.activate(request).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "INVALID_RESPONSE" });
    expect(String(error)).not.toContain(rawSecret);
    expect(JSON.stringify(error)).not.toContain(rawSecret);
  });

  it("commits through the OpenAPI path with the shared strict body and idempotency key", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const client = createActivationClient({ endpoint: "https://activation.example.test/", fetch });
    await expect(client.commit("activation-001", { idempotencyKey: request.idempotencyKey, artifactGeneration: 7 })).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(new URL("https://activation.example.test/v1/activations/activation-001/commit"), expect.objectContaining({
      method: "POST", body: JSON.stringify({ idempotencyKey: request.idempotencyKey, artifactGeneration: 7 }),
      headers: expect.objectContaining({ "idempotency-key": request.idempotencyKey }), redirect: "error",
    }));
  });

  it("combines caller cancellation with the total request deadline", async () => {
    const signals: AbortSignal[] = [];
    const fetch = vi.fn((_url: string | URL, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    });
    const client = createActivationClient({ endpoint: "https://activation.example.test/", fetch });
    const controller = new AbortController();
    const pending = client.commit("activation-001", { idempotencyKey: request.idempotencyKey, artifactGeneration: 1 }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(signals[0]?.aborted).toBe(true);
  });
});
