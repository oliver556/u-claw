import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

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

export type ProvisioningArtifactErrorCode =
  | "ARTIFACT_PATH_UNSAFE"
  | "ARTIFACT_WRITE_FAILED"
  | "ARTIFACT_INVALID"
  | "JOURNAL_INVALID";

export class ProvisioningArtifactError extends Error {
  constructor(readonly code: ProvisioningArtifactErrorCode, message: string) {
    super(message);
    this.name = "ProvisioningArtifactError";
  }
}

export interface ProvisioningArtifactInput {
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
  writeJournal(journal: ProvisioningJournal): Promise<void>;
  readJournal(): Promise<ProvisioningJournal | null>;
  writeArtifacts(input: ProvisioningArtifactInput): Promise<void>;
  finalizeCredential(input: Omit<ProvisioningArtifactInput, "startupCredential" | "license">): Promise<void>;
  verifyArtifacts(binding: ProvisioningBinding, requireActive?: boolean): Promise<void>;
  cleanupArtifacts(): Promise<void>;
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

async function atomicWrite(path: string, body: string): Promise<void> {
  if (Buffer.byteLength(body) > MAX_JSON_BYTES) {
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
  await assertReplaceable(path);
  try {
    const body = await readFile(path);
    if (body.byteLength > MAX_JSON_BYTES) throw new ProvisioningArtifactError("ARTIFACT_INVALID", "Provisioning artifact is too large.");
    return body;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function restore(path: string, body: Buffer | null): Promise<void> {
  if (body === null) await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  else await atomicWrite(path, body.toString("utf8"));
  await syncDirectory(dirname(path));
}

async function boundedJson(path: string): Promise<unknown> {
  await assertReplaceable(path);
  const body = await readFile(path);
  if (body.byteLength > MAX_JSON_BYTES) throw new ProvisioningArtifactError("ARTIFACT_INVALID", "Provisioning artifact is too large.");
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new ProvisioningArtifactError("ARTIFACT_INVALID", "Provisioning artifact is invalid.");
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

  const prepare = async (): Promise<void> => {
    await assertDirectory(uclawDir);
    await assertDirectory(licenseDir);
  };

  return {
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
      const paths = [startupPath, licensePath, credentialPath] as const;
      const previous = await Promise.all(paths.map((path) => snapshot(path)));
      try {
        await atomicWrite(startupPath, `${JSON.stringify(startup)}\n`);
        await atomicWrite(licensePath, `${JSON.stringify(license)}\n`);
        await credentialStore.provision({ endpoint: input.endpoint, model: input.model, mapping, issuedToken });
      } catch {
        await Promise.all(paths.map((path, index) => restore(path, previous[index] ?? null)));
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
      await Promise.all([startupPath, licensePath, credentialPath].map((path) => unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      })));
      await Promise.all([licenseDir, uclawDir].map((path) => syncDirectory(path).catch(() => undefined)));
    },
  };
}
