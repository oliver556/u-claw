import { FsSafeError, root as createSafeRoot } from "@openclaw/fs-safe";
import { configureFsSafePython } from "@openclaw/fs-safe/config";

import { UClawErrorSchema, type UClawError } from "@uclaw/shared";

export interface ProviderCredentialStore {
  get(providerId: string): Promise<string | undefined>;
  has(providerId: string): Promise<boolean>;
  set(providerId: string, apiKey: string): Promise<void>;
  remove(providerId: string): Promise<void>;
}

export interface CreateProviderCredentialStoreOptions {
  dataDir: string;
  platformForTest?: NodeJS.Platform;
  allowUnpinnedFilesystemForTest?: true;
}

const PATH = ".uclaw/provider-credentials.v1.json";

function credentialError(message: string): UClawError {
  return UClawErrorSchema.parse({ code: "OPERATION_FAILED", message, retryable: false, recoveryActions: [], causeDetails: {} });
}

function parse(value: string): Record<string, string> {
  const candidate: unknown = JSON.parse(value);
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error();
  const record = candidate as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.credentials === null || typeof record.credentials !== "object" || Array.isArray(record.credentials)) throw new Error();
  const credentials = record.credentials as Record<string, unknown>;
  if (Object.entries(credentials).some(([id, secret]) => !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(id) || typeof secret !== "string" || secret.length < 1 || secret.length > 8_192)) throw new Error();
  return credentials as Record<string, string>;
}

export function createProviderCredentialStore({
  dataDir,
  platformForTest,
  allowUnpinnedFilesystemForTest,
}: CreateProviderCredentialStoreOptions): ProviderCredentialStore {
  const platform = platformForTest ?? process.platform;
  if (platform === "win32" && allowUnpinnedFilesystemForTest !== true) {
    throw credentialError("Pinned Windows credential storage requires the native filesystem helper.");
  }
  if (platform !== "win32") configureFsSafePython({ mode: "require" });
  let safeRoot: ReturnType<typeof createSafeRoot> | undefined;
  const root = () => safeRoot ??= createSafeRoot(dataDir, {
    symlinks: "reject", hardlinks: "reject", maxBytes: 1024 * 1024, mkdir: true, mode: 0o600,
  }).catch(() => { throw credentialError("Provider credential root is unsafe."); });
  const load = async (): Promise<Record<string, string>> => {
    try {
      return parse(await (await root()).readText(PATH));
    } catch (error) {
      if (error instanceof FsSafeError && error.code === "not-found") return {};
      throw credentialError("Provider credentials could not be read safely.");
    }
  };
  const write = async (credentials: Record<string, string>): Promise<void> => {
    try {
      await (await root()).write(PATH, `${JSON.stringify({ schemaVersion: 1, credentials })}\n`, { mode: 0o600, overwrite: true });
    } catch {
      throw credentialError("Provider credentials could not be saved safely.");
    }
  };
  let queue = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  return {
    get: (providerId) => serialize(async () => (await load())[providerId]),
    has: (providerId) => serialize(async () => Object.hasOwn(await load(), providerId)),
    set: (providerId, apiKey) => serialize(async () => {
      const credentials = await load();
      credentials[providerId] = apiKey;
      await write(credentials);
    }),
    remove: (providerId) => serialize(async () => {
      const credentials = await load();
      delete credentials[providerId];
      await write(credentials);
    }),
  };
}
