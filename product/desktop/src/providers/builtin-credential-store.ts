import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

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
  provision(input: BuiltinCredentialProvisioningInput): Promise<void>;
  loadActive(): Promise<BuiltinModelCredential>;
  loadForConnectivityCheck(): Promise<BuiltinModelCredential>;
  clear(): Promise<void>;
}

export interface CreateBuiltinCredentialStoreOptions {
  dataDir: string;
  allowLoopbackHttp?: boolean;
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
      || issuedToken.data.token.status !== "active"
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

async function writeMode600(path: string, body: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new BuiltinCredentialError("BUILTIN_CREDENTIAL_UNSAFE", "Builtin credential directory is unsafe.");
  }
  try {
    const targetStat = await lstat(path);
    if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink !== 1) {
      throw new BuiltinCredentialError("BUILTIN_CREDENTIAL_UNSAFE", "Builtin credential target is unsafe.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(parent, `.${FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    const directory = await open(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export function createBuiltinCredentialStore({
  dataDir,
  allowLoopbackHttp = false,
}: CreateBuiltinCredentialStoreOptions): BuiltinCredentialStore {
  const path = join(dataDir, ".uclaw", FILE_NAME);
  const load = async (requiredMappingStatus?: "active"): Promise<BuiltinModelCredential> => {
    let body: string;
    try {
      body = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new BuiltinCredentialError("BUILTIN_CREDENTIAL_MISSING", "Builtin model credential is not configured.");
      }
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
    async provision(input) {
      const { persisted } = validatePersisted({ schemaVersion: 1, ...input }, allowLoopbackHttp);
      await writeMode600(path, `${JSON.stringify(persisted)}\n`);
    },
    loadActive: () => load("active"),
    loadForConnectivityCheck: () => load(),
    async clear() {
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}
