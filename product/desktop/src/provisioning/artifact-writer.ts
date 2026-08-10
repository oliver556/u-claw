import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  NewApiDeviceMappingSchema,
  NewApiIssuedTokenSchema,
  ProvisioningBindingSchema,
  ProvisioningJournalSchema,
  StartupCredentialArtifactSchema,
  StartupLicenseArtifactSchema,
  type NewApiDeviceMapping,
  type NewApiIssuedToken,
  type ProvisioningBinding,
  type ProvisioningJournal,
  type StartupLicenseArtifact,
} from "@uclaw/shared";

import type { BuiltinCredentialStore } from "../providers/builtin-credential-store.js";

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_BACKUP_BYTES = 5 * MAX_JSON_BYTES;
const LOCK_STALE_MS = 5 * 60_000;
const LOCK_WAIT_MS = 10_000;
const localLockQueues = new Map<string, Promise<void>>();

export type ProvisioningArtifactErrorCode =
  | "ARTIFACT_PATH_UNSAFE"
  | "ARTIFACT_WRITE_FAILED"
  | "ARTIFACT_INVALID"
  | "JOURNAL_INVALID"
  | "ARTIFACT_LOCKED";

export class ProvisioningArtifactError extends Error {
  constructor(readonly code: ProvisioningArtifactErrorCode, message: string) {
    super(message);
    this.name = "ProvisioningArtifactError";
  }
}

export interface ProvisioningArtifactInput {
  transactionId: string;
  generation: number;
  startupCredential: {
    schemaVersion: 1;
    deviceId: string;
    licenseId: string;
    startupSecret: string;
  };
  license: StartupLicenseArtifact;
  endpoint: string;
  model: string;
  mapping: NewApiDeviceMapping;
  issuedToken: NewApiIssuedToken;
}

export interface ProvisioningArtifactWriter {
  acquireLock(identity: { deviceId: string; requestHash: string }): Promise<() => Promise<void>>;
  recoverPendingArtifacts(): Promise<void>;
  commitArtifacts(transactionId: string, generation: number): Promise<void>;
  writeJournal(journal: ProvisioningJournal): Promise<void>;
  readJournal(): Promise<ProvisioningJournal | null>;
  writeArtifacts(input: ProvisioningArtifactInput): Promise<void>;
  finalizeCredential(input: Omit<ProvisioningArtifactInput, "transactionId" | "generation" | "startupCredential" | "license">): Promise<void>;
  verifyArtifacts(binding: ProvisioningBinding, requireActive?: boolean): Promise<void>;
  cleanupArtifacts(): Promise<void>;
}

interface BackupEntry {
  present: boolean;
  body: string | null;
  sha256: string | null;
}

interface ArtifactBackup {
  schemaVersion: 1;
  transactionId: string;
  generation: number;
  files: [BackupEntry, BackupEntry, BackupEntry];
}

function backupEntry(body: Buffer | null): BackupEntry {
  return body === null
    ? { present: false, body: null, sha256: null }
    : { present: true, body: body.toString("base64"), sha256: createHash("sha256").update(body).digest("hex") };
}

function parseBackup(value: unknown): ArtifactBackup {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("backup");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "files,generation,schemaVersion,transactionId"
      || record.schemaVersion !== 1 || typeof record.transactionId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(record.transactionId)
      || typeof record.generation !== "number" || !Number.isSafeInteger(record.generation) || record.generation < 1
      || !Array.isArray(record.files) || record.files.length !== 3) throw new Error("backup");
  const files = record.files.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("backup");
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).sort().join(",") !== "body,present,sha256") throw new Error("backup");
    if (item.present === false && item.body === null && item.sha256 === null) return item as unknown as BackupEntry;
    if (item.present !== true || typeof item.body !== "string" || typeof item.sha256 !== "string"
        || !/^[a-f0-9]{64}$/u.test(item.sha256)) throw new Error("backup");
    const body = Buffer.from(item.body, "base64");
    if (body.toString("base64") !== item.body || createHash("sha256").update(body).digest("hex") !== item.sha256) throw new Error("backup");
    return item as unknown as BackupEntry;
  }) as ArtifactBackup["files"];
  return { schemaVersion: 1, transactionId: record.transactionId, generation: record.generation, files };
}

async function acquireLocalLock(key: string): Promise<() => void> {
  const previous = localLockQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => { release = resolveLock; });
  const queued = previous.catch(() => undefined).then(() => current);
  localLockQueues.set(key, queued);
  await previous.catch(() => undefined);
  return () => {
    release();
    if (localLockQueues.get(key) === queued) localLockQueues.delete(key);
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface CreateProvisioningArtifactWriterOptions {
  dataDir: string;
  credentialStore: BuiltinCredentialStore;
}

async function assertDirectory(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ProvisioningArtifactError("ARTIFACT_PATH_UNSAFE", "Provisioning artifact directory is unsafe.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { mode: 0o700 });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ProvisioningArtifactError("ARTIFACT_PATH_UNSAFE", "Provisioning artifact directory is unsafe.");
    }
  }
}

async function assertReplaceable(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new ProvisioningArtifactError("ARTIFACT_PATH_UNSAFE", "Provisioning artifact target is unsafe.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(path: string, body: string, maxBytes = MAX_JSON_BYTES): Promise<void> {
  if (Buffer.byteLength(body) > maxBytes) {
    throw new ProvisioningArtifactError("ARTIFACT_INVALID", "Provisioning artifact is too large.");
  }
  await assertReplaceable(path);
  const parent = dirname(path);
  const temporary = join(parent, `.${path.split("/").at(-1)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function snapshot(path: string): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new ProvisioningArtifactError("ARTIFACT_PATH_UNSAFE", "Provisioning artifact target is unsafe.");
    }
    const body = await handle.readFile();
    if (body.byteLength > MAX_JSON_BYTES) throw new ProvisioningArtifactError("ARTIFACT_INVALID", "Provisioning artifact is too large.");
    return body;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function restore(path: string, body: Buffer | null): Promise<void> {
  if (body === null) await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  else await atomicWrite(path, body.toString("utf8"));
  await syncDirectory(dirname(path));
}

async function boundedJson(path: string, maxBytes = MAX_JSON_BYTES): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new ProvisioningArtifactError("ARTIFACT_PATH_UNSAFE", "Provisioning artifact target is unsafe.");
    }
    const body = await handle.readFile();
    if (body.byteLength > maxBytes) throw new ProvisioningArtifactError("ARTIFACT_INVALID", "Provisioning artifact is too large.");
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new ProvisioningArtifactError("ARTIFACT_PATH_UNSAFE", "Provisioning artifact target is unsafe.");
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof ProvisioningArtifactError) throw error;
    throw new ProvisioningArtifactError("ARTIFACT_INVALID", "Provisioning artifact is invalid.");
  } finally {
    await handle?.close();
  }
}

async function syncDirectoryIfExists(path: string): Promise<void> {
  try {
    await syncDirectory(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function createProvisioningArtifactWriter({
  dataDir,
  credentialStore,
}: CreateProvisioningArtifactWriterOptions): ProvisioningArtifactWriter {
  const uclawDir = join(dataDir, ".uclaw");
  const licenseDir = join(uclawDir, "license");
  const startupPath = join(licenseDir, ".startup-credential.json");
  const licensePath = join(licenseDir, "license.json");
  const credentialPath = join(uclawDir, "builtin-model-credential.v1.json");
  const journalPath = join(uclawDir, "provisioning-transaction.v1.json");
  const lockPath = join(uclawDir, "provisioning.lock");
  const backupPath = join(uclawDir, "provisioning-artifact-backup.v1.json");
  const lockKey = resolve(uclawDir);

  const prepare = async (): Promise<void> => {
    await assertDirectory(uclawDir);
    await assertDirectory(licenseDir);
  };
  const artifactPaths = [startupPath, licensePath, credentialPath] as const;

  const restoreBackup = async (backup: ArtifactBackup): Promise<void> => {
    await prepare();
    await Promise.all(artifactPaths.map(async (path, index) => {
      const entry = backup.files[index];
      await restore(path, entry.present ? Buffer.from(entry.body!, "base64") : null);
    }));
    await unlink(backupPath);
    await syncDirectory(uclawDir);
  };

  return {
    async acquireLock(identity) {
      const releaseLocal = await acquireLocalLock(lockKey);
      const nonce = randomUUID();
      const startedAt = Date.now();
      try {
        await assertDirectory(uclawDir);
        while (true) {
          let handle: Awaited<ReturnType<typeof open>> | undefined;
          try {
            handle = await open(lockPath, "wx", 0o600);
            const record = {
              nonce,
              pid: process.pid,
              deviceId: identity.deviceId,
              requestHash: identity.requestHash,
              acquiredAt: new Date().toISOString(),
            };
            await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
            await handle.sync();
            await handle.close();
            handle = undefined;
            await syncDirectory(uclawDir);
            break;
          } catch (error) {
            await handle?.close().catch(() => undefined);
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            try {
              const record = await boundedJson(lockPath) as Record<string, unknown>;
              const acquiredAt = typeof record.acquiredAt === "string" ? Date.parse(record.acquiredAt) : Number.NaN;
              const pid = typeof record.pid === "number" && Number.isSafeInteger(record.pid) ? record.pid : -1;
              if (Number.isFinite(acquiredAt) && Date.now() - acquiredAt > LOCK_STALE_MS && !processIsAlive(pid)) {
                await unlink(lockPath);
                await syncDirectory(uclawDir);
                continue;
              }
            } catch (readError) {
              if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
            }
            if (Date.now() - startedAt >= LOCK_WAIT_MS) {
              throw new ProvisioningArtifactError("ARTIFACT_LOCKED", "Provisioning target is locked.");
            }
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
          }
        }
      } catch (error) {
        releaseLocal();
        if (error instanceof ProvisioningArtifactError) throw error;
        throw new ProvisioningArtifactError("ARTIFACT_LOCKED", "Provisioning target lock could not be acquired.");
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          const record = await boundedJson(lockPath) as Record<string, unknown>;
          if (record.nonce === nonce) {
            await unlink(lockPath);
            await syncDirectory(uclawDir);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        } finally {
          releaseLocal();
        }
      };
    },

    async recoverPendingArtifacts() {
      try {
        await restoreBackup(parseBackup(await boundedJson(backupPath, MAX_BACKUP_BYTES)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        if (error instanceof ProvisioningArtifactError) throw error;
        throw new ProvisioningArtifactError("ARTIFACT_INVALID", "Provisioning artifact backup is invalid.");
      }
    },

    async commitArtifacts(transactionId, generation) {
      try {
        const backup = parseBackup(await boundedJson(backupPath, MAX_BACKUP_BYTES));
        if (backup.transactionId !== transactionId || backup.generation !== generation) {
          throw new ProvisioningArtifactError("ARTIFACT_INVALID", "Provisioning artifact backup does not match transaction.");
        }
        await unlink(backupPath);
        await syncDirectory(uclawDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        if (error instanceof ProvisioningArtifactError) throw error;
        throw new ProvisioningArtifactError("ARTIFACT_INVALID", "Provisioning artifact backup is invalid.");
      }
    },

    async writeJournal(value) {
      let journal: ProvisioningJournal;
      try {
        journal = ProvisioningJournalSchema.parse(value);
      } catch {
        throw new ProvisioningArtifactError("JOURNAL_INVALID", "Provisioning journal is invalid.");
      }
      await assertDirectory(uclawDir);
      try {
        await atomicWrite(journalPath, `${JSON.stringify(journal)}\n`);
      } catch (error) {
        if (error instanceof ProvisioningArtifactError) throw error;
        throw new ProvisioningArtifactError("ARTIFACT_WRITE_FAILED", "Provisioning journal could not be written.");
      }
    },

    async readJournal() {
      try {
        return ProvisioningJournalSchema.parse(await boundedJson(journalPath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        if (error instanceof ProvisioningArtifactError && error.code === "ARTIFACT_INVALID") {
          throw new ProvisioningArtifactError("JOURNAL_INVALID", "Provisioning journal is invalid.");
        }
        if (error instanceof ProvisioningArtifactError) throw error;
        throw new ProvisioningArtifactError("JOURNAL_INVALID", "Provisioning journal is invalid.");
      }
    },

    async writeArtifacts(input) {
      let startup: typeof input.startupCredential;
      let license: StartupLicenseArtifact;
      let mapping: NewApiDeviceMapping;
      let issuedToken: NewApiIssuedToken;
      try {
        startup = StartupCredentialArtifactSchema.parse(input.startupCredential);
        license = StartupLicenseArtifactSchema.parse(input.license);
        mapping = NewApiDeviceMappingSchema.parse(input.mapping);
        issuedToken = NewApiIssuedTokenSchema.parse(input.issuedToken);
        if (startup.deviceId !== license.deviceId || startup.licenseId !== license.licenseId
            || license.deviceId !== mapping.deviceId || license.licenseId !== mapping.licenseId
            || license.usbFingerprint.sha256 !== mapping.usbFingerprint
            || license.startupSecretProof.startupSecretHash !== mapping.startupSecretHash
            || license.startupSecretProof.startupSecretSalt !== mapping.startupSecretSalt
            || mapping.newApiTokenId !== issuedToken.token.id
            || mapping.newApiUserId !== issuedToken.token.userId
            || mapping.channelId !== issuedToken.token.channelId
            || mapping.policyDigest !== issuedToken.token.policyDigest
            || mapping.generation !== issuedToken.token.generation) throw new Error("binding");
      } catch {
        throw new ProvisioningArtifactError("ARTIFACT_INVALID", "Provisioning artifact binding is invalid.");
      }
      await prepare();
      const previous = await Promise.all(artifactPaths.map((path) => snapshot(path)));
      const backup: ArtifactBackup = {
        schemaVersion: 1,
        transactionId: input.transactionId,
        generation: input.generation,
        files: previous.map(backupEntry) as ArtifactBackup["files"],
      };
      try {
        await atomicWrite(backupPath, `${JSON.stringify(backup)}\n`, MAX_BACKUP_BYTES);
        await atomicWrite(startupPath, `${JSON.stringify(startup)}\n`);
        await atomicWrite(licensePath, `${JSON.stringify(license)}\n`);
        await credentialStore.provision({ endpoint: input.endpoint, model: input.model, mapping, issuedToken });
      } catch {
        await Promise.all(artifactPaths.map((path, index) => restore(path, previous[index] ?? null)));
        await unlink(backupPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        await syncDirectory(uclawDir);
        throw new ProvisioningArtifactError("ARTIFACT_WRITE_FAILED", "Provisioning artifacts could not be written.");
      }
    },

    async finalizeCredential(input) {
      try {
        await credentialStore.provision({
          endpoint: input.endpoint,
          model: input.model,
          mapping: NewApiDeviceMappingSchema.parse(input.mapping),
          issuedToken: NewApiIssuedTokenSchema.parse(input.issuedToken),
        });
        await credentialStore.loadActive();
      } catch {
        throw new ProvisioningArtifactError("ARTIFACT_WRITE_FAILED", "Active credential could not be finalized.");
      }
    },

    async verifyArtifacts(value, requireActive = false) {
      const binding = ProvisioningBindingSchema.parse(value);
      try {
        const startup = StartupCredentialArtifactSchema.parse(await boundedJson(startupPath));
        const license = StartupLicenseArtifactSchema.parse(await boundedJson(licensePath));
        const credential = requireActive
          ? await credentialStore.loadActive()
          : await credentialStore.loadForConnectivityCheck();
        if (startup.deviceId !== binding.deviceId || startup.licenseId !== binding.licenseId
            || license.deviceId !== binding.deviceId || license.licenseId !== binding.licenseId
            || license.usbFingerprint.sha256 !== binding.usbFingerprint
            || credential.deviceId !== binding.deviceId || credential.userId !== binding.newApiUserId
            || credential.tokenId !== binding.newApiTokenId) throw new Error("binding");
      } catch {
        throw new ProvisioningArtifactError("ARTIFACT_INVALID", "Provisioning artifact verification failed.");
      }
    },

    async cleanupArtifacts() {
      try {
        await restoreBackup(parseBackup(await boundedJson(backupPath, MAX_BACKUP_BYTES)));
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await Promise.all([startupPath, licensePath, credentialPath].map((path) => unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      })));
      await syncDirectoryIfExists(licenseDir);
      await syncDirectoryIfExists(uclawDir);
    },
  };
}
