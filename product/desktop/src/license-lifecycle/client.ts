import {
  IssuedLicenseSchema,
  LicenseIssueInputSchema,
  LicenseLifecycleErrorBodySchema,
  LicenseMutationInputSchema,
  LicenseReissueInputSchema,
  LicenseStatusResponseSchema,
  redactRendererText,
  type LicenseLifecycleClient,
  type LicenseLifecycleErrorCategory,
} from "@uclaw/shared";
import { z } from "zod";

export interface LicenseLifecycleClientOptions {
  endpoint: string | URL;
  managementCredential: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  allowLoopbackHttp?: boolean;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const ResourceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u);

export class LicenseLifecycleError extends Error {
  constructor(
    readonly category: LicenseLifecycleErrorCategory,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LicenseLifecycleError";
  }
}

function lifecycleEndpoint(value: string | URL, allowLoopbackHttp: boolean): URL {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const loopback = LOOPBACK_HOSTS.has(hostname);
  if ((url.protocol !== "https:" && !(allowLoopbackHttp && url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("License lifecycle endpoint must use HTTPS; plain HTTP requires explicit test-only loopback permission.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    throw new LicenseLifecycleError("invalid-response", "INVALID_CONTENT_TYPE", "License service returned a non-JSON response.", false, response.status);
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 0 || Number(declared) > maxBytes)) {
    throw new LicenseLifecycleError("invalid-response", "RESPONSE_TOO_LARGE", "License service response is too large.", false, response.status);
  }
  if (!response.body) throw new LicenseLifecycleError("invalid-response", "MISSING_BODY", "License service response body is missing.", false, response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new LicenseLifecycleError("invalid-response", "RESPONSE_TOO_LARGE", "License service response is too large.", false, response.status);
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof LicenseLifecycleError) throw error;
    throw new LicenseLifecycleError("invalid-response", "INVALID_JSON", "License service returned invalid JSON.", false, response.status);
  } finally {
    reader.releaseLock();
  }
}

export function createUnavailableLicenseLifecycleClient(reason: string): LicenseLifecycleClient {
  const message = z.string().min(1).max(300).transform((value) => redactRendererText(value)).parse(reason);
  const unavailable = async (): Promise<never> => {
    throw new LicenseLifecycleError("unavailable", "ENDPOINT_NOT_CONFIGURED", message, false);
  };
  return {
    issueLicense: unavailable,
    getLicenseStatus: unavailable,
    revokeLicense: unavailable,
    reissueLicense: unavailable,
  };
}

export function createLicenseLifecycleClient(options: LicenseLifecycleClientOptions): LicenseLifecycleClient {
  const endpoint = lifecycleEndpoint(options.endpoint, options.allowLoopbackHttp ?? false);
  const credential = z.string().min(12).max(512).parse(options.managementCredential);
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = z.number().int().min(1).max(60_000).parse(options.timeoutMs ?? 10_000);
  const maxResponseBytes = z.number().int().min(1).max(4 * 1024 * 1024).parse(options.maxResponseBytes ?? 256 * 1024);

  const request = async <T>(
    method: "GET" | "POST",
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(new URL(path, endpoint), {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credential}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        credentials: "omit",
        signal: controller.signal,
      });
      const payload = await readBoundedJson(response, maxResponseBytes);
      if (!response.ok) {
        const parsed = LicenseLifecycleErrorBodySchema.safeParse(payload);
        if (!parsed.success) throw new LicenseLifecycleError("invalid-response", "INVALID_ERROR_BODY", "License service returned an invalid error response.", false, response.status);
        throw new LicenseLifecycleError(
          parsed.data.error.category,
          parsed.data.error.code,
          "License service rejected the request.",
          parsed.data.error.retryable,
          response.status,
        );
      }
      try {
        return schema.parse(payload);
      } catch {
        throw new LicenseLifecycleError("invalid-response", "INVALID_RESPONSE_BODY", "License service returned an invalid response body.", false, response.status);
      }
    } catch (error) {
      if (error instanceof LicenseLifecycleError) throw error;
      if (controller.signal.aborted) throw new LicenseLifecycleError("transport", "TIMEOUT", "License service request timed out.", true);
      throw new LicenseLifecycleError("transport", "NETWORK_ERROR", "License service request failed.", true);
    } finally {
      clearTimeout(timer);
    }
  };

  const id = (value: string): string => encodeURIComponent(ResourceIdSchema.parse(value));
  return {
    async issueLicense(input) {
      const parsed = LicenseIssueInputSchema.parse(input);
      const { idempotencyKey, ...body } = parsed;
      return request("POST", "licenses", IssuedLicenseSchema, body, idempotencyKey);
    },
    async getLicenseStatus(licenseId) {
      return request("GET", `licenses/${id(licenseId)}/status`, LicenseStatusResponseSchema);
    },
    async revokeLicense(licenseId, input) {
      const parsed = LicenseMutationInputSchema.parse(input);
      return request("POST", `licenses/${id(licenseId)}/revoke`, LicenseStatusResponseSchema, {}, parsed.idempotencyKey);
    },
    async reissueLicense(licenseId, input) {
      const parsed = LicenseReissueInputSchema.parse(input);
      const { idempotencyKey, ...body } = parsed;
      return request("POST", `licenses/${id(licenseId)}/reissue`, IssuedLicenseSchema, body, idempotencyKey);
    },
  };
}
