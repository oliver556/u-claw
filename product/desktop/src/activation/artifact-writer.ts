import { createHash, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

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

const JournalBaseSchema = z.object({
  schemaVersion: z.literal(2),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u),
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
const IdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u);
const RequestBindingSchema = z.object({
  requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  usbFingerprint: z.object({
    version: z.literal("uclaw-usb-v1"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
  clientVersion: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
});
const RequestedJournalSchema = JournalBaseSchema.extend({
  stage: z.literal("requested"),
  activationId: z.null(),
  deviceId: z.null(),
  licenseId: z.null(),
  ...RequestBindingSchema.shape,
}).strict();
const BoundJournalSchema = JournalBaseSchema.extend({
  stage: z.enum(["server_bound", "committed"]),
  activationId: IdentifierSchema,
  deviceId: IdentifierSchema,
  licenseId: IdentifierSchema,
  ...RequestBindingSchema.shape,
}).strict();
const JournalSchema = z.union([RequestedJournalSchema, BoundJournalSchema]);
const LegacyJournalBaseSchema = z.object({
  schemaVersion: z.literal(1),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u),
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  username: z.string().trim().min(3).max(128), requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  usbFingerprint: z.object({ version: z.literal("uclaw-usb-v1"), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
  clientVersion: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
});
const LegacyJournalSchema = z.union([
  LegacyJournalBaseSchema.extend({ stage: z.literal("requested"), activationId: z.null(), deviceId: z.null(), licenseId: z.null() }).strict(),
  LegacyJournalBaseSchema.extend({ stage: z.enum(["server_bound", "committed"]), activationId: IdentifierSchema, deviceId: IdentifierSchema, licenseId: IdentifierSchema }).strict(),
]);

export type ActivationArtifactJournal = z.infer<typeof JournalSchema>;
export type ActivationLegacyJournal = z.infer<typeof LegacyJournalSchema>;
export type ActivationReadableJournal = ActivationArtifactJournal | ActivationLegacyJournal;
export type ActivationRequestedJournal = z.infer<typeof RequestedJournalSchema>;
export type ActivationServerBoundJournal = z.infer<typeof BoundJournalSchema>;

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
  preflight(): Promise<void>;
  writeJournal(journal: ActivationArtifactJournal): Promise<void>;
  writeServerBoundJournal(journal: ActivationServerBoundJournal): Promise<void>;
  readJournal(): Promise<ActivationReadableJournal | null>;
  discardRequestedJournal(idempotencyKey: string): Promise<void>;
  retireLegacyCredential(): Promise<void>;
  readLegacyServerBoundRecovery(journal: ActivationLegacyJournal): Promise<ActivationResponse>;
  commitLegacyServerBoundRecovery(journal: ActivationLegacyJournal, response: ActivationResponse): Promise<void>;
  writeArtifacts(input: { generation: number; response: ActivationResponse }): Promise<void>;
  verifyArtifacts(response: ActivationResponse, generation: number): Promise<void>;
  recoverPendingArtifacts(): Promise<void>;
  commitArtifacts(activationId: string, generation: number): Promise<void>;
}

export interface CreateActivationArtifactWriterOptions {
  packageRoot: string;
  dataDir: string;
  allowUnpinnedFilesystemForTest?: true;
  platformForTest?: NodeJS.Platform;
  beforeArtifactWrite?: (index: number) => void | Promise<void>;
  afterArtifactWrite?: (index: number) => void | Promise<void>;
  beforeCommitCleanup?: (index: number) => void | Promise<void>;
  removeForTest?: (path: string, remove: () => Promise<void>) => Promise<void>;
}

const artifactPaths = [
  { root: "package", path: "license/.startup-credential.json" },
  { root: "package", path: "license/license.json" },
  { root: "data", path: ".uclaw/builtin-model-credential.v1.json" },
  { root: "data", path: ".uclaw/activation-artifact-generation.v1.json" },
] as const;
const journalPath = ".uclaw/activation-transaction.v1.json";
const backupPath = ".uclaw/activation-artifact-backup.v1.json";
const legacyBuiltinCredentialPath = ".uclaw/activation-builtin-credential.v1.json";

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
  if (resolve(options.dataDir) !== join(resolve(options.packageRoot), "data")) {
    throw new ActivationArtifactError("ARTIFACT_PATH_UNSAFE", "Activation data root must be the package data directory.");
  }
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
  const packageSafeRoot = createSafeRoot(options.packageRoot, {
    symlinks: "reject", hardlinks: "reject", maxBytes: MAX_JSON_BYTES, mkdir: true, mode: 0o600,
  }).catch(() => {
    throw new ActivationArtifactError("ARTIFACT_PATH_UNSAFE", "Activation package root is unsafe.");
  });
  const dataSafeRoot = createSafeRoot(options.dataDir, {
    symlinks: "reject", hardlinks: "reject", maxBytes: MAX_JSON_BYTES, mkdir: true, mode: 0o600,
  }).catch(() => {
    throw new ActivationArtifactError("ARTIFACT_PATH_UNSAFE", "Activation artifact root is unsafe.");
  });
  const credentialStore = createBuiltinCredentialStore({
    dataDir: options.dataDir,
    allowUnpinnedFilesystemForTest: options.allowUnpinnedFilesystemForTest,
    platformForTest: options.platformForTest,
  });
  const isNotFound = (error: unknown): boolean =>
    (error instanceof FsSafeError && error.code === "not-found") ||
    (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT");
  const prepare = async (): Promise<void> => {
    try {
      const [packageFs, dataFs] = await Promise.all([packageSafeRoot, dataSafeRoot]);
      await packageFs.mkdir("license");
      await dataFs.mkdir(".uclaw");
    } catch {
      throw new ActivationArtifactError("ARTIFACT_PATH_UNSAFE", "Activation artifact directory is unsafe.");
    }
  };
  const rootFor = (kind: "package" | "data") => kind === "package" ? packageSafeRoot : dataSafeRoot;
  const writeAt = async (kind: "package" | "data", path: string, body: string | Buffer, maxBytes = MAX_JSON_BYTES): Promise<void> => {
    if (Buffer.byteLength(body) > maxBytes) throw new ActivationArtifactError("ARTIFACT_INVALID", "Activation artifact is too large.");
    await (await rootFor(kind)).write(path, body, { mode: 0o600, overwrite: true });
  };
  const write = (path: string, body: string | Buffer, maxBytes = MAX_JSON_BYTES) =>
    writeAt("data", path, body, maxBytes);
  const removeAt = async (kind: "package" | "data", path: string): Promise<void> => {
    const removeDirect = async (): Promise<void> => (await rootFor(kind)).remove(path);
    try {
      if (kind === "data" && options.removeForTest) await options.removeForTest(path, removeDirect);
      else await removeDirect();
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  };
  const remove = (path: string) => removeAt("data", path);
  const snapshot = async (kind: "package" | "data", path: string): Promise<Buffer | null> => {
    try {
      return await (await rootFor(kind)).readBytes(path);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };
  const readJson = async (path: string, maxBytes = MAX_JSON_BYTES): Promise<unknown> =>
    JSON.parse(await (await dataSafeRoot).readText(path, { maxBytes })) as unknown;
  const restore = async (target: (typeof artifactPaths)[number], entry: BackupEntry): Promise<void> => {
    if (!entry.present) await removeAt(target.root, target.path);
    else await writeAt(target.root, target.path, Buffer.from(entry.body!, "base64"));
  };

  const writeJournal = async (value: ActivationArtifactJournal): Promise<void> => {
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
  };

  const readLegacyServerBoundRecovery = async (expected: ActivationLegacyJournal): Promise<ActivationResponse> => {
    try {
      const trusted = LegacyJournalSchema.parse(expected);
      const journal = LegacyJournalSchema.parse(await readJson(journalPath));
      if (journal.stage !== "server_bound" || trusted.stage !== "server_bound"
          || journal.idempotencyKey !== trusted.idempotencyKey
          || journal.activationId !== trusted.activationId
          || journal.deviceId !== trusted.deviceId
          || journal.licenseId !== trusted.licenseId
          || journal.generation !== trusted.generation
          || journal.username !== trusted.username
          || journal.requestHash !== trusted.requestHash
          || journal.usbFingerprint.version !== trusted.usbFingerprint.version
          || journal.usbFingerprint.sha256 !== trusted.usbFingerprint.sha256
          || journal.clientVersion !== trusted.clientVersion) throw new Error("transaction");
      const startup = StartupCredentialArtifactSchema.parse(JSON.parse(await (await packageSafeRoot).readText(artifactPaths[0].path)));
      const license = StartupLicenseArtifactSchema.parse(JSON.parse(await (await packageSafeRoot).readText(artifactPaths[1].path)));
      const loadedBuiltin = await credentialStore.loadActive();
      const builtin = BuiltinCredentialArtifactSchema.parse({
        schemaVersion: 2,
        deviceId: loadedBuiltin.deviceId,
        licenseId: loadedBuiltin.licenseId,
        endpoint: loadedBuiltin.endpoint.href,
        ...(loadedBuiltin.deviceTokenId === undefined ? {} : { deviceTokenId: loadedBuiltin.deviceTokenId }),
        model: loadedBuiltin.model,
        deviceToken: loadedBuiltin.deviceToken,
      });
      if (startup.deviceId !== journal.deviceId || startup.licenseId !== journal.licenseId
          || license.deviceId !== journal.deviceId || license.licenseId !== journal.licenseId
          || license.usbFingerprint.scheme !== journal.usbFingerprint.version
          || license.usbFingerprint.sha256 !== journal.usbFingerprint.sha256
          || builtin.deviceId !== journal.deviceId || builtin.licenseId !== journal.licenseId) throw new Error("identity");
      return ActivationResponseSchema.parse({
        activationId: journal.activationId,
        deviceId: journal.deviceId,
        licenseId: journal.licenseId,
        license,
        startupCredential: startup,
        builtinCredential: builtin,
        status: "active",
      });
    } catch (error) {
      if (error instanceof FsSafeError) throw new ActivationArtifactError("ARTIFACT_PATH_UNSAFE", "Legacy activation recovery path is unsafe.");
      throw new ActivationArtifactError("ARTIFACT_INVALID", "Legacy activation recovery artifacts are invalid.");
    }
  };

  return {
    async preflight() {
      await prepare();
      const probe = `.activation-write-probe-${randomBytes(16).toString("hex")}`;
      try {
        await writeAt("package", `license/${probe}`, "probe\n");
        await writeAt("data", `.uclaw/${probe}`, "probe\n");
        await removeAt("package", `license/${probe}`);
        await removeAt("data", `.uclaw/${probe}`);
      } catch {
        try { await removeAt("package", `license/${probe}`); } catch { /* best-effort probe cleanup */ }
        try { await removeAt("data", `.uclaw/${probe}`); } catch { /* best-effort probe cleanup */ }
        throw new ActivationArtifactError("ARTIFACT_PATH_UNSAFE", "Activation artifact roots are not safely writable.");
      }
    },
    writeJournal,
    async writeServerBoundJournal(value) {
      let journal: ActivationServerBoundJournal;
      try {
        journal = BoundJournalSchema.parse(value);
      } catch {
        throw new ActivationArtifactError("JOURNAL_INVALID", "Activation journal is invalid.");
      }
      await writeJournal(journal);
    },

    async readJournal() {
      try {
        const value = await readJson(journalPath);
        return value && typeof value === "object" && "schemaVersion" in value && value.schemaVersion === 1
          ? LegacyJournalSchema.parse(value)
          : JournalSchema.parse(value);
      } catch (error) {
        if (isNotFound(error)) return null;
        if (error instanceof FsSafeError) throw new ActivationArtifactError("ARTIFACT_PATH_UNSAFE", "Activation journal path is unsafe.");
        throw new ActivationArtifactError("JOURNAL_INVALID", "Activation journal is invalid.");
      }
    },

    async discardRequestedJournal(idempotencyKey) {
      try {
        const journal = RequestedJournalSchema.parse(await readJson(journalPath));
        if (journal.idempotencyKey !== idempotencyKey) throw new Error("transaction");
        await remove(journalPath);
      } catch (error) {
        if (error instanceof FsSafeError) throw new ActivationArtifactError("ARTIFACT_PATH_UNSAFE", "Activation journal path is unsafe.");
        throw new ActivationArtifactError("JOURNAL_INVALID", "Activation journal is invalid.");
      }
    },

    async retireLegacyCredential() {
      try {
        await remove(legacyBuiltinCredentialPath);
      } catch {
        throw new ActivationArtifactError("ARTIFACT_WRITE_FAILED", "Legacy activation credential could not be retired.");
      }
    },

    readLegacyServerBoundRecovery,
    async commitLegacyServerBoundRecovery(expected, value) {
      try {
        const response = ActivationResponseSchema.parse(value);
        const readback = await readLegacyServerBoundRecovery(expected);
        if (JSON.stringify(readback) !== JSON.stringify(response)) throw new Error("binding");
      } catch (error) {
        if (error instanceof FsSafeError) throw new ActivationArtifactError("ARTIFACT_PATH_UNSAFE", "Legacy activation recovery path is unsafe.");
        if (error instanceof ActivationArtifactError) throw error;
        throw new ActivationArtifactError("ARTIFACT_INVALID", "Legacy activation recovery artifacts changed after verification.");
      }
      try {
        await write(journalPath, `${JSON.stringify({ ...expected, stage: "committed" })}\n`);
        await remove(backupPath);
        await remove(journalPath);
      } catch (error) {
        if (error instanceof FsSafeError) throw new ActivationArtifactError("ARTIFACT_PATH_UNSAFE", "Legacy activation recovery path is unsafe.");
        throw new ActivationArtifactError("ARTIFACT_WRITE_FAILED", "Legacy activation recovery could not be completed.");
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
        previous = await Promise.all(artifactPaths.map((target) => snapshot(target.root, target.path)));
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
          if (index === 2) await credentialStore.provision(response.builtinCredential);
          else await writeAt(artifactPaths[index].root, artifactPaths[index].path, `${JSON.stringify(bodies[index])}\n`);
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
        const startupBody = await (await packageSafeRoot).readText(artifactPaths[0].path);
        const licenseBody = await (await packageSafeRoot).readText(artifactPaths[1].path);
        const builtinBody = await (await dataSafeRoot).readText(artifactPaths[2].path);
        const startup = StartupCredentialArtifactSchema.parse(JSON.parse(startupBody));
        const license = StartupLicenseArtifactSchema.parse(JSON.parse(licenseBody));
        const loadedBuiltin = await credentialStore.loadActive();
        const builtin = BuiltinCredentialArtifactSchema.parse({
          schemaVersion: 2,
          deviceId: loadedBuiltin.deviceId,
          licenseId: loadedBuiltin.licenseId,
          endpoint: loadedBuiltin.endpoint.href,
          ...(loadedBuiltin.deviceTokenId === undefined ? {} : { deviceTokenId: loadedBuiltin.deviceTokenId }),
          model: loadedBuiltin.model,
          deviceToken: loadedBuiltin.deviceToken,
        });
        const manifest = GenerationManifestSchema.parse(await readJson(artifactPaths[3].path));
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
        await Promise.all(artifactPaths.map((target, index) => restore(target, backup.files[index])));
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
        const manifest = GenerationManifestSchema.parse(await readJson(artifactPaths[3].path));
        if (manifest.activationId !== responseIds.activationId || manifest.deviceId !== responseIds.deviceId
            || manifest.licenseId !== responseIds.licenseId || manifest.generation !== generation) throw new Error("manifest");
        const startupBody = await (await packageSafeRoot).readText(artifactPaths[0].path);
        const licenseBody = await (await packageSafeRoot).readText(artifactPaths[1].path);
        const builtinBody = await (await dataSafeRoot).readText(artifactPaths[2].path);
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
