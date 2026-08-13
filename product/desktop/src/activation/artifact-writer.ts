import { createHash } from "node:crypto";

import { FsSafeError, root as createSafeRoot } from "@openclaw/fs-safe";
import { configureFsSafePython, getFsSafePythonConfig } from "@openclaw/fs-safe/config";
import {
  ActivationResponseSchema,
  BuiltinCredentialArtifactSchema,
  StartupCredentialArtifactSchema,
  StartupLicenseArtifactSchema,
  type ActivationResponse,
} from "@uclaw/shared";
import { z } from "zod";

import { createBuiltinCredentialStore } from "../providers/builtin-credential-store.js";

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_BACKUP_BYTES = 4 * MAX_JSON_BYTES;

const JournalSchema = z.object({
  schemaVersion: z.literal(1),
  activationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u),
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  deviceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u),
  licenseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u),
  stage: z.enum(["server_bound", "committed"]),
}).strict();

export type ActivationArtifactJournal = z.infer<typeof JournalSchema>;

interface BackupEntry {
  present: boolean;
  body: string | null;
  sha256: string | null;
}

const BackupEntrySchema = z.union([
  z.object({ present: z.literal(false), body: z.null(), sha256: z.null() }).strict(),
  z.object({
    present: z.literal(true), body: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
]);

const BackupSchema = z.object({
  schemaVersion: z.literal(1),
  activationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u),
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  files: z.tuple([BackupEntrySchema, BackupEntrySchema, BackupEntrySchema, BackupEntrySchema]),
}).strict();

type ArtifactBackup = z.infer<typeof BackupSchema>;

const GenerationManifestSchema = z.object({
  schemaVersion: z.literal(1),
  activationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u),
  deviceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u),
  licenseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u),
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  sha256: z.object({
    startupCredential: z.string().regex(/^[a-f0-9]{64}$/u),
    license: z.string().regex(/^[a-f0-9]{64}$/u),
    builtinCredential: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
}).strict();

export type ActivationArtifactErrorCode =
  | "ARTIFACT_PATH_UNSAFE"
  | "ARTIFACT_WRITE_FAILED"
  | "ARTIFACT_INVALID"
  | "JOURNAL_INVALID";

export class ActivationArtifactError extends Error {
  constructor(readonly code: ActivationArtifactErrorCode, message: string) {
    super(message);
    this.name = "ActivationArtifactError";
  }
}

export interface ActivationArtifactWriter {
  writeServerBoundJournal(journal: ActivationArtifactJournal): Promise<void>;
  readJournal(): Promise<ActivationArtifactJournal | null>;
  writeArtifacts(input: { generation: number; response: ActivationResponse }): Promise<void>;
  verifyArtifacts(response: ActivationResponse, generation: number): Promise<void>;
  recoverPendingArtifacts(): Promise<void>;
  commitArtifacts(activationId: string, generation: number): Promise<void>;
}

export interface CreateActivationArtifactWriterOptions {
  dataDir: string;
  allowUnpinnedFilesystemForTest?: true;
  platformForTest?: NodeJS.Platform;
  beforeArtifactWrite?: (index: number) => void | Promise<void>;
  afterArtifactWrite?: (index: number) => void | Promise<void>;
  beforeCommitCleanup?: (index: number) => void | Promise<void>;
  removeForTest?: (path: string, remove: () => Promise<void>) => Promise<void>;
}

const artifactPaths = [
  ".uclaw/license/.startup-credential.json",
  ".uclaw/license/license.json",
  ".uclaw/activation-builtin-credential.v1.json",
  ".uclaw/activation-artifact-generation.v1.json",
] as const;
const journalPath = ".uclaw/activation-transaction.v1.json";
const backupPath = ".uclaw/activation-artifact-backup.v1.json";

const backupEntry = (body: Buffer | null): BackupEntry => body === null
  ? { present: false, body: null, sha256: null }
  : { present: true, body: body.toString("base64"), sha256: createHash("sha256").update(body).digest("hex") };

function parseBackup(value: unknown): ArtifactBackup {
  const parsed = BackupSchema.parse(value);
  for (const entry of parsed.files) {
    if (!entry.present) continue;
    const body = Buffer.from(entry.body, "base64");
    if (body.toString("base64") !== entry.body || createHash("sha256").update(body).digest("hex") !== entry.sha256) {
      throw new Error("invalid backup");
    }
  }
  return parsed;
}

export function createActivationArtifactWriter(options: CreateActivationArtifactWriterOptions): ActivationArtifactWriter {
  const platform = options.platformForTest ?? process.platform;
  if (platform === "win32" && options.allowUnpinnedFilesystemForTest !== true) {
    throw new ActivationArtifactError("ARTIFACT_PATH_UNSAFE", "Pinned Windows filesystem helper is unavailable.");
  }
  if (platform !== "win32") {
    configureFsSafePython({ mode: "require" });
    if (getFsSafePythonConfig().mode !== "require") {
      throw new ActivationArtifactError("ARTIFACT_PATH_UNSAFE", "Pinned filesystem helper is unavailable.");
    }
  }
  const safeRoot = createSafeRoot(options.dataDir, {
    symlinks: "reject", hardlinks: "reject", maxBytes: MAX_JSON_BYTES, mkdir: true, mode: 0o600,
  }).catch(() => {
    throw new ActivationArtifactError("ARTIFACT_PATH_UNSAFE", "Activation artifact root is unsafe.");
  });
  const credentialStore = createBuiltinCredentialStore({
    dataDir: options.dataDir,
    allowUnpinnedFilesystemForTest: options.allowUnpinnedFilesystemForTest,
    platformForTest: options.platformForTest,
  });
  if (!credentialStore.provisionActivation || !credentialStore.loadActivation) {
    throw new ActivationArtifactError("ARTIFACT_PATH_UNSAFE", "Builtin activation credential store is unavailable.");
  }
  const provisionActivation = credentialStore.provisionActivation.bind(credentialStore);
  const loadActivation = credentialStore.loadActivation.bind(credentialStore);
  const isNotFound = (error: unknown): boolean => error instanceof FsSafeError && error.code === "not-found";
  const prepare = async (): Promise<void> => {
    try {
      const fs = await safeRoot;
      await fs.mkdir(".uclaw");
      await fs.mkdir(".uclaw/license");
    } catch {
      throw new ActivationArtifactError("ARTIFACT_PATH_UNSAFE", "Activation artifact directory is unsafe.");
    }
  };
  const write = async (path: string, body: string | Buffer, maxBytes = MAX_JSON_BYTES): Promise<void> => {
    if (Buffer.byteLength(body) > maxBytes) throw new ActivationArtifactError("ARTIFACT_INVALID", "Activation artifact is too large.");
    await (await safeRoot).write(path, body, { mode: 0o600, overwrite: true });
  };
  const remove = async (path: string): Promise<void> => {
    const removeDirect = async (): Promise<void> => {
      try {
        await (await safeRoot).remove(path);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    };
    if (options.removeForTest) {
      await options.removeForTest(path, removeDirect);
      return;
    }
    await removeDirect();
  };
  const snapshot = async (path: string): Promise<Buffer | null> => {
    try {
      return await (await safeRoot).readBytes(path);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };
  const readJson = async (path: string, maxBytes = MAX_JSON_BYTES): Promise<unknown> =>
    JSON.parse(await (await safeRoot).readText(path, { maxBytes })) as unknown;
  const restore = async (path: string, entry: BackupEntry): Promise<void> => {
    if (!entry.present) await remove(path);
    else await write(path, Buffer.from(entry.body!, "base64"));
  };

  return {
    async writeServerBoundJournal(value) {
      let journal: ActivationArtifactJournal;
      try {
        journal = JournalSchema.parse(value);
      } catch {
        throw new ActivationArtifactError("JOURNAL_INVALID", "Activation journal is invalid.");
      }
      await prepare();
      try {
        await write(journalPath, `${JSON.stringify(journal)}\n`);
      } catch {
        throw new ActivationArtifactError("ARTIFACT_WRITE_FAILED", "Activation journal could not be written.");
      }
    },

    async readJournal() {
      try {
        return JournalSchema.parse(await readJson(journalPath));
      } catch (error) {
        if (isNotFound(error)) return null;
        if (error instanceof FsSafeError) throw new ActivationArtifactError("ARTIFACT_PATH_UNSAFE", "Activation journal path is unsafe.");
        throw new ActivationArtifactError("JOURNAL_INVALID", "Activation journal is invalid.");
      }
    },

    async writeArtifacts(input) {
      let response: ActivationResponse;
      try {
        response = ActivationResponseSchema.parse(input.response);
        z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).parse(input.generation);
        const journal = JournalSchema.parse(await readJson(journalPath));
        if (journal.stage !== "server_bound" || journal.activationId !== response.activationId
            || journal.deviceId !== response.deviceId || journal.licenseId !== response.licenseId
            || journal.generation !== input.generation) throw new Error("transaction");
      } catch {
        throw new ActivationArtifactError("ARTIFACT_INVALID", "Activation artifacts are invalid.");
      }
      await prepare();
      let previous: Array<Buffer | null>;
      try {
        previous = await Promise.all(artifactPaths.map(snapshot));
        const backup = {
          schemaVersion: 1 as const,
          activationId: response.activationId,
          generation: input.generation,
          files: previous.map(backupEntry) as [BackupEntry, BackupEntry, BackupEntry, BackupEntry],
        };
        await write(backupPath, `${JSON.stringify(backup)}\n`, MAX_BACKUP_BYTES);
        const artifactBodies = [response.startupCredential, response.license, response.builtinCredential];
        const encodedArtifacts = artifactBodies.map((body) => `${JSON.stringify(body)}\n`);
        const generationManifest = {
          schemaVersion: 1,
          activationId: response.activationId,
          deviceId: response.deviceId,
          licenseId: response.licenseId,
          generation: input.generation,
          sha256: {
            startupCredential: createHash("sha256").update(encodedArtifacts[0]).digest("hex"),
            license: createHash("sha256").update(encodedArtifacts[1]).digest("hex"),
            builtinCredential: createHash("sha256").update(encodedArtifacts[2]).digest("hex"),
          },
        };
        const bodies = [...artifactBodies, generationManifest];
        for (let index = 0; index < artifactPaths.length; index += 1) {
          await options.beforeArtifactWrite?.(index);
          if (index === 2) await provisionActivation(response.builtinCredential);
          else await write(artifactPaths[index], `${JSON.stringify(bodies[index])}\n`);
          await options.afterArtifactWrite?.(index);
        }
      } catch (error) {
        if (error instanceof ActivationArtifactError) throw error;
        throw new ActivationArtifactError("ARTIFACT_WRITE_FAILED", "Activation artifacts could not be written.");
      }
      try {
        await this.verifyArtifacts(response, input.generation);
      } catch {
        throw new ActivationArtifactError("ARTIFACT_INVALID", "Activation artifact read-back verification failed.");
      }
    },

    async verifyArtifacts(value, generation) {
      let response: ActivationResponse;
      try {
        response = ActivationResponseSchema.parse(value);
        try {
          const backup = parseBackup(await readJson(backupPath, MAX_BACKUP_BYTES));
          if (backup.generation !== generation || backup.activationId !== response.activationId) throw new Error("generation");
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        const startupBody = await (await safeRoot).readText(artifactPaths[0]);
        const licenseBody = await (await safeRoot).readText(artifactPaths[1]);
        const builtinBody = await (await safeRoot).readText(artifactPaths[2]);
        const startup = StartupCredentialArtifactSchema.parse(JSON.parse(startupBody));
        const license = StartupLicenseArtifactSchema.parse(JSON.parse(licenseBody));
        const builtin = BuiltinCredentialArtifactSchema.parse(await loadActivation());
        const manifest = GenerationManifestSchema.parse(await readJson(artifactPaths[3]));
        if (manifest.schemaVersion !== 1 || manifest.activationId !== response.activationId
            || manifest.deviceId !== response.deviceId || manifest.licenseId !== response.licenseId
            || manifest.generation !== generation
            || manifest.sha256?.startupCredential !== createHash("sha256").update(startupBody).digest("hex")
            || manifest.sha256?.license !== createHash("sha256").update(licenseBody).digest("hex")
            || manifest.sha256?.builtinCredential !== createHash("sha256").update(builtinBody).digest("hex")) throw new Error("manifest");
        if (JSON.stringify(startup) !== JSON.stringify(response.startupCredential)
            || JSON.stringify(license) !== JSON.stringify(response.license)
            || JSON.stringify(builtin) !== JSON.stringify(response.builtinCredential)) throw new Error("binding");
      } catch (error) {
        if (error instanceof FsSafeError && ["symlink", "hardlink", "path-mismatch"].includes(error.code)) {
          throw new ActivationArtifactError("ARTIFACT_PATH_UNSAFE", "Activation artifact path is unsafe.");
        }
        throw new ActivationArtifactError("ARTIFACT_INVALID", "Activation artifact verification failed.");
      }
    },

    async recoverPendingArtifacts() {
      const journal = await this.readJournal();
      if (journal?.stage === "committed") {
        try {
          await remove(backupPath);
          await remove(journalPath);
          return;
        } catch {
          throw new ActivationArtifactError("ARTIFACT_WRITE_FAILED", "Activation commit cleanup failed.");
        }
      }
      let backup: ArtifactBackup;
      try {
        backup = parseBackup(await readJson(backupPath, MAX_BACKUP_BYTES));
      } catch (error) {
        if (isNotFound(error)) return;
        throw new ActivationArtifactError("ARTIFACT_INVALID", "Activation artifact backup is invalid.");
      }
      await prepare();
      try {
        await Promise.all(artifactPaths.map((path, index) => restore(path, backup.files[index])));
        await remove(backupPath);
      } catch {
        throw new ActivationArtifactError("ARTIFACT_WRITE_FAILED", "Activation artifact recovery failed.");
      }
    },

    async commitArtifacts(activationId, generation) {
      let journal: ActivationArtifactJournal;
      try {
        journal = JournalSchema.parse(await readJson(journalPath));
        if (journal.activationId !== activationId || journal.generation !== generation) throw new Error("transaction");
        if (journal.stage === "committed") {
          try {
            await remove(backupPath);
            await remove(journalPath);
            return;
          } catch {
            throw new ActivationArtifactError("ARTIFACT_WRITE_FAILED", "Activation commit cleanup failed.");
          }
        }
        const backup = parseBackup(await readJson(backupPath, MAX_BACKUP_BYTES));
        if (backup.activationId !== activationId || backup.generation !== generation) throw new Error("transaction");
        const responseIds = { activationId, deviceId: journal.deviceId, licenseId: journal.licenseId };
        const manifest = GenerationManifestSchema.parse(await readJson(artifactPaths[3]));
        if (manifest.activationId !== responseIds.activationId || manifest.deviceId !== responseIds.deviceId
            || manifest.licenseId !== responseIds.licenseId || manifest.generation !== generation) throw new Error("manifest");
        const startupBody = await (await safeRoot).readText(artifactPaths[0]);
        const licenseBody = await (await safeRoot).readText(artifactPaths[1]);
        const builtinBody = await (await safeRoot).readText(artifactPaths[2]);
        StartupCredentialArtifactSchema.parse(JSON.parse(startupBody));
        const startup = StartupCredentialArtifactSchema.parse(JSON.parse(startupBody));
        const license = StartupLicenseArtifactSchema.parse(JSON.parse(licenseBody));
        const builtin = BuiltinCredentialArtifactSchema.parse(JSON.parse(builtinBody));
        for (const artifact of [startup, license, builtin]) {
          if (artifact.deviceId !== journal.deviceId || artifact.licenseId !== journal.licenseId
              || artifact.deviceId !== manifest.deviceId || artifact.licenseId !== manifest.licenseId) throw new Error("identity");
        }
        if (manifest.sha256.startupCredential !== createHash("sha256").update(startupBody).digest("hex")
            || manifest.sha256.license !== createHash("sha256").update(licenseBody).digest("hex")
            || manifest.sha256.builtinCredential !== createHash("sha256").update(builtinBody).digest("hex")) throw new Error("hash");
        await write(journalPath, `${JSON.stringify({ ...journal, stage: "committed" })}\n`);
      } catch (error) {
        if (error instanceof ActivationArtifactError) throw error;
        if (isNotFound(error)) throw new ActivationArtifactError("ARTIFACT_INVALID", "Activation artifact transaction is incomplete.");
        throw new ActivationArtifactError("ARTIFACT_INVALID", "Activation artifact transaction is invalid.");
      }
      try {
        await options.beforeCommitCleanup?.(0);
        await remove(backupPath);
        await options.beforeCommitCleanup?.(1);
        await remove(journalPath);
      } catch {
        throw new ActivationArtifactError("ARTIFACT_WRITE_FAILED", "Activation commit cleanup failed.");
      }
    },
  };
}
