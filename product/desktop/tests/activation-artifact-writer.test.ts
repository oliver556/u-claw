import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ActivationResponse } from "@uclaw/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ActivationArtifactError,
  createActivationArtifactWriter,
} from "../src/activation/artifact-writer.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function tempRoot(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "uclaw-activation-writer-"));
  roots.push(value);
  return value;
}

const material = (suffix = "001"): ActivationResponse => ({
  activationId: `activation-${suffix}`,
  deviceId: `device-${suffix}`,
  licenseId: `license-${suffix}`,
  license: {
    schemaVersion: 1,
    deviceId: `device-${suffix}`,
    licenseId: `license-${suffix}`,
    usbFingerprint: { scheme: "uclaw-usb-v1", sha256: "a".repeat(64) },
    startupSecretProof: {
      algorithm: "sha256-salt-v1", startupSecretSalt: "b".repeat(32), startupSecretHash: "c".repeat(64),
    },
    notBefore: "2026-08-13T00:00:00.000Z",
    expiresAt: "2027-08-13T00:00:00.000Z",
    signature: { algorithm: "ed25519", keyId: "activation-key", value: "s".repeat(80) },
  },
  startupCredential: {
    schemaVersion: 1, deviceId: `device-${suffix}`, licenseId: `license-${suffix}`, startupSecret: "x".repeat(32),
  },
  builtinCredential: {
    schemaVersion: 1, deviceId: `device-${suffix}`, licenseId: `license-${suffix}`,
    accessToken: "t".repeat(16), expiresAt: "2026-08-14T00:00:00.000Z",
  },
  status: "active",
});

const journal = (response = material(), generation = 1) => ({
  schemaVersion: 1 as const,
  activationId: response.activationId,
  idempotencyKey: "activation:test:001",
  generation,
  deviceId: response.deviceId,
  licenseId: response.licenseId,
  stage: "server_bound" as const,
});

const paths = {
  startup: ".uclaw/license/.startup-credential.json",
  license: ".uclaw/license/license.json",
  builtin: ".uclaw/builtin-model-credential.v1.json",
  activationBuiltin: ".uclaw/activation-builtin-credential.v1.json",
  generation: ".uclaw/activation-artifact-generation.v1.json",
  journal: ".uclaw/activation-transaction.v1.json",
  backup: ".uclaw/activation-artifact-backup.v1.json",
};

describe("activation artifact writer", () => {
  it("rejects Windows writes when the pinned helper is unavailable", async () => {
    const dataDir = await tempRoot();
    expect(() => createActivationArtifactWriter({ dataDir, platformForTest: "win32" }))
      .toThrow(/pinned Windows filesystem/i);
  });

  it("writes all three strict artifacts, records generation, and verifies read-back", async () => {
    const dataDir = await tempRoot();
    const writer = createActivationArtifactWriter({ dataDir });
    const response = material();
    await writer.writeServerBoundJournal(journal(response, 7));
    await writer.writeArtifacts({ generation: 7, response });
    await expect(writer.verifyArtifacts(response, 7)).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(join(dataDir, paths.startup), "utf8"))).toEqual(response.startupCredential);
    expect(JSON.parse(await readFile(join(dataDir, paths.license), "utf8"))).toEqual(response.license);
    expect(JSON.parse(await readFile(join(dataDir, paths.activationBuiltin), "utf8"))).toEqual(response.builtinCredential);
    expect(JSON.parse(await readFile(join(dataDir, paths.generation), "utf8"))).toMatchObject({
      generation: 7, activationId: response.activationId, deviceId: response.deviceId, licenseId: response.licenseId,
    });
    expect(JSON.parse(await readFile(join(dataDir, paths.backup), "utf8"))).toMatchObject({ generation: 7 });
  });

  it("restores the previous generation after a partial write", async () => {
    const dataDir = await tempRoot();
    const first = createActivationArtifactWriter({ dataDir });
    const previous = material("001");
    await first.writeServerBoundJournal(journal(previous, 1));
    await first.writeArtifacts({ generation: 1, response: previous });
    await first.commitArtifacts(previous.activationId, 1);

    const next = material("002");
    const interrupted = createActivationArtifactWriter({
      dataDir,
      beforeArtifactWrite: (index) => { if (index === 1) throw new Error("USB removed"); },
    });
    await interrupted.writeServerBoundJournal(journal(next, 2));
    await expect(interrupted.writeArtifacts({ generation: 2, response: next }))
      .rejects.toMatchObject({ code: "ARTIFACT_WRITE_FAILED" });
    expect(await interrupted.readJournal()).toMatchObject({ stage: "server_bound", generation: 2 });
    await createActivationArtifactWriter({ dataDir }).recoverPendingArtifacts();
    await expect(createActivationArtifactWriter({ dataDir }).verifyArtifacts(previous, 1)).resolves.toBeUndefined();
  });

  it("keeps the server-bound journal and backup when the USB disappears", async () => {
    const dataDir = await tempRoot();
    const response = material();
    const writer = createActivationArtifactWriter({
      dataDir,
      beforeArtifactWrite: () => { throw Object.assign(new Error("device gone"), { code: "ENODEV" }); },
    });
    await writer.writeServerBoundJournal(journal(response));
    await expect(writer.writeArtifacts({ generation: 1, response })).rejects.toMatchObject({ code: "ARTIFACT_WRITE_FAILED" });
    await expect(readFile(join(dataDir, paths.journal), "utf8")).resolves.toContain("server_bound");
    await expect(readFile(join(dataDir, paths.backup), "utf8")).resolves.toContain('"generation":1');
  });

  it.each(["symlink", "hardlink"] as const)("rejects a %s artifact target", async (kind) => {
    const dataDir = await tempRoot();
    await mkdir(join(dataDir, ".uclaw", "license"), { recursive: true });
    const outside = join(await tempRoot(), "outside.json");
    await writeFile(outside, "{}\n");
    if (kind === "symlink") await symlink(outside, join(dataDir, paths.license));
    else await link(outside, join(dataDir, paths.license));
    const writer = createActivationArtifactWriter({ dataDir });
    const response = material();
    await writer.writeServerBoundJournal(journal(response));
    await expect(writer.writeArtifacts({ generation: 1, response })).rejects.toBeInstanceOf(ActivationArtifactError);
  });

  it("rejects corrupted read-back and retains recovery state", async () => {
    const dataDir = await tempRoot();
    const response = material();
    const writer = createActivationArtifactWriter({
      dataDir,
      afterArtifactWrite: async (index) => {
        if (index === 2) await writeFile(join(dataDir, paths.activationBuiltin), "{}\n");
      },
    });
    await writer.writeServerBoundJournal(journal(response));
    await expect(writer.writeArtifacts({ generation: 1, response })).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
    expect(await writer.readJournal()).toMatchObject({ stage: "server_bound" });
    await expect(readFile(join(dataDir, paths.backup), "utf8")).resolves.toBeTruthy();
  });

  it("does not expose any remote unbind operation", async () => {
    const writer = createActivationArtifactWriter({ dataDir: await tempRoot() });
    expect(writer).not.toHaveProperty("unbind");
    expect(writer).not.toHaveProperty("rollbackRemote");
    expect(vi.isMockFunction((writer as never as { unbind?: unknown }).unbind)).toBe(false);
  });

  it("rejects artifacts that do not match the server-bound journal transaction", async () => {
    const dataDir = await tempRoot();
    const writer = createActivationArtifactWriter({ dataDir });
    await writer.writeServerBoundJournal(journal(material("001"), 1));
    await expect(writer.writeArtifacts({ generation: 1, response: material("002") }))
      .rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
  });

  it.each([0, 1])("converges after commit cleanup crash at boundary %s without rollback", async (boundary) => {
    const dataDir = await tempRoot();
    const response = material();
    const initial = createActivationArtifactWriter({ dataDir, beforeCommitCleanup: (index) => {
      if (index === boundary) throw new Error("crash");
    } });
    await initial.writeServerBoundJournal(journal(response));
    await initial.writeArtifacts({ generation: 1, response });
    await expect(initial.commitArtifacts(response.activationId, 1)).rejects.toMatchObject({ code: "ARTIFACT_WRITE_FAILED" });
    expect(await initial.readJournal()).toMatchObject({ stage: "committed" });

    const restarted = createActivationArtifactWriter({ dataDir });
    await restarted.recoverPendingArtifacts();
    await expect(restarted.verifyArtifacts(response, 1)).resolves.toBeUndefined();
    expect(await restarted.readJournal()).toBeNull();
    await expect(readFile(join(dataDir, paths.backup))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects commit when a generated artifact no longer matches the strict sidecar", async () => {
    const dataDir = await tempRoot();
    const response = material();
    const writer = createActivationArtifactWriter({ dataDir });
    await writer.writeServerBoundJournal(journal(response));
    await writer.writeArtifacts({ generation: 1, response });
    await writeFile(join(dataDir, paths.startup), `${JSON.stringify({ ...response.startupCredential, startupSecret: "z".repeat(32) })}\n`);

    await expect(writer.commitArtifacts(response.activationId, 1)).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
    expect(await writer.readJournal()).toMatchObject({ stage: "server_bound" });
    await expect(readFile(join(dataDir, paths.backup), "utf8")).resolves.toBeTruthy();
  });

  it("reports cleanup I/O failure after persisting committed state as recovery-required", async () => {
    const dataDir = await tempRoot();
    const response = material();
    const writer = createActivationArtifactWriter({
      dataDir,
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
    const writer = createActivationArtifactWriter({ dataDir });
    await writer.writeServerBoundJournal(journal(response));
    await writer.writeArtifacts({ generation: 1, response });

    const mixed = material("002");
    const startupBody = `${JSON.stringify(mixed.startupCredential)}\n`;
    const licenseBody = await readFile(join(dataDir, paths.license), "utf8");
    const builtinBody = await readFile(join(dataDir, paths.activationBuiltin), "utf8");
    await writeFile(join(dataDir, paths.startup), startupBody);
    const manifest = JSON.parse(await readFile(join(dataDir, paths.generation), "utf8"));
    const { createHash } = await import("node:crypto");
    manifest.sha256 = {
      startupCredential: createHash("sha256").update(startupBody).digest("hex"),
      license: createHash("sha256").update(licenseBody).digest("hex"),
      builtinCredential: createHash("sha256").update(builtinBody).digest("hex"),
    };
    await writeFile(join(dataDir, paths.generation), `${JSON.stringify(manifest)}\n`);

    await expect(writer.commitArtifacts(response.activationId, 1)).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
    expect(await writer.readJournal()).toMatchObject({ stage: "server_bound" });
  });
});
