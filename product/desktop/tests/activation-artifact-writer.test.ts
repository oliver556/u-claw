import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ActivationResponse } from "@uclaw/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ActivationArtifactError,
  createActivationArtifactWriter,
} from "../src/activation/artifact-writer.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "uclaw-activation-writer-"));
  roots.push(root);
  const dataDir = join(root, ".uclaw", "data");
  await mkdir(dataDir, { recursive: true });
  return dataDir;
}

const packageRootFor = (dataDir: string): string => dirname(dataDir);
const writerOptions = (dataDir: string) => ({
  packageRoot: packageRootFor(dataDir), dataDir, platformForTest: "linux" as const,
  allowUnpinnedFilesystemForTest: true as const,
});

const material = (suffix = "001"): ActivationResponse => ({
  activationId: `activation-${suffix}`,
  deviceId: `device-${suffix}`,
  licenseId: `license-${suffix}`,
  license: {
    schemaVersion: 1,
    usernameId: `username-${suffix}`,
    deviceId: `device-${suffix}`,
    licenseId: `license-${suffix}`,
    usbFingerprint: { scheme: "uclaw-usb-v1", sha256: "a".repeat(64) },
    startupSecretProof: {
      algorithm: "sha256-salt-v1", startupSecretSalt: "b".repeat(32), startupSecretHash: "c".repeat(64),
    },
    notBefore: "2026-08-13T00:00:00Z",
    expiresAt: "2027-08-13T00:00:00Z",
    revision: 1,
    signature: { algorithm: "ed25519", keyId: "activation-key", value: "s".repeat(80) },
  },
  startupCredential: {
    schemaVersion: 1, deviceId: `device-${suffix}`, licenseId: `license-${suffix}`, startupSecret: "x".repeat(32),
  },
  builtinCredential: {
    schemaVersion: 2, deviceId: `device-${suffix}`, licenseId: `license-${suffix}`,
    endpoint: "https://license.example.test/model-api/",
    deviceToken: `uclaw_dt_${"A".repeat(43)}`,
  },
  status: "active",
});

const request = {
  activationCode: "TESTTESTTESTTESTTESTTEST12",
  usbFingerprint: { version: "uclaw-usb-v1" as const, sha256: "d".repeat(64) },
  clientVersion: "1.0.0",
  idempotencyKey: "activation:test:requested:001",
};

const journal = (response = material(), generation = 1) => ({
  schemaVersion: 2 as const,
  activationId: response.activationId,
  idempotencyKey: request.idempotencyKey,
  generation,
  deviceId: response.deviceId,
  licenseId: response.licenseId,
  stage: "server_bound" as const,
  requestHash: "e".repeat(64),
  usbFingerprint: request.usbFingerprint,
  clientVersion: request.clientVersion,
});

const requestedJournal = {
  schemaVersion: 2 as const,
  stage: "requested" as const,
  activationId: null,
  deviceId: null,
  licenseId: null,
  generation: 1,
  idempotencyKey: request.idempotencyKey,
  requestHash: "e".repeat(64),
  usbFingerprint: request.usbFingerprint,
  clientVersion: request.clientVersion,
};

const paths = {
  startup: "license/.startup-credential.json",
  license: "license/license.json",
  builtin: ".uclaw/builtin-model-credential.v1.json",
  legacyBuiltin: ".uclaw/activation-builtin-credential.v1.json",
  generation: ".uclaw/activation-artifact-generation.v1.json",
  journal: ".uclaw/activation-transaction.v1.json",
  backup: ".uclaw/activation-artifact-backup.v1.json",
};

const absolutePath = (dataDir: string, path: string): string =>
  path.startsWith("license/") ? join(packageRootFor(dataDir), path) : join(dataDir, path);

describe("activation artifact writer", () => {
  it("persists and reads a strict requested journal for same-key activation replay", async () => {
    const dataDir = await tempRoot();
    const writer = createActivationArtifactWriter(writerOptions(dataDir));

    await writer.writeJournal(requestedJournal);

    expect(await writer.readJournal()).toEqual(requestedJournal);
    expect(JSON.parse(await readFile(absolutePath(dataDir, paths.journal), "utf8"))).toEqual(requestedJournal);
    const body = await readFile(absolutePath(dataDir, paths.journal), "utf8");
    expect(body).not.toContain("activationCode");
    expect(body).not.toContain(request.activationCode);
    expect(body).not.toContain("startupSecret");
    expect(body).not.toContain("accessToken");
  });

  it("retires only the obsolete v1 activation credential", async () => {
    const dataDir = await tempRoot();
    const writer = createActivationArtifactWriter(writerOptions(dataDir));
    const current = material().builtinCredential;
    await mkdir(dirname(absolutePath(dataDir, paths.legacyBuiltin)), { recursive: true });
    await writeFile(absolutePath(dataDir, paths.legacyBuiltin), JSON.stringify({
      schemaVersion: 1,
      deviceId: current.deviceId,
      licenseId: current.licenseId,
      accessToken: "t".repeat(16),
      expiresAt: "2026-08-14T00:00:00.000Z",
    }));
    await writeFile(absolutePath(dataDir, paths.builtin), JSON.stringify(current));

    await writer.retireLegacyCredential();

    await expect(readFile(absolutePath(dataDir, paths.legacyBuiltin))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(absolutePath(dataDir, paths.builtin), "utf8"))).toEqual(current);
  });

  it("reads a strict legacy v1 requested journal for controlled recovery", async () => {
    const dataDir = await tempRoot();
    const writer = createActivationArtifactWriter(writerOptions(dataDir));
    const legacy = { ...requestedJournal, schemaVersion: 1, username: "UCLAW-TEST" };
    await writer.preflight();
    await writeFile(absolutePath(dataDir, paths.journal), JSON.stringify(legacy));
    await expect(writer.readJournal()).resolves.toEqual(legacy);
  });

  it("clears a legacy server-bound journal only after matching replacement artifacts are installed", async () => {
    const dataDir = await tempRoot();
    const writer = createActivationArtifactWriter(writerOptions(dataDir));
    const current = material();
    const legacy = {
      ...journal(current), schemaVersion: 1 as const, username: "UCLAW-TEST",
      usbFingerprint: { version: "uclaw-usb-v1" as const, sha256: "a".repeat(64) },
    };
    await writer.preflight();
    await writeFile(absolutePath(dataDir, paths.journal), JSON.stringify(legacy));
    await writeFile(absolutePath(dataDir, paths.startup), JSON.stringify(current.startupCredential));
    await writeFile(absolutePath(dataDir, paths.license), JSON.stringify(current.license));

    await expect(writer.readLegacyServerBoundRecovery(legacy)).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
    await expect(writer.readJournal()).resolves.toEqual(legacy);

    await writeFile(absolutePath(dataDir, paths.builtin), JSON.stringify(current.builtinCredential), { mode: 0o600 });
    const recovered = await writer.readLegacyServerBoundRecovery(legacy);
    expect(recovered).toEqual(current);
    await writer.commitLegacyServerBoundRecovery(legacy, recovered);
    await expect(writer.readJournal()).resolves.toBeNull();
  });

  it("does not roll back committed legacy recovery when a v2 artifact backup is still present", async () => {
    const dataDir = await tempRoot();
    const writer = createActivationArtifactWriter(writerOptions(dataDir));
    const previous = material("previous");
    await writer.writeServerBoundJournal(journal(previous, 1));
    await writer.writeArtifacts({ generation: 1, response: previous });
    await writer.commitArtifacts(previous.activationId, 1);

    const current = material("current");
    await writer.writeServerBoundJournal(journal(current, 2));
    await writer.writeArtifacts({ generation: 2, response: current });
    const legacy = {
      ...journal(current, 2), schemaVersion: 1 as const, username: "UCLAW-TEST",
      usbFingerprint: { version: "uclaw-usb-v1" as const, sha256: "a".repeat(64) },
    };
    await writeFile(absolutePath(dataDir, paths.journal), JSON.stringify(legacy));

    const recovered = await writer.readLegacyServerBoundRecovery(legacy);
    await writer.commitLegacyServerBoundRecovery(legacy, recovered);
    await createActivationArtifactWriter(writerOptions(dataDir)).recoverPendingArtifacts();

    await expect(createActivationArtifactWriter(writerOptions(dataDir)).verifyArtifacts(current, 2))
      .resolves.toBeUndefined();
    await expect(writer.readJournal()).resolves.toBeNull();
    await expect(readFile(absolutePath(dataDir, paths.backup))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a legacy server-bound journal when replacement artifact identity differs", async () => {
    const dataDir = await tempRoot();
    const writer = createActivationArtifactWriter(writerOptions(dataDir));
    const current = material();
    const legacy = {
      ...journal(current), schemaVersion: 1 as const, username: "UCLAW-TEST",
      usbFingerprint: { version: "uclaw-usb-v1" as const, sha256: "a".repeat(64) },
    };
    await writer.preflight();
    await writeFile(absolutePath(dataDir, paths.journal), JSON.stringify(legacy));
    await writeFile(absolutePath(dataDir, paths.startup), JSON.stringify(current.startupCredential));
    await writeFile(absolutePath(dataDir, paths.license), JSON.stringify(current.license));
    await writeFile(absolutePath(dataDir, paths.builtin), JSON.stringify(material("other").builtinCredential), { mode: 0o600 });

    await expect(writer.readLegacyServerBoundRecovery(legacy)).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
    await expect(writer.readJournal()).resolves.toEqual(legacy);
  });

  it("preserves a legacy server-bound journal when artifacts change after recovery verification", async () => {
    const dataDir = await tempRoot();
    const writer = createActivationArtifactWriter(writerOptions(dataDir));
    const current = material();
    const legacy = {
      ...journal(current), schemaVersion: 1 as const, username: "UCLAW-TEST",
      usbFingerprint: { version: "uclaw-usb-v1" as const, sha256: "a".repeat(64) },
    };
    await writer.preflight();
    await writeFile(absolutePath(dataDir, paths.journal), JSON.stringify(legacy));
    await writeFile(absolutePath(dataDir, paths.startup), JSON.stringify(current.startupCredential));
    await writeFile(absolutePath(dataDir, paths.license), JSON.stringify(current.license));
    await writeFile(absolutePath(dataDir, paths.builtin), JSON.stringify(current.builtinCredential), { mode: 0o600 });
    const recovered = await writer.readLegacyServerBoundRecovery(legacy);
    await writeFile(absolutePath(dataDir, paths.builtin), JSON.stringify({ ...current.builtinCredential, model: "other" }), { mode: 0o600 });

    await expect(writer.commitLegacyServerBoundRecovery(legacy, recovered)).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
    await expect(writer.readJournal()).resolves.toEqual(legacy);
  });

  it("rejects requested journals with invalid hashes or server-bound fields", async () => {
    const dataDir = await tempRoot();
    const writer = createActivationArtifactWriter(writerOptions(dataDir));

    await expect(writer.writeJournal({
      ...requestedJournal,
      requestHash: "not-a-sha256",
    })).rejects.toMatchObject({ code: "JOURNAL_INVALID" });
    await expect(writer.writeJournal({
      ...requestedJournal,
      activationId: "activation-001",
    } as never)).rejects.toMatchObject({ code: "JOURNAL_INVALID" });
  });

  it("discards only the matching requested journal", async () => {
    const dataDir = await tempRoot();
    const writer = createActivationArtifactWriter(writerOptions(dataDir));
    await writer.writeJournal(requestedJournal);
    await expect(writer.discardRequestedJournal("activation:other-key")).rejects.toMatchObject({ code: "JOURNAL_INVALID" });
    await writer.discardRequestedJournal(requestedJournal.idempotencyKey);
    await expect(writer.readJournal()).resolves.toBeNull();

    await writer.writeServerBoundJournal(journal());
    await expect(writer.discardRequestedJournal(request.idempotencyKey)).rejects.toMatchObject({ code: "JOURNAL_INVALID" });
    await expect(writer.readJournal()).resolves.toMatchObject({ stage: "server_bound" });
  });

  it("rejects secret-bearing response material in a requested journal", async () => {
    const dataDir = await tempRoot();
    const writer = createActivationArtifactWriter(writerOptions(dataDir));

    await expect(writer.writeJournal({
      ...requestedJournal,
      startupSecret: "x".repeat(32),
    } as never)).rejects.toMatchObject({ code: "JOURNAL_INVALID" });
    await expect(writer.writeJournal({
      ...requestedJournal,
      response: material(),
    } as never)).rejects.toMatchObject({ code: "JOURNAL_INVALID" });
  });

  it("persists a strict server-bound journal without request secrets", async () => {
    const dataDir = await tempRoot();
    const writer = createActivationArtifactWriter(writerOptions(dataDir));
    const value = journal();

    await writer.writeServerBoundJournal(value);

    expect(await writer.readJournal()).toEqual(value);
    const body = await readFile(absolutePath(dataDir, paths.journal), "utf8");
    expect(body).not.toContain("activationCode");
    expect(body).not.toContain("startupSecret");
    expect(body).not.toContain("accessToken");
  });

  it("requires non-sensitive request binding on server-bound and committed journals", async () => {
    const dataDir = await tempRoot();
    const writer = createActivationArtifactWriter(writerOptions(dataDir));

    await expect(writer.writeServerBoundJournal({ ...journal(), username: "legacy-user" } as never))
      .rejects.toMatchObject({ code: "JOURNAL_INVALID" });
    await expect(writer.writeJournal({ ...journal(), stage: "committed" }))
      .resolves.toBeUndefined();
    await expect(writer.readJournal()).resolves.toEqual({ ...journal(), stage: "committed" });
  });

  it("rejects secret response material in a server-bound journal", async () => {
    const dataDir = await tempRoot();
    const writer = createActivationArtifactWriter(writerOptions(dataDir));

    await expect(writer.writeServerBoundJournal({
      ...journal(),
      response: material(),
    } as never)).rejects.toMatchObject({ code: "JOURNAL_INVALID" });
  });

  it("rejects Windows writes when the pinned helper is unavailable", async () => {
    const dataDir = await tempRoot();
    expect(() => createActivationArtifactWriter({ packageRoot: packageRootFor(dataDir), dataDir, platformForTest: "win32" }))
      .toThrow(/pinned Windows filesystem/i);
  });

  it("preflights both roots without leaving probe files", async () => {
    const dataDir = await tempRoot();
    const writer = createActivationArtifactWriter(writerOptions(dataDir));

    await expect(writer.preflight()).resolves.toBeUndefined();
    expect(await readdir(join(packageRootFor(dataDir), "license"))).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.activation-write-probe-/u)]),
    );
    expect(await readdir(join(dataDir, ".uclaw"))).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.activation-write-probe-/u)]),
    );
  });

  it("rejects a data root outside the package data directory", async () => {
    const dataDir = await tempRoot();
    const unrelatedPackageRoot = packageRootFor(await tempRoot());

    expect(() => createActivationArtifactWriter({ packageRoot: unrelatedPackageRoot, dataDir }))
      .toThrow(/root|data/i);
  });

  it("writes all three strict artifacts, records generation, and verifies read-back", async () => {
    const dataDir = await tempRoot();
    const writer = createActivationArtifactWriter(writerOptions(dataDir));
    const response = material();
    await writer.writeServerBoundJournal(journal(response, 7));
    await writer.writeArtifacts({ generation: 7, response });
    await expect(writer.verifyArtifacts(response, 7)).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(absolutePath(dataDir, paths.startup), "utf8"))).toEqual(response.startupCredential);
    expect(JSON.parse(await readFile(absolutePath(dataDir, paths.license), "utf8"))).toEqual(response.license);
    await expect(readFile(join(dataDir, "license", ".startup-credential.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(dataDir, "license", "license.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(absolutePath(dataDir, paths.builtin), "utf8"))).toEqual(response.builtinCredential);
    expect(await readdir(join(dataDir, ".uclaw"))).not.toContain("activation-builtin-credential.v1.json");
    expect(JSON.parse(await readFile(absolutePath(dataDir, paths.generation), "utf8"))).toMatchObject({
      generation: 7, activationId: response.activationId, deviceId: response.deviceId, licenseId: response.licenseId,
    });
    expect(JSON.parse(await readFile(absolutePath(dataDir, paths.backup), "utf8"))).toMatchObject({ generation: 7 });
  });

  it("restores the previous generation after a partial write", async () => {
    const dataDir = await tempRoot();
    const first = createActivationArtifactWriter(writerOptions(dataDir));
    const previous = material("001");
    await first.writeServerBoundJournal(journal(previous, 1));
    await first.writeArtifacts({ generation: 1, response: previous });
    await first.commitArtifacts(previous.activationId, 1);

    const next = material("002");
    const interrupted = createActivationArtifactWriter({
      ...writerOptions(dataDir),
      beforeArtifactWrite: (index) => { if (index === 1) throw new Error("USB removed"); },
    });
    await interrupted.writeServerBoundJournal(journal(next, 2));
    await expect(interrupted.writeArtifacts({ generation: 2, response: next }))
      .rejects.toMatchObject({ code: "ARTIFACT_WRITE_FAILED" });
    expect(await interrupted.readJournal()).toMatchObject({ stage: "server_bound", generation: 2 });
    await createActivationArtifactWriter(writerOptions(dataDir)).recoverPendingArtifacts();
    await expect(createActivationArtifactWriter(writerOptions(dataDir)).verifyArtifacts(previous, 1)).resolves.toBeUndefined();
  });

  it("keeps the server-bound journal and backup when the USB disappears", async () => {
    const dataDir = await tempRoot();
    const response = material();
    const writer = createActivationArtifactWriter({
      ...writerOptions(dataDir),
      beforeArtifactWrite: () => { throw Object.assign(new Error("device gone"), { code: "ENODEV" }); },
    });
    await writer.writeServerBoundJournal(journal(response));
    await expect(writer.writeArtifacts({ generation: 1, response })).rejects.toMatchObject({ code: "ARTIFACT_WRITE_FAILED" });
    await expect(readFile(absolutePath(dataDir, paths.journal), "utf8")).resolves.toContain("server_bound");
    await expect(readFile(absolutePath(dataDir, paths.backup), "utf8")).resolves.toContain('"generation":1');
  });

  it.each(["symlink", "hardlink"] as const)("rejects a %s artifact target", async (kind) => {
    const dataDir = await tempRoot();
    await mkdir(join(packageRootFor(dataDir), "license"), { recursive: true });
    const outside = join(await tempRoot(), "outside.json");
    await writeFile(outside, "{}\n");
    if (kind === "symlink") await symlink(outside, absolutePath(dataDir, paths.license));
    else await link(outside, absolutePath(dataDir, paths.license));
    const writer = createActivationArtifactWriter(writerOptions(dataDir));
    const response = material();
    await writer.writeServerBoundJournal(journal(response));
    await expect(writer.writeArtifacts({ generation: 1, response })).rejects.toBeInstanceOf(ActivationArtifactError);
  });

  it("rejects corrupted read-back and retains recovery state", async () => {
    const dataDir = await tempRoot();
    const response = material();
    const writer = createActivationArtifactWriter({
      ...writerOptions(dataDir),
      afterArtifactWrite: async (index) => {
        if (index === 2) await writeFile(absolutePath(dataDir, paths.builtin), "{}\n");
      },
    });
    await writer.writeServerBoundJournal(journal(response));
    await expect(writer.writeArtifacts({ generation: 1, response })).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
    expect(await writer.readJournal()).toMatchObject({ stage: "server_bound" });
    await expect(readFile(absolutePath(dataDir, paths.backup), "utf8")).resolves.toBeTruthy();
  });

  it("does not expose any remote unbind operation", async () => {
    const dataDir = await tempRoot();
    const writer = createActivationArtifactWriter(writerOptions(dataDir));
    expect(writer).not.toHaveProperty("unbind");
    expect(writer).not.toHaveProperty("rollbackRemote");
    expect(vi.isMockFunction((writer as never as { unbind?: unknown }).unbind)).toBe(false);
  });

  it("rejects artifacts that do not match the server-bound journal transaction", async () => {
    const dataDir = await tempRoot();
    const writer = createActivationArtifactWriter(writerOptions(dataDir));
    await writer.writeServerBoundJournal(journal(material("001"), 1));
    await expect(writer.writeArtifacts({ generation: 1, response: material("002") }))
      .rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
  });

  it.each([0, 1])("converges after commit cleanup crash at boundary %s without rollback", async (boundary) => {
    const dataDir = await tempRoot();
    const response = material();
    const initial = createActivationArtifactWriter({ ...writerOptions(dataDir), beforeCommitCleanup: (index) => {
      if (index === boundary) throw new Error("crash");
    } });
    await initial.writeServerBoundJournal(journal(response));
    await initial.writeArtifacts({ generation: 1, response });
    await expect(initial.commitArtifacts(response.activationId, 1)).rejects.toMatchObject({ code: "ARTIFACT_WRITE_FAILED" });
    expect(await initial.readJournal()).toMatchObject({ stage: "committed" });

    const restarted = createActivationArtifactWriter(writerOptions(dataDir));
    await restarted.recoverPendingArtifacts();
    await expect(restarted.verifyArtifacts(response, 1)).resolves.toBeUndefined();
    expect(await restarted.readJournal()).toBeNull();
    await expect(readFile(absolutePath(dataDir, paths.backup))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects commit when a generated artifact no longer matches the strict sidecar", async () => {
    const dataDir = await tempRoot();
    const response = material();
    const writer = createActivationArtifactWriter(writerOptions(dataDir));
    await writer.writeServerBoundJournal(journal(response));
    await writer.writeArtifacts({ generation: 1, response });
    await writeFile(absolutePath(dataDir, paths.startup), `${JSON.stringify({ ...response.startupCredential, startupSecret: "z".repeat(32) })}\n`);

    await expect(writer.commitArtifacts(response.activationId, 1)).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
    expect(await writer.readJournal()).toMatchObject({ stage: "server_bound" });
    await expect(readFile(absolutePath(dataDir, paths.backup), "utf8")).resolves.toBeTruthy();
  });

  it("reports cleanup I/O failure after persisting committed state as recovery-required", async () => {
    const dataDir = await tempRoot();
    const response = material();
    const writer = createActivationArtifactWriter({
      ...writerOptions(dataDir),
      removeForTest: async (path, remove) => {
        if (path === paths.backup) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        await remove();
      },
    });
    await writer.writeServerBoundJournal(journal(response));
    await writer.writeArtifacts({ generation: 1, response });

    await expect(writer.commitArtifacts(response.activationId, 1))
      .rejects.toMatchObject({ code: "ARTIFACT_WRITE_FAILED" });
    expect(await writer.readJournal()).toMatchObject({ stage: "committed" });
  });

  it("rejects mixed artifact identities even when the generation sidecar hashes are recomputed", async () => {
    const dataDir = await tempRoot();
    const response = material("001");
    const writer = createActivationArtifactWriter(writerOptions(dataDir));
    await writer.writeServerBoundJournal(journal(response));
    await writer.writeArtifacts({ generation: 1, response });

    const mixed = material("002");
    const startupBody = `${JSON.stringify(mixed.startupCredential)}\n`;
    const licenseBody = await readFile(absolutePath(dataDir, paths.license), "utf8");
    const builtinBody = await readFile(absolutePath(dataDir, paths.builtin), "utf8");
    await writeFile(absolutePath(dataDir, paths.startup), startupBody);
    const manifest = JSON.parse(await readFile(absolutePath(dataDir, paths.generation), "utf8"));
    const { createHash } = await import("node:crypto");
    manifest.sha256 = {
      startupCredential: createHash("sha256").update(startupBody).digest("hex"),
      license: createHash("sha256").update(licenseBody).digest("hex"),
      builtinCredential: createHash("sha256").update(builtinBody).digest("hex"),
    };
    await writeFile(absolutePath(dataDir, paths.generation), `${JSON.stringify(manifest)}\n`);

    await expect(writer.commitArtifacts(response.activationId, 1)).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
    expect(await writer.readJournal()).toMatchObject({ stage: "server_bound" });
  });
});
