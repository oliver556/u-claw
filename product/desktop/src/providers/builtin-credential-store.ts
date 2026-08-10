import { FsSafeError, root as createSafeRoot } from "@openclaw/fs-safe";
import { configureFsSafePython, getFsSafePythonConfig } from "@openclaw/fs-safe/config";

import {
  NewApiDeviceMappingSchema,
  NewApiIssuedTokenSchema,
  type NewApiDeviceMapping,
  type NewApiIssuedToken,
} from "@uclaw/shared";

const FILE_NAME = "builtin-model-credential.v1.json";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export type BuiltinCredentialErrorCode =
  | "BUILTIN_CREDENTIAL_MISSING"
  | "BUILTIN_CREDENTIAL_INVALID"
  | "BUILTIN_ENDPOINT_INSECURE"
  | "BUILTIN_CREDENTIAL_UNSAFE";

export class BuiltinCredentialError extends Error {
  constructor(readonly code: BuiltinCredentialErrorCode, message: string) {
    super(message);
    this.name = "BuiltinCredentialError";
  }
}

export interface BuiltinCredentialProvisioningInput {
  endpoint: string;
  model: string;
  mapping: NewApiDeviceMapping;
  issuedToken: NewApiIssuedToken;
}

export interface BuiltinModelCredential {
  endpoint: URL;
  deviceId: string;
  userId: string;
  tokenId: string;
  tokenSecret: string;
  model: string;
}

export interface BuiltinCredentialStore {
  readonly pinnedFilesystem: boolean;
  provision(input: BuiltinCredentialProvisioningInput): Promise<void>;
  loadActive(): Promise<BuiltinModelCredential>;
  loadForConnectivityCheck(): Promise<BuiltinModelCredential>;
  clear(): Promise<void>;
}

export interface CreateBuiltinCredentialStoreOptions {
  dataDir: string;
  allowLoopbackHttp?: boolean;
  allowUnpinnedFilesystemForTest?: true;
  platformForTest?: NodeJS.Platform;
}

interface PersistedCredential {
  schemaVersion: 1;
  endpoint: string;
  model: string;
  mapping: NewApiDeviceMapping;
  issuedToken: NewApiIssuedToken;
}

function validateEndpoint(value: string, allowLoopbackHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BuiltinCredentialError("BUILTIN_ENDPOINT_INSECURE", "Builtin model endpoint is invalid.");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const allowedProtocol = url.protocol === "https:"
    || (allowLoopbackHttp && url.protocol === "http:" && LOOPBACK_HOSTS.has(hostname));
  if (!allowedProtocol || url.username || url.password || url.search || url.hash) {
    throw new BuiltinCredentialError("BUILTIN_ENDPOINT_INSECURE", "Builtin model endpoint must use HTTPS.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function validatePersisted(
  value: unknown,
  allowLoopbackHttp: boolean,
  requiredMappingStatus?: "active",
): { persisted: PersistedCredential; credential: BuiltinModelCredential } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BuiltinCredentialError("BUILTIN_CREDENTIAL_INVALID", "Builtin model credential is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.endpoint !== "string" || typeof record.model !== "string"
      || record.model.trim() !== record.model || record.model.length < 1 || record.model.length > 160) {
    throw new BuiltinCredentialError("BUILTIN_CREDENTIAL_INVALID", "Builtin model credential is invalid.");
  }
  const mapping = NewApiDeviceMappingSchema.safeParse(record.mapping);
  const issuedToken = NewApiIssuedTokenSchema.safeParse(record.issuedToken);
  if (!mapping.success || !issuedToken.success
      || (mapping.data.status !== "provisioning" && mapping.data.status !== "active")
      || (requiredMappingStatus !== undefined && mapping.data.status !== requiredMappingStatus)
      || (mapping.data.status === "provisioning" && issuedToken.data.token.status !== "provisioning")
      || (mapping.data.status === "active" && issuedToken.data.token.status !== "active")
      || mapping.data.newApiUserId !== issuedToken.data.token.userId
      || mapping.data.newApiTokenId !== issuedToken.data.token.id
      || mapping.data.channelId !== issuedToken.data.token.channelId
      || mapping.data.policyDigest !== issuedToken.data.token.policyDigest
      || mapping.data.generation !== issuedToken.data.token.generation) {
    throw new BuiltinCredentialError("BUILTIN_CREDENTIAL_INVALID", "Builtin model credential is invalid.");
  }
  const endpoint = validateEndpoint(record.endpoint, allowLoopbackHttp);
  const persisted: PersistedCredential = {
    schemaVersion: 1,
    endpoint: endpoint.href,
    model: record.model,
    mapping: mapping.data,
    issuedToken: issuedToken.data,
  };
  return {
    persisted,
    credential: {
      endpoint,
      deviceId: mapping.data.deviceId,
      userId: mapping.data.newApiUserId,
      tokenId: issuedToken.data.token.id,
      tokenSecret: issuedToken.data.secret,
      model: record.model,
    },
  };
}

export function createBuiltinCredentialStore({
  dataDir,
  allowLoopbackHttp = false,
  allowUnpinnedFilesystemForTest,
  platformForTest,
}: CreateBuiltinCredentialStoreOptions): BuiltinCredentialStore {
  const platform = platformForTest ?? process.platform;
  if (platform === "win32" && allowUnpinnedFilesystemForTest !== true) {
    throw new BuiltinCredentialError(
      "BUILTIN_CREDENTIAL_UNSAFE",
      "Pinned Windows filesystem access requires the P3-T08 native helper.",
    );
  }
  if (platform !== "win32") {
    configureFsSafePython({ mode: "require" });
    if (getFsSafePythonConfig().mode !== "require") {
      throw new BuiltinCredentialError("BUILTIN_CREDENTIAL_UNSAFE", "Pinned filesystem helper is unavailable.");
    }
  }
  const path = `.uclaw/${FILE_NAME}`;
  const safeRoot = createSafeRoot(dataDir, {
    symlinks: "reject", hardlinks: "reject", maxBytes: 1024 * 1024, mkdir: true, mode: 0o600,
  }).catch(() => {
    throw new BuiltinCredentialError("BUILTIN_CREDENTIAL_UNSAFE", "Builtin credential root is unsafe.");
  });
  const load = async (requiredMappingStatus?: "active"): Promise<BuiltinModelCredential> => {
    let body: string;
    try {
      body = await (await safeRoot).readText(path);
    } catch (error) {
      if (error instanceof FsSafeError && error.code === "not-found") {
        throw new BuiltinCredentialError("BUILTIN_CREDENTIAL_MISSING", "Builtin model credential is not configured.");
      }
      if (error instanceof FsSafeError && ["symlink", "hardlink", "path-mismatch"].includes(error.code)) {
        throw new BuiltinCredentialError("BUILTIN_CREDENTIAL_UNSAFE", "Builtin credential target is unsafe.");
      }
      if (error instanceof BuiltinCredentialError) throw error;
      throw new BuiltinCredentialError("BUILTIN_CREDENTIAL_INVALID", "Builtin model credential could not be read.");
    }
    try {
      return validatePersisted(JSON.parse(body) as unknown, allowLoopbackHttp, requiredMappingStatus).credential;
    } catch (error) {
      if (error instanceof BuiltinCredentialError) throw error;
      throw new BuiltinCredentialError("BUILTIN_CREDENTIAL_INVALID", "Builtin model credential is invalid.");
    }
  };
  return {
    pinnedFilesystem: platform !== "win32",
    async provision(input) {
      const { persisted } = validatePersisted({ schemaVersion: 1, ...input }, allowLoopbackHttp);
      try {
        await (await safeRoot).write(path, `${JSON.stringify(persisted)}\n`, { mode: 0o600, overwrite: true });
      } catch {
        throw new BuiltinCredentialError("BUILTIN_CREDENTIAL_UNSAFE", "Builtin credential could not be written safely.");
      }
    },
    loadActive: () => load("active"),
    loadForConnectivityCheck: () => load(),
    async clear() {
      try {
        await (await safeRoot).remove(path);
      } catch (error) {
        if (!(error instanceof FsSafeError) || error.code !== "not-found") throw error;
      }
    },
  };
}
