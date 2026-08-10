import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  BuiltinDeviceControlsSchema,
  BuiltinDeviceControlsUpdateSchema,
  BuiltinModelRequestSchema,
  BuiltinModelResponseSchema,
  BuiltinModelUsageSchema,
  BuiltinServiceHealthSchema,
  BuiltinServiceStatusSchema,
  BuiltinServiceStatusUpdateSchema,
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
  LicenseStatusSummarySchema,
  type BuiltinDeviceControls,
  type BuiltinModelRequest,
  type BuiltinModelUsage,
  type BuiltinServiceState,
  type BuiltinServiceStatus,
  type LicenseStatusSummary,
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
  builtin?: {
    readLicenseStatus(licenseId: string, signal?: AbortSignal): Promise<LicenseStatusSummary>;
    execute(request: BuiltinModelRequest, signal?: AbortSignal): Promise<{ output: string; usage: BuiltinModelUsage }>;
    licenseTimeoutMs?: number;
  };
}

export interface LocalNewApiManagementServer {
  readonly url: string;
  readonly dataUrl: string;
  recordUsage(userId: string, amount: number): void;
  close(): Promise<void>;
}

type StoredToken = { summary: NewApiToken; secretHash: string };
type IdempotencyEntry = { fingerprint: string; status: number; sealedResponse: string };
type InFlightEntry = { fingerprint: string; promise: Promise<{ status: number; value: unknown }> };
class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly category: NewApiErrorCategory,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

const BASE_PATH = "/uclaw-management/v1/";
const DATA_BASE_PATH = "/v1/";
const DEFAULT_POLICY: NewApiPolicy = {
  quota: { unit: "tokens", limit: 100_000, period: "monthly" },
  rateLimit: { requestsPerMinute: 60, concurrentRequests: 2 },
  allowedModels: [],
  disabled: false,
};

function failure(status: number, category: NewApiErrorCategory, code: string, message: string, retryable = false): ApiFailure {
  return new ApiFailure(status, category, code, message, retryable);
}

export class LocalBuiltinUpstreamError extends Error {
  constructor(readonly status: number) {
    super("Builtin upstream request failed.");
    this.name = "LocalBuiltinUpstreamError";
  }
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
  const reservedQuota = new Map<string, number>();
  const activeRequests = new Map<string, number>();
  const admittedAt = new Map<string, number[]>();
  const controls = new Map<string, BuiltinDeviceControls>();
  const audit: NewApiAuditEvent[] = [];
  const idempotency = new Map<string, IdempotencyEntry>();
  const inFlight = new Map<string, InFlightEntry>();
  let sequence = 0;

  const timestamp = (): string => now().toISOString();
  let serviceStatus: BuiltinServiceStatus = BuiltinServiceStatusSchema.parse({
    schemaVersion: 1,
    state: "disabled",
    revision: 1,
    reasonCode: "OPERATOR_DISABLED",
    updatedAt: timestamp(),
  });
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
    serviceRevision: number | null = null,
  ): void => {
    audit.push({ id: nextId("aud"), action, subjectType, subjectId, deviceId, outcome, errorCategory, serviceRevision, createdAt: timestamp() });
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

  const allowedServiceTransitions: Readonly<Record<BuiltinServiceState, readonly BuiltinServiceState[]>> = {
    enabled: ["degraded", "maintenance", "disabled"],
    degraded: ["enabled", "maintenance", "disabled"],
    maintenance: ["enabled", "disabled"],
    disabled: ["enabled", "maintenance"],
  };

  const controlsForRoute = (route: string): { deviceId: string; current: BuiltinDeviceControls } | null => {
    const deviceMatch = /^operations\/devices\/([^/]+)\/controls$/u.exec(route);
    const userMatch = /^operations\/users\/([^/]+)\/controls$/u.exec(route);
    if (!deviceMatch && !userMatch) return null;
    const deviceId = deviceMatch
      ? decodeURIComponent(deviceMatch[1])
      : users.get(decodeURIComponent(userMatch![1]))?.deviceId;
    if (!deviceId) throw failure(404, "not-found", "DEVICE_CONTROLS_NOT_FOUND", "Device controls were not found.");
    const current = controls.get(deviceId);
    if (!current) throw failure(404, "not-found", "DEVICE_CONTROLS_NOT_FOUND", "Device controls were not found.");
    return { deviceId, current };
  };

  type AdmissionSnapshot = {
    serviceRevision: number;
    serviceState: BuiltinServiceState;
    controlsRevision: number;
    deviceId: string;
    userId: string;
    tokenId: string;
    licenseId: string;
    generation: number;
    channelId: string;
    policyDigest: string;
    policy: NewApiPolicy;
  };

  const authenticateData = (request: IncomingMessage): StoredToken => {
    const authorization = request.headers.authorization ?? "";
    const hasBearerScheme = authorization.startsWith("Bearer ") && authorization.length > 7;
    const candidate = hasBearerScheme ? authorization.slice(7) : "";
    const candidateHash = createHash("sha256").update(candidate).digest();
    let matched: StoredToken | undefined;
    for (const stored of tokens.values()) {
      if (timingSafeEqual(candidateHash, Buffer.from(stored.secretHash, "hex"))) matched = stored;
    }
    if (!hasBearerScheme || !matched) throw failure(401, "authentication", "AUTHENTICATION_FAILED", "Data authentication failed.");
    return matched;
  };

  const captureAdmission = (request: IncomingMessage, checkServiceState: boolean): AdmissionSnapshot => {
    const stored = authenticateData(request);
    if (!options.builtin) throw failure(503, "unavailable", "SERVICE_UNAVAILABLE", "Builtin service is unavailable.", true);
    const token = stored.summary;
    const deviceId = deviceIdsByToken.get(token.id);
    const mapping = deviceId ? devices.get(deviceId) : undefined;
    const user = users.get(token.userId);
    const control = deviceId ? controls.get(deviceId) : undefined;
    if (token.status !== "active" || !mapping || !user || !control
        || mapping.status !== "active"
        || mapping.newApiTokenId !== token.id
        || mapping.newApiUserId !== token.userId
        || mapping.deviceId !== user.deviceId
        || mapping.generation !== token.generation
        || mapping.channelId !== token.channelId
        || mapping.policyDigest !== token.policyDigest
        || control.deviceId !== mapping.deviceId
        || control.userId !== user.id
        || control.generation !== mapping.generation
        || control.licenseId !== mapping.licenseId
        || control.tokenId !== token.id
        || control.policyDigest !== mapping.policyDigest
        || policyDigest(user.policy) !== mapping.policyDigest) {
      throw failure(401, "authentication", "AUTHENTICATION_FAILED", "Data authentication failed.");
    }
    if (user.status !== "active" || user.policy.disabled) {
      throw failure(403, "disabled", "DEVICE_DISABLED", "Builtin access is disabled.");
    }
    if (checkServiceState && serviceStatus.state === "disabled") {
      throw failure(503, "unavailable", "SERVICE_DISABLED", "Builtin service is disabled.");
    }
    if (checkServiceState && serviceStatus.state === "maintenance") {
      throw failure(503, "unavailable", "SERVICE_MAINTENANCE", "Builtin service is in maintenance.");
    }
    return {
      serviceRevision: serviceStatus.revision,
      serviceState: serviceStatus.state,
      controlsRevision: control.revision,
      deviceId: mapping.deviceId,
      userId: user.id,
      tokenId: token.id,
      licenseId: mapping.licenseId,
      generation: mapping.generation,
      channelId: mapping.channelId,
      policyDigest: mapping.policyDigest,
      policy: structuredClone(user.policy),
    };
  };

  const sameAdmission = (left: AdmissionSnapshot, right: AdmissionSnapshot): boolean =>
    left.serviceRevision === right.serviceRevision
    && left.serviceState === right.serviceState
    && left.controlsRevision === right.controlsRevision
    && left.deviceId === right.deviceId
    && left.userId === right.userId
    && left.tokenId === right.tokenId
    && left.licenseId === right.licenseId
    && left.generation === right.generation
    && left.channelId === right.channelId
    && left.policyDigest === right.policyDigest
    && JSON.stringify(left.policy) === JSON.stringify(right.policy);

  const readAuthoritativeLicense = async (snapshot: AdmissionSnapshot): Promise<void> => {
    const controller = new AbortController();
    const timeoutMs = z.number().int().min(1).max(10_000).parse(options.builtin?.licenseTimeoutMs ?? 1_000);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(failure(503, "unavailable", "LICENSE_STATUS_UNAVAILABLE", "License status is unavailable.", true));
        }, timeoutMs);
      });
      const raw = await Promise.race([
        options.builtin!.readLicenseStatus(snapshot.licenseId, controller.signal),
        timeoutPromise,
      ]);
      let license: LicenseStatusSummary;
      try {
        license = LicenseStatusSummarySchema.parse(raw);
      } catch {
        throw failure(503, "invalid-response", "LICENSE_STATUS_INVALID", "License status is invalid.");
      }
      const currentTime = now().getTime();
      if (license.licenseId !== snapshot.licenseId
          || license.deviceId !== snapshot.deviceId
          || license.status !== "active"
          || license.replacementLicenseId !== null
          || currentTime < Date.parse(license.notBefore)
          || currentTime >= Date.parse(license.expiresAt)) {
        throw failure(401, "authentication", "AUTHENTICATION_FAILED", "Data authentication failed.");
      }
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      throw failure(503, "unavailable", "LICENSE_STATUS_UNAVAILABLE", "License status is unavailable.", true);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };

  const authorizeData = async (request: IncomingMessage, checkServiceState: boolean): Promise<AdmissionSnapshot> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const captured = captureAdmission(request, checkServiceState);
      await readAuthoritativeLicense(captured);
      const current = captureAdmission(request, checkServiceState);
      if (sameAdmission(captured, current)) return current;
    }
    throw failure(409, "conflict", "ADMISSION_CONFLICT", "Builtin admission state changed.", true);
  };

  const reserveRequest = (snapshot: AdmissionSnapshot, request: BuiltinModelRequest): number => {
    if (!snapshot.policy.allowedModels.includes(request.model)) {
      throw failure(403, "model-permission", "MODEL_NOT_ALLOWED", "Builtin model is not allowed.");
    }
    const effectiveConcurrent = snapshot.serviceState === "degraded"
      ? 1
      : snapshot.policy.rateLimit.concurrentRequests;
    if ((activeRequests.get(snapshot.userId) ?? 0) >= effectiveConcurrent) {
      throw failure(429, "rate-limit", "CONCURRENCY_LIMIT_EXCEEDED", "Builtin concurrency limit exceeded.", true);
    }
    const minuteStart = now().getTime() - 60_000;
    const recent = (admittedAt.get(snapshot.userId) ?? []).filter((value) => value > minuteStart);
    const effectiveRpm = snapshot.serviceState === "degraded"
      ? Math.max(1, Math.floor(snapshot.policy.rateLimit.requestsPerMinute / 2))
      : snapshot.policy.rateLimit.requestsPerMinute;
    if (recent.length >= effectiveRpm) {
      throw failure(429, "rate-limit", "REQUEST_RATE_LIMIT_EXCEEDED", "Builtin request rate exceeded.", true);
    }
    const reservation = snapshot.policy.quota.unit === "requests"
      ? 1
      : Buffer.byteLength(request.prompt, "utf8") + request.maxOutputTokens;
    const consumed = usage.get(snapshot.userId) ?? 0;
    const reserved = reservedQuota.get(snapshot.userId) ?? 0;
    if (consumed + reserved + reservation > snapshot.policy.quota.limit) {
      throw failure(429, "quota", "QUOTA_EXCEEDED", "Builtin quota exceeded.");
    }
    admittedAt.set(snapshot.userId, [...recent, now().getTime()]);
    activeRequests.set(snapshot.userId, (activeRequests.get(snapshot.userId) ?? 0) + 1);
    reservedQuota.set(snapshot.userId, reserved + reservation);
    return reservation;
  };

  const releaseReservation = (snapshot: AdmissionSnapshot, reservation: number, consumed: number): void => {
    reservedQuota.set(snapshot.userId, Math.max(0, (reservedQuota.get(snapshot.userId) ?? 0) - reservation));
    if (consumed > 0) usage.set(snapshot.userId, (usage.get(snapshot.userId) ?? 0) + consumed);
  };

  const releaseConcurrency = (snapshot: AdmissionSnapshot): void => {
    activeRequests.set(snapshot.userId, Math.max(0, (activeRequests.get(snapshot.userId) ?? 0) - 1));
  };

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      authenticate(request);
      const url = new URL(request.url ?? "/", `http://${hostname}`);
      if (!url.pathname.startsWith(BASE_PATH)) throw failure(404, "not-found", "ENDPOINT_NOT_FOUND", "Management endpoint was not found.");
      const route = url.pathname.slice(BASE_PATH.length).replace(/\/$/u, "");
      const method = request.method ?? "GET";

      if (method === "GET" && route === "operations/service") {
        sendJson(response, 200, serviceStatus);
        return;
      }
      if (method === "PATCH" && route === "operations/service") {
        const body = await readJson(request);
        const input = BuiltinServiceStatusUpdateSchema.parse({
          ...z.record(z.string(), z.unknown()).parse(body),
          idempotencyKey: request.headers["idempotency-key"],
        });
        const result = await runIdempotent(request, "operations.service", body, async () => {
          if (serviceStatus.revision !== input.expectedRevision) {
            throw failure(409, "conflict", "SERVICE_STATE_CAS_CONFLICT", "Builtin service state changed before update.");
          }
          if (!allowedServiceTransitions[serviceStatus.state].includes(input.state)) {
            throw failure(409, "conflict", "SERVICE_STATE_TRANSITION_INVALID", "Builtin service state transition is invalid.");
          }
          if ((input.state === "enabled" || input.state === "degraded") && options.builtin === undefined) {
            throw failure(503, "unavailable", "SERVICE_UNAVAILABLE", "Builtin service dependencies are not configured.");
          }
          serviceStatus = BuiltinServiceStatusSchema.parse({
            schemaVersion: 1,
            state: input.state,
            revision: serviceStatus.revision + 1,
            reasonCode: input.reasonCode,
            updatedAt: timestamp(),
          });
          addAudit("service-state.updated", "service", "builtin-service", null, "succeeded", null, serviceStatus.revision);
          return { status: 200, value: serviceStatus };
        });
        sendJson(response, result.status, result.value);
        return;
      }

      const locatedControls = controlsForRoute(route);
      if (method === "GET" && locatedControls) {
        sendJson(response, 200, locatedControls.current);
        return;
      }
      if (method === "PATCH" && locatedControls) {
        const body = await readJson(request);
        const input = BuiltinDeviceControlsUpdateSchema.parse({
          ...z.record(z.string(), z.unknown()).parse(body),
          idempotencyKey: request.headers["idempotency-key"],
        });
        const result = await runIdempotent(request, `operations.controls:${locatedControls.deviceId}`, body, async () => {
          const current = controls.get(locatedControls.deviceId);
          const mapping = devices.get(locatedControls.deviceId);
          if (!current || !mapping) {
            throw failure(404, "not-found", "DEVICE_CONTROLS_NOT_FOUND", "Device controls were not found.");
          }
          const stored = tokens.get(mapping.newApiTokenId);
          const user = users.get(mapping.newApiUserId);
          if (current.revision !== input.expectedRevision
              || current.generation !== input.expectedGeneration
              || current.licenseId !== input.expectedLicenseId
              || current.tokenId !== input.expectedTokenId
              || mapping.generation !== input.expectedGeneration
              || mapping.licenseId !== input.expectedLicenseId
              || mapping.newApiTokenId !== input.expectedTokenId
              || !stored
              || !user) {
            throw failure(409, "conflict", "DEVICE_CONTROLS_CAS_CONFLICT", "Device controls changed before update.");
          }
          const updatedAt = timestamp();
          const updatedDigest = policyDigest(input.policy);
          const updatedUser: NewApiUser = {
            ...user,
            policy: input.policy,
            status: input.policy.disabled ? "disabled" : "active",
            updatedAt,
          };
          const updatedMapping = NewApiDeviceMappingSchema.parse({ ...mapping, policyDigest: updatedDigest, updatedAt });
          const updatedToken: NewApiToken = { ...stored.summary, policyDigest: updatedDigest, updatedAt };
          const updatedControls = BuiltinDeviceControlsSchema.parse({
            ...current,
            revision: current.revision + 1,
            policy: input.policy,
            policyDigest: updatedDigest,
            updatedAt,
          });
          users.set(user.id, updatedUser);
          devices.set(mapping.deviceId, updatedMapping);
          tokens.set(stored.summary.id, { ...stored, summary: updatedToken });
          controls.set(mapping.deviceId, updatedControls);
          addAudit("device-controls.updated", "device", mapping.deviceId, mapping.deviceId);
          return { status: 200, value: updatedControls };
        });
        sendJson(response, result.status, result.value);
        return;
      }

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

      const userMatch = /^users\/([^/]+)$/u.exec(route);
      if (method === "GET" && userMatch) {
        const userId = decodeURIComponent(userMatch[1]);
        const user = users.get(userId);
        if (!user) throw failure(404, "not-found", "USER_NOT_FOUND", "User was not found.");
        sendJson(response, 200, user);
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
          if (policyDigest(user.policy) !== input.policyDigest) {
            throw failure(409, "conflict", "POLICY_BINDING_CONFLICT", "User policy changed before device mapping.");
          }
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
          controls.set(mapping.deviceId, BuiltinDeviceControlsSchema.parse({
            schemaVersion: 1,
            deviceId: mapping.deviceId,
            userId: mapping.newApiUserId,
            revision: (controls.get(mapping.deviceId)?.revision ?? 0) + 1,
            policy: user.policy,
            policyDigest: mapping.policyDigest,
            generation: mapping.generation,
            licenseId: mapping.licenseId,
            tokenId: mapping.newApiTokenId,
            updatedAt: createdAt,
          }));
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
      if (method === "GET" && policyMatch) {
        const userId = decodeURIComponent(policyMatch[1]);
        const user = users.get(userId);
        if (!user) throw failure(404, "not-found", "USER_NOT_FOUND", "User was not found.");
        sendJson(response, 200, user.policy);
        return;
      }
      if (method === "PUT" && policyMatch) {
        const userId = decodeURIComponent(policyMatch[1]);
        const policy = NewApiPolicySchema.parse(await readJson(request));
        const user = users.get(userId);
        if (!user) throw failure(404, "not-found", "USER_NOT_FOUND", "User was not found.");
        if (devices.has(user.deviceId)) {
          throw failure(409, "conflict", "OPERATIONS_CAS_REQUIRED", "Mapped device policy requires operations CAS.");
        }
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
      else if (error instanceof ApiFailure) apiError = error;
      else apiError = failure(500, "unavailable", "INTERNAL_ERROR", "Management service failed.", true);
      addAudit("request.rejected", "request", nextId("req"), null, "failed", apiError.category);
      sendJson(response, apiError.status, NewApiManagementErrorBodySchema.parse({
        error: { category: apiError.category, code: apiError.code, message: apiError.message, retryable: apiError.retryable },
      }));
    }
  };

  const dataHandler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let admitted: AdmissionSnapshot | undefined;
    try {
      const url = new URL(request.url ?? "/", `http://${hostname}`);
      if (!url.pathname.startsWith(DATA_BASE_PATH) || url.search.length > 0) {
        throw failure(404, "not-found", "ENDPOINT_NOT_FOUND", "Data endpoint was not found.");
      }
      const route = url.pathname.slice(DATA_BASE_PATH.length).replace(/\/$/u, "");
      const method = request.method ?? "GET";
      if (method === "GET" && route === "health") {
        admitted = await authorizeData(request, false);
        const health = BuiltinServiceHealthSchema.parse({
          schemaVersion: 1,
          acceptingBuiltin: admitted.serviceState === "enabled" || admitted.serviceState === "degraded",
          state: admitted.serviceState,
          revision: admitted.serviceRevision,
        });
        addAudit("builtin.health-queried", "request", nextId("req"), admitted.deviceId, "succeeded", null, admitted.serviceRevision);
        sendJson(response, 200, health);
        return;
      }
      if (method === "POST" && route === "models/respond") {
        authenticateData(request);
        const modelRequest = BuiltinModelRequestSchema.parse(await readJson(request));
        admitted = await authorizeData(request, true);
        if (request.aborted || response.destroyed) {
          throw failure(499, "cancelled", "OPERATION_CANCELLED", "Builtin request was cancelled.");
        }
        const reservation = reserveRequest(admitted, modelRequest);
        const abortController = new AbortController();
        const onAborted = (): void => abortController.abort();
        const onClosed = (): void => {
          if (!response.writableEnded) abortController.abort();
        };
        request.once("aborted", onAborted);
        response.once("close", onClosed);
        let reservationReleased = false;
        let removeAbortWaiter = (): void => undefined;
        try {
          let raw: unknown;
          try {
            const aborted = new Promise<never>((_resolve, reject) => {
              const onAbort = (): void => reject(failure(499, "cancelled", "OPERATION_CANCELLED", "Builtin request was cancelled."));
              abortController.signal.addEventListener("abort", onAbort, { once: true });
              removeAbortWaiter = () => abortController.signal.removeEventListener("abort", onAbort);
            });
            raw = await Promise.race([options.builtin!.execute(modelRequest, abortController.signal), aborted]);
          } catch (error) {
            if (abortController.signal.aborted) {
              throw failure(499, "cancelled", "OPERATION_CANCELLED", "Builtin request was cancelled.");
            }
            if (error instanceof LocalBuiltinUpstreamError && error.status >= 400 && error.status < 500) {
              throw failure(502, "upstream", "UPSTREAM_4XX", "Builtin upstream rejected the request.");
            }
            throw failure(502, "upstream", "UPSTREAM_5XX", "Builtin upstream failed.", true);
          }
          let upstream: { output: string; usage: BuiltinModelUsage };
          try {
            upstream = z.object({ output: z.string().max(1_048_576), usage: BuiltinModelUsageSchema }).strict().parse(raw);
            if (upstream.usage.outputTokens > modelRequest.maxOutputTokens
                || (admitted.policy.quota.unit === "tokens"
                  && upstream.usage.inputTokens + upstream.usage.outputTokens > reservation)) {
              throw new Error("usage exceeds reservation");
            }
          } catch {
            releaseReservation(admitted, reservation, reservation);
            reservationReleased = true;
            throw failure(502, "invalid-response", "UPSTREAM_INVALID_RESPONSE", "Builtin upstream response is invalid.");
          }
          const consumed = admitted.policy.quota.unit === "requests"
            ? 1
            : upstream.usage.inputTokens + upstream.usage.outputTokens;
          releaseReservation(admitted, reservation, consumed);
          reservationReleased = true;
          const result = BuiltinModelResponseSchema.parse({
            schemaVersion: 1,
            requestId: modelRequest.requestId,
            output: upstream.output,
            usage: upstream.usage,
            serviceState: admitted.serviceState,
            serviceRevision: admitted.serviceRevision,
          });
          addAudit("builtin.request-succeeded", "request", nextId("req"), admitted.deviceId, "succeeded", null, admitted.serviceRevision);
          sendJson(response, 200, result);
        } finally {
          removeAbortWaiter();
          request.off("aborted", onAborted);
          response.off("close", onClosed);
          if (!reservationReleased) releaseReservation(admitted, reservation, 0);
          releaseConcurrency(admitted);
        }
        return;
      }
      throw failure(404, "not-found", "ENDPOINT_NOT_FOUND", "Data endpoint was not found.");
    } catch (error) {
      let apiError: ApiFailure;
      if (error instanceof z.ZodError) apiError = failure(400, "validation", "VALIDATION_FAILED", "Data request validation failed.");
      else if (error instanceof ApiFailure) apiError = error;
      else apiError = failure(500, "unavailable", "INTERNAL_ERROR", "Data service failed.", true);
      addAudit(
        "builtin.request-rejected",
        "request",
        nextId("req"),
        admitted?.deviceId ?? null,
        "failed",
        apiError.category,
        apiError.category === "authentication" ? null : (admitted?.serviceRevision ?? null),
      );
      if (!response.destroyed) {
        sendJson(response, apiError.status, NewApiManagementErrorBodySchema.parse({
          error: { category: apiError.category, code: apiError.code, message: apiError.message, retryable: apiError.retryable },
        }));
      }
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
  const dataServer = createServer((request, response) => void dataHandler(request, response));
  await new Promise<void>((resolve, reject) => {
    dataServer.once("error", reject);
    dataServer.listen(0, hostname, () => {
      dataServer.off("error", reject);
      resolve();
    });
  });
  const dataAddress = dataServer.address() as AddressInfo;
  const dataHost = dataAddress.family === "IPv6" ? `[${dataAddress.address}]` : dataAddress.address;
  return {
    url: `http://${host}:${address.port}${BASE_PATH}`,
    dataUrl: `http://${dataHost}:${dataAddress.port}${DATA_BASE_PATH}`,
    recordUsage(userId, amount) {
      if (!users.has(userId)) throw new Error("Unknown fixture user.");
      const parsed = z.number().int().min(0).parse(amount);
      usage.set(userId, (usage.get(userId) ?? 0) + parsed);
    },
    close: async () => {
      await Promise.all([server, dataServer].map((current) => new Promise<void>((resolve, reject) => {
        current.close((error) => error ? reject(error) : resolve());
      })));
    },
  };
}
