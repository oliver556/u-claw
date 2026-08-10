import { chmod, lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NewApiDeviceMapping, NewApiIssuedToken } from "@uclaw/shared";
import { afterEach, describe, expect, it } from "vitest";

import { createBuiltinCredentialStore } from "../src/providers/builtin-credential-store.js";
import type { BuiltinCredentialStore } from "../src/providers/builtin-credential-store.js";
import {
  ProvisioningArtifactError,
  createProvisioningArtifactWriter,
} from "../src/provisioning/artifact-writer.js";

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const value = await mkdtemp(join(tmpdir(), "uclaw-provisioning-writer-"));
  roots.push(value);
  return value;
}

const now = "2026-08-10T00:00:00.000Z";
const binding = {
  deviceId: "dev_fixture_001",
  usbFingerprint: "a".repeat(64),
  licenseId: "lic_fixture_001",
  newApiUserId: "usr_fixture_001",
  newApiUsername: "uclaw_fixture",
  newApiTokenId: "tok_fixture_001",
  channelId: "channel_builtin_001",
};
const mapping: NewApiDeviceMapping = {
  ...binding,
  startupSecretHash: "b".repeat(64),
  startupSecretSalt: "c".repeat(32),
  policyDigest: "d".repeat(64),
  generation: 1,
  previousTokenId: null,
  status: "provisioning",
  failure: null,
  createdAt: now,
  updatedAt: now,
};
const issuedToken: NewApiIssuedToken = {
  token: {
    id: binding.newApiTokenId, userId: binding.newApiUserId, name: "device", channelId: binding.channelId,
    policyDigest: mapping.policyDigest, generation: mapping.generation,
    status: "provisioning", createdAt: now, updatedAt: now,
  },
  secret: "fixture-device-token-secret-material",
};
const startupCredential = {
  schemaVersion: 1 as const,
  deviceId: binding.deviceId,
  licenseId: binding.licenseId,
  startupSecret: "fixture-startup-secret-material-001",
};
const license = {
  schemaVersion: 1 as const,
  deviceId: binding.deviceId,
  licenseId: binding.licenseId,
  usbFingerprint: { scheme: "uclaw-usb-v1" as const, sha256: binding.usbFingerprint },
  startupSecretProof: {
    algorithm: "sha256-salt-v1" as const,
    startupSecretSalt: mapping.startupSecretSalt,
    startupSecretHash: mapping.startupSecretHash,
  },
  notBefore: now,
  expiresAt: "2027-08-10T00:00:00.000Z",
  signature: { algorithm: "ed25519" as const, keyId: "fixture-key-001", value: "s".repeat(88) },
};
const journal = {
  schemaVersion: 1 as const,
  generation: 1,
  licenseOperation: "issue" as const,
  licenseSourceId: null,
  transactionId: "txn_fixture_001",
  requestHash: "d".repeat(64),
  mappedTokenId: binding.newApiTokenId,
  previousTokenId: null,
  binding,
  endpoint: "http://127.0.0.1:3300/v1/",
  model: "built-in-model",
  stage: "started" as const,
  failureCode: null,
  compensation: {
    mapping: "not-needed" as const, token: "not-needed" as const,
    license: "not-needed" as const, artifacts: "not-needed" as const,
  },
  lifecycle: null,
  createdAt: now,
  updatedAt: now,
};

describe("provisioning artifact writer", () => {
  it("serializes separate writers that target the same data directory", async () => {
    const dataDir = await root();
    const first = createProvisioningArtifactWriter({
      dataDir, credentialStore: createBuiltinCredentialStore({ dataDir, allowLoopbackHttp: true }),
    });
    const second = createProvisioningArtifactWriter({
      dataDir, credentialStore: createBuiltinCredentialStore({ dataDir, allowLoopbackHttp: true }),
    });
    const releaseFirst = await first.acquireLock({ deviceId: "dev_fixture_001", requestHash: "a".repeat(64) });
    let secondAcquired = false;
    const pending = second.acquireLock({ deviceId: "dev_fixture_002", requestHash: "b".repeat(64) })
      .then((release) => { secondAcquired = true; return release; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondAcquired).toBe(false);
    await releaseFirst();
    const releaseSecond = await pending;
    expect(secondAcquired).toBe(true);
    await releaseSecond();
  });

  it("atomically writes and verifies all mode-0600 artifacts", async () => {
    const dataDir = await root();
    const credentialStore = createBuiltinCredentialStore({ dataDir, allowLoopbackHttp: true });
    const writer = createProvisioningArtifactWriter({ dataDir, credentialStore });
    await writer.writeJournal(journal);
    await writer.writeArtifacts({ transactionId: journal.transactionId, generation: 1, startupCredential, license, endpoint: journal.endpoint, model: journal.model, mapping, issuedToken });
    await expect(writer.verifyArtifacts(binding)).resolves.toBeUndefined();

    for (const path of [
      join(dataDir, ".uclaw", "license", ".startup-credential.json"),
      join(dataDir, ".uclaw", "license", "license.json"),
      join(dataDir, ".uclaw", "builtin-model-credential.v1.json"),
      join(dataDir, ".uclaw", "provisioning-transaction.v1.json"),
    ]) {
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
    }
    expect((await readdir(join(dataDir, ".uclaw"))).some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(await writer.readJournal()).toEqual(journal);
  });

  it("restores the previous generation from a durable backup after writer restart", async () => {
    const dataDir = await root();
    const store = createBuiltinCredentialStore({ dataDir, allowLoopbackHttp: true });
    const first = createProvisioningArtifactWriter({ dataDir, credentialStore: store });
    await first.writeArtifacts({
      transactionId: journal.transactionId, generation: 1,
      startupCredential, license, endpoint: journal.endpoint, model: journal.model, mapping, issuedToken,
    });
    await first.commitArtifacts(journal.transactionId, 1);

    const nextBinding = {
      ...binding,
      usbFingerprint: "e".repeat(64),
      licenseId: "lic_fixture_002",
      newApiTokenId: "tok_fixture_002",
    };
    const nextMapping: NewApiDeviceMapping = {
      ...mapping, ...nextBinding, startupSecretHash: "f".repeat(64), startupSecretSalt: "1".repeat(32),
      generation: 2, previousTokenId: binding.newApiTokenId,
    };
    const nextToken: NewApiIssuedToken = {
      token: { ...issuedToken.token, id: nextBinding.newApiTokenId, generation: 2 },
      secret: "fixture-device-token-secret-material-next",
    };
    await first.writeArtifacts({
      transactionId: "txn_fixture_002", generation: 2,
      startupCredential: { ...startupCredential, licenseId: nextBinding.licenseId },
      license: {
        ...license,
        deviceId: nextBinding.deviceId,
        licenseId: nextBinding.licenseId,
        usbFingerprint: { ...license.usbFingerprint, sha256: nextBinding.usbFingerprint },
        startupSecretProof: {
          ...license.startupSecretProof,
          startupSecretHash: nextMapping.startupSecretHash,
          startupSecretSalt: nextMapping.startupSecretSalt,
        },
      },
      endpoint: journal.endpoint, model: journal.model, mapping: nextMapping, issuedToken: nextToken,
    });

    const restarted = createProvisioningArtifactWriter({ dataDir, credentialStore: store });
    await restarted.recoverPendingArtifacts();
    await expect(restarted.verifyArtifacts(binding)).resolves.toBeUndefined();
    await expect(readFile(join(dataDir, ".uclaw", "provisioning-artifact-backup.v1.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects corrupted read-back and non-directory or symlink license paths", async () => {
    const dataDir = await root();
    const writer = createProvisioningArtifactWriter({
      dataDir,
      credentialStore: createBuiltinCredentialStore({ dataDir, allowLoopbackHttp: true }),
    });
    await writer.writeArtifacts({ transactionId: journal.transactionId, generation: 1, startupCredential, license, endpoint: journal.endpoint, model: journal.model, mapping, issuedToken });
    await writeFile(join(dataDir, ".uclaw", "license", "license.json"), "{}\n", "utf8");
    await expect(writer.verifyArtifacts(binding)).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });

    const linkedRoot = await root();
    const target = await root();
    await mkdir(join(linkedRoot, ".uclaw"), { recursive: true });
    await symlink(target, join(linkedRoot, ".uclaw", "license"));
    const linked = createProvisioningArtifactWriter({
      dataDir: linkedRoot,
      credentialStore: createBuiltinCredentialStore({ dataDir: linkedRoot, allowLoopbackHttp: true }),
    });
    await expect(linked.writeArtifacts({ transactionId: journal.transactionId, generation: 1, startupCredential, license, endpoint: journal.endpoint, model: journal.model, mapping, issuedToken }))
      .rejects.toBeInstanceOf(ProvisioningArtifactError);
  });

  it("removes artifacts committed before a later write failure", async () => {
    const dataDir = await root();
    const failingStore: BuiltinCredentialStore = {
      provision: async () => { throw new Error("injected write failure"); },
      loadActive: async () => { throw new Error("unused"); },
      loadForConnectivityCheck: async () => { throw new Error("unused"); },
      clear: async () => undefined,
    };
    const writer = createProvisioningArtifactWriter({ dataDir, credentialStore: failingStore });
    await expect(writer.writeArtifacts({ transactionId: journal.transactionId, generation: 1, startupCredential, license, endpoint: journal.endpoint, model: journal.model, mapping, issuedToken }))
      .rejects.toMatchObject({ code: "ARTIFACT_WRITE_FAILED" });
    await expect(readFile(join(dataDir, ".uclaw", "license", "license.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(dataDir, ".uclaw", "license", ".startup-credential.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects secret-bearing journal objects before disk write", async () => {
    const dataDir = await root();
    await chmod(dataDir, 0o700);
    const writer = createProvisioningArtifactWriter({
      dataDir,
      credentialStore: createBuiltinCredentialStore({ dataDir, allowLoopbackHttp: true }),
    });
    await expect(writer.writeJournal({ ...journal, tokenSecret: issuedToken.secret } as never))
      .rejects.toMatchObject({ code: "JOURNAL_INVALID" });
  });

  it("rejects a symlinked journal during recovery", async () => {
    const dataDir = await root();
    const uclawDir = join(dataDir, ".uclaw");
    await mkdir(uclawDir, { recursive: true });
    const source = join(dataDir, "journal-source.json");
    await writeFile(source, `${JSON.stringify(journal)}\n`, "utf8");
    await symlink(source, join(uclawDir, "provisioning-transaction.v1.json"));
    const writer = createProvisioningArtifactWriter({
      dataDir, credentialStore: createBuiltinCredentialStore({ dataDir, allowLoopbackHttp: true }),
    });
    await expect(writer.readJournal()).rejects.toMatchObject({ code: "ARTIFACT_PATH_UNSAFE" });
  });
});
