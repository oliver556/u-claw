import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  NewApiAuditPageSchema,
  NewApiAuditQuerySchema,
  NewApiActivateTokenInputSchema,
  NewApiCreateDeviceMappingInputSchema,
  NewApiCreateTokenInputSchema,
  NewApiCreateUserInputSchema,
  NewApiDeviceMappingSchema,
  NewApiManagementErrorBodySchema,
  NewApiPolicySchema,
  NewApiUpdateDeviceStatusInputSchema,
  type NewApiAuditEvent,
  type NewApiDeviceMapping,
  type NewApiErrorCategory,
  type NewApiIssuedToken,
  type NewApiPolicy,
  type NewApiToken,
  type NewApiUsage,
  type NewApiUser,
} from "@uclaw/shared";
import { z } from "zod";

export interface StartLocalNewApiManagementServerOptions {
  hostname?: "127.0.0.1" | "::1" | "localhost";
  managementCredential: string;
  now?: () => Date;
}

export interface LocalNewApiManagementServer {
  readonly url: string;
  recordUsage(userId: string, amount: number): void;
  close(): Promise<void>;
}

type StoredToken = { summary: NewApiToken; secretHash: string };
type IdempotencyEntry = { fingerprint: string; status: number; sealedResponse: string };
type InFlightEntry = { fingerprint: string; promise: Promise<{ status: number; value: unknown }> };
type ApiFailure = Error & { category: NewApiErrorCategory; code: string; retryable: boolean; status: number };

const BASE_PATH = "/uclaw-management/v1/";
const DEFAULT_POLICY: NewApiPolicy = {
  quota: { unit: "tokens", limit: 100_000, period: "monthly" },
  rateLimit: { requestsPerMinute: 60, concurrentRequests: 2 },
  allowedModels: [],
  disabled: false,
};

function failure(status: number, category: NewApiErrorCategory, code: string, message: string, retryable = false): ApiFailure {
  return Object.assign(new Error(message), { status, category, code, retryable });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 256 * 1024) throw failure(413, "validation", "REQUEST_TOO_LARGE", "Management request is too large.");
    chunks.push(buffer);
  }
  if (bytes === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
  } catch (error) {
    throw failure(400, "validation", "INVALID_JSON", "Management request contains invalid JSON.", false);
  }
}

export async function startLocalNewApiManagementServer(options: StartLocalNewApiManagementServerOptions): Promise<LocalNewApiManagementServer> {
  const hostname = z.enum(["127.0.0.1", "::1", "localhost"], {
    error: "Local New API management server must bind to an exact loopback host.",
  }).parse(options.hostname ?? "127.0.0.1");
  const credential = z.string().min(12).max(512).parse(options.managementCredential);
  const now = options.now ?? (() => new Date());
  const encryptionKey = randomBytes(32);
  const users = new Map<string, NewApiUser>();
  const userIdsByUsername = new Map<string, string>();
  const userIdsByDevice = new Map<string, string>();
  const tokens = new Map<string, StoredToken>();
  const devices = new Map<string, NewApiDeviceMapping>();
  const deviceIdsByLicense = new Map<string, string>();
  const deviceIdsByToken = new Map<string, string>();
  const usage = new Map<string, number>();
  const audit: NewApiAuditEvent[] = [];
  const idempotency = new Map<string, IdempotencyEntry>();
  const inFlight = new Map<string, InFlightEntry>();
  let sequence = 0;

  const timestamp = (): string => now().toISOString();
  const nextId = (prefix: string): string => `${prefix}_${String(++sequence).padStart(6, "0")}`;
  const seal = (value: unknown): string => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
  };
  const open = (sealed: string): unknown => {
    const bytes = Buffer.from(sealed, "base64");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8")) as unknown;
  };
  const policyDigest = (policy: NewApiPolicy): string => createHash("sha256")
    .update("uclaw-new-api-policy-v1\0")
    .update(JSON.stringify(policy))
    .digest("hex");

  const addAudit = (
    action: NewApiAuditEvent["action"],
    subjectType: NewApiAuditEvent["subjectType"],
    subjectId: string,
    deviceId: string | null,
    outcome: NewApiAuditEvent["outcome"] = "succeeded",
    errorCategory: NewApiErrorCategory | null = null,
  ): void => {
    audit.push({ id: nextId("aud"), action, subjectType, subjectId, deviceId, outcome, errorCategory, createdAt: timestamp() });
    if (audit.length > 1_000) audit.shift();
  };

  const authenticate = (request: IncomingMessage): void => {
    const expected = Buffer.from(`Bearer ${credential}`);
    const actual = Buffer.from(request.headers.authorization ?? "");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw failure(401, "authentication", "AUTHENTICATION_FAILED", "Management authentication failed.");
    }
  };

  const runIdempotent = async (request: IncomingMessage, scope: string, body: unknown, operation: () => Promise<{ status: number; value: unknown }>): Promise<{ status: number; value: unknown }> => {
    const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u).parse(request.headers["idempotency-key"]);
    const storageKey = `${scope}:${key}`;
    const fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const existing = idempotency.get(storageKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw failure(409, "conflict", "IDEMPOTENCY_CONFLICT", "Idempotency key was reused with different input.");
      return { status: existing.status, value: open(existing.sealedResponse) };
    }
    const running = inFlight.get(storageKey);
    if (running) {
      if (running.fingerprint !== fingerprint) throw failure(409, "conflict", "IDEMPOTENCY_CONFLICT", "Idempotency key was reused with different input.");
      return running.promise;
    }
    const promise = operation().then((result) => {
      idempotency.set(storageKey, { fingerprint, status: result.status, sealedResponse: seal(result.value) });
      return result;
    }).finally(() => inFlight.delete(storageKey));
    inFlight.set(storageKey, { fingerprint, promise });
    return promise;
  };

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      authenticate(request);
      const url = new URL(request.url ?? "/", `http://${hostname}`);
      if (!url.pathname.startsWith(BASE_PATH)) throw failure(404, "not-found", "ENDPOINT_NOT_FOUND", "Management endpoint was not found.");
      const route = url.pathname.slice(BASE_PATH.length).replace(/\/$/u, "");
      const method = request.method ?? "GET";

      if (method === "POST" && route === "users") {
        const body = await readJson(request);
        const input = NewApiCreateUserInputSchema.parse({ ...z.record(z.string(), z.unknown()).parse(body), idempotencyKey: request.headers["idempotency-key"] });
        const result = await runIdempotent(request, "user.create", body, async () => {
          if (userIdsByUsername.has(input.username)) throw failure(409, "conflict", "USERNAME_CONFLICT", "Username already exists.");
          if (userIdsByDevice.has(input.deviceId)) throw failure(409, "conflict", "DEVICE_CONFLICT", "Device already has a user.");
          const createdAt = timestamp();
          const user: NewApiUser = {
            id: nextId("usr"), deviceId: input.deviceId, username: input.username, status: "active",
            policy: structuredClone(DEFAULT_POLICY), createdAt, updatedAt: createdAt,
          };
          users.set(user.id, user);
          userIdsByUsername.set(user.username, user.id);
          userIdsByDevice.set(user.deviceId, user.id);
          usage.set(user.id, 0);
          addAudit("user.created", "user", user.id, user.deviceId);
          return { status: 201, value: user };
        });
        sendJson(response, result.status, result.value);
        return;
      }

      const createTokenMatch = /^users\/([^/]+)\/tokens$/u.exec(route);
      if (method === "POST" && createTokenMatch) {
        const userId = decodeURIComponent(createTokenMatch[1]);
        const body = await readJson(request);
        const input = NewApiCreateTokenInputSchema.parse({ ...z.record(z.string(), z.unknown()).parse(body), userId, idempotencyKey: request.headers["idempotency-key"] });
        const result = await runIdempotent(request, `token.create:${userId}`, body, async () => {
          const user = users.get(userId);
          if (!user) throw failure(404, "not-found", "USER_NOT_FOUND", "User was not found.");
          if (user.status === "disabled") throw failure(409, "disabled", "USER_DISABLED", "User is disabled.");
          if (user.policy.allowedModels.length === 0 || input.policyDigest !== policyDigest(user.policy)) {
            throw failure(409, "conflict", "POLICY_BINDING_CONFLICT", "Token policy binding does not match user policy.");
          }
          const createdAt = timestamp();
          const token: NewApiToken = {
            id: nextId("tok"), userId, name: input.name,
            channelId: input.channelId, policyDigest: input.policyDigest, generation: input.generation,
            status: "provisioning", createdAt, updatedAt: createdAt,
          };
          const secret = `uclaw_dev_${randomBytes(24).toString("base64url")}`;
          tokens.set(token.id, { summary: token, secretHash: createHash("sha256").update(secret).digest("hex") });
          addAudit("token.created", "token", token.id, user.deviceId);
          return { status: 201, value: { token, secret } satisfies NewApiIssuedToken };
        });
        sendJson(response, result.status, result.value);
        return;
      }

      if (method === "POST" && route === "devices") {
        const body = await readJson(request);
        const input = NewApiCreateDeviceMappingInputSchema.parse({ ...z.record(z.string(), z.unknown()).parse(body), idempotencyKey: request.headers["idempotency-key"] });
        const result = await runIdempotent(request, "device.create", body, async () => {
          const previous = devices.get(input.deviceId);
          if (previous && (input.previousTokenId !== previous.newApiTokenId
              || input.generation <= previous.generation
              || !["failed", "disabled", "revoked"].includes(previous.status))) {
            throw failure(409, "conflict", "DEVICE_CONFLICT", "Device mapping replacement is invalid.");
          }
          if (!previous && input.previousTokenId !== null) {
            throw failure(409, "conflict", "DEVICE_GENERATION_CONFLICT", "Initial device mapping generation is invalid.");
          }
          if (deviceIdsByLicense.has(input.licenseId)) throw failure(409, "conflict", "LICENSE_CONFLICT", "License mapping already exists.");
          if (deviceIdsByToken.has(input.newApiTokenId)) throw failure(409, "conflict", "TOKEN_ID_CONFLICT", "Token mapping already exists.");
          const user = users.get(input.newApiUserId);
          const token = tokens.get(input.newApiTokenId);
          if (!user || user.username !== input.newApiUsername || user.deviceId !== input.deviceId) throw failure(409, "conflict", "USER_MAPPING_CONFLICT", "User mapping does not match device.");
          if (!token || token.summary.userId !== user.id || token.summary.status !== "provisioning"
              || token.summary.channelId !== input.channelId
              || token.summary.policyDigest !== input.policyDigest
              || token.summary.generation !== input.generation) {
            throw failure(409, "conflict", "TOKEN_MAPPING_CONFLICT", "Token mapping does not match user, channel, policy, or generation.");
          }
          const createdAt = timestamp();
          const { idempotencyKey: _key, ...fields } = input;
          const mapping = NewApiDeviceMappingSchema.parse({ ...fields, failure: null, createdAt, updatedAt: createdAt });
          devices.set(mapping.deviceId, mapping);
          deviceIdsByLicense.set(mapping.licenseId, mapping.deviceId);
          deviceIdsByToken.set(mapping.newApiTokenId, mapping.deviceId);
          addAudit("device.created", "device", mapping.deviceId, mapping.deviceId);
          return { status: 201, value: mapping };
        });
        sendJson(response, result.status, result.value);
        return;
      }

      const deviceMatch = /^devices\/([^/]+)$/u.exec(route);
      if (method === "GET" && deviceMatch) {
        const deviceId = decodeURIComponent(deviceMatch[1]);
        const mapping = devices.get(deviceId);
        if (!mapping) throw failure(404, "not-found", "DEVICE_NOT_FOUND", "Device mapping was not found.");
        sendJson(response, 200, mapping);
        return;
      }

      const deviceStatusMatch = /^devices\/([^/]+)\/status$/u.exec(route);
      if (method === "PATCH" && deviceStatusMatch) {
        const deviceId = decodeURIComponent(deviceStatusMatch[1]);
        const body = await readJson(request);
        const input = NewApiUpdateDeviceStatusInputSchema.parse({ ...z.record(z.string(), z.unknown()).parse(body), idempotencyKey: request.headers["idempotency-key"] });
        const result = await runIdempotent(request, `device.status:${deviceId}`, body, async () => {
          const current = devices.get(deviceId);
          if (!current) throw failure(404, "not-found", "DEVICE_NOT_FOUND", "Device mapping was not found.");
          if (current.status !== input.expectedStatus
              || current.generation !== input.expectedGeneration
              || current.licenseId !== input.expectedLicenseId
              || current.newApiTokenId !== input.expectedTokenId) {
            throw failure(409, "conflict", "DEVICE_CAS_CONFLICT", "Device mapping changed before status update.");
          }
          const updated = NewApiDeviceMappingSchema.parse({
            ...current,
            status: input.status,
            failure: input.status === "failed" ? input.failure : null,
            updatedAt: timestamp(),
          });
          devices.set(deviceId, updated);
          addAudit("device.status-updated", "device", deviceId, deviceId);
          return { status: 200, value: updated };
        });
        sendJson(response, result.status, result.value);
        return;
      }

      const activateMatch = /^tokens\/([^/]+)\/activate$/u.exec(route);
      if (method === "POST" && activateMatch) {
        const tokenId = decodeURIComponent(activateMatch[1]);
        const body = await readJson(request);
        const input = NewApiActivateTokenInputSchema.parse({
          ...z.record(z.string(), z.unknown()).parse(body),
          idempotencyKey: request.headers["idempotency-key"],
        });
        const result = await runIdempotent(request, `token.activate:${tokenId}`, body, async () => {
          const stored = tokens.get(tokenId);
          const mapping = devices.get(input.deviceId);
          if (!stored) throw failure(404, "not-found", "TOKEN_NOT_FOUND", "Device token was not found.");
          if (!mapping || mapping.status !== "active") {
            throw failure(409, "conflict", "TOKEN_MAPPING_INACTIVE", "Token mapping is not active.");
          }
          if (stored.summary.status === "revoked"
              || mapping.newApiTokenId !== stored.summary.id
              || mapping.newApiUserId !== stored.summary.userId
              || mapping.channelId !== stored.summary.channelId
              || mapping.policyDigest !== stored.summary.policyDigest
              || mapping.generation !== stored.summary.generation) {
            throw failure(409, "conflict", "TOKEN_MAPPING_CONFLICT", "Token mapping does not match token binding.");
          }
          const updated: NewApiToken = { ...stored.summary, status: "active", updatedAt: timestamp() };
          tokens.set(tokenId, { ...stored, summary: updated });
          addAudit("token.activated", "token", tokenId, mapping.deviceId);
          return { status: 200, value: updated };
        });
        sendJson(response, result.status, result.value);
        return;
      }

      const policyMatch = /^users\/([^/]+)\/policy$/u.exec(route);
      if (method === "PUT" && policyMatch) {
        const userId = decodeURIComponent(policyMatch[1]);
        const policy = NewApiPolicySchema.parse(await readJson(request));
        const user = users.get(userId);
        if (!user) throw failure(404, "not-found", "USER_NOT_FOUND", "User was not found.");
        const updatedUser: NewApiUser = { ...user, policy, status: policy.disabled ? "disabled" : "active", updatedAt: timestamp() };
        users.set(userId, updatedUser);
        addAudit("policy.updated", "user", userId, user.deviceId);
        sendJson(response, 200, policy);
        return;
      }

      const usageMatch = /^users\/([^/]+)\/usage$/u.exec(route);
      if (method === "GET" && usageMatch) {
        const userId = decodeURIComponent(usageMatch[1]);
        const user = users.get(userId);
        if (!user) throw failure(404, "not-found", "USER_NOT_FOUND", "User was not found.");
        const consumed = usage.get(userId) ?? 0;
        const result: NewApiUsage = {
          userId,
          consumed,
          remaining: Math.max(0, user.policy.quota.limit - consumed),
          resetAt: user.policy.quota.period === "lifetime" ? null : timestamp(),
          updatedAt: timestamp(),
        };
        addAudit("usage.queried", "user", userId, user.deviceId);
        sendJson(response, 200, result);
        return;
      }

      const revokeMatch = /^tokens\/([^/]+)\/revoke$/u.exec(route);
      if (method === "POST" && revokeMatch) {
        const tokenId = decodeURIComponent(revokeMatch[1]);
        const body = await readJson(request);
        const result = await runIdempotent(request, `token.revoke:${tokenId}`, body, async () => {
          const stored = tokens.get(tokenId);
          if (!stored) throw failure(404, "not-found", "TOKEN_NOT_FOUND", "Device token was not found.");
          const updated: NewApiToken = { ...stored.summary, status: "revoked", updatedAt: timestamp() };
          tokens.set(tokenId, { ...stored, summary: updated });
          const deviceId = deviceIdsByToken.get(tokenId) ?? users.get(updated.userId)?.deviceId ?? null;
          addAudit("token.revoked", "token", tokenId, deviceId);
          return { status: 200, value: updated };
        });
        sendJson(response, result.status, result.value);
        return;
      }

      if (method === "GET" && route === "audit-events") {
        if ([...url.searchParams.keys()].some((key) => !["deviceId", "cursor", "pageSize"].includes(key))) {
          throw failure(400, "validation", "INVALID_QUERY", "Audit query is invalid.");
        }
        const query = NewApiAuditQuerySchema.parse({
          ...(url.searchParams.has("deviceId") ? { deviceId: url.searchParams.get("deviceId") } : {}),
          cursor: url.searchParams.get("cursor"),
          pageSize: Number(url.searchParams.get("pageSize")),
        });
        const offset = query.cursor === null ? 0 : Number(query.cursor);
        const events = query.deviceId === undefined ? audit : audit.filter((event) => event.deviceId === query.deviceId);
        const items = events.slice(offset, offset + query.pageSize);
        const nextOffset = offset + items.length;
        const hasMore = nextOffset < events.length;
        const result = NewApiAuditPageSchema.parse({ items, nextCursor: hasMore ? String(nextOffset) : null, hasMore });
        sendJson(response, 200, result);
        return;
      }

      throw failure(404, "not-found", "ENDPOINT_NOT_FOUND", "Management endpoint was not found.");
    } catch (error) {
      let apiError: ApiFailure;
      if (error instanceof z.ZodError) apiError = failure(400, "validation", "VALIDATION_FAILED", "Management request validation failed.");
      else if (error && typeof error === "object" && "category" in error) apiError = error as ApiFailure;
      else apiError = failure(500, "unavailable", "INTERNAL_ERROR", "Management service failed.", true);
      addAudit("request.rejected", "request", nextId("req"), null, "failed", apiError.category);
      sendJson(response, apiError.status, NewApiManagementErrorBodySchema.parse({
        error: { category: apiError.category, code: apiError.code, message: apiError.message, retryable: apiError.retryable },
      }));
    }
  };

  const server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `http://${host}:${address.port}${BASE_PATH}`,
    recordUsage(userId, amount) {
      if (!users.has(userId)) throw new Error("Unknown fixture user.");
      const parsed = z.number().int().min(0).parse(amount);
      usage.set(userId, (usage.get(userId) ?? 0) + parsed);
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
