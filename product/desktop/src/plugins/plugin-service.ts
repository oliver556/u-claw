import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

import {
  LOCKED_OPENCLAW_VERSION,
  PluginDetailSchema,
  UClawErrorSchema,
  type CapabilityRisk,
  type PluginCatalogItem,
  type PluginConfirmation,
  type PluginDetail,
  type PluginOperation,
} from "@uclaw/shared";
import { z } from "zod";

import { validatePluginBundle } from "./bundle-validator.js";
import type { PluginRegistryClient } from "./fixture-client.js";
import type { PluginRuntimeAdapter, RuntimePluginRecord } from "./runtime-adapter.js";

const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/);
const InstalledRecordSchema = z.object({
  packageKind: z.literal("plugin"),
  slug: SlugSchema,
  version: z.string().min(1).max(80),
  enabled: z.boolean(),
  detail: PluginDetailSchema,
  packageFiles: z.array(z.object({
    path: z.string().min(1).max(500),
    size: z.number().int().min(0).max(5 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).min(1).max(1_000),
}).strict();
type InstalledRecord = z.infer<typeof InstalledRecordSchema>;
const PluginStateSchema = z.object({
  schemaVersion: z.literal(1),
  packageKind: z.literal("plugin"),
  installed: z.record(SlugSchema, InstalledRecordSchema),
}).strict();
type PluginState = z.infer<typeof PluginStateSchema>;
const JournalSchema = z.object({
  operationId: z.uuid(),
  slug: SlugSchema,
  action: z.enum(["replace", "remove", "metadata"]),
  phase: z.enum(["staged", "runtime-starting", "runtime-committed", "committed"]),
  previousRecord: InstalledRecordSchema.nullable(),
  nextRecord: InstalledRecordSchema.nullable(),
  previousEnabled: z.boolean().nullable(),
  nextEnabled: z.boolean().nullable(),
}).strict();
type Journal = z.infer<typeof JournalSchema>;

export interface PluginMutationInput { slug: string; confirmation: PluginConfirmation | null }
export interface PluginService {
  search(input: { query: string; cursor: string | null; pageSize: number }): Promise<{ items: PluginCatalogItem[]; nextCursor: string | null; hasMore: boolean; mode: "fixture" | "live"; repositoryVerified: boolean }>;
  detail(slug: string): Promise<PluginDetail>;
  installed(): Promise<PluginCatalogItem[]>;
  startInstall(input: PluginMutationInput): Promise<PluginOperation>;
  startUpdate(input: PluginMutationInput): Promise<PluginOperation>;
  startUninstall(slug: string): Promise<PluginOperation>;
  setEnabled(input: PluginMutationInput & { enabled: boolean }): Promise<PluginOperation>;
  operation(id: string): Promise<PluginOperation>;
  waitForOperation(id: string): Promise<PluginOperation>;
}

const riskOrder: CapabilityRisk[] = ["low", "medium", "high", "critical"];
const emptyState = (): PluginState => ({ schemaVersion: 1, packageKind: "plugin", installed: {} });

function domainError(code: "CONFIRMATION_REQUIRED" | "NOT_FOUND" | "CONFLICT" | "UNAVAILABLE", message: string) {
  return UClawErrorSchema.parse({ code, message, retryable: false, recoveryActions: [], causeDetails: {} });
}

async function readState(path: string): Promise<PluginState> {
  try { return PluginStateSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState(); throw error; }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!new Set(["EINVAL", "ENOTSUP", "EISDIR", "EPERM"]).has(code ?? "")) throw error;
  } finally {
    await handle?.close();
  }
}

async function durableRename(from: string, to: string): Promise<void> {
  await rename(from, to);
  await syncDirectory(dirname(to));
}

async function durableRemove(path: string, recursive = false): Promise<void> {
  await rm(path, { recursive, force: true });
  await syncDirectory(dirname(path));
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await durableRename(temporary, path);
}

async function writeDurableFile(path: string, content: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

function replaceStateRecord(state: PluginState, slug: string, record: InstalledRecord | null): PluginState {
  const installed = { ...state.installed };
  if (record) installed[slug] = record;
  else delete installed[slug];
  return PluginStateSchema.parse({ ...state, installed });
}

function runtimeMap(records: RuntimePluginRecord[]): Map<string, RuntimePluginRecord> {
  return new Map(records.map((record) => [record.slug, record]));
}

function isWithin(root: string, child: string): boolean {
  const value = relative(root, child);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

async function ensureSafeDirectory(root: string, target: string): Promise<void> {
  const relativeTarget = relative(root, target);
  if (relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) throw new Error("Plugin storage path escapes data root.");
  let current = root;
  for (const segment of relativeTarget.split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    await mkdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Plugin storage contains an unsafe directory link.");
  }
  if (!isWithin(await realpath(root), await realpath(target))) throw new Error("Plugin storage path escapes data root.");
}

function packagePath(packageDir: string, record: InstalledRecord): string {
  return join(packageDir, record.slug, record.detail.integritySha256);
}

async function verifyRetainedPackage(packageDir: string, record: InstalledRecord): Promise<string> {
  const root = packagePath(packageDir, record);
  const resolvedPackageDir = await realpath(packageDir);
  const resolvedRoot = await realpath(root);
  if (!isWithin(resolvedPackageDir, resolvedRoot)) throw new Error("Retained Plugin package escapes package storage.");
  const expected = new Map(record.packageFiles.map((file) => [file.path, file]));
  const seen = new Set<string>();
  const visit = async (directory: string, prefix = ""): Promise<void> => {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
      const path = join(directory, child.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error("Retained Plugin package contains a symbolic link.");
      if (info.isDirectory()) {
        await visit(path, relativePath);
        continue;
      }
      const manifest = expected.get(relativePath);
      if (!info.isFile() || info.nlink !== 1 || !manifest || info.size !== manifest.size) {
        throw new Error("Retained Plugin package inventory mismatch.");
      }
      const content = await readFile(path);
      if (createHash("sha256").update(content).digest("hex") !== manifest.sha256) {
        throw new Error("Retained Plugin package checksum mismatch.");
      }
      seen.add(relativePath);
    }
  };
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Retained Plugin package root is unsafe.");
  await visit(root);
  if (seen.size !== expected.size) throw new Error("Retained Plugin package is incomplete.");
  return root;
}

async function applyJournalRuntime(input: {
  journal: Journal;
  rollForward: boolean;
  packageDir: string;
  runtime: PluginRuntimeAdapter;
}): Promise<InstalledRecord | null> {
  const { journal, rollForward, packageDir, runtime } = input;
  const desiredRecord = rollForward ? journal.nextRecord : journal.previousRecord;
  const desiredEnabled = rollForward ? journal.nextEnabled : journal.previousEnabled;
  if (journal.action === "metadata") {
    if (desiredEnabled === null) throw new Error("Plugin enablement journal is incomplete.");
    await runtime.setEnabled(journal.slug, desiredEnabled);
  } else if (desiredRecord) {
    const sourceDir = await verifyRetainedPackage(packageDir, desiredRecord);
    await runtime.installFromPath({ sourceDir, slug: journal.slug });
    await runtime.setEnabled(journal.slug, desiredRecord.enabled);
  } else {
    const actual = (await runtime.installed()).find((record) => record.slug === journal.slug);
    if (actual && actual.origin !== "bundled") await runtime.uninstall(journal.slug);
  }
  const actual = (await runtime.installed()).find((record) => record.slug === journal.slug);
  if (desiredRecord || journal.action === "metadata") {
    const expectedVersion = desiredRecord?.version;
    if (!actual || (expectedVersion !== undefined && actual.version !== expectedVersion) || actual.enabled !== desiredEnabled) {
      throw new Error("OpenClaw Plugin runtime recovery state mismatch.");
    }
  } else if (actual && actual.origin !== "bundled") {
    throw new Error("OpenClaw Plugin runtime recovery did not remove Plugin.");
  }
  return desiredRecord;
}

async function recoverTransactions(input: {
  transactionDir: string;
  stagingDir: string;
  packageDir: string;
  statePath: string;
  runtime: PluginRuntimeAdapter;
}): Promise<PluginState> {
  let state = await readState(input.statePath);
  const names = await readdir(input.transactionDir).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const journalPath = join(input.transactionDir, name);
    let journal: Journal;
    try { journal = JournalSchema.parse(JSON.parse(await readFile(journalPath, "utf8")) as unknown); }
    catch {
      await durableRename(journalPath, `${journalPath}.invalid-${randomUUID()}`);
      continue;
    }
    if (name !== `${journal.operationId}.json`) {
      await durableRename(journalPath, `${journalPath}.invalid-${randomUUID()}`);
      continue;
    }
    const rollForward = journal.phase === "runtime-committed" || journal.phase === "committed";
    const record = journal.phase === "staged"
      ? journal.previousRecord
      : await applyJournalRuntime({ journal, rollForward, packageDir: input.packageDir, runtime: input.runtime });
    state = replaceStateRecord(state, journal.slug, record);
    await writeJsonAtomic(input.statePath, state);
    await durableRemove(join(input.stagingDir, journal.operationId), true);
    await durableRemove(journalPath);
  }
  return state;
}

export async function createPluginService({
  dataDir,
  client,
  runtime,
}: {
  dataDir: string;
  client: PluginRegistryClient;
  runtime: PluginRuntimeAdapter;
}): Promise<PluginService> {
  const capabilityDir = join(dataDir, "capabilities");
  const transactionDir = join(capabilityDir, ".plugin-transactions");
  const stagingDir = join(capabilityDir, ".plugin-staging");
  const packageDir = join(capabilityDir, "plugin-packages");
  const statePath = join(capabilityDir, "plugin-state.json");
  await mkdir(dataDir, { recursive: true });
  await ensureSafeDirectory(dataDir, capabilityDir);
  await ensureSafeDirectory(dataDir, transactionDir);
  await ensureSafeDirectory(dataDir, stagingDir);
  await ensureSafeDirectory(dataDir, packageDir);
  let state = await recoverTransactions({ transactionDir, stagingDir, packageDir, statePath, runtime });
  let runtimeRecords = runtimeMap(await runtime.installed());
  let reconciledState = state;
  for (const record of Object.values(state.installed)) {
    const actual = runtimeRecords.get(record.slug);
    if (!actual) {
      reconciledState = replaceStateRecord(reconciledState, record.slug, null);
    } else if (actual.enabled !== record.enabled) {
      reconciledState = replaceStateRecord(reconciledState, record.slug, {
        ...record,
        enabled: actual.enabled,
      });
    }
  }
  if (JSON.stringify(reconciledState) !== JSON.stringify(state)) {
    state = reconciledState;
    await writeJsonAtomic(statePath, state);
  }
  const operations = new Map<string, PluginOperation>();
  const tasks = new Map<string, Promise<void>>();
  let lifecycleTail: Promise<void> = Promise.resolve();

  const normalize = (detail: PluginDetail): PluginDetail => {
    const risk = detail.permissions.reduce<CapabilityRisk>((highest, permission) =>
      riskOrder.indexOf(permission.risk) > riskOrder.indexOf(highest) ? permission.risk : highest, "low");
    const elevatedRisk: CapabilityRisk = detail.nativeCode || detail.commandExecution
      ? riskOrder.indexOf(risk) < riskOrder.indexOf("high") ? "high" : risk
      : risk;
    return {
      ...detail,
      packageKind: "plugin",
      risk: elevatedRisk,
      permissionFingerprint: createHash("sha256").update(JSON.stringify(detail.permissions)).digest("hex"),
    };
  };
  const project = (detail: PluginDetail): PluginCatalogItem => {
    const normalized = normalize(detail);
    const managed = state.installed[detail.slug];
    const actual = runtimeRecords.get(detail.slug);
    const { manifest: _manifest, ...catalogItem } = normalized;
    return {
      ...catalogItem,
      installedVersion: actual?.version ?? managed?.version ?? null,
      enabled: actual?.enabled ?? false,
      updateAvailable: actual !== undefined && actual.version !== normalized.version,
      availability: actual ? "available" : normalized.availability,
      integrityVerified: normalized.integrityVerified,
      managedByUClaw: managed !== undefined,
    };
  };
  const loadRemoteDetail = async (slug: string): Promise<PluginDetail> => {
    const parsed = PluginDetailSchema.parse(await client.detail(slug).catch(() => { throw domainError("NOT_FOUND", "Plugin not found."); }));
    return { ...normalize(parsed), ...project(parsed) };
  };
  const loadDetail = async (slug: string): Promise<PluginDetail> => {
    const actual = runtimeRecords.get(slug);
    if (actual && !state.installed[slug]) return fallbackDetail(actual);
    try { return await loadRemoteDetail(slug); }
    catch (error) {
      const snapshot = state.installed[slug]?.detail;
      if (snapshot) return { ...normalize(snapshot), ...project(snapshot) };
      throw error;
    }
  };
  const fallbackDetail = (record: RuntimePluginRecord): PluginDetail => ({
    packageKind: "plugin",
    slug: record.slug,
    name: record.name,
    description: record.description,
    version: record.version,
    installedVersion: record.version,
    enabled: record.enabled,
    updateAvailable: false,
    source: { provider: record.origin === "bundled" ? "bundled" : "external", url: "https://openclaw.ai/", packaged: true },
    integritySha256: createHash("sha256").update(JSON.stringify(record)).digest("hex"),
    integrityVerified: false,
    managedByUClaw: false,
    availability: "available",
    compatibility: { state: "unknown", openClawVersion: LOCKED_OPENCLAW_VERSION, reason: "Runtime reports this Plugin, but its manifest, integrity, permissions, and compatibility are not verified by U-Claw." },
    permissions: [],
    permissionFingerprint: createHash("sha256").update("[]").digest("hex"),
    risk: "high",
    nativeCode: false,
    commandExecution: false,
    mode: "live",
    manifest: null,
  });
  const fallbackCatalogItem = (record: RuntimePluginRecord): PluginCatalogItem => {
    const { manifest: _manifest, ...item } = fallbackDetail(record);
    return item;
  };
  const confirm = (detail: Pick<PluginCatalogItem, "permissionFingerprint" | "risk">, confirmation: PluginConfirmation | null): void => {
    if (!confirmation || confirmation.permissionFingerprint !== detail.permissionFingerprint ||
      riskOrder.indexOf(confirmation.acceptedRisk) < riskOrder.indexOf(detail.risk)) {
      throw domainError("CONFIRMATION_REQUIRED", "Plugin permissions and execution risk require explicit confirmation.");
    }
  };
  const ensureInstallable = (detail: PluginDetail): void => {
    if (!detail.manifest || !detail.integrityVerified) throw domainError("UNAVAILABLE", "Plugin package metadata or integrity is not verified.");
    if (!detail.source.packaged || detail.availability === "unpackaged") throw domainError("UNAVAILABLE", "Plugin is not packaged in the current portable runtime.");
    if (detail.compatibility.state !== "compatible" || detail.availability === "incompatible") throw domainError("UNAVAILABLE", "Plugin is incompatible with locked OpenClaw runtime.");
  };
  const updateOperation = (id: string, patch: Partial<PluginOperation>) => {
    const current = operations.get(id);
    if (current) operations.set(id, { ...current, ...patch });
  };
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const running = lifecycleTail.then(task, task);
    lifecycleTail = running.catch(() => undefined);
    return running;
  };
  const start = (slug: string, action: PluginOperation["action"], task: (id: string) => Promise<void>): PluginOperation => {
    const operation: PluginOperation = { id: randomUUID(), slug, action, state: "queued", progress: 0, phase: "queued" };
    operations.set(operation.id, operation);
    const running = enqueue(async () => {
      updateOperation(operation.id, { state: "running", progress: 5, phase: "downloading" });
      try {
        await task(operation.id);
        updateOperation(operation.id, { state: "succeeded", progress: 100, phase: "complete" });
      } catch {
        updateOperation(operation.id, { state: "failed", phase: "failed", error: "Plugin operation failed. Retry or restart U-Claw for recovery." });
      }
    });
    tasks.set(operation.id, running);
    void running.finally(() => tasks.delete(operation.id));
    return operation;
  };
  const saveJournal = async (journal: Journal) => writeJsonAtomic(join(transactionDir, `${journal.operationId}.json`), JournalSchema.parse(journal));
  const finishJournal = async (journal: Journal) => {
    await durableRemove(join(stagingDir, journal.operationId), true);
    await durableRemove(join(transactionDir, `${journal.operationId}.json`));
  };
  const retainPackage = async (stage: string, record: InstalledRecord): Promise<string> => {
    const target = packagePath(packageDir, record);
    await ensureSafeDirectory(packageDir, dirname(target));
    try { await durableRename(stage, target); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!new Set(["EEXIST", "ENOTEMPTY"]).has(code ?? "")) throw error;
      try {
        await verifyRetainedPackage(packageDir, record);
        await durableRemove(stage, true);
      } catch {
        await durableRemove(target, true);
        await durableRename(stage, target);
      }
    }
    return verifyRetainedPackage(packageDir, record);
  };

  const installOrUpdate = async (detail: PluginDetail, action: "install" | "update", operationId: string): Promise<void> => {
    runtimeRecords = runtimeMap(await runtime.installed());
    const actual = runtimeRecords.get(detail.slug);
    const previousRecord = state.installed[detail.slug] ?? null;
    if (action === "install" && actual) throw domainError("CONFLICT", "Plugin is already installed.");
    if (action === "update" && (!actual || !previousRecord || actual.origin === "bundled")) {
      throw domainError("NOT_FOUND", "Installed Plugin not found.");
    }
    const bundle = await client.download(detail.slug);
    updateOperation(operationId, { progress: 25, phase: "validating" });
    const validated = validatePluginBundle(bundle, detail);
    const stage = join(stagingDir, operationId);
    await durableRemove(stage, true);
    await mkdir(stage, { recursive: true });
    updateOperation(operationId, { progress: 50, phase: "staging" });
    for (const file of validated.files) await writeDurableFile(join(stage, ...file.path.split("/")), file.content);
    await syncDirectory(stage);
    const nextRecord = InstalledRecordSchema.parse({
      packageKind: "plugin",
      slug: detail.slug,
      version: detail.version,
      enabled: previousRecord?.enabled ?? true,
      detail,
      packageFiles: validated.files.map((file) => ({
        path: file.path,
        size: file.content.byteLength,
        sha256: createHash("sha256").update(file.content).digest("hex"),
      })),
    });
    const retainedPackage = await retainPackage(stage, nextRecord);
    let journal: Journal = {
      operationId,
      slug: detail.slug,
      action: "replace",
      phase: "staged",
      previousRecord,
      nextRecord,
      previousEnabled: previousRecord?.enabled ?? null,
      nextEnabled: nextRecord.enabled,
    };
    await saveJournal(journal);
    let leaveForRecovery = false;
    try {
      journal = { ...journal, phase: "runtime-starting" };
      await saveJournal(journal);
      if (client.failAfterBackup) { leaveForRecovery = true; throw new Error("Simulated interrupted Plugin runtime commit."); }
      updateOperation(operationId, { progress: 75, phase: "replacing" });
      await runtime.installFromPath({ sourceDir: retainedPackage, slug: detail.slug });
      await runtime.setEnabled(detail.slug, nextRecord.enabled);
      if (client.failAfterRuntimeInstall) { leaveForRecovery = true; throw new Error("Simulated power loss after Plugin runtime install."); }
      runtimeRecords = runtimeMap(await runtime.installed());
      const committed = runtimeRecords.get(detail.slug);
      if (!committed || committed.version !== detail.version) throw new Error("OpenClaw Plugin runtime state mismatch.");
      journal = { ...journal, phase: "runtime-committed", nextRecord: { ...nextRecord, enabled: committed.enabled } };
      await saveJournal(journal);
      if (client.failAtPhase === "replaced") { leaveForRecovery = true; throw new Error("Simulated interrupted U-Claw state commit."); }
      state = replaceStateRecord(state, detail.slug, journal.nextRecord);
      updateOperation(operationId, { progress: 90, phase: "persisting" });
      await writeJsonAtomic(statePath, state);
      journal = { ...journal, phase: "committed" };
      await saveJournal(journal);
      await finishJournal(journal).catch(() => undefined);
    } catch (error) {
      if (!leaveForRecovery) {
        const recovered = await applyJournalRuntime({ journal, rollForward: false, packageDir, runtime });
        state = replaceStateRecord(state, detail.slug, recovered);
        await writeJsonAtomic(statePath, state);
        await finishJournal(journal).catch(() => undefined);
      }
      throw error;
    }
  };

  return {
    async search(input) {
      runtimeRecords = runtimeMap(await runtime.installed());
      const page = await client.search(input);
      return { ...page, items: page.items.map((item) => project(PluginDetailSchema.parse(item))) };
    },
    detail: loadDetail,
    async installed() {
      const records = await runtime.installed();
      runtimeRecords = runtimeMap(records);
      return records.map((record) => {
        const snapshot = state.installed[record.slug]?.detail;
        if (snapshot) return project(snapshot);
        return fallbackCatalogItem(record);
      });
    },
    async startInstall(input) {
      const detail = await loadRemoteDetail(input.slug);
      ensureInstallable(detail);
      confirm(detail, input.confirmation);
      return start(input.slug, "install", (id) => installOrUpdate(detail, "install", id));
    },
    async startUpdate(input) {
      runtimeRecords = runtimeMap(await runtime.installed());
      const actual = runtimeRecords.get(input.slug);
      if (!actual || !state.installed[input.slug] || actual.origin === "bundled") {
        throw domainError("NOT_FOUND", "Installed Plugin not found.");
      }
      const detail = await loadRemoteDetail(input.slug);
      ensureInstallable(detail);
      confirm(detail, input.confirmation);
      return start(input.slug, "update", (id) => installOrUpdate(detail, "update", id));
    },
    async startUninstall(slug) {
      SlugSchema.parse(slug);
      return start(slug, "uninstall", async (id) => {
        runtimeRecords = runtimeMap(await runtime.installed());
        const previousRecord = state.installed[slug];
        const actual = runtimeRecords.get(slug);
        if (!actual || !previousRecord || actual.origin === "bundled") throw domainError("NOT_FOUND", "Installed Plugin not found.");
        let journal: Journal = {
          operationId: id,
          slug,
          action: "remove",
          phase: "staged",
          previousRecord,
          nextRecord: null,
          previousEnabled: previousRecord.enabled,
          nextEnabled: null,
        };
        await saveJournal(journal);
        try {
          journal = { ...journal, phase: "runtime-starting" };
          await saveJournal(journal);
          updateOperation(id, { progress: 60, phase: "replacing" });
          await runtime.uninstall(slug);
          runtimeRecords = runtimeMap(await runtime.installed());
          journal = { ...journal, phase: "runtime-committed" };
          await saveJournal(journal);
          state = replaceStateRecord(state, slug, null);
          await writeJsonAtomic(statePath, state);
          journal = { ...journal, phase: "committed" };
          await saveJournal(journal);
          await finishJournal(journal).catch(() => undefined);
        } catch (error) {
          const recovered = await applyJournalRuntime({ journal, rollForward: false, packageDir, runtime });
          state = replaceStateRecord(state, slug, recovered);
          await writeJsonAtomic(statePath, state);
          await finishJournal(journal).catch(() => undefined);
          throw error;
        }
      });
    },
    async setEnabled(input) {
      SlugSchema.parse(input.slug);
      runtimeRecords = runtimeMap(await runtime.installed());
      const actual = runtimeRecords.get(input.slug);
      const record = state.installed[input.slug] ?? null;
      if (!actual) throw domainError("NOT_FOUND", "Installed Plugin not found.");
      if (input.enabled) confirm(record?.detail ?? fallbackCatalogItem(actual), input.confirmation);
      const operation = start(input.slug, input.enabled ? "enable" : "disable", async (id) => {
        runtimeRecords = runtimeMap(await runtime.installed());
        const current = runtimeRecords.get(input.slug);
        if (!current) throw domainError("NOT_FOUND", "Installed Plugin not found.");
        const previousRecord = state.installed[input.slug] ?? null;
        const nextRecord = previousRecord ? InstalledRecordSchema.parse({ ...previousRecord, enabled: input.enabled }) : null;
        let journal: Journal = {
          operationId: id,
          slug: input.slug,
          action: "metadata",
          phase: "staged",
          previousRecord,
          nextRecord,
          previousEnabled: current.enabled,
          nextEnabled: input.enabled,
        };
        await saveJournal(journal);
        try {
          journal = { ...journal, phase: "runtime-starting" };
          await saveJournal(journal);
          updateOperation(id, { progress: 70, phase: "persisting" });
          await runtime.setEnabled(input.slug, input.enabled);
          runtimeRecords = runtimeMap(await runtime.installed());
          if (runtimeRecords.get(input.slug)?.enabled !== input.enabled) throw new Error("OpenClaw Plugin enablement state mismatch.");
          journal = { ...journal, phase: "runtime-committed" };
          await saveJournal(journal);
          state = replaceStateRecord(state, input.slug, nextRecord);
          await writeJsonAtomic(statePath, state);
          journal = { ...journal, phase: "committed" };
          await saveJournal(journal);
          await finishJournal(journal).catch(() => undefined);
        } catch (error) {
          const recovered = await applyJournalRuntime({ journal, rollForward: false, packageDir, runtime });
          state = replaceStateRecord(state, input.slug, recovered);
          await writeJsonAtomic(statePath, state);
          await finishJournal(journal).catch(() => undefined);
          throw error;
        }
      });
      await tasks.get(operation.id);
      return operations.get(operation.id)!;
    },
    async operation(id) {
      const operation = operations.get(id);
      if (!operation) throw domainError("NOT_FOUND", "Plugin operation not found.");
      return operation;
    },
    async waitForOperation(id) {
      await tasks.get(id);
      const operation = operations.get(id);
      if (!operation) throw domainError("NOT_FOUND", "Plugin operation not found.");
      return operation;
    },
  };
}
