import {
  NewApiAuditPageSchema,
  NewApiAuditQuerySchema,
  NewApiCreateDeviceMappingInputSchema,
  NewApiCreateTokenInputSchema,
  NewApiCreateUserInputSchema,
  NewApiDeviceMappingSchema,
  NewApiIssuedTokenSchema,
  NewApiManagementErrorBodySchema,
  NewApiPolicySchema,
  NewApiRevokeTokenInputSchema,
  NewApiTokenSchema,
  NewApiUpdateDeviceStatusInputSchema,
  NewApiUsageSchema,
  NewApiUserSchema,
  type NewApiErrorCategory,
  type NewApiManagementClient,
  redactRendererText,
} from "@uclaw/shared";
import { z } from "zod";

export interface NewApiManagementClientOptions {
  endpoint: string | URL;
  managementCredential: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const ResourceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u);

export class NewApiManagementError extends Error {
  constructor(
    readonly category: NewApiErrorCategory,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NewApiManagementError";
  }
}

function managementEndpoint(value: string | URL): URL {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const loopback = LOOPBACK_HOSTS.has(hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("New API management endpoint must use HTTPS; plain HTTP is allowed only for exact loopback hosts without credentials, query, or fragment.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    throw new NewApiManagementError("invalid-response", "INVALID_CONTENT_TYPE", "Management service returned a non-JSON response.", false, response.status);
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 0 || Number(declared) > maxBytes)) {
    throw new NewApiManagementError("invalid-response", "RESPONSE_TOO_LARGE", "Management service response is too large.", false, response.status);
  }
  if (!response.body) throw new NewApiManagementError("invalid-response", "MISSING_BODY", "Management service response body is missing.", false, response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new NewApiManagementError("invalid-response", "RESPONSE_TOO_LARGE", "Management service response is too large.", false, response.status);
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof NewApiManagementError) throw error;
    throw new NewApiManagementError("invalid-response", "INVALID_JSON", "Management service returned invalid JSON.", false, response.status, { cause: error });
  } finally {
    reader.releaseLock();
  }
}

export function createUnavailableNewApiManagementClient(reason: string): NewApiManagementClient {
  const message = z.string().min(1).max(300).transform((value) => redactRendererText(value)).parse(reason);
  const unavailable = async (): Promise<never> => {
    throw new NewApiManagementError("unavailable", "ENDPOINT_NOT_CONFIGURED", message, false);
  };
  return {
    createUser: unavailable,
    createToken: unavailable,
    createDeviceMapping: unavailable,
    updateDeviceStatus: unavailable,
    updatePolicy: unavailable,
    getUsage: unavailable,
    revokeToken: unavailable,
    listAuditEvents: unavailable,
  };
}

export function createNewApiManagementClient(options: NewApiManagementClientOptions): NewApiManagementClient {
  const endpoint = managementEndpoint(options.endpoint);
  const credential = z.string().min(12).max(512).parse(options.managementCredential);
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = z.number().int().min(1).max(60_000).parse(options.timeoutMs ?? 10_000);
  const maxResponseBytes = z.number().int().min(1).max(4 * 1024 * 1024).parse(options.maxResponseBytes ?? 256 * 1024);

  const request = async <T>(
    method: "GET" | "POST" | "PUT" | "PATCH",
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
        const parsed = NewApiManagementErrorBodySchema.safeParse(payload);
        if (!parsed.success) throw new NewApiManagementError("invalid-response", "INVALID_ERROR_BODY", "Management service returned an invalid error response.", false, response.status);
        const message = redactRendererText(parsed.data.error.message.split(credential).join("[REDACTED]"));
        throw new NewApiManagementError(parsed.data.error.category, parsed.data.error.code, message, parsed.data.error.retryable, response.status);
      }
      try {
        return schema.parse(payload);
      } catch (error) {
        throw new NewApiManagementError("invalid-response", "INVALID_RESPONSE_BODY", "Management service returned an invalid response body.", false, response.status, { cause: error });
      }
    } catch (error) {
      if (error instanceof NewApiManagementError) throw error;
      if (controller.signal.aborted) throw new NewApiManagementError("transport", "TIMEOUT", "Management service request timed out.", true, undefined, { cause: error });
      throw new NewApiManagementError("transport", "NETWORK_ERROR", "Management service request failed.", true, undefined, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  };

  const id = (value: string): string => encodeURIComponent(ResourceIdSchema.parse(value));
  return {
    async createUser(input) {
      const parsed = NewApiCreateUserInputSchema.parse(input);
      const { idempotencyKey, ...body } = parsed;
      return request("POST", "users", NewApiUserSchema, body, idempotencyKey);
    },
    async createToken(input) {
      const parsed = NewApiCreateTokenInputSchema.parse(input);
      const { idempotencyKey, userId, ...body } = parsed;
      return request("POST", `users/${id(userId)}/tokens`, NewApiIssuedTokenSchema, body, idempotencyKey);
    },
    async createDeviceMapping(input) {
      const parsed = NewApiCreateDeviceMappingInputSchema.parse(input);
      const { idempotencyKey, ...body } = parsed;
      return request("POST", "devices", NewApiDeviceMappingSchema, body, idempotencyKey);
    },
    async updateDeviceStatus(deviceId, input) {
      const parsed = NewApiUpdateDeviceStatusInputSchema.parse(input);
      const { idempotencyKey, ...body } = parsed;
      return request("PATCH", `devices/${id(deviceId)}/status`, NewApiDeviceMappingSchema, body, idempotencyKey);
    },
    async updatePolicy(userId, policy) {
      return request("PUT", `users/${id(userId)}/policy`, NewApiPolicySchema, NewApiPolicySchema.parse(policy));
    },
    async getUsage(userId) {
      return request("GET", `users/${id(userId)}/usage`, NewApiUsageSchema);
    },
    async revokeToken(tokenId, input) {
      const parsed = NewApiRevokeTokenInputSchema.parse(input);
      return request("POST", `tokens/${id(tokenId)}/revoke`, NewApiTokenSchema, {}, parsed.idempotencyKey);
    },
    async listAuditEvents(query) {
      const parsed = NewApiAuditQuerySchema.parse(query);
      const url = new URL("audit-events", endpoint);
      if (parsed.deviceId !== undefined) url.searchParams.set("deviceId", parsed.deviceId);
      if (parsed.cursor !== null) url.searchParams.set("cursor", parsed.cursor);
      url.searchParams.set("pageSize", String(parsed.pageSize));
      return request("GET", url.href, NewApiAuditPageSchema);
    },
  };
}
