import {
  ActivationErrorSchema,
  ActivationRequestSchema,
  ActivationResponseSchema,
  type ActivationRequest,
  type ActivationResponse,
} from "@uclaw/shared";
import { Agent, type Dispatcher, fetch as undiciFetch } from "undici";
import { z } from "zod";

import { ActivationClientError } from "./errors.js";

interface DispatcherDeadlines {
  connectTimeout: number;
  headersTimeout: number;
  bodyTimeout: number;
}

type ActivationFetch = (
  input: string | URL,
  init: RequestInit & { dispatcher?: Dispatcher },
) => Promise<Response>;

export interface ActivationClientOptions {
  endpoint: string | URL;
  fetch?: ActivationFetch;
  createDispatcher?: (deadlines: DispatcherDeadlines) => Dispatcher;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
}

export interface ActivationClient {
  activate(input: ActivationRequest): Promise<ActivationResponse>;
  close(): Promise<void>;
}

const AUTHENTICATION_FAILURE_CODES = new Set([
  "ACTIVATION_INVALID",
  "ACTIVATION_CODE_INVALID",
  "INVALID_ACTIVATION_CODE",
  "INVALID_USERNAME_OR_CODE",
  "USERNAME_NOT_FOUND",
]);

function activationEndpoint(value: string | URL): URL {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("Activation endpoint must use HTTPS without credentials, query, or fragment.");
  }
  if (!endpoint.pathname.endsWith("/")) endpoint.pathname += "/";
  return endpoint;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    await response.body?.cancel().catch(() => undefined);
    throw new ActivationClientError("INVALID_RESPONSE", "Activation service returned an invalid response.", false, response.status);
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 0 || Number(declared) > maxBytes)) {
    await response.body?.cancel().catch(() => undefined);
    throw new ActivationClientError("INVALID_RESPONSE", "Activation service returned an invalid response.", false, response.status);
  }
  if (!response.body) {
    throw new ActivationClientError("INVALID_RESPONSE", "Activation service returned an invalid response.", false, response.status);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        throw new ActivationClientError("INVALID_RESPONSE", "Activation service returned an invalid response.", false, response.status);
      }
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ActivationClientError) throw error;
    throw new ActivationClientError("INVALID_RESPONSE", "Activation service returned an invalid response.", false, response.status);
  } finally {
    reader.releaseLock();
  }
}

function projectedRemoteError(payload: unknown, status: number): ActivationClientError {
  const parsed = ActivationErrorSchema.safeParse(payload);
  if (!parsed.success) {
    return new ActivationClientError("INVALID_RESPONSE", "Activation service returned an invalid response.", false, status);
  }
  if (AUTHENTICATION_FAILURE_CODES.has(parsed.data.code)) {
    return new ActivationClientError("ACTIVATION_INVALID", "Username or activation code is incorrect.", false, status, parsed.data.supportCode);
  }
  return new ActivationClientError(
    parsed.data.code,
    "Activation request could not be completed.",
    parsed.data.retryable,
    status,
    parsed.data.supportCode,
  );
}

function isRedirectFailure(error: unknown): boolean {
  if (!(error instanceof TypeError) || error.message !== "fetch failed") return false;
  try {
    const cause = Reflect.get(error, "cause");
    if (typeof cause !== "object" || cause === null) return false;
    const causeMessage = Reflect.get(cause, "message");
    return typeof causeMessage === "string" && /^unexpected redirect(?:\s|$)/iu.test(causeMessage);
  } catch {
    return false;
  }
}

export function createActivationClient(options: ActivationClientOptions): ActivationClient {
  const endpoint = activationEndpoint(options.endpoint);
  const connectTimeout = z.number().int().min(1).max(60_000).parse(options.connectTimeoutMs ?? 5_000);
  const requestTimeout = z.number().int().min(1).max(120_000).parse(options.requestTimeoutMs ?? 15_000);
  const maxResponseBytes = z.number().int().min(1).max(4 * 1024 * 1024).parse(options.maxResponseBytes ?? 512 * 1024);
  const fetchImpl = options.fetch ?? (undiciFetch as unknown as ActivationFetch);
  const dispatcher = (options.createDispatcher ?? ((deadlines) => new Agent({
    connect: { timeout: deadlines.connectTimeout },
    headersTimeout: deadlines.headersTimeout,
    bodyTimeout: deadlines.bodyTimeout,
  })))({ connectTimeout, headersTimeout: requestTimeout, bodyTimeout: requestTimeout });

  const requestOnce = async (input: ActivationRequest, signal: AbortSignal): Promise<ActivationResponse> => {
    try {
      if (signal.aborted) throw new ActivationClientError("TIMEOUT", "Activation service request timed out.", true);
      const response = await fetchImpl(new URL("v1/activations", endpoint), {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": input.idempotencyKey,
        },
        body: JSON.stringify(input),
        redirect: "error",
        credentials: "omit",
        signal,
        dispatcher,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new ActivationClientError("REDIRECT_REJECTED", "Activation service redirect was rejected.", false, response.status);
      }
      const payload = await readBoundedJson(response, maxResponseBytes);
      if (!response.ok) throw projectedRemoteError(payload, response.status);
      const parsed = ActivationResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new ActivationClientError("INVALID_RESPONSE", "Activation service returned an invalid response.", false, response.status);
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof ActivationClientError) throw error;
      if (signal.aborted) throw new ActivationClientError("TIMEOUT", "Activation service request timed out.", true);
      if (isRedirectFailure(error)) {
        throw new ActivationClientError("REDIRECT_REJECTED", "Activation service redirect was rejected.", false);
      }
      throw new ActivationClientError("NETWORK_ERROR", "Activation service request failed.", true);
    }
  };

  return {
    async activate(input) {
      const parsed = ActivationRequestSchema.parse(input);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeout);
      timer.unref?.();
      try {
        try {
          return await requestOnce(parsed, controller.signal);
        } catch (error) {
          if (!(error instanceof ActivationClientError) || !error.retryable) throw error;
          return await requestOnce(parsed, controller.signal);
        }
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      await dispatcher.close();
    },
  };
}
