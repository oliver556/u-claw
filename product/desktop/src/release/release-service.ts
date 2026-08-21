import { createHash, randomUUID, verify } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ReleaseCheckResult, ReleaseOperation, ReleaseUpdate, UninstallPreview } from "@uclaw/shared";

export interface SignedReleaseManifest {
  schemaVersion: 1; id: string; version: string; channel: "stable" | "beta";
  publishedAt: string; expiresAt: string; sequence: number; notes: string[];
  compatibility: { platform: "win32"; arch: "x64"; runtimeId: string };
  package: { bytes: number; sha256: string }; runtimeManifest: RuntimeManifest; mandatory: boolean;
  signature: { algorithm: "ed25519"; keyId: string; value: string };
}

export interface RuntimeManifest {
  schemaVersion: 1; releaseId: string; releaseSequence: number; productVersion: string; nodeVersion: string; electronVersion: string; runtimeVersion: string;
  runtimeId: string; targetPlatform: "win32"; targetArch: "x64"; runtimeArchive: "runtime.pkg";
  runtimeSha256: string; runtimeTreeSha256: string; runtimeBytes: number; unpackedBytes: number; fileCount: number; entrypoint: string; entryArgs: string[];
  criticalFiles: Array<{ path: string; size: number; sha256: string }>;
  signature: { algorithm: "ed25519"; keyId: string; signedAt: string; expiresAt: string; sequence: number; value: string };
}

interface UpdateIdentity {
  sequence: number;
  runtimeSha256: string;
  signatureValue: string;
}

interface UpdateTransaction {
  schemaVersion: 1;
  state: "switching" | "complete";
  target: UpdateIdentity;
  previous: UpdateIdentity | null;
}

type RollbackStage = "prepared" | "active-runtime-moved" | "active-version-moved" | "rollback-runtime-moved" | "rollback-version-moved";
interface RollbackTransaction {
  schemaVersion: 1;
  stage: RollbackStage;
  active: UpdateIdentity;
  target: UpdateIdentity;
}

type UnsignedReleaseManifest = Omit<SignedReleaseManifest, "signature">;
export const canonicalReleasePayload = (manifest: UnsignedReleaseManifest): Buffer => Buffer.from(JSON.stringify(manifest));
export const canonicalRuntimePayload = (runtime: RuntimeManifest): Buffer => Buffer.from(JSON.stringify([
  "uclaw-runtime-manifest-v2",
  runtime.schemaVersion, runtime.releaseId, runtime.releaseSequence, runtime.productVersion, runtime.nodeVersion, runtime.electronVersion,
  runtime.runtimeVersion, runtime.runtimeId, runtime.targetPlatform, runtime.targetArch,
  runtime.runtimeArchive, runtime.runtimeSha256, runtime.runtimeTreeSha256, runtime.runtimeBytes,
  runtime.unpackedBytes, runtime.fileCount, runtime.entrypoint, runtime.entryArgs, runtime.criticalFiles,
  runtime.signature.algorithm, runtime.signature.keyId, runtime.signature.signedAt,
  runtime.signature.expiresAt, runtime.signature.sequence,
]));

export interface ReleaseServiceOptions {
  currentVersion: string; channel: "stable" | "beta"; platform: "win32"; arch: "x64"; runtimeId: string;
  cacheRoot: string; packageRoot: string; trustedKeys: Record<string, string>; revokedKeyIds: Set<string>;
  highestSequence?: number; timeoutMs?: number; now?: () => Date;
  configurationError?: string;
  runMutation?<T>(operation: () => Promise<T>): Promise<T>;
  fetchManifest(channel: "stable" | "beta", signal: AbortSignal): Promise<SignedReleaseManifest>;
  download(manifest: SignedReleaseManifest, controlledTarget: string, signal: AbortSignal): Promise<void>;
  secureInstall?(manifest: SignedReleaseManifest, signal: AbortSignal): Promise<void>;
  secureCleanup?(child: "runtime" | "cache" | "updates"): Promise<void>;
  beforeRollbackSwitch?(stage: "before" | "active-runtime-moved" | "active-version-moved" | "rollback-runtime-moved" | "rollback-version-moved"): Promise<void>;
}

const token = () => randomUUID().replaceAll("-", "");
const operationId = () => `operation-${token()}`;

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync().catch((error: NodeJS.ErrnoException) => {
      if (
        process.platform !== "win32" ||
        !["EINVAL", "ENOTSUP", "EPERM"].includes(error.code ?? "")
      ) throw error;
    });
  } finally { await handle.close(); }
}

async function writeJsonDurable(path: string, value: unknown, exclusive = false): Promise<void> {
  const temporary = `${path}.new-${token()}`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
  try {
    if (exclusive && await lstat(path).then(() => true, () => false)) throw new Error("Target already exists.");
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}

function validManifest(value: SignedReleaseManifest, options: ReleaseServiceOptions, now: Date, highestSequence: number, acceptedIdentity: UpdateIdentity | undefined, channel: "stable" | "beta"): boolean {
  const { signature, ...unsigned } = value;
  const key = options.trustedKeys[signature?.keyId];
  if (!key || signature.algorithm !== "ed25519" || options.revokedKeyIds.has(signature.keyId)) return false;
  if (!verify(null, canonicalReleasePayload(unsigned), key, Buffer.from(signature.value, "base64"))) return false;
  const version = parseVersion(value.version); const current = parseVersion(options.currentVersion);
  if (!version || !current || compareVersion(version, current) < 0) return false;
  if (value.channel !== channel || value.compatibility.platform !== options.platform || value.compatibility.arch !== options.arch || value.compatibility.runtimeId !== options.runtimeId) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.id) || !Number.isSafeInteger(value.sequence) || value.sequence < highestSequence) return false;
  if (value.sequence === highestSequence && (!acceptedIdentity || !sameUpdateIdentity(value.runtimeManifest, acceptedIdentity))) return false;
  if (!Number.isFinite(Date.parse(value.publishedAt)) || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now.getTime()) return false;
  return value.package.bytes > 0 && /^[a-f0-9]{64}$/u.test(value.package.sha256) && validRuntimeManifest(value.runtimeManifest, value, options, now);
}

function validRuntimeManifest(runtime: RuntimeManifest, release: SignedReleaseManifest, options: ReleaseServiceOptions, now: Date): boolean {
  if (!validRuntimeSignature(runtime, options, now)) return false;
  const { signature } = runtime;
  return signature.sequence === release.sequence && runtime.releaseSequence === release.sequence && runtime.releaseId === release.id && runtime.runtimeId === options.runtimeId && runtime.targetPlatform === options.platform && runtime.targetArch === options.arch &&
    runtime.productVersion === release.version && runtime.runtimeArchive === "runtime.pkg" && runtime.runtimeBytes === release.package.bytes && runtime.runtimeSha256 === release.package.sha256;
}

const runtimeManifestKeys = ["criticalFiles", "electronVersion", "entryArgs", "entrypoint", "fileCount", "nodeVersion", "productVersion", "releaseId", "releaseSequence", "runtimeArchive", "runtimeBytes", "runtimeId", "runtimeSha256", "runtimeTreeSha256", "runtimeVersion", "schemaVersion", "signature", "targetArch", "targetPlatform", "unpackedBytes"];

function validRuntimeSignature(runtime: RuntimeManifest, options: ReleaseServiceOptions, now: Date): boolean {
  if (!runtime || typeof runtime !== "object" || Object.keys(runtime).sort().join("\0") !== runtimeManifestKeys.join("\0")) return false;
  const { signature } = runtime;
  const key = options.trustedKeys[signature?.keyId];
  if (!signature || !key || signature.algorithm !== "ed25519" || options.revokedKeyIds.has(signature.keyId)) return false;
  try { if (!verify(null, canonicalRuntimePayload(runtime), key, Buffer.from(signature.value, "base64"))) return false; } catch { return false; }
  if (Date.parse(signature.expiresAt) <= now.getTime() || Date.parse(signature.signedAt) > now.getTime() + 300_000 || !Number.isSafeInteger(signature.sequence) || signature.sequence < 1) return false;
  const criticalPaths = runtime.criticalFiles?.map((file) => file.path.replaceAll("\\", "/").toLowerCase()) ?? [];
  const criticalValid = criticalPaths.length > 0 && criticalPaths.length <= 512 && new Set(criticalPaths).size === criticalPaths.length && criticalPaths.includes(runtime.entrypoint.replaceAll("\\", "/").toLowerCase()) &&
    runtime.criticalFiles.every((file) => Number.isSafeInteger(file.size) && file.size >= 0 && /^[a-f0-9]{64}$/u.test(file.sha256));
  return runtime.schemaVersion === 1 && runtime.releaseSequence === signature.sequence && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runtime.releaseId) && criticalValid && runtime.runtimeId === options.runtimeId && runtime.targetPlatform === options.platform && runtime.targetArch === options.arch && runtime.runtimeArchive === "runtime.pkg" &&
    Number.isSafeInteger(runtime.runtimeBytes) && runtime.runtimeBytes > 0 && /^[a-f0-9]{64}$/u.test(runtime.runtimeSha256) && /^[a-f0-9]{64}$/u.test(runtime.runtimeTreeSha256);
}

function parseVersion(value: string): readonly [number, number, number] | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  if (!match) return undefined;
  const parts = match.slice(1).map(Number) as [number, number, number];
  return parts.every(Number.isSafeInteger) ? parts : undefined;
}

function compareVersion(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index]! - right[index]!;
  return 0;
}

function updateIdentity(manifest: RuntimeManifest): UpdateIdentity {
  return {
    sequence: manifest.signature.sequence,
    runtimeSha256: manifest.runtimeSha256,
    signatureValue: manifest.signature.value,
  };
}

function validUpdateIdentity(value: unknown): value is UpdateIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Record<string, unknown>;
  return Object.keys(identity).sort().join("\0") === "runtimeSha256\0sequence\0signatureValue" &&
    Number.isSafeInteger(identity.sequence) && (identity.sequence as number) > 0 &&
    typeof identity.runtimeSha256 === "string" && /^[a-f0-9]{64}$/u.test(identity.runtimeSha256) &&
    typeof identity.signatureValue === "string" && identity.signatureValue.length > 0 && identity.signatureValue.length <= 256;
}

function sameUpdateIdentity(manifest: RuntimeManifest, identity: UpdateIdentity): boolean {
  const actual = updateIdentity(manifest);
  return actual.sequence === identity.sequence && actual.runtimeSha256 === identity.runtimeSha256 && actual.signatureValue === identity.signatureValue;
}

async function hashRegularFile(path: string, bytes: number): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== bytes) throw new Error("Unsafe staged update.");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== bytes) throw new Error("Unsafe staged update.");
    const hash = createHash("sha256");
    for await (const chunk of handle.readableWebStream()) hash.update(Buffer.from(chunk));
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("Staged update changed during verification.");
    return hash.digest("hex");
  } finally { await handle.close(); }
}

async function readOwnedCacheMarker(cacheRoot: string): Promise<boolean> {
  const root = await lstat(cacheRoot).catch(() => undefined);
  if (!root?.isDirectory() || root.isSymbolicLink()) return false;
  const handle = await open(join(cacheRoot, ".uclaw-cache.json"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => undefined);
  if (!handle) return false;
  try {
    const info = await handle.stat(); if (!info.isFile() || info.nlink !== 1 || info.size > 4096) return false;
    const marker = JSON.parse(await handle.readFile("utf8")) as { schemaVersion?: number; product?: string; purpose?: string };
    return marker.schemaVersion === 1 && marker.product === "U-Claw" && marker.purpose === "rebuildable-cache";
  } catch { return false; } finally { await handle.close(); }
}

export function createReleaseService(options: ReleaseServiceOptions) {
  const runMutation = options.runMutation ?? ((operation) => operation());
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 15_000;
  let lastChannel = options.channel;
  let activeCheck: AbortController | undefined;
  let checked: { manifest: SignedReleaseManifest; previewToken: string } | undefined;
  let uninstallPreview: UninstallPreview | undefined;
  let rollbackPreview: { token: string; identity: UpdateIdentity } | undefined;
  let highestSequence = options.highestSequence ?? 0;
  let acceptedIdentity: UpdateIdentity | undefined;
  const operations = new Map<string, ReleaseOperation>();
  const operationSignals = new Map<string, AbortController>();
  const checkedAt = () => now().toISOString();
  const sequencePath = join(options.cacheRoot, ".uclaw-release-sequence.json");
  const exists = (path: string) => lstat(path).then(() => true, () => false);
  const installedPair = async (runtimePath: string, versionPath: string): Promise<RuntimeManifest | undefined> => {
    try {
      const text = await readFile(versionPath, "utf8");
      if (Buffer.byteLength(text) > 1_048_576) return undefined;
      const manifest = JSON.parse(text) as RuntimeManifest;
      if (!validRuntimeSignature(manifest, options, now())) return undefined;
      if (await hashRegularFile(runtimePath, manifest.runtimeBytes) !== manifest.runtimeSha256) return undefined;
      return manifest;
    } catch { return undefined; }
  };
  const loadSequence = async () => {
    const pathInfo = await lstat(sequencePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (pathInfo === undefined) return;
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.nlink !== 1 || pathInfo.size < 1 || pathInfo.size > 4096) {
      throw new Error("Release sequence record is invalid.");
    }
    let handle;
    try { handle = await open(sequencePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    let text: string;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > 4096) throw new Error("Release sequence record is invalid.");
      text = await handle.readFile("utf8");
    } finally { await handle.close(); }
    const value = JSON.parse(text) as { schemaVersion?: number; sequence?: number; runtimeSha256?: string; signatureValue?: string };
    const { schemaVersion, ...identity } = value;
    if (Object.keys(value).sort().join("\0") !== "runtimeSha256\0schemaVersion\0sequence\0signatureValue" || schemaVersion !== 1 || !validUpdateIdentity(identity)) throw new Error("Release sequence record is invalid.");
    if (identity.sequence >= highestSequence) { highestSequence = identity.sequence; acceptedIdentity = identity; }
  };
  const base = (state: ReleaseCheckResult["state"], extra: Partial<ReleaseCheckResult> = {}): ReleaseCheckResult => ({ state, checkedAt: checkedAt(), currentVersion: options.currentVersion, channel: lastChannel, ...extra });

  const check = async (channel: "stable" | "beta"): Promise<ReleaseCheckResult> => {
    lastChannel = channel; checked = undefined; activeCheck?.abort(new Error("cancelled"));
    if (options.configurationError) return base("unavailable", { retryable: false, message: options.configurationError });
    if (Object.keys(options.trustedKeys).length === 0) return base("unavailable", { retryable: false, message: "发布签名信任根未配置。" });
    const controller = new AbortController(); activeCheck = controller;
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs); timer.unref?.();
    try {
      await loadSequence();
      const manifest = await options.fetchManifest(channel, controller.signal);
      if (!validManifest(manifest, options, now(), highestSequence, acceptedIdentity, channel)) return base("unavailable", { retryable: false, message: "更新签名或兼容性验证失败。" });
      if (compareVersion(parseVersion(manifest.version)!, parseVersion(options.currentVersion)!) === 0) { highestSequence = manifest.sequence; acceptedIdentity = updateIdentity(manifest.runtimeManifest); return base("current"); }
      const previewToken = token(); checked = { manifest, previewToken };
      const update: ReleaseUpdate = { id: manifest.id, version: manifest.version, channel: manifest.channel, publishedAt: manifest.publishedAt, notes: manifest.notes, compatibility: manifest.compatibility, bytes: manifest.package.bytes, mandatory: manifest.mandatory, previewToken };
      return base("available", { update });
    } catch (error) {
      if (controller.signal.aborted) {
        return base(controller.signal.reason instanceof Error && controller.signal.reason.message === "timeout" ? "timeout" : "cancelled", { retryable: true, message: "更新检查已中止。" });
      }
      const code = (error as NodeJS.ErrnoException)?.code;
      return base(code === "ENETUNREACH" || code === "ENOTFOUND" || code === "ECONNREFUSED" ? "offline" : "unavailable", { retryable: true, message: "更新服务当前不可用。" });
    } finally { clearTimeout(timer); if (activeCheck === controller) activeCheck = undefined; }
  };

  const setOperation = (value: ReleaseOperation) => { operations.set(value.id, value); return value; };
  const install = (updateId: string, previewToken: string, confirmed: boolean): ReleaseOperation => {
    if (!confirmed || !checked || checked.manifest.id !== updateId || checked.previewToken !== previewToken) throw new Error("Update confirmation is stale.");
    const id = operationId(); const controller = new AbortController(); operationSignals.set(id, controller);
    const initial = setOperation({ id, kind: "install", state: "queued", phase: "queued", processedItems: 0, totalItems: 3, partialFailures: 0, message: "更新已排队。", recovery: "none" });
    const manifest = checked.manifest; checked = undefined;
    void runMutation(async () => {
      const staging = join(options.packageRoot, `.update-staging-${id}`); const stagedPackage = join(staging, "runtime.pkg"); const stagedManifest = join(staging, "version.json");
      const runtime = join(options.packageRoot, "runtime.pkg"); const version = join(options.packageRoot, "version.json");
      const runtimeRollback = join(options.packageRoot, "runtime.pkg.rollback"); const versionRollback = join(options.packageRoot, "version.json.rollback");
      const transaction = join(options.packageRoot, ".update-transaction.json");
      try {
        setOperation({ ...initial, state: "running", phase: "downloading", message: "正在下载到受控暂存区。" });
        if (options.secureInstall) {
          if (!validManifest(manifest, options, now(), highestSequence, acceptedIdentity, manifest.channel)) throw new Error("Update verification failed.");
          await options.secureInstall(manifest, controller.signal); controller.signal.throwIfAborted();
          setOperation({ ...operations.get(id)!, state: "completed", phase: "completed", processedItems: 3, message: "安全更新已安装，重启后完成验收。" });
          return;
        }
        const packageInfo = await lstat(options.packageRoot); if (!packageInfo.isDirectory() || packageInfo.isSymbolicLink()) throw new Error("Unsafe package root.");
        await mkdir(staging, { recursive: false, mode: 0o700 }); await options.download(manifest, stagedPackage, controller.signal); controller.signal.throwIfAborted();
        await writeJsonDurable(stagedManifest, manifest.runtimeManifest, true);
        setOperation({ ...operations.get(id)!, phase: "verifying", processedItems: 1, message: "正在验证签名与校验和。" });
        if (!validManifest(manifest, options, now(), highestSequence, acceptedIdentity, manifest.channel) || await hashRegularFile(stagedPackage, manifest.package.bytes) !== manifest.package.sha256) throw new Error("Update verification failed.");
        controller.signal.throwIfAborted();
        if (await lstat(transaction).then(() => true, () => false) || await lstat(runtimeRollback).then(() => true, () => false) || await lstat(versionRollback).then(() => true, () => false)) throw new Error("Update recovery is required before another install.");
        const runtimeExists = await lstat(runtime).then(() => true, () => false); const versionExists = await lstat(version).then(() => true, () => false);
        if (runtimeExists !== versionExists) throw new Error("Portable release is incomplete.");
        const previousManifest = runtimeExists ? await installedPair(runtime, version) : undefined;
        if (runtimeExists && !previousManifest) throw new Error("Active runtime is not eligible for rollback.");
        const record: UpdateTransaction = { schemaVersion: 1, state: "switching", target: updateIdentity(manifest.runtimeManifest), previous: previousManifest ? updateIdentity(previousManifest) : null };
        await writeJsonDurable(transaction, record, true);
        setOperation({ ...operations.get(id)!, phase: "switching", processedItems: 2, message: "正在原子切换 runtime。" });
        if (previousManifest) { await rename(runtime, runtimeRollback); await syncDirectory(options.packageRoot); await rename(version, versionRollback); await syncDirectory(options.packageRoot); }
        await rename(stagedPackage, runtime); await syncDirectory(options.packageRoot); await rename(stagedManifest, version); await syncDirectory(options.packageRoot);
        const activeManifest = await installedPair(runtime, version);
        if (!activeManifest || !validRuntimeManifest(activeManifest, manifest, options, now())) throw new Error("Installed update validation failed.");
        await writeJsonDurable(transaction, { ...record, state: "complete" });
        await rm(staging, { recursive: true, force: true });
        await syncDirectory(options.packageRoot);
        setOperation({ ...operations.get(id)!, state: "completed", phase: "completed", processedItems: 3, message: "安全更新已安装，重启后完成验收。" });
      } catch (error) {
        const cancelled = controller.signal.aborted;
        if (!options.secureInstall) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
        const recovery = await recover();
        setOperation({ ...operations.get(id)!, state: cancelled ? "cancelled" : "failed", phase: cancelled ? "cancelled" : "failed", message: cancelled ? "更新已取消。" : recovery.state === "recovery-required" ? "更新失败，需要恢复。" : "更新失败，已保留或回滚当前 runtime。", recovery: recovery.state === "rolled-back" ? "rolled-back" : recovery.state === "recovery-required" ? "recovery-required" : "none" });
      } finally { operationSignals.delete(id); }
    }).catch(() => {
      operationSignals.delete(id);
      setOperation({ ...operations.get(id)!, state: "failed", phase: "failed", message: "更新失败，runtime 当前不可写。" });
    });
    return initial;
  };

  const previewUninstall = async (): Promise<UninstallPreview> => {
    if (!await readOwnedCacheMarker(options.cacheRoot)) throw new Error("Host cache ownership could not be proven.");
    uninstallPreview = { previewToken: token(), scopes: [
      { id: "application", label: "U-Claw 应用", selected: false, protected: false, available: false, detail: "需由 Windows 受控卸载器移除；当前入口不执行。" },
      { id: "usb-user-data", label: "U 盘用户数据", selected: false, protected: true, available: false, detail: "默认永久保留，不属于卸载清理。" },
      { id: "host-cache", label: "本机 U-Claw 缓存", selected: true, protected: false, available: true, detail: "仅清理 marker 证明归属的 runtime、cache 与 updates。" },
    ] };
    return uninstallPreview;
  };

  const previewRollback = async () => {
    const rollback = await installedPair(join(options.packageRoot, "runtime.pkg.rollback"), join(options.packageRoot, "version.json.rollback"));
    const previewToken = token();
    rollbackPreview = rollback ? { token: previewToken, identity: updateIdentity(rollback) } : undefined;
    return rollback ? { available: true, previewToken, version: rollback.productVersion } : { available: false, previewToken };
  };

  const rollback = async (previewToken: string, confirmed: boolean) => {
    const preview = rollbackPreview;
    rollbackPreview = undefined;
    if (!confirmed || !preview || preview.token !== previewToken) throw new Error("Rollback confirmation is stale.");
    return runMutation(async () => {
      const runtime = join(options.packageRoot, "runtime.pkg"); const version = join(options.packageRoot, "version.json");
      const runtimeRollback = join(options.packageRoot, "runtime.pkg.rollback"); const versionRollback = join(options.packageRoot, "version.json.rollback");
      const previous = await installedPair(runtimeRollback, versionRollback);
      if (!previous || !sameUpdateIdentity(previous, preview.identity)) throw new Error("Rollback target changed after preview.");
      const active = await installedPair(runtime, version);
      if (!active) throw new Error("Active runtime is not eligible for rollback.");
      await options.beforeRollbackSwitch?.("before");
      const runtimeCurrent = join(options.packageRoot, "runtime.pkg.current"); const versionCurrent = join(options.packageRoot, "version.json.current");
      const rollbackTransaction = join(options.packageRoot, ".rollback-transaction.json");
      const rollbackRecord: RollbackTransaction = { schemaVersion: 1, stage: "prepared", active: updateIdentity(active), target: preview.identity };
      let activeRuntimeMoved = false; let activeVersionMoved = false; let rollbackRuntimeMoved = false; let rollbackVersionMoved = false;
      try {
        await writeJsonDurable(rollbackTransaction, rollbackRecord, true);
        await rename(runtime, runtimeCurrent); activeRuntimeMoved = true; await syncDirectory(options.packageRoot); await writeJsonDurable(rollbackTransaction, { ...rollbackRecord, stage: "active-runtime-moved" }); await options.beforeRollbackSwitch?.("active-runtime-moved");
        await rename(version, versionCurrent); activeVersionMoved = true; await syncDirectory(options.packageRoot); await writeJsonDurable(rollbackTransaction, { ...rollbackRecord, stage: "active-version-moved" }); await options.beforeRollbackSwitch?.("active-version-moved");
        await rename(runtimeRollback, runtime); rollbackRuntimeMoved = true; await syncDirectory(options.packageRoot); await writeJsonDurable(rollbackTransaction, { ...rollbackRecord, stage: "rollback-runtime-moved" }); await options.beforeRollbackSwitch?.("rollback-runtime-moved");
        await rename(versionRollback, version); rollbackVersionMoved = true; await syncDirectory(options.packageRoot); await writeJsonDurable(rollbackTransaction, { ...rollbackRecord, stage: "rollback-version-moved" }); await options.beforeRollbackSwitch?.("rollback-version-moved");
        const readback = await installedPair(runtime, version);
        if (!readback || !sameUpdateIdentity(readback, preview.identity)) throw new Error("Rollback readback failed.");
        await rename(runtimeCurrent, runtimeRollback); await rename(versionCurrent, versionRollback); await syncDirectory(options.packageRoot);
        await rm(rollbackTransaction, { force: true }); await syncDirectory(options.packageRoot);
        return { state: "rolled-back" as const, version: readback.productVersion, message: "已切换到上一已验证版本。" };
      } catch (error) {
        if (rollbackVersionMoved) await rename(version, versionRollback).catch(() => undefined);
        if (rollbackRuntimeMoved) await rename(runtime, runtimeRollback).catch(() => undefined);
        if (activeVersionMoved) await rename(versionCurrent, version).catch(() => undefined);
        if (activeRuntimeMoved) await rename(runtimeCurrent, runtime).catch(() => undefined);
        await syncDirectory(options.packageRoot).catch(() => undefined);
        const [activeReadback, rollbackReadback] = await Promise.all([installedPair(runtime, version), installedPair(runtimeRollback, versionRollback)]);
        if (!activeReadback || !sameUpdateIdentity(activeReadback, updateIdentity(active)) || !rollbackReadback || !sameUpdateIdentity(rollbackReadback, preview.identity)) throw new Error("Rollback recovery failed.");
        await rm(rollbackTransaction, { force: true }); await syncDirectory(options.packageRoot);
        throw error;
      }
    });
  };

  const executeUninstall = (scopeIds: readonly "host-cache"[], previewToken: string, confirmed: boolean): ReleaseOperation => {
    if (!confirmed || !uninstallPreview || uninstallPreview.previewToken !== previewToken || scopeIds.length !== 1 || scopeIds[0] !== "host-cache") throw new Error("Uninstall confirmation is stale.");
    uninstallPreview = undefined; const id = operationId();
    const initial = setOperation({ id, kind: "uninstall", state: "queued", phase: "queued", processedItems: 0, totalItems: 3, partialFailures: 0, message: "缓存清理已排队。", recovery: "none" });
    void runMutation(async () => {
      let processed = 0; let failures = 0;
      setOperation({ ...initial, state: "running", phase: "cleaning", message: "正在清理本机 U-Claw 自有缓存。" });
      if (!await readOwnedCacheMarker(options.cacheRoot)) {
        setOperation({ ...operations.get(id)!, state: "failed", phase: "failed", message: "缓存归属已变化，清理已拒绝。" });
        return;
      }
      for (const child of ["runtime", "cache", "updates"] as const) {
        try {
          if (options.secureCleanup) await options.secureCleanup(child);
          else {
            const path = join(options.cacheRoot, child); const quarantine = join(options.cacheRoot, `.uclaw-cleanup-${id}-${child}`);
            const info = await lstat(path).catch(() => undefined); if (!info) { processed += 1; continue; }
            if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Unknown cache target rejected.");
            await rename(path, quarantine); const moved = await lstat(quarantine);
            if (moved.isSymbolicLink() || !moved.isDirectory()) { await rename(quarantine, path).catch(() => undefined); throw new Error("Changed cache target rejected."); }
            await rm(quarantine, { recursive: true, force: true });
          }
        } catch { failures += 1; }
        processed += 1; setOperation({ ...operations.get(id)!, processedItems: processed, partialFailures: failures });
      }
      setOperation({ ...operations.get(id)!, state: "completed", phase: "completed", processedItems: processed, partialFailures: failures, message: failures ? "缓存清理完成，部分项目失败。" : "本机 U-Claw 缓存已清理。" });
    }).catch(() => {
      setOperation({ ...operations.get(id)!, state: "failed", phase: "failed", message: "缓存清理失败，runtime 当前不可写。" });
    });
    return initial;
  };

  const recover = async () => {
    const transaction = join(options.packageRoot, ".update-transaction.json");
    const rollbackTransaction = join(options.packageRoot, ".rollback-transaction.json");
    if (await exists(rollbackTransaction)) {
      let record: RollbackTransaction;
      try {
        const raw = JSON.parse(await readFile(rollbackTransaction, "utf8")) as Record<string, unknown>;
        const stages: RollbackStage[] = ["prepared", "active-runtime-moved", "active-version-moved", "rollback-runtime-moved", "rollback-version-moved"];
        if (Object.keys(raw).sort().join("\0") !== "active\0schemaVersion\0stage\0target" || raw.schemaVersion !== 1 || !stages.includes(raw.stage as RollbackStage) || !validUpdateIdentity(raw.active) || !validUpdateIdentity(raw.target)) throw new Error("invalid rollback transaction");
        record = raw as unknown as RollbackTransaction;
      } catch { return { state: "recovery-required" as const, message: "回滚事务记录损坏，需要恢复。" }; }
      const runtime = join(options.packageRoot, "runtime.pkg"); const version = join(options.packageRoot, "version.json");
      const runtimeRollback = join(options.packageRoot, "runtime.pkg.rollback"); const versionRollback = join(options.packageRoot, "version.json.rollback");
      const runtimeCurrent = join(options.packageRoot, "runtime.pkg.current"); const versionCurrent = join(options.packageRoot, "version.json.current");
      const activeRuntimeRecovery = join(options.packageRoot, "runtime.pkg.active-recovery"); const activeVersionRecovery = join(options.packageRoot, "version.json.active-recovery");
      const targetRuntimeRecovery = join(options.packageRoot, "runtime.pkg.target-recovery"); const targetVersionRecovery = join(options.packageRoot, "version.json.target-recovery");
      const runtimeCandidates = [runtime, runtimeRollback, runtimeCurrent, activeRuntimeRecovery, targetRuntimeRecovery];
      const versionCandidates = [version, versionRollback, versionCurrent, activeVersionRecovery, targetVersionRecovery];
      const findPair = async (identity: UpdateIdentity) => {
        for (const runtimePath of runtimeCandidates) for (const versionPath of versionCandidates) {
          const candidate = await installedPair(runtimePath, versionPath);
          if (candidate && sameUpdateIdentity(candidate, identity)) return { runtimePath, versionPath };
        }
        return undefined;
      };
      try {
        const activeSource = await findPair(record.active); const targetSource = await findPair(record.target);
        if (!activeSource || !targetSource) throw new Error("Rollback source missing.");
        for (const path of [activeRuntimeRecovery, activeVersionRecovery, targetRuntimeRecovery, targetVersionRecovery]) await rm(path, { force: true });
        await copyFile(activeSource.runtimePath, activeRuntimeRecovery, constants.COPYFILE_EXCL); await syncFile(activeRuntimeRecovery);
        await copyFile(activeSource.versionPath, activeVersionRecovery, constants.COPYFILE_EXCL); await syncFile(activeVersionRecovery);
        await copyFile(targetSource.runtimePath, targetRuntimeRecovery, constants.COPYFILE_EXCL); await syncFile(targetRuntimeRecovery);
        await copyFile(targetSource.versionPath, targetVersionRecovery, constants.COPYFILE_EXCL); await syncFile(targetVersionRecovery); await syncDirectory(options.packageRoot);
        const [activeCopy, targetCopy] = await Promise.all([installedPair(activeRuntimeRecovery, activeVersionRecovery), installedPair(targetRuntimeRecovery, targetVersionRecovery)]);
        if (!activeCopy || !sameUpdateIdentity(activeCopy, record.active) || !targetCopy || !sameUpdateIdentity(targetCopy, record.target)) throw new Error("Rollback recovery copy invalid.");
        await rm(runtime, { force: true }); await rename(activeRuntimeRecovery, runtime); await syncDirectory(options.packageRoot);
        await rm(version, { force: true }); await rename(activeVersionRecovery, version); await syncDirectory(options.packageRoot);
        await rm(runtimeRollback, { force: true }); await rename(targetRuntimeRecovery, runtimeRollback); await syncDirectory(options.packageRoot);
        await rm(versionRollback, { force: true }); await rename(targetVersionRecovery, versionRollback); await syncDirectory(options.packageRoot);
        const [activeReadback, targetReadback] = await Promise.all([installedPair(runtime, version), installedPair(runtimeRollback, versionRollback)]);
        if (!activeReadback || !sameUpdateIdentity(activeReadback, record.active) || !targetReadback || !sameUpdateIdentity(targetReadback, record.target)) throw new Error("Rollback recovery readback invalid.");
        await rm(runtimeCurrent, { force: true }); await rm(versionCurrent, { force: true }); await rm(rollbackTransaction, { force: true }); await syncDirectory(options.packageRoot);
        return { state: "rolled-back" as const, message: "检测到中断回滚，已恢复原版本对。" };
      } catch { return { state: "recovery-required" as const, message: "中断回滚自动恢复失败，需要恢复。" }; }
    }
    if (!await exists(transaction)) return { state: "clean" as const, message: "无待恢复更新。" };
    let record: UpdateTransaction;
    try {
      const raw = JSON.parse(await readFile(transaction, "utf8")) as Record<string, unknown>;
      if (Object.keys(raw).sort().join("\0") !== "previous\0schemaVersion\0state\0target" || raw.schemaVersion !== 1 || !["switching", "complete"].includes(raw.state as string) || !validUpdateIdentity(raw.target) || (raw.previous !== null && !validUpdateIdentity(raw.previous))) throw new Error("invalid transaction");
      record = raw as unknown as UpdateTransaction;
    } catch { return { state: "recovery-required" as const, message: "更新事务记录损坏，需要恢复。" }; }
    const runtime = join(options.packageRoot, "runtime.pkg"); const version = join(options.packageRoot, "version.json");
    const runtimeRollback = join(options.packageRoot, "runtime.pkg.rollback"); const versionRollback = join(options.packageRoot, "version.json.rollback");
    const runtimeRecovery = join(options.packageRoot, "runtime.pkg.recovery"); const versionRecovery = join(options.packageRoot, "version.json.recovery");
    const activeManifest = await installedPair(runtime, version);
    if (activeManifest && sameUpdateIdentity(activeManifest, record.target)) {
      if (record.state === "switching") await writeJsonDurable(transaction, { ...record, state: "complete" });
      return { state: "clean" as const, message: "更新已切换，等待 Launcher 验收。" };
    }
    if (!record.previous) {
      return { state: "recovery-required" as const, message: "更新中断且无可用回滚版本。" };
    }
    const runtimes = [runtimeRollback, runtimeRecovery, runtime]; const versions = [versionRollback, versionRecovery, version];
    let source: { runtime: string; version: string } | undefined;
    for (const runtimeCandidate of runtimes) {
      for (const versionCandidate of versions) {
        const candidate = await installedPair(runtimeCandidate, versionCandidate);
        if (candidate && sameUpdateIdentity(candidate, record.previous)) { source = { runtime: runtimeCandidate, version: versionCandidate }; break; }
      }
      if (source) break;
    }
    if (!source) return { state: "recovery-required" as const, message: "自动回滚失败，需要恢复。" };
    try {
      if (source.runtime !== runtimeRecovery) { await rm(runtimeRecovery, { force: true }); await copyFile(source.runtime, runtimeRecovery, constants.COPYFILE_EXCL); await syncFile(runtimeRecovery); }
      if (source.version !== versionRecovery) { await rm(versionRecovery, { force: true }); await copyFile(source.version, versionRecovery, constants.COPYFILE_EXCL); await syncFile(versionRecovery); }
      await syncDirectory(options.packageRoot);
      const recoveryManifest = await installedPair(runtimeRecovery, versionRecovery);
      if (!recoveryManifest || !sameUpdateIdentity(recoveryManifest, record.previous)) throw new Error("Recovery copy validation failed.");
      await rm(runtime, { force: true }); await rename(runtimeRecovery, runtime); await syncDirectory(options.packageRoot);
      await rm(version, { force: true }); await rename(versionRecovery, version); await syncDirectory(options.packageRoot);
      const restoredManifest = await installedPair(runtime, version);
      if (!restoredManifest || !sameUpdateIdentity(restoredManifest, record.previous)) throw new Error("Recovered pair validation failed.");
      await rm(runtimeRollback, { force: true }); await rm(versionRollback, { force: true }); await rm(transaction, { force: true }); await syncDirectory(options.packageRoot);
      return { state: "rolled-back" as const, message: "检测到中断更新，已回滚。" };
    } catch { return { state: "recovery-required" as const, message: "自动回滚失败，需要恢复。" }; }
  };

  return {
    check, retry: () => check(lastChannel), cancelCheck: () => { activeCheck?.abort(new Error("cancelled")); return base("cancelled", { retryable: true, message: "更新检查已取消。" }); },
    install, previewRollback, rollback, previewUninstall, executeUninstall, recover,
    operation: (id: string) => operations.get(id), cancel: (id: string) => { operationSignals.get(id)?.abort(new Error("cancelled")); return operations.get(id); },
    wait: async (id: string) => { while (["queued", "running"].includes(operations.get(id)?.state ?? "")) await new Promise((resolve) => setTimeout(resolve, 2)); return operations.get(id); },
  };
}
export type ReleaseService = ReturnType<typeof createReleaseService>;
