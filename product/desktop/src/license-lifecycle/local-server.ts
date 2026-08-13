import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  sign,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  IssuedLicenseSchema,
  LicenseIssueInputSchema,
  LicenseLifecycleAuditEventSchema,
  LicenseMutationInputSchema,
  LicenseReissueInputSchema,
  LicenseStatusResponseSchema,
  type IssuedLicense,
  type LicenseLifecycleAuditEvent,
  type LicenseLifecycleErrorCategory,
  type LicenseLifecycleStatus,
  type LicenseStatusResponse,
  type LicenseStatusSummary,
  type StartupLicenseArtifact,
} from "@uclaw/shared";
import { z } from "zod";

export interface StartLocalLicenseLifecycleServerOptions {
  hostname?: "127.0.0.1" | "::1" | "localhost";
  managementCredential: string;
  signingKeyId: string;
  signingPrivateKey: KeyObject;
  now?: () => Date;
  maxOfflineGraceMs?: number;
}

export interface LocalLicenseLifecycleServer {
  readonly url: string;
  readonly clientStatusUrl: string;
  listAuditEvents(): readonly LicenseLifecycleAuditEvent[];
  close(): Promise<void>;
}

type StoredLicenseStatus = Exclude<LicenseLifecycleStatus, "expired">;
type LicenseRecord = {
  licenseId: string;
  deviceId: string;
  status: StoredLicenseStatus;
  revision: number;
  usbFingerprint: string;
  startupSecretDigest: Buffer;
  notBefore: string;
  expiresAt: string;
  replacementLicenseId: string | null;
  updatedAt: string;
};
type IdempotencyEntry = { fingerprint: string; status: number; sealedResponse: string };
type ApiFailure = Error & { category: LicenseLifecycleErrorCategory; code: string; retryable: boolean; status: number };

const BASE_PATH = "/uclaw-license/v1/";
const MAX_GRACE_MS = 24 * 60 * 60 * 1_000;
const IdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u);

function failure(status: number, category: LicenseLifecycleErrorCategory, code: string, message: string, retryable = false): ApiFailure {
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
    if (bytes > 256 * 1024) throw failure(413, "validation", "REQUEST_TOO_LARGE", "License request is too large.");
    chunks.push(buffer);
  }
  if (bytes === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
  } catch {
    throw failure(400, "validation", "INVALID_JSON", "License request contains invalid JSON.");
  }
}

export async function startLocalLicenseLifecycleServer(options: StartLocalLicenseLifecycleServerOptions): Promise<LocalLicenseLifecycleServer> {
  const hostname = z.enum(["127.0.0.1", "::1", "localhost"], {
    error: "Local license lifecycle server must bind to an exact loopback host.",
  }).parse(options.hostname ?? "127.0.0.1");
  const managementCredential = z.string().min(12).max(512).parse(options.managementCredential);
  const signingKeyId = IdentifierSchema.parse(options.signingKeyId);
  if (options.signingPrivateKey.type !== "private" || options.signingPrivateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Local license lifecycle server requires an Ed25519 private key at its test boundary.");
  }
  const now = options.now ?? (() => new Date());
  const maxOfflineGraceMs = Math.min(z.number().int().min(1).max(MAX_GRACE_MS).parse(options.maxOfflineGraceMs ?? MAX_GRACE_MS), MAX_GRACE_MS);
  const encryptionKey = randomBytes(32);
  const records = new Map<string, LicenseRecord>();
  const licenseIdByDevice = new Map<string, string>();
  const idempotency = new Map<string, IdempotencyEntry>();
  const audit: LicenseLifecycleAuditEvent[] = [];
  let sequence = 0;

  const timestamp = (): string => now().toISOString();
  const nextId = (prefix: string): string => `${prefix}_${String(++sequence).padStart(6, "0")}`;
  const secretDigest = (secret: string): Buffer => createHash("sha256").update("uclaw-license-status-auth-v1\0").update(secret).digest();
  const seal = (value: unknown): string => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
  };
  const open = (value: string): unknown => {
    const bytes = Buffer.from(value, "base64");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8")) as unknown;
  };

  const addAudit = (
    action: LicenseLifecycleAuditEvent["action"],
    record: LicenseRecord | null,
    outcome: LicenseLifecycleAuditEvent["outcome"] = "succeeded",
    errorCategory: LicenseLifecycleErrorCategory | null = null,
  ): void => {
    const value = LicenseLifecycleAuditEventSchema.parse({
      id: nextId("aud"),
      action,
      licenseId: record?.licenseId ?? "lic_unknown",
      deviceId: record?.deviceId ?? "dev_unknown",
      status: record?.status ?? "provisioning",
      revision: record?.revision ?? 0,
      outcome,
      errorCategory,
      createdAt: timestamp(),
    });
    audit.push(value);
    if (audit.length > 1_000) audit.shift();
  };

  const authenticateManagement = (request: IncomingMessage): void => {
    const expected = Buffer.from(`Bearer ${managementCredential}`);
    const actual = Buffer.from(request.headers.authorization ?? "");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw failure(401, "authentication", "AUTHENTICATION_FAILED", "License management authentication failed.");
    }
  };

  const statusSummary = (record: LicenseRecord): LicenseStatusSummary => {
    const status = record.status === "active" && now().getTime() >= Date.parse(record.expiresAt) ? "expired" : record.status;
    return {
      licenseId: record.licenseId,
      deviceId: record.deviceId,
      status,
      revision: record.revision,
      notBefore: record.notBefore,
      expiresAt: record.expiresAt,
      replacementLicenseId: record.replacementLicenseId,
      updatedAt: record.updatedAt,
    };
  };

  const statusResponse = (record: LicenseRecord): LicenseStatusResponse => {
    const status = statusSummary(record);
    const checkedAt = timestamp();
    const graceUntil = status.status === "active"
      ? new Date(Math.min(Date.parse(checkedAt) + maxOfflineGraceMs, Date.parse(status.expiresAt))).toISOString()
      : checkedAt;
    const payload = [
      "uclaw-license-status-v1", 1, status.licenseId, status.deviceId, status.status, status.revision,
      status.notBefore, status.expiresAt, status.replacementLicenseId, status.updatedAt, checkedAt, graceUntil, signingKeyId,
    ];
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = sign(null, Buffer.from(JSON.stringify(payload), "utf8"), options.signingPrivateKey).toString("base64url");
    return LicenseStatusResponseSchema.parse({ status, receipt: { value: `${encoded}.${signature}` } });
  };

  const startupSecretHash = (secret: string, salt: Buffer): string => createHash("sha256")
    .update(Buffer.from("uclaw-startup-secret-v1\0", "utf8"))
    .update(salt)
    .update(Buffer.from([0]))
    .update(Buffer.from(secret, "utf8"))
    .digest("hex");

  const canonicalSigningTimestamp = (value: string): string => {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime()) || parsed.getUTCMilliseconds() !== 0) {
      throw failure(400, "validation", "INVALID_LICENSE_TIME", "License timestamps must use whole seconds.");
    }
    return parsed.toISOString().replace(".000Z", "Z");
  };

  const issue = (input: z.infer<typeof LicenseIssueInputSchema>): IssuedLicense => {
    if (licenseIdByDevice.has(input.deviceId)) {
      throw failure(409, "conflict", "LICENSE_CONFLICT", "Device already has a tracked license.");
    }
    return createIssued(input.deviceId, input.usbFingerprint, input.notBefore, input.expiresAt);
  };

  const createIssued = (deviceId: string, usbFingerprint: string, notBefore: string, expiresAt: string): IssuedLicense => {
    const canonicalNotBefore = canonicalSigningTimestamp(notBefore);
    const canonicalExpiresAt = canonicalSigningTimestamp(expiresAt);
    const licenseId = nextId("lic");
    const startupSecret = randomBytes(32).toString("base64url");
    const salt = randomBytes(16);
    const updatedAt = timestamp();
    const record: LicenseRecord = {
      licenseId,
      deviceId,
      status: "active",
      revision: 1,
      usbFingerprint,
      startupSecretDigest: secretDigest(startupSecret),
      notBefore: canonicalNotBefore,
      expiresAt: canonicalExpiresAt,
      replacementLicenseId: null,
      updatedAt,
    };
    const license: StartupLicenseArtifact = {
      schemaVersion: 1,
      usernameId: `usr_${createHash("sha256").update(deviceId).digest("hex").slice(0, 24)}`,
      deviceId,
      licenseId,
      usbFingerprint: { scheme: "uclaw-usb-v1", sha256: usbFingerprint },
      startupSecretProof: {
        algorithm: "sha256-salt-v1",
        startupSecretSalt: salt.toString("hex"),
        startupSecretHash: startupSecretHash(startupSecret, salt),
      },
      notBefore: canonicalNotBefore,
      expiresAt: canonicalExpiresAt,
      revision: record.revision,
      signature: { algorithm: "ed25519", keyId: signingKeyId, value: "" },
    };
    const signingPayload = [
      "uclaw-startup-license-v1", license.schemaVersion, license.signature.keyId, license.usernameId,
      license.deviceId, license.licenseId,
      license.usbFingerprint.scheme, license.usbFingerprint.sha256,
      license.startupSecretProof.startupSecretSalt, license.startupSecretProof.startupSecretHash,
      license.notBefore, license.expiresAt, license.revision,
    ];
    license.signature.value = sign(null, Buffer.from(JSON.stringify(signingPayload), "utf8"), options.signingPrivateKey).toString("base64");
    records.set(licenseId, record);
    licenseIdByDevice.set(deviceId, licenseId);
    addAudit("license.issued", record);
    return IssuedLicenseSchema.parse({
      status: statusSummary(record),
      startupCredential: { schemaVersion: 1, deviceId, licenseId, startupSecret },
      license,
    });
  };

  const runIdempotent = (
    request: IncomingMessage,
    scope: string,
    body: unknown,
    operation: () => { status: number; value: unknown },
  ): { status: number; value: unknown } => {
    const key = LicenseMutationInputSchema.shape.idempotencyKey.parse(request.headers["idempotency-key"]);
    const storageKey = `${scope}:${key}`;
    const fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const existing = idempotency.get(storageKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw failure(409, "conflict", "IDEMPOTENCY_CONFLICT", "Idempotency key was reused with different input.");
      return { status: existing.status, value: open(existing.sealedResponse) };
    }
    const result = operation();
    idempotency.set(storageKey, { fingerprint, status: result.status, sealedResponse: seal(result.value) });
    return result;
  };

  const server = createServer(async (request, response) => {
    let currentRecord: LicenseRecord | null = null;
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (!url.pathname.startsWith(BASE_PATH) || url.search || url.hash) throw failure(404, "not-found", "NOT_FOUND", "License endpoint was not found.");
      const path = url.pathname.slice(BASE_PATH.length);
      const match = /^licenses\/([^/]+)\/(status|revoke|reissue)$/u.exec(path);
      const clientMatch = /^client-status\/([^/]+)$/u.exec(path);

      if (request.method === "POST" && path === "licenses") {
        authenticateManagement(request);
        const body = await readJson(request);
        const key = LicenseMutationInputSchema.shape.idempotencyKey.parse(request.headers["idempotency-key"]);
        const input = LicenseIssueInputSchema.parse({ ...(body as object), idempotencyKey: key });
        const { idempotencyKey: _ignored, ...operationBody } = input;
        const result = runIdempotent(request, "issue", operationBody, () => ({ status: 201, value: issue(input) }));
        sendJson(response, result.status, result.value);
        return;
      }

      if (clientMatch && request.method === "GET") {
        const licenseId = IdentifierSchema.parse(decodeURIComponent(clientMatch[1] ?? ""));
        currentRecord = records.get(licenseId) ?? null;
        if (!currentRecord) throw failure(404, "not-found", "LICENSE_NOT_FOUND", "License was not found.");
        const authorization = request.headers.authorization ?? "";
        const actualSecret = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        const actualDigest = secretDigest(actualSecret);
        if (actualDigest.length !== currentRecord.startupSecretDigest.length || !timingSafeEqual(actualDigest, currentRecord.startupSecretDigest)) {
          throw failure(401, "authentication", "AUTHENTICATION_FAILED", "License status authentication failed.");
        }
        addAudit("license.status-queried", currentRecord);
        sendJson(response, 200, statusResponse(currentRecord));
        return;
      }

      authenticateManagement(request);
      if (!match) throw failure(404, "not-found", "NOT_FOUND", "License endpoint was not found.");
      const licenseId = IdentifierSchema.parse(decodeURIComponent(match[1] ?? ""));
      currentRecord = records.get(licenseId) ?? null;
      if (!currentRecord) throw failure(404, "not-found", "LICENSE_NOT_FOUND", "License was not found.");
      const action = match[2];

      if (request.method === "GET" && action === "status") {
        addAudit("license.status-queried", currentRecord);
        sendJson(response, 200, statusResponse(currentRecord));
        return;
      }
      if (request.method === "POST" && (action === "revoke" || action === "reissue")) {
        const body = await readJson(request);
        let operationBody: unknown = body;
        if (action === "reissue") {
          const { idempotencyKey: _ignored, ...parsed } = LicenseReissueInputSchema.parse({
            ...(body as object),
            idempotencyKey: request.headers["idempotency-key"],
          });
          operationBody = parsed;
        } else {
          LicenseMutationInputSchema.parse({ idempotencyKey: request.headers["idempotency-key"] });
        }
        const result = runIdempotent(request, `${action}:${licenseId}`, operationBody, () => {
          if (!currentRecord) throw failure(404, "not-found", "LICENSE_NOT_FOUND", "License was not found.");
          if (currentRecord.status === "reissued") throw failure(409, "status", "LICENSE_REISSUED", "License was already reissued.");
          if (action === "revoke") {
            if (currentRecord.status !== "revoked") {
              currentRecord.status = "revoked";
              currentRecord.revision += 1;
              currentRecord.updatedAt = timestamp();
              addAudit("license.revoked", currentRecord);
            }
            return { status: 200, value: statusResponse(currentRecord) };
          }
          const reissue = operationBody as Omit<z.infer<typeof LicenseReissueInputSchema>, "idempotencyKey">;
          const replacement = createIssued(currentRecord.deviceId, reissue.usbFingerprint, reissue.notBefore, reissue.expiresAt);
          currentRecord.status = "reissued";
          currentRecord.revision += 1;
          currentRecord.replacementLicenseId = replacement.status.licenseId;
          currentRecord.updatedAt = timestamp();
          addAudit("license.reissued", currentRecord);
          return { status: 201, value: replacement };
        });
        sendJson(response, result.status, result.value);
        return;
      }
      throw failure(404, "not-found", "NOT_FOUND", "License endpoint was not found.");
    } catch (error) {
      const apiError = error && typeof error === "object" && "status" in error
        ? error as ApiFailure
        : failure(400, "validation", "INVALID_REQUEST", "License request is invalid.");
      addAudit("request.rejected", currentRecord, "failed", apiError.category);
      sendJson(response, apiError.status, {
        error: { category: apiError.category, code: apiError.code, message: apiError.message, retryable: apiError.retryable },
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, hostname, () => resolve());
  });
  const address = server.address() as AddressInfo;
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  const url = `http://${host}:${address.port}${BASE_PATH}`;
  return {
    url,
    clientStatusUrl: `${url}client-status/`,
    listAuditEvents: () => audit.map((event) => ({ ...event })),
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
