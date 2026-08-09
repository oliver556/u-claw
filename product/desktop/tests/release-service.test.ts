import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { canonicalReleasePayload, canonicalRuntimePayload, createReleaseService, type RuntimeManifest, type SignedReleaseManifest } from "../src/release/release-service.js";

const keys = generateKeyPairSync("ed25519");
const wrongKeys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

function manifest(overrides: Partial<SignedReleaseManifest> = {}): SignedReleaseManifest {
  const runtimeUnsigned = {
    schemaVersion: 1 as const, productVersion: "0.2.0", nodeVersion: "24.15.0", electronVersion: "40.10.6", runtimeVersion: "2026.7.1-2",
    runtimeId: "openclaw-2026.7.1-2-win-x64", targetPlatform: "win32" as const, targetArch: "x64" as const, runtimeArchive: "runtime.pkg" as const,
    runtimeSha256: createHash("sha256").update("runtime").digest("hex"), runtimeTreeSha256: "b".repeat(64), runtimeBytes: 7, unpackedBytes: 7, fileCount: 1,
    entrypoint: "electron/electron.exe", entryArgs: [] as string[],
  };
  const runtimeManifest = { ...runtimeUnsigned, signature: { algorithm: "ed25519" as const, keyId: "release-2026", signedAt: "2026-08-09T00:00:00.000Z", expiresAt: "2026-08-10T00:00:00.000Z", sequence: 42, value: "" } };
  runtimeManifest.signature.value = sign(null, canonicalRuntimePayload(runtimeManifest as RuntimeManifest), keys.privateKey).toString("base64");
  const unsigned = {
    schemaVersion: 1 as const, id: "release-42", version: "0.2.0", channel: "stable" as const,
    publishedAt: "2026-08-09T00:00:00.000Z", expiresAt: "2026-08-10T00:00:00.000Z", sequence: 42,
    notes: ["安全更新"], compatibility: { platform: "win32" as const, arch: "x64" as const, runtimeId: "openclaw-2026.7.1-2-win-x64" },
    package: { bytes: 7, sha256: createHash("sha256").update("runtime").digest("hex") }, runtimeManifest, mandatory: false,
    ...overrides,
  };
  const signature = sign(null, canonicalReleasePayload(unsigned), keys.privateKey).toString("base64");
  return { ...unsigned, signature: { algorithm: "ed25519", keyId: "release-2026", value: signature } };
}

const transactionIdentity = (runtime: RuntimeManifest) => ({
  sequence: runtime.signature.sequence,
  runtimeSha256: runtime.runtimeSha256,
  signatureValue: runtime.signature.value,
});

async function fixture(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "uclaw-release-test-"));
  const cacheRoot = join(root, "cache");
  const packageRoot = join(root, "portable", ".uclaw");
  await mkdir(cacheRoot, { recursive: true }); await mkdir(packageRoot, { recursive: true });
  await writeFile(join(cacheRoot, ".uclaw-cache.json"), JSON.stringify({ schemaVersion: 1, product: "U-Claw", purpose: "rebuildable-cache" }));
  const fetchManifest = vi.fn(async () => manifest());
  const download = vi.fn(async (_release: SignedReleaseManifest, target: string) => writeFile(target, "runtime", { flag: "wx" }));
  return { root, cacheRoot, fetchManifest, download, service: createReleaseService({
    currentVersion: "0.1.0", channel: "stable", platform: "win32", arch: "x64",
    runtimeId: "openclaw-2026.7.1-2-win-x64", cacheRoot, packageRoot,
    trustedKeys: { "release-2026": publicKey }, revokedKeyIds: new Set(), fetchManifest, download,
    now: () => new Date("2026-08-09T01:00:00.000Z"), ...overrides,
  }), packageRoot };
}

describe("release service", () => {
  it("tracks background install work until the operation settles", async () => {
    const runMutation = vi.fn(async <T>(operation: () => Promise<T>) => operation());
    const setup = await fixture({ runMutation });
    const checked = await setup.service.check("stable");
    if (checked.state !== "available" || !checked.update) throw new Error("release preview unavailable");
    const operation = setup.service.install(checked.update.id, checked.update.previewToken, true);

    await setup.service.wait(operation.id);

    expect(runMutation).toHaveBeenCalledOnce();
  });

  it("fails a queued install when the consistency coordinator rejects it", async () => {
    const runMutation = async <T>(_operation: () => Promise<T>): Promise<T> => { throw new Error("runtime unavailable"); };
    const setup = await fixture({ runMutation });
    const checked = await setup.service.check("stable");
    if (checked.state !== "available" || !checked.update) throw new Error("release preview unavailable");
    const operation = setup.service.install(checked.update.id, checked.update.previewToken, true);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setup.service.operation(operation.id)).toMatchObject({ state: "failed" });
  });

  it("returns structured available, offline, unavailable, timeout and retry states", async () => {
    const healthy = await fixture();
    expect(await healthy.service.check("stable")).toMatchObject({ state: "available", update: { version: "0.2.0", compatibility: { platform: "win32", arch: "x64" } } });
    const offline = await fixture({ fetchManifest: vi.fn(async () => { throw Object.assign(new Error("offline"), { code: "ENETUNREACH" }); }) });
    expect(await offline.service.check("stable")).toMatchObject({ state: "offline", retryable: true });
    const unavailable = await fixture({ trustedKeys: {} });
    expect(await unavailable.service.check("stable")).toMatchObject({ state: "unavailable", retryable: false });
    const timed = await fixture({ timeoutMs: 5, fetchManifest: vi.fn(async (_channel: string, signal: AbortSignal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))) });
    expect(await timed.service.check("stable")).toMatchObject({ state: "timeout", retryable: true });
    expect(await healthy.service.retry()).toMatchObject({ state: "available" });
  });

  it("reports a valid same-version manifest as current", async () => {
    const setup = await fixture({ currentVersion: "0.2.0" });
    expect(await setup.service.check("stable")).toMatchObject({ state: "current", currentVersion: "0.2.0" });
    await expect(readFile(join(setup.cacheRoot, ".uclaw-release-sequence.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await setup.service.retry()).toMatchObject({ state: "current" });
  });

  it("allows only the exact current runtime identity at an accepted sequence", async () => {
    const setup = await fixture({ currentVersion: "0.2.0" });
    const accepted = manifest().runtimeManifest;
    await writeFile(join(setup.cacheRoot, ".uclaw-release-sequence.json"), JSON.stringify({ schemaVersion: 1, ...transactionIdentity(accepted) }));
    expect(await setup.service.check("stable")).toMatchObject({ state: "current" });

    const replacement = manifest();
    replacement.runtimeManifest.runtimeTreeSha256 = "c".repeat(64);
    replacement.runtimeManifest.signature.value = sign(null, canonicalRuntimePayload(replacement.runtimeManifest), keys.privateKey).toString("base64");
    const { signature: _signature, ...replacementUnsigned } = replacement;
    replacement.signature.value = sign(null, canonicalReleasePayload(replacementUnsigned), keys.privateKey).toString("base64");
    const replaced = await fixture({ currentVersion: "0.2.0", fetchManifest: vi.fn(async () => replacement) });
    await writeFile(join(replaced.cacheRoot, ".uclaw-release-sequence.json"), JSON.stringify({ schemaVersion: 1, ...transactionIdentity(accepted) }));
    expect(await replaced.service.check("stable")).toMatchObject({ state: "unavailable", retryable: false });
  });

  it.each(["oversized", "symlink"])("fails closed for an %s sequence record before fetching", async (kind) => {
    const setup = await fixture();
    const sequencePath = join(setup.cacheRoot, ".uclaw-release-sequence.json");
    if (kind === "oversized") await writeFile(sequencePath, "x".repeat(4097));
    else {
      const outside = join(setup.root, "outside-sequence.json");
      await writeFile(outside, JSON.stringify({ schemaVersion: 1, ...transactionIdentity(manifest().runtimeManifest) }));
      await symlink(outside, sequencePath);
    }
    expect(await setup.service.check("stable")).toMatchObject({ state: "unavailable" });
    expect(setup.fetchManifest).not.toHaveBeenCalled();
  });

  it("validates the requested beta channel instead of the startup default", async () => {
    const betaManifest = manifest({ channel: "beta" });
    const setup = await fixture({ fetchManifest: vi.fn(async () => betaManifest) });
    expect(await setup.service.check("beta")).toMatchObject({ state: "available", channel: "beta", update: { channel: "beta" } });
  });

  it.each([
    ["tampered", () => ({ ...manifest(), notes: ["被篡改"] }), undefined],
    ["wrong key", () => manifest(), wrongKeys.publicKey.export({ type: "spki", format: "pem" }).toString()],
    ["expired", () => manifest({ expiresAt: "2026-08-09T00:00:00.000Z" }), undefined],
    ["version mismatch", () => manifest({ compatibility: { platform: "win32", arch: "x64", runtimeId: "other" } }), undefined],
  ])("fails closed for %s manifests", async (_name, createManifest, alternateKey) => {
    const setup = await fixture({ fetchManifest: vi.fn(async () => createManifest() as SignedReleaseManifest), ...(alternateKey ? { trustedKeys: { "release-2026": alternateKey } } : {}) });
    expect(await setup.service.check("stable")).toMatchObject({ state: "unavailable", retryable: false });
  });

  it("rejects revoked keys, replay and downgrade", async () => {
    const revoked = await fixture({ revokedKeyIds: new Set(["release-2026"]) });
    expect(await revoked.service.check("stable")).toMatchObject({ state: "unavailable" });
    const replay = await fixture({ highestSequence: 42 });
    expect(await replay.service.check("stable")).toMatchObject({ state: "unavailable" });
    const downgrade = await fixture({ currentVersion: "0.3.0" });
    expect(await downgrade.service.check("stable")).toMatchObject({ state: "unavailable" });
  });

  it("downloads into controlled staging, verifies before atomic switch, and recovers interrupted switch", async () => {
    const setup = await fixture();
    const checked = await setup.service.check("stable");
    const update = checked.update!;
    const started = setup.service.install(update.id, update.previewToken, true);
    expect(await setup.service.wait(started.id)).toMatchObject({ state: "completed", recovery: "none" });
    expect(await readFile(join(setup.packageRoot, "runtime.pkg"), "utf8")).toBe("runtime");
    expect(JSON.parse(await readFile(join(setup.packageRoot, "version.json"), "utf8"))).toMatchObject({ runtimeId: "openclaw-2026.7.1-2-win-x64", signature: { keyId: "release-2026" } });
    expect(JSON.parse(await readFile(join(setup.packageRoot, ".update-transaction.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
      state: "complete",
      target: {
        sequence: 42,
        runtimeSha256: manifest().runtimeManifest.runtimeSha256,
        signatureValue: manifest().runtimeManifest.signature.value,
      },
      previous: null,
    });
    expect(JSON.stringify(setup.download.mock.calls)).not.toContain("renderer");

    const installed = manifest().runtimeManifest;
    await writeFile(join(setup.packageRoot, ".update-transaction.json"), JSON.stringify({ schemaVersion: 1, state: "switching", target: transactionIdentity(installed), previous: transactionIdentity(installed) }));
    await writeFile(join(setup.packageRoot, "runtime.pkg.rollback"), "runtime");
    await writeFile(join(setup.packageRoot, "version.json.rollback"), JSON.stringify(manifest().runtimeManifest));
    await setup.service.recover();
    expect(await readFile(join(setup.packageRoot, "runtime.pkg"), "utf8")).toBe("runtime");
  });

  it("uses the secure native install path without exposing a staging target", async () => {
    const secureInstall = vi.fn(async () => undefined);
    const download = vi.fn(async () => { throw new Error("Node staging path must not run"); });
    const setup = await fixture({ secureInstall, download });
    const checked = await setup.service.check("stable");
    const operation = setup.service.install(checked.update!.id, checked.update!.previewToken, true);

    expect(await setup.service.wait(operation.id)).toMatchObject({ state: "completed", recovery: "none" });
    expect(secureInstall).toHaveBeenCalledWith(expect.objectContaining({ id: "release-42" }), expect.any(AbortSignal));
    expect(download).not.toHaveBeenCalled();
  });

  it("recovers idempotently when only runtime reached rollback", async () => {
    const setup = await fixture();
    const oldManifest = manifest().runtimeManifest;
    await writeFile(join(setup.packageRoot, ".update-transaction.json"), JSON.stringify({
      schemaVersion: 1,
      state: "switching",
      target: { ...transactionIdentity(oldManifest), runtimeSha256: "0".repeat(64) },
      previous: transactionIdentity(oldManifest),
    }));
    await writeFile(join(setup.packageRoot, "runtime.pkg.rollback"), "runtime");
    await writeFile(join(setup.packageRoot, "version.json"), JSON.stringify(oldManifest));

    expect(await setup.service.recover()).toMatchObject({ state: "rolled-back" });
    expect(await readFile(join(setup.packageRoot, "runtime.pkg"), "utf8")).toBe("runtime");
    expect(JSON.parse(await readFile(join(setup.packageRoot, "version.json"), "utf8"))).toMatchObject({ runtimeId: oldManifest.runtimeId });
  });

  it("reports damaged or unverifiable transactions as recovery-required", async () => {
    const setup = await fixture();
    const transaction = join(setup.packageRoot, ".update-transaction.json");
    await writeFile(transaction, "{");
    expect(await setup.service.recover()).toMatchObject({ state: "recovery-required" });
    await writeFile(transaction, JSON.stringify({ schemaVersion: 1, state: "complete", hadPrevious: false }));
    expect(await setup.service.recover()).toMatchObject({ state: "recovery-required" });
  });

  it("refuses tampered downloads and preserves active runtime", async () => {
    const setup = await fixture({ download: vi.fn(async (_release: SignedReleaseManifest, target: string) => writeFile(target, "tampered", { flag: "wx" })) });
    await writeFile(join(setup.packageRoot, "runtime.pkg"), "current");
    const checked = await setup.service.check("stable");
    const operation = setup.service.install(checked.update!.id, checked.update!.previewToken, true);
    expect(await setup.service.wait(operation.id)).toMatchObject({ state: "failed" });
    expect(await readFile(join(setup.packageRoot, "runtime.pkg"), "utf8")).toBe("current");
  });

  it.each(["symlink", "hardlink"])("rejects %s staged packages before installation", async (kind) => {
    const setup = await fixture({ download: vi.fn(async (_release: SignedReleaseManifest, target: string) => {
      const outside = join(target, "..", "..", `${kind}.pkg`); await writeFile(outside, "runtime");
      if (kind === "symlink") await symlink(outside, target); else await link(outside, target);
    }) });
    await writeFile(join(setup.packageRoot, "runtime.pkg"), "current");
    const checked = await setup.service.check("stable");
    const op = setup.service.install(checked.update!.id, checked.update!.previewToken, true);
    expect(await setup.service.wait(op.id)).toMatchObject({ state: "failed" });
    expect(await readFile(join(setup.packageRoot, "runtime.pkg"), "utf8")).toBe("current");
  });

  it("previews uninstall scopes and deletes only marker-owned host cache with token and partial progress", async () => {
    const setup = await fixture();
    await mkdir(join(setup.cacheRoot, "cache")); await writeFile(join(setup.cacheRoot, "cache", "entry"), "x");
    const preview = await setup.service.previewUninstall();
    expect(preview.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "application", selected: false }),
      expect.objectContaining({ id: "usb-user-data", selected: false, protected: true }),
      expect.objectContaining({ id: "host-cache", selected: true }),
    ]));
    const op = setup.service.executeUninstall(["host-cache"], preview.previewToken, true);
    expect(await setup.service.wait(op.id)).toMatchObject({ state: "completed", processedItems: 3 });
    await expect(readFile(join(setup.cacheRoot, "cache", "entry"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rechecks cache ownership after preview and refuses changed markers", async () => {
    const setup = await fixture(); const preview = await setup.service.previewUninstall();
    await writeFile(join(setup.cacheRoot, ".uclaw-cache.json"), JSON.stringify({ schemaVersion: 1, product: "Other", purpose: "rebuildable-cache" }));
    const op = setup.service.executeUninstall(["host-cache"], preview.previewToken, true);
    expect(await setup.service.wait(op.id)).toMatchObject({ state: "failed", processedItems: 0 });
  });

  it("leaves unknown fixed cache entries in place", async () => {
    const setup = await fixture();
    const unknown = join(setup.cacheRoot, "runtime");
    await writeFile(unknown, "foreign");
    const preview = await setup.service.previewUninstall();
    const op = setup.service.executeUninstall(["host-cache"], preview.previewToken, true);
    expect(await setup.service.wait(op.id)).toMatchObject({ state: "completed", partialFailures: 1 });
    expect(await readFile(unknown, "utf8")).toBe("foreign");
  });

  it("delegates each cache child to the native cleanup boundary", async () => {
    const secureCleanup = vi.fn(async (child: string) => {
      if (child === "cache") throw new Error("replacement rejected");
    });
    const setup = await fixture({ secureCleanup });
    const preview = await setup.service.previewUninstall();
    const operation = setup.service.executeUninstall(["host-cache"], preview.previewToken, true);

    expect(await setup.service.wait(operation.id)).toMatchObject({ state: "completed", processedItems: 3, partialFailures: 1 });
    expect(secureCleanup.mock.calls.map(([child]) => child)).toEqual(["runtime", "cache", "updates"]);
  });
});
