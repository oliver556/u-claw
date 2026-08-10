import {
  BuiltinModelRequestSchema,
  BuiltinModelResponseSchema,
  BuiltinServiceHealthSchema,
  NewApiManagementErrorBodySchema,
  type BuiltinModelRequest,
  type BuiltinModelResponse,
  type BuiltinServiceHealth,
  type NewApiErrorCategory,
} from "@uclaw/shared";
import { z } from "zod";

import type { BuiltinModelCredential } from "./builtin-credential-store.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const FIXED_SERVER_ERRORS = new Map<string, boolean>([
  ["401:authentication:AUTHENTICATION_FAILED", false],
  ["403:disabled:DEVICE_DISABLED", false],
  ["403:model-permission:MODEL_NOT_ALLOWED", false],
  ["404:not-found:ENDPOINT_NOT_FOUND", false],
  ["409:conflict:ADMISSION_CONFLICT", true],
  ["429:quota:QUOTA_EXCEEDED", false],
  ["429:rate-limit:CONCURRENCY_LIMIT_EXCEEDED", true],
  ["429:rate-limit:REQUEST_RATE_LIMIT_EXCEEDED", true],
  ["499:cancelled:OPERATION_CANCELLED", false],
  ["500:unavailable:INTERNAL_ERROR", true],
  ["502:invalid-response:UPSTREAM_INVALID_RESPONSE", false],
  ["502:upstream:UPSTREAM_4XX", false],
  ["502:upstream:UPSTREAM_5XX", true],
  ["503:invalid-response:LICENSE_STATUS_INVALID", false],
  ["503:unavailable:LICENSE_STATUS_UNAVAILABLE", true],
  ["503:unavailable:SERVICE_DISABLED", false],
  ["503:unavailable:SERVICE_MAINTENANCE", false],
  ["503:unavailable:SERVICE_UNAVAILABLE", true],
]);

export interface BuiltinServiceClient {
  execute(
    request: BuiltinModelRequest,
    credential: BuiltinModelCredential,
    signal?: AbortSignal,
  ): Promise<BuiltinModelResponse>;
  health(credential: BuiltinModelCredential, signal?: AbortSignal): Promise<BuiltinServiceHealth>;
}

export interface CreateBuiltinServiceClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  allowLoopbackHttp?: boolean;
  now?: () => number;
  circuitCooldownMs?: number;
}

export class BuiltinServiceClientError extends Error {
  readonly causeDetails = {};

  constructor(
    readonly category: NewApiErrorCategory,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "BuiltinServiceClientError";
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      category: this.category,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      causeDetails: this.causeDetails,
    };
  }
}

const publicMessages: Partial<Record<NewApiErrorCategory, string>> = {
  authentication: "Builtin service authentication failed.",
  disabled: "Builtin service access is disabled.",
  quota: "Builtin service quota is exhausted.",
  "rate-limit": "Builtin service rate limit was exceeded.",
  "model-permission": "Builtin model is not allowed.",
  upstream: "Builtin upstream request failed.",
  unavailable: "Builtin service is unavailable.",
  conflict: "Builtin service state changed.",
  validation: "Builtin service request was rejected.",
  "not-found": "Builtin service endpoint was not found.",
  transport: "Builtin service request failed.",
  "invalid-response": "Builtin service returned an invalid response.",
  cancelled: "Builtin service request was cancelled.",
};

function clientError(
  category: NewApiErrorCategory,
  code: string,
  retryable: boolean,
): BuiltinServiceClientError {
  return new BuiltinServiceClientError(category, code, publicMessages[category]!, retryable);
}

function endpointFor(credential: BuiltinModelCredential, allowLoopbackHttp: boolean): URL {
  const endpoint = new URL(credential.endpoint.href);
  const hostname = endpoint.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const allowed = endpoint.protocol === "https:"
    || (allowLoopbackHttp && endpoint.protocol === "http:" && LOOPBACK_HOSTS.has(hostname));
  if (!allowed || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw clientError("unavailable", "ENDPOINT_INSECURE", false);
  }
  if (!endpoint.pathname.endsWith("/")) endpoint.pathname += "/";
  return endpoint;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    await response.body?.cancel().catch(() => undefined);
    throw clientError("invalid-response", "INVALID_CONTENT_TYPE", false);
  }
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw clientError("invalid-response", "RESPONSE_TOO_LARGE", false);
    }
  }
  if (!response.body) throw clientError("invalid-response", "MISSING_BODY", false);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw clientError("invalid-response", "RESPONSE_TOO_LARGE", false);
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof BuiltinServiceClientError) throw error;
    throw error;
  } finally {
    reader.releaseLock();
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
    return JSON.parse(text) as unknown;
  } catch {
    throw clientError("invalid-response", "INVALID_JSON", false);
  }
}

function parsePositiveInteger(value: number, maximum: number): number {
  return z.number().int().min(1).max(maximum).parse(value);
}

type CircuitState = "closed" | "open" | "half-open";

function breakerCounted(error: BuiltinServiceClientError): boolean {
  return error.category === "transport"
    || error.category === "invalid-response"
    || (error.category === "upstream" && error.code === "UPSTREAM_5XX")
    || (error.category === "unavailable" && error.retryable && error.code !== "CIRCUIT_OPEN");
}

export function createUnavailableBuiltinServiceClient(): BuiltinServiceClient {
  const unavailable = async (): Promise<never> => {
    throw clientError("unavailable", "ENDPOINT_NOT_CONFIGURED", false);
  };
  return { execute: unavailable, health: unavailable };
}

export function createBuiltinServiceClient(options: CreateBuiltinServiceClientOptions = {}): BuiltinServiceClient {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = parsePositiveInteger(options.timeoutMs ?? 10_000, 60_000);
  const maxResponseBytes = parsePositiveInteger(options.maxResponseBytes ?? 2 * 1024 * 1024, 4 * 1024 * 1024);
  const cooldownMs = parsePositiveInteger(options.circuitCooldownMs ?? 30_000, 10 * 60_000);
  const allowLoopbackHttp = options.allowLoopbackHttp ?? false;
  const now = options.now ?? Date.now;
  let state: CircuitState = "closed";
  let consecutiveFailures = 0;
  let reopenAt = 0;
  let circuitEpoch = 0;

  const circuitOpen = (): BuiltinServiceClientError => clientError("unavailable", "CIRCUIT_OPEN", true);

  const send = async <T>(
    route: "models/respond" | "health",
    schema: z.ZodType<T>,
    credential: BuiltinModelCredential,
    body: BuiltinModelRequest | undefined,
    callerSignal?: AbortSignal,
  ): Promise<T> => {
    if (callerSignal?.aborted) throw clientError("cancelled", "OPERATION_CANCELLED", false);
    const endpoint = endpointFor(credential, allowLoopbackHttp);
    const controller = new AbortController();
    let abortSource: "caller" | "timeout" | undefined;
    const onCallerAbort = (): void => {
      if (abortSource === undefined) abortSource = "caller";
      controller.abort();
    };
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      if (abortSource === undefined) abortSource = "timeout";
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(new URL(route, endpoint), {
        method: body === undefined ? "GET" : "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credential.tokenSecret}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        credentials: "omit",
        signal: controller.signal,
      });
      const payload = await readBoundedJson(response, maxResponseBytes);
      if (!response.ok) {
        const parsed = NewApiManagementErrorBodySchema.safeParse(payload);
        const fixedRetryable = parsed.success
          ? FIXED_SERVER_ERRORS.get(`${response.status}:${parsed.data.error.category}:${parsed.data.error.code}`)
          : undefined;
        if (!parsed.success || fixedRetryable === undefined || fixedRetryable !== parsed.data.error.retryable) {
          throw clientError("invalid-response", "INVALID_ERROR_BODY", false);
        }
        throw clientError(
          parsed.data.error.category,
          parsed.data.error.code,
          parsed.data.error.retryable,
        );
      }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) throw clientError("invalid-response", "INVALID_RESPONSE_BODY", false);
      return parsed.data;
    } catch (error) {
      if (error instanceof BuiltinServiceClientError) throw error;
      if (abortSource === "caller" || callerSignal?.aborted) {
        throw clientError("cancelled", "OPERATION_CANCELLED", false);
      }
      if (abortSource === "timeout") throw clientError("transport", "TIMEOUT", true);
      throw clientError("transport", "NETWORK_ERROR", true);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  };

  const execute = async (
    input: BuiltinModelRequest,
    credential: BuiltinModelCredential,
    signal?: AbortSignal,
  ): Promise<BuiltinModelResponse> => {
    const parsedRequest = BuiltinModelRequestSchema.safeParse(input);
    if (!parsedRequest.success) throw clientError("validation", "INVALID_REQUEST", false);
    const request = parsedRequest.data;
    if (signal?.aborted) throw clientError("cancelled", "OPERATION_CANCELLED", false);
    if (state === "half-open") throw circuitOpen();
    if (state === "open") {
      if (now() < reopenAt) throw circuitOpen();
      state = "half-open";
    }
    const requestEpoch = circuitEpoch;
    try {
      const result = await send("models/respond", BuiltinModelResponseSchema, credential, request, signal);
      if (result.requestId !== request.requestId) {
        throw clientError("invalid-response", "RESPONSE_REQUEST_MISMATCH", false);
      }
      if (requestEpoch === circuitEpoch) {
        state = "closed";
        consecutiveFailures = 0;
      }
      return result;
    } catch (error) {
      if (!(error instanceof BuiltinServiceClientError)) throw error;
      if (requestEpoch !== circuitEpoch) throw error;
      if (breakerCounted(error)) {
        consecutiveFailures += 1;
        if (state === "half-open" || consecutiveFailures >= 2) {
          state = "open";
          reopenAt = now() + cooldownMs;
          circuitEpoch += 1;
        }
      } else {
        state = "closed";
        consecutiveFailures = 0;
      }
      throw error;
    }
  };

  const health = async (credential: BuiltinModelCredential, signal?: AbortSignal): Promise<BuiltinServiceHealth> =>
    send("health", BuiltinServiceHealthSchema, credential, undefined, signal);

  return { execute, health };
}
