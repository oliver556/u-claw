import { join, resolve } from "node:path";

import { FsSafeError, root as createSafeRoot } from "@openclaw/fs-safe";
import { configureFsSafePython, getFsSafePythonConfig } from "@openclaw/fs-safe/config";
import { readSecureFile } from "@openclaw/fs-safe/secure-file";
import type { BuiltinCredentialArtifact } from "@uclaw/shared";
import { z } from "zod";

const FILE_NAME = "builtin-model-credential.v1.json";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const PersistedCredentialSchema = z.object({
  schemaVersion: z.literal(1),
  deviceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u),
  licenseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u),
  endpoint: z.string(),
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u),
  deviceToken: z.string().regex(/^uclaw_dt_[A-Za-z0-9_-]{43}$/u),
}).strict();

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

export type BuiltinCredentialProvisioningInput = BuiltinCredentialArtifact;

export interface BuiltinModelCredential {
  endpoint: URL;
  deviceId: string;
  licenseId: string;
  deviceToken: string;
  model: string;
}

export interface BuiltinCredentialStore {
  readonly pinnedFilesystem: boolean;
  readonly credentialPath: string;
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

function validatePersisted(value: unknown, allowLoopbackHttp: boolean): {
  persisted: BuiltinCredentialArtifact;
  credential: BuiltinModelCredential;
} {
  const parsed = PersistedCredentialSchema.safeParse(value);
  if (!parsed.success) {
    throw new BuiltinCredentialError("BUILTIN_CREDENTIAL_INVALID", "Builtin model credential is invalid.");
  }
  const endpoint = validateEndpoint(parsed.data.endpoint, allowLoopbackHttp);
  const persisted = { ...parsed.data, endpoint: endpoint.href };
  return {
    persisted,
    credential: {
      endpoint,
      deviceId: persisted.deviceId,
      licenseId: persisted.licenseId,
      deviceToken: persisted.deviceToken,
      model: persisted.model,
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
  let safeRoot: ReturnType<typeof createSafeRoot> | undefined;
  const getSafeRoot = (): ReturnType<typeof createSafeRoot> => {
    safeRoot ??= createSafeRoot(dataDir, {
      symlinks: "reject", hardlinks: "reject", maxBytes: 1024 * 1024, mkdir: true, mode: 0o600,
    }).catch(() => {
      throw new BuiltinCredentialError("BUILTIN_CREDENTIAL_UNSAFE", "Builtin credential root is unsafe.");
    });
    return safeRoot;
  };
  const load = async (): Promise<BuiltinModelCredential> => {
    let body: string;
    try {
      await getSafeRoot();
      body = (await readSecureFile({
        filePath: join(resolve(dataDir), path),
        label: "builtin credential",
        trust: { trustedDirs: [resolve(dataDir)] },
        io: { maxBytes: 1024 * 1024 },
      })).buffer.toString("utf8");
    } catch (error) {
      if (error instanceof FsSafeError && error.code === "not-found") {
        throw new BuiltinCredentialError("BUILTIN_CREDENTIAL_MISSING", "Builtin model credential is not configured.");
      }
      if (error instanceof FsSafeError && [
        "symlink", "hardlink", "path-mismatch", "insecure-permissions", "permission-unverified", "not-owned",
      ].includes(error.code)) {
        throw new BuiltinCredentialError("BUILTIN_CREDENTIAL_UNSAFE", "Builtin credential target is unsafe.");
      }
      if (error instanceof BuiltinCredentialError) throw error;
      throw new BuiltinCredentialError("BUILTIN_CREDENTIAL_INVALID", "Builtin model credential could not be read.");
    }
    try {
      return validatePersisted(JSON.parse(body) as unknown, allowLoopbackHttp).credential;
    } catch (error) {
      if (error instanceof BuiltinCredentialError) throw error;
      throw new BuiltinCredentialError("BUILTIN_CREDENTIAL_INVALID", "Builtin model credential is invalid.");
    }
  };
  return {
    pinnedFilesystem: platform !== "win32",
    credentialPath: join(resolve(dataDir), path),
    async provision(input) {
      const { persisted } = validatePersisted(input, allowLoopbackHttp);
      try {
        await (await getSafeRoot()).write(path, `${JSON.stringify(persisted)}\n`, { mode: 0o600, overwrite: true });
      } catch {
        throw new BuiltinCredentialError("BUILTIN_CREDENTIAL_UNSAFE", "Builtin credential could not be written safely.");
      }
    },
    loadActive: load,
    loadForConnectivityCheck: load,
    async clear() {
      try {
        await (await getSafeRoot()).remove(path);
      } catch (error) {
        if (!(error instanceof FsSafeError) || error.code !== "not-found") throw error;
      }
    },
  };
}
