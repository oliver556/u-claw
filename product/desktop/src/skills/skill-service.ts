import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  SkillDetailSchema,
  UClawErrorSchema,
  type CapabilityRisk,
  type SkillCatalogItem,
  type SkillConfirmation,
  type SkillCuratorStatus,
  type SkillDetail,
  type LocalSkillDetail,
  type SkillOperation,
  type SkillProposalInspect,
  type SkillProposalCreateInput,
  type SkillProposalUpdateInput,
  type SkillProposalReviseInput,
  type SkillProposalRevisionRequestInput,
  type SkillProposalRevisionRun,
  type SkillProposalManifest,
  type SkillRuntimeInventory,
} from "@uclaw/shared";
import { z } from "zod";

import { parseSkillMarkdownFrontmatter, validateSkillBundle, type ValidatedBundle } from "./bundle-validator.js";
import type { SkillHubClient } from "./fixture-client.js";
import { scanLocalSkills, type LocalSkillItem } from "./local-skill-scanner.js";
import type { OpenClawSkillRuntime } from "./openclaw-skill-runtime.js";

const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/);
const OperationIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/i);
const InstalledRecordSchema = z.object({
  slug: SlugSchema,
  version: z.string().min(1).max(80),
  enabled: z.boolean(),
  detail: SkillDetailSchema.optional(),
}).strict();
const SkillStateSchema = z.object({
  schemaVersion: z.literal(1),
  installed: z.record(SlugSchema, InstalledRecordSchema),
}).strict();
type InstalledRecord = z.infer<typeof InstalledRecordSchema>;
type SkillState = z.infer<typeof SkillStateSchema>;

const ReplaceJournalSchema = z.object({
  operationId: OperationIdSchema,
  slug: SlugSchema,
  action: z.literal("replace"),
  phase: z.enum(["prepared", "staged", "backed-up", "replaced", "verified", "rolling-back"]),
  previousRecord: InstalledRecordSchema.nullable(),
  nextRecord: InstalledRecordSchema,
}).strict();
const RemoveJournalSchema = z.object({
  operationId: OperationIdSchema,
  slug: SlugSchema,
  action: z.literal("remove"),
  phase: z.enum(["staged", "backed-up", "committed", "committed-final", "rolling-back"]),
  previousRecord: InstalledRecordSchema,
}).strict();
const ToggleJournalSchema = z.object({
  operationId: OperationIdSchema,
  slug: SlugSchema,
  action: z.literal("toggle"),
  phase: z.enum(["prepared", "runtime-changed", "state-persisted"]),
  previousRecord: InstalledRecordSchema,
  nextRecord: InstalledRecordSchema,
}).strict();
const JournalSchema = z.discriminatedUnion("action", [ReplaceJournalSchema, RemoveJournalSchema, ToggleJournalSchema]);
type ReplaceJournal = z.infer<typeof ReplaceJournalSchema>;
type RemoveJournal = z.infer<typeof RemoveJournalSchema>;
type ToggleJournal = z.infer<typeof ToggleJournalSchema>;
type Journal = z.infer<typeof JournalSchema>;

export interface SkillMutationInput { slug: string; expectedVersion?: string; confirmation: SkillConfirmation | null }
export interface SkillBundleInstallInput { detail: SkillDetail; validated: ValidatedBundle; confirmation: SkillConfirmation }
export interface SkillService {
  search(input: { query: string; category?: string | null; sort?: "score" | "downloads" | "stars" | "updatedAt"; cursor: string | null; pageSize: number }): Promise<{ items: SkillCatalogItem[]; nextCursor: string | null; hasMore: boolean; mode: "fixture" | "live" }>;
  detail(slug: string, expectedVersion?: string): Promise<SkillDetail>;
  localDetail(slug: string): Promise<LocalSkillDetail>;
  installed(): Promise<SkillCatalogItem[]>;
  runtimeStatus(): Promise<SkillRuntimeInventory>;
  curatorStatus(): Promise<SkillCuratorStatus>;
  curatorAction(skill: string, action: "pin" | "unpin" | "restore"): ReturnType<OpenClawSkillRuntime["curatorAction"]>;
  proposalsList(): Promise<SkillProposalManifest>;
  proposalInspect(proposalId: string): Promise<SkillProposalInspect>;
  proposalAction(proposalId: string, action: "apply" | "reject" | "quarantine", reason?: string): Promise<unknown>;
  proposalCreate(input: SkillProposalCreateInput): Promise<SkillProposalInspect>;
  proposalUpdate(input: SkillProposalUpdateInput): Promise<SkillProposalInspect>;
  proposalRevise(input: SkillProposalReviseInput): Promise<SkillProposalInspect>;
  proposalRequestRevision(input: SkillProposalRevisionRequestInput): Promise<SkillProposalRevisionRun>;
  startInstall(input: SkillMutationInput): Promise<SkillOperation>;
  startInstallBundle(input: SkillBundleInstallInput): Promise<SkillOperation>;
  startUpdate(input: SkillMutationInput): Promise<SkillOperation>;
  startUninstall(slug: string): Promise<SkillOperation>;
  setEnabled(input: SkillMutationInput & { enabled: boolean }): Promise<SkillOperation>;
  operation(id: string): Promise<SkillOperation>;
  waitForOperation(id: string): Promise<SkillOperation>;
}

const riskOrder: CapabilityRisk[] = ["low", "medium", "high", "critical"];
const emptyState = (): SkillState => ({ schemaVersion: 1, installed: {} });
const emptyMissing = { bins: [], anyBins: [], env: [], config: [], os: [] };

function domainError(code: "FORBIDDEN" | "CONFIRMATION_REQUIRED" | "NOT_FOUND" | "CONFLICT" | "UNAVAILABLE", message: string) {
  return UClawErrorSchema.parse({ code, message, retryable: code === "UNAVAILABLE", recoveryActions: [], causeDetails: {} });
}

function within(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    await handle?.close();
  }
}

async function writeFileDurable(path: string, content: string | Buffer): Promise<void> {
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

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFileDurable(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readState(path: string): Promise<SkillState> {
  try { return SkillStateSchema.parse(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
}

async function readJournal(path: string): Promise<Journal> {
  return JournalSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function assertDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe Skill directory.");
}

async function prepareAuthoritativeRoot(dataDir: string, root: string): Promise<string> {
  const dataReal = await realpath(dataDir);
  const normalized = resolve(root);
  await mkdir(normalized, { recursive: true });
  await assertDirectory(normalized);
  const rootReal = await realpath(normalized);
  if (!within(dataReal, rootReal)) throw new Error("Unsafe Skill root.");
  return normalized;
}

function operationPaths(workspaceRoot: string, slug: string, operationId: string) {
  return {
    target: join(workspaceRoot, slug),
    staging: join(workspaceRoot, `.${slug}.${operationId}.staging`),
    backup: join(workspaceRoot, `.${slug}.${operationId}.backup`),
  };
}

function isWorkspaceRuntimeItem(item: SkillRuntimeInventory["skills"][number]): boolean {
  return !item.bundled && item.source.toLowerCase().includes("workspace");
}

async function recoverTransactions(
  transactionDir: string,
  statePath: string,
  workspaceRoot: string,
  runtime: OpenClawSkillRuntime | undefined,
  persistState: (path: string, value: SkillState) => Promise<void>,
  actions: readonly Journal["action"][] = ["replace", "remove", "toggle"],
): Promise<boolean> {
  let deferred = false;
  const names = await readdir(transactionDir).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const journalPath = join(transactionDir, name);
    const journal = await readJournal(journalPath);
    if (`${journal.operationId}.json` !== name) throw new Error("Skill transaction identity mismatch.");
    if (!actions.includes(journal.action)) continue;
    const state = await readState(statePath);
    if (journal.action === "toggle") {
      if (!runtime) {
        deferred = true;
        continue;
      }
      let inventory: SkillRuntimeInventory;
      try {
        inventory = await runtime.status(new Map());
      } catch {
        deferred = true;
        continue;
      }
      const item = inventory.skills.find((candidate) => candidate.id === journal.slug && isWorkspaceRuntimeItem(candidate));
      if (!item) {
        if (await pathExists(join(workspaceRoot, journal.slug))) {
          deferred = true;
          continue;
        }
        const installed = { ...state.installed };
        delete installed[journal.slug];
        await persistState(statePath, { ...state, installed });
        await rm(journalPath, { force: true });
        await syncDirectory(transactionDir);
        continue;
      }
      const enabled = !item.disabled;
      const recovered = enabled === journal.nextRecord.enabled ? journal.nextRecord
        : enabled === journal.previousRecord.enabled ? journal.previousRecord : undefined;
      if (!recovered) throw new Error("OpenClaw Skill toggle recovery is ambiguous.");
      await persistState(statePath, { ...state, installed: { ...state.installed, [journal.slug]: recovered } });
      await rm(journalPath, { force: true });
      await syncDirectory(transactionDir);
      continue;
    }
    const { target, staging, backup } = operationPaths(workspaceRoot, journal.slug, journal.operationId);
    if (journal.action === "replace") {
      const targetExists = await pathExists(target);
      const stagingExists = await pathExists(staging);
      const backupExists = await pathExists(backup);
      const finalCommit = journal.phase === "verified";
      const filesystemCommitted = finalCommit || (journal.phase !== "prepared" && journal.phase !== "rolling-back" && targetExists && !stagingExists);
      let runtimeCommitted = filesystemCommitted;
      const irreversible = filesystemCommitted && journal.previousRecord !== null && !backupExists;
      if (runtime && filesystemCommitted && !irreversible && !finalCommit) {
        try {
          const inventory = await runtime.status(new Map());
          const item = inventory.skills.find((candidate) => candidate.id === journal.slug && isWorkspaceRuntimeItem(candidate));
          runtimeCommitted = item !== undefined && !item.disabled === journal.nextRecord.enabled;
        } catch {
          deferred = true;
          continue;
        }
      }
      if (runtimeCommitted) {
        await persistState(statePath, { ...state, installed: { ...state.installed, [journal.slug]: journal.nextRecord } });
        await rm(backup, { recursive: true, force: true });
      } else {
        if (backupExists) {
          await rm(target, { recursive: true, force: true });
          await rename(backup, target);
          await syncDirectory(workspaceRoot);
        } else if (journal.previousRecord && !targetExists) {
          throw new Error("Skill replacement recovery is missing both target and backup.");
        } else if (!journal.previousRecord) {
          await rm(target, { recursive: true, force: true });
        }
        const installed = { ...state.installed };
        if (journal.previousRecord) installed[journal.slug] = journal.previousRecord;
        else delete installed[journal.slug];
        await persistState(statePath, { ...state, installed });
      }
    } else {
      const targetExists = await pathExists(target);
      const backupExists = await pathExists(backup);
      const finalCommit = journal.phase === "committed-final";
      const filesystemCommitted = finalCommit || (journal.phase === "committed" && !targetExists);
      let runtimeCommitted = filesystemCommitted;
      const irreversible = filesystemCommitted && !backupExists;
      if (runtime && filesystemCommitted && !irreversible && !finalCommit) {
        try {
          const inventory = await runtime.status(new Map());
          runtimeCommitted = !inventory.skills.some((candidate) => candidate.id === journal.slug && isWorkspaceRuntimeItem(candidate));
        } catch {
          deferred = true;
          continue;
        }
      }
      if (runtimeCommitted) {
        const installed = { ...state.installed };
        delete installed[journal.slug];
        await persistState(statePath, { ...state, installed });
        await rm(backup, { recursive: true, force: true });
      } else {
        if (backupExists && !targetExists) {
          await rename(backup, target);
          await syncDirectory(workspaceRoot);
        }
        if (!await pathExists(target)) throw new Error("Skill uninstall recovery is missing both target and backup.");
        await persistState(statePath, { ...state, installed: { ...state.installed, [journal.slug]: journal.previousRecord } });
      }
    }
    await rm(staging, { recursive: true, force: true });
    await rm(journalPath, { force: true });
    await syncDirectory(transactionDir);
  }
  return deferred;
}

async function assertSafeExistingTarget(path: string): Promise<void> {
  if (!await pathExists(path)) return;
  await assertDirectory(path);
}

async function assertInstalledVersion(target: string, validated: ValidatedBundle): Promise<void> {
  if (validated.manifest.entry === "SKILL.md") {
    const frontmatter = parseSkillMarkdownFrontmatter(await readFile(join(target, "SKILL.md"), "utf8"));
    if ((frontmatter.slug ?? validated.manifest.id) !== validated.manifest.id ||
      (frontmatter.version ?? validated.manifest.version) !== validated.manifest.version) throw new Error("Installed Skill version readback mismatch.");
    return;
  }
  const manifest = JSON.parse(await readFile(join(target, "SKILL.json"), "utf8")) as { id?: unknown; version?: unknown };
  if (manifest.id !== validated.manifest.id || manifest.version !== validated.manifest.version) throw new Error("Installed Skill version readback mismatch.");
}

/** Creates the portable Skill service and enforces identity/version confirmation at mutations. */
export async function createSkillService({
  dataDir,
  client,
  runtime,
  bundledRoots = [],
  managedRoot = join(dataDir, ".openclaw", "skills"),
  workspaceRoot,
  writeState = writeJsonAtomic,
  runMutation = (operation) => operation(),
  removePath = rm,
}: {
  dataDir: string;
  client: SkillHubClient;
  runtime?: OpenClawSkillRuntime;
  bundledRoots?: readonly string[];
  managedRoot?: string;
  workspaceRoot?: string;
  writeState?: (path: string, state: SkillState) => Promise<void>;
  runMutation?: <T>(operation: () => Promise<T>) => Promise<T>;
  removePath?: typeof rm;
}): Promise<SkillService> {
  const metadataRoot = await prepareAuthoritativeRoot(dataDir, join(dataDir, "capabilities"));
  const authoritativeRoot = await prepareAuthoritativeRoot(dataDir, workspaceRoot ?? join(metadataRoot, "skills"));
  const transactionDir = join(metadataRoot, ".skill-transactions");
  const statePath = join(metadataRoot, "skill-state.json");
  await mkdir(transactionDir, { recursive: true });
  await assertDirectory(transactionDir);
  await recoverTransactions(transactionDir, statePath, authoritativeRoot, runtime, writeState);
  let state = await readState(statePath);
  const operations = new Map<string, SkillOperation>();
  const tasks = new Map<string, Promise<void>>();
  let mutationTail = Promise.resolve();

  const scan = () => scanLocalSkills({ bundledRoots, managedRoot, workspaceRoot: authoritativeRoot });
  let recoverPendingTransactions: () => Promise<void>;
  const normalize = (detail: SkillDetail): SkillDetail => {
    const risk = detail.permissions.reduce<CapabilityRisk>((highest, permission) =>
      riskOrder.indexOf(permission.risk) > riskOrder.indexOf(highest) ? permission.risk : highest, "low");
    const permissionFingerprint = createHash("sha256").update(JSON.stringify(detail.permissions)).digest("hex");
    return { ...detail, risk, permissionFingerprint };
  };
  /** Combines remote catalog metadata with authoritative local install state. */
  const project = (detail: SkillDetail): SkillCatalogItem => {
    const normalized = normalize(detail);
    const record = state.installed[detail.slug];
    return {
      slug: normalized.slug, name: normalized.name, description: normalized.description, version: normalized.version,
      pricingType: normalized.pricingType, installedVersion: record?.version ?? null, enabled: record?.enabled ?? false,
      updateAvailable: record !== undefined && record.version !== normalized.version, source: normalized.source,
      permissions: normalized.permissions, permissionFingerprint: normalized.permissionFingerprint, risk: normalized.risk,
      mode: normalized.mode, categories: normalized.categories, logoUrl: normalized.logoUrl,
      ownerName: normalized.ownerName, downloads: normalized.downloads, stars: normalized.stars,
      requiresKey: normalized.requiresKey, updatedAt: normalized.updatedAt,
    };
  };
  const projectLocal = (item: LocalSkillItem, runtimeItem?: SkillRuntimeInventory["skills"][number]): SkillCatalogItem => {
    const record = state.installed[item.id];
    const source = item.origin === "portable-bundled"
      ? { provider: "portable" as const, origin: "bundled" as const }
      : { provider: "openclaw" as const, origin: item.origin === "managed-installed" ? "managed" as const : "workspace" as const };
    return {
      slug: item.id, name: item.name, description: item.description, version: record?.version ?? "local",
      pricingType: "free", installedVersion: record?.version ?? "local",
      enabled: runtimeItem ? !runtimeItem.disabled : runtime ? false : record?.enabled ?? false,
      updateAvailable: false, source,
      permissions: [], permissionFingerprint: createHash("sha256").update("[]").digest("hex"), risk: "low",
      mode: "live", categories: [], logoUrl: null,
    };
  };
  /** Loads one pinned remote detail and maps identity drift at mutation time to reconfirmation. */
  const loadRemoteDetail = async (slug: string, expectedVersion?: string, confirmationBoundary = false): Promise<SkillDetail> => {
    let found: SkillDetail;
    try {
      found = await client.detail(slug, expectedVersion, confirmationBoundary);
    } catch (error) {
      if (confirmationBoundary && /identity|version/iu.test(error instanceof Error ? error.message : "")) {
        throw domainError("CONFIRMATION_REQUIRED", "Skill identity changed; review the latest detail before installing.");
      }
      throw domainError("NOT_FOUND", "Skill not found.");
    }
    const parsed = SkillDetailSchema.parse(found);
    if (confirmationBoundary && parsed.stale) {
      throw domainError("CONFIRMATION_REQUIRED", "Live Skill identity is unavailable; review the detail again before installing.");
    }
    if (expectedVersion !== undefined && parsed.version !== expectedVersion) {
      throw domainError(
        confirmationBoundary ? "CONFIRMATION_REQUIRED" : "NOT_FOUND",
        confirmationBoundary ? "Skill identity changed; review the latest detail before installing." : "Skill version not found.",
      );
    }
    if (parsed.pricingType !== "free") throw domainError("FORBIDDEN", "Paid Skills are not available.");
    const normalized = normalize(parsed);
    return { ...normalized, ...project(normalized) };
  };
  /** Falls back to an installed snapshot only for ordinary detail reads, never paid results. */
  const loadDetail = async (slug: string, expectedVersion?: string): Promise<SkillDetail> => {
    try { return await loadRemoteDetail(slug, expectedVersion); }
    catch (error) {
      if ((error as { code?: unknown })?.code === "FORBIDDEN") throw error;
      const snapshot = state.installed[slug]?.detail;
      if (snapshot && (expectedVersion === undefined || snapshot.version === expectedVersion)) {
        return { ...normalize(snapshot), ...project(snapshot) };
      }
      throw error;
    }
  };
  /** Verifies permissions, risk, and marketplace identity against the exact detail the user accepted. */
  const confirm = (detail: SkillDetail, confirmation: SkillConfirmation | null, requireIdentity = false): void => {
    if (!confirmation || confirmation.permissionFingerprint !== detail.permissionFingerprint ||
      (requireIdentity && (!detail.identityFingerprint || confirmation.identityFingerprint !== detail.identityFingerprint)) ||
      riskOrder.indexOf(confirmation.acceptedRisk) < riskOrder.indexOf(detail.risk)) {
      throw domainError("CONFIRMATION_REQUIRED", "Skill permissions require explicit confirmation.");
    }
  };
  const requireRuntime = (): OpenClawSkillRuntime => {
    if (!runtime) throw domainError("UNAVAILABLE", "OpenClaw Skill runtime is unavailable.");
    return runtime;
  };
  const runtimeReadback = async (): Promise<SkillRuntimeInventory> => {
    const local = await scan();
    const conflicts = new Map([...local.conflicts].map(([id, origins]) => [id, origins as readonly string[]]));
    return runtime
      ? runtime.status(conflicts)
      : { workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills", skills: [] };
  };
  const matchesRuntime = (local: LocalSkillItem, candidate: SkillRuntimeInventory["skills"][number]): boolean =>
    isWorkspaceRuntimeItem(candidate) && [local.id, local.runtimeName, local.directoryKey].includes(candidate.id);
  const runtimeForLocal = (local: LocalSkillItem, inventory?: SkillRuntimeInventory) => {
    const matches = inventory?.skills.filter((candidate) => matchesRuntime(local, candidate)) ?? [];
    return matches.length === 1 ? matches[0] : undefined;
  };
  const runtimeStatus = async (): Promise<SkillRuntimeInventory> => {
    await recoverPendingTransactions();
    const local = await scan();
    const conflicts = new Map([...local.conflicts].map(([id, origins]) => [id, origins as readonly string[]]));
    const inventory = runtime
      ? await runtime.status(conflicts)
      : { workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills", skills: [] };
    const matchedRuntimeIds = new Set<string>();
    const projectedLocal = local.items.flatMap((item) => {
      const runtimeItem = runtimeForLocal(item, inventory);
      if (!runtimeItem) return [];
      matchedRuntimeIds.add(runtimeItem.id);
      const collision = conflicts.get(item.id) ?? [];
      return [{
        ...runtimeItem,
        id: item.id,
        runtimeId: runtimeItem.id,
        name: item.name,
        description: item.description,
        availability: collision.length === 0 ? runtimeItem.availability : "conflict" as const,
        conflicts: collision.length === 0 ? runtimeItem.conflicts : [...collision],
      }];
    });
    const skills = inventory.skills.filter((item) => !matchedRuntimeIds.has(item.id)).map((item) => {
      const collision = conflicts.get(item.id) ?? [];
      return collision.length === 0 ? item : { ...item, availability: "conflict" as const, conflicts: [...collision] };
    });
    for (const item of local.items) {
      if (projectedLocal.some((candidate) => candidate.id === item.id)) continue;
      const collision = conflicts.get(item.id) ?? [];
      skills.push({
        id: item.id, name: item.name, description: item.description, source: item.origin,
        bundled: item.origin === "portable-bundled", disabled: true, eligible: false,
        modelVisible: false, userInvocable: false, commandVisible: false,
        availability: collision.length > 0 ? "conflict" : "not-detected", missing: emptyMissing, conflicts: [...collision],
      });
    }
    return { ...inventory, skills: [...skills, ...projectedLocal] };
  };
  const updateOperation = (id: string, patch: Partial<SkillOperation>) => {
    const current = operations.get(id);
    if (current) operations.set(id, { ...current, ...patch });
  };
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const running = mutationTail.then(() => runMutation(operation), () => runMutation(operation));
    mutationTail = running.then(() => undefined, () => undefined);
    return running;
  };
  const recoverBeforeMutation = async (): Promise<void> => {
    const unresolved = await recoverTransactions(transactionDir, statePath, authoritativeRoot, runtime, writeState);
    state = await readState(statePath);
    if (unresolved) throw domainError("CONFLICT", "A pending Skill transaction must be recovered before another mutation.");
  };
  const enqueueMutation = <T>(operation: () => Promise<T>): Promise<T> => enqueue(async () => {
    await recoverBeforeMutation();
    return operation();
  });
  recoverPendingTransactions = async () => {
    await enqueue(async () => {
      await recoverTransactions(transactionDir, statePath, authoritativeRoot, runtime, writeState);
      state = await readState(statePath);
    });
  };
  const start = (slug: string, action: SkillOperation["action"], task: (id: string) => Promise<void>): SkillOperation => {
    const operation: SkillOperation = { id: randomUUID(), slug, action, state: "queued", progress: 0, phase: "queued" };
    operations.set(operation.id, operation);
    const running = enqueue(async () => {
      updateOperation(operation.id, { state: "running", progress: 5, phase: "downloading" });
      try {
        await recoverBeforeMutation();
        await task(operation.id);
        updateOperation(operation.id, { state: "succeeded", progress: 100, phase: "complete" });
      } catch {
        updateOperation(operation.id, { state: "failed", phase: "failed", error: "Skill operation failed. Retry or restart U-Claw for recovery." });
      }
    }).catch(() => {
      updateOperation(operation.id, { state: "failed", phase: "failed", error: "Skill operation failed. Retry or restart U-Claw for recovery." });
    });
    tasks.set(operation.id, running);
    void running.finally(() => tasks.delete(operation.id));
    return operation;
  };
  const verifyPresent = async (slug: string, expectedEnabled: boolean): Promise<void> => {
    if (!runtime) return;
    const inventory = await runtimeReadback();
    const item = inventory.skills.find((candidate) => candidate.id === slug && isWorkspaceRuntimeItem(candidate));
    if (!item) throw new Error("OpenClaw Skill readback mismatch.");
    const actualEnabled = !item.disabled;
    if (actualEnabled !== expectedEnabled) throw new Error("OpenClaw Skill readback mismatch.");
  };
  const synthesizeWorkspaceRecord = async (slug: string, inventory?: SkillRuntimeInventory): Promise<InstalledRecord> => {
    const localItem = (await scan()).items.find((item) => item.id === slug && item.origin === "workspace-installed");
    if (!localItem) throw new Error("Workspace Skill is missing.");
    const frontmatter = parseSkillMarkdownFrontmatter(localItem.markdown);
    if (frontmatter.slug !== undefined && frontmatter.slug !== slug) throw new Error("Workspace Skill identity mismatch.");
    const currentInventory = inventory ?? (runtime ? await runtimeReadback() : undefined);
    const runtimeItem = runtimeForLocal(localItem, currentInventory);
    if (runtime && !runtimeItem) throw new Error("Workspace Skill is not detected by OpenClaw.");
    return { slug, version: frontmatter.version ?? "local", enabled: runtimeItem ? !runtimeItem.disabled : false };
  };
  const installOrUpdate = async (detail: SkillDetail, action: "install" | "update", operationId: string, prepared?: ValidatedBundle): Promise<void> => {
    state = await readState(statePath);
    if (action === "install" && (state.installed[detail.slug] || await pathExists(join(authoritativeRoot, detail.slug)))) {
      throw domainError("CONFLICT", "Skill is already installed.");
    }
    if (action === "update" && !state.installed[detail.slug]) state = {
      ...state, installed: { ...state.installed, [detail.slug]: await synthesizeWorkspaceRecord(detail.slug) },
    };
    updateOperation(operationId, { progress: 25, phase: "validating" });
    const validated = prepared ?? validateSkillBundle(await client.download(detail.slug), detail);
    const { target, staging, backup } = operationPaths(authoritativeRoot, detail.slug, operationId);
    const journalPath = join(transactionDir, `${operationId}.json`);
    const stateBeforeOperation = state;
    const previousRecord = stateBeforeOperation.installed[detail.slug] ?? null;
    const nextRecord: InstalledRecord = {
      slug: detail.slug, version: detail.version, enabled: previousRecord?.enabled ?? true, detail,
    };
    let backedUp = false;
    let replaced = false;
    let journal: ReplaceJournal | undefined;
    try {
      await assertSafeExistingTarget(target);
      journal = { operationId, slug: detail.slug, action: "replace", phase: "prepared", previousRecord, nextRecord };
      await writeJsonAtomic(journalPath, journal);
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: false, mode: 0o700 });
      await syncDirectory(authoritativeRoot);
      updateOperation(operationId, { progress: 50, phase: "staging" });
      for (const file of validated.files) await writeFileDurable(join(staging, ...file.path.split("/")), file.content);
      journal = { ...journal, phase: "staged" };
      await writeJsonAtomic(journalPath, journal);
      if (await pathExists(target)) {
        await rename(target, backup);
        await syncDirectory(authoritativeRoot);
        backedUp = true;
        journal = { ...journal, phase: "backed-up" };
        await writeJsonAtomic(journalPath, journal);
        if (client.failAfterBackup) throw new Error("Simulated interrupted replacement.");
      }
      updateOperation(operationId, { progress: 75, phase: "replacing" });
      await rename(staging, target);
      await syncDirectory(authoritativeRoot);
      replaced = true;
      journal = { ...journal, phase: "replaced" };
      await writeJsonAtomic(journalPath, journal);
      state = { ...state, installed: { ...state.installed, [detail.slug]: nextRecord } };
      updateOperation(operationId, { progress: 90, phase: "persisting" });
      await writeState(statePath, state);
      await assertInstalledVersion(target, validated);
      await verifyPresent(detail.slug, nextRecord.enabled);
      journal = { ...journal, phase: "verified" };
      await writeJsonAtomic(journalPath, journal);
    } catch (error) {
      state = stateBeforeOperation;
      if (client.failAfterBackup && backedUp && !replaced) throw error;
      if (journal) {
        journal = { ...journal, phase: "rolling-back" };
        await writeJsonAtomic(journalPath, journal);
      }
      if (replaced) await rm(target, { recursive: true, force: true });
      if (backedUp && await pathExists(backup) && !(await pathExists(target))) await rename(backup, target);
      await writeState(statePath, stateBeforeOperation);
      await rm(staging, { recursive: true, force: true });
      await rm(backup, { recursive: true, force: true });
      await rm(journalPath, { force: true });
      await syncDirectory(authoritativeRoot);
      await syncDirectory(transactionDir);
      throw error;
    }
    await removePath(backup, { recursive: true, force: true });
    await removePath(journalPath, { force: true });
    await syncDirectory(transactionDir);
  };

  return {
    async search(input) {
      const page = await client.search(input);
      const free = page.items.map((item) => SkillDetailSchema.parse(item))
        .filter((item) => item.pricingType === "free").map(project);
      return { ...page, items: free };
    },
    detail: loadDetail,
    async localDetail(slug) {
      SlugSchema.parse(slug);
      const item = (await scan()).items.find((candidate) => candidate.id === slug && candidate.origin === "workspace-installed");
      if (!item) throw domainError("NOT_FOUND", "Workspace Skill not found.");
      return { slug: item.id, name: item.name, description: item.description, markdown: item.markdown };
    },
    async installed() {
      await recoverPendingTransactions();
      state = await readState(statePath);
      const local = await scan();
      const inventory = runtime ? await runtime.status(new Map([...local.conflicts].map(([id, origins]) => [id, origins as readonly string[]]))) : undefined;
      const bySlug = new Map<string, SkillCatalogItem>();
      for (const item of local.items) {
        if (item.origin !== "workspace-installed") continue;
        const runtimeItem = runtimeForLocal(item, inventory);
        bySlug.set(item.id, projectLocal(item, runtimeItem));
      }
      for (const [slug, record] of Object.entries(state.installed)) {
        if (!local.items.some((item) => item.id === slug && item.origin === "workspace-installed")) continue;
        if (!record.detail) continue;
        const localItem = local.items.find((item) => item.id === slug && item.origin === "workspace-installed");
        const runtimeItem = localItem ? runtimeForLocal(localItem, inventory) : undefined;
        bySlug.set(slug, { ...project(record.detail), source: { provider: "openclaw", origin: "workspace" }, enabled: runtimeItem ? !runtimeItem.disabled : runtime ? false : record.enabled });
      }
      return [...bySlug.values()];
    },
    runtimeStatus,
    curatorStatus: () => requireRuntime().curatorStatus(),
    curatorAction: (skill, action) => enqueueMutation(() => requireRuntime().curatorAction(skill, action)),
    proposalsList: () => requireRuntime().listProposals(),
    proposalInspect: (proposalId) => requireRuntime().inspectProposal(proposalId),
    proposalAction: (proposalId, action, reason) => enqueueMutation(() => requireRuntime().proposalAction(proposalId, action, reason)),
    proposalCreate: (input) => enqueueMutation(() => requireRuntime().createProposal(input)),
    proposalUpdate: (input) => enqueueMutation(() => requireRuntime().updateProposal(input)),
    proposalRevise: (input) => enqueueMutation(() => requireRuntime().reviseProposal(input)),
    proposalRequestRevision: (input) => enqueueMutation(() => requireRuntime().requestProposalRevision(input)),
    async startInstall(input) {
      const detail = await loadRemoteDetail(input.slug, input.expectedVersion, true);
      confirm(detail, input.confirmation, detail.mode === "live" && detail.source.provider === "skillhub");
      const persistedState = await readState(statePath);
      if (persistedState.installed[detail.slug] || await pathExists(join(authoritativeRoot, detail.slug))) {
        throw domainError("CONFLICT", "Skill is already installed.");
      }
      return start(input.slug, "install", (id) => installOrUpdate(detail, "install", id));
    },
    async startInstallBundle({ detail, validated, confirmation }) {
      SkillDetailSchema.parse(detail);
      confirm(detail, confirmation);
      const persistedState = await readState(statePath);
      if (persistedState.installed[detail.slug] || await pathExists(join(authoritativeRoot, detail.slug))) {
        throw domainError("CONFLICT", "Skill is already installed.");
      }
      return start(detail.slug, "install", (id) => installOrUpdate(detail, "install", id, validated));
    },
    async startUpdate(input) {
      const detail = await loadRemoteDetail(input.slug, input.expectedVersion, true);
      confirm(detail, input.confirmation, detail.mode === "live" && detail.source.provider === "skillhub");
      return start(input.slug, "update", (id) => installOrUpdate(detail, "update", id));
    },
    async startUninstall(slug) {
      SlugSchema.parse(slug);
      return start(slug, "uninstall", async (id) => {
        state = await readState(statePath);
        const previousRecord = state.installed[slug] ?? await synthesizeWorkspaceRecord(slug);
        updateOperation(id, { progress: 50, phase: "replacing" });
        const { target, staging, backup } = operationPaths(authoritativeRoot, slug, id);
        const journalPath = join(transactionDir, `${id}.json`);
        const stateBeforeOperation = state;
        let journal: RemoveJournal = { operationId: id, slug, action: "remove", phase: "staged", previousRecord };
        await writeJsonAtomic(journalPath, journal);
        try {
          await assertSafeExistingTarget(target);
          await rename(target, backup);
          await syncDirectory(authoritativeRoot);
          journal = { ...journal, phase: "backed-up" };
          await writeJsonAtomic(journalPath, journal);
          const installed = { ...state.installed };
          delete installed[slug];
          state = { ...state, installed };
          await writeState(statePath, state);
          journal = { ...journal, phase: "committed" };
          await writeJsonAtomic(journalPath, journal);
          if (runtime && (await runtimeReadback()).skills.some((item) => item.id === slug && isWorkspaceRuntimeItem(item))) throw new Error("OpenClaw Skill uninstall readback mismatch.");
          journal = { ...journal, phase: "committed-final" };
          await writeJsonAtomic(journalPath, journal);
        } catch (error) {
          try {
            journal = { ...journal, phase: "rolling-back" };
            await writeJsonAtomic(journalPath, journal);
            if (await pathExists(backup) && !(await pathExists(target))) await rename(backup, target);
            await syncDirectory(authoritativeRoot);
            state = stateBeforeOperation;
            await writeState(statePath, stateBeforeOperation);
            await rm(journalPath, { force: true });
            await syncDirectory(transactionDir);
          } catch {
            throw error;
          }
          throw error;
        }
        await removePath(backup, { recursive: true, force: true });
        await removePath(journalPath, { force: true });
        await syncDirectory(transactionDir);
      });
    },
    async setEnabled(input) {
      SlugSchema.parse(input.slug);
      const action = input.enabled ? "enable" : "disable";
      const operation = start(input.slug, action, async (id) => {
        state = await readState(statePath);
        const local = await scan();
        const conflicts = new Map([...local.conflicts].map(([slug, origins]) => [slug, origins as readonly string[]]));
        if (conflicts.has(input.slug)) throw domainError("CONFLICT", "Conflicting local Skill sources must be resolved before enablement changes.");
        if (!local.items.some((item) => item.id === input.slug && item.origin === "workspace-installed")) {
          throw domainError("NOT_FOUND", "Workspace Skill not found.");
        }
        const inventory = runtime ? await runtime.status(conflicts) : undefined;
        const localItem = local.items.find((item) => item.id === input.slug && item.origin === "workspace-installed")!;
        const runtimeItem = runtimeForLocal(localItem, inventory);
        if (runtime && (!runtimeItem || runtimeItem.availability === "conflict")) {
          throw domainError("CONFLICT", "OpenClaw cannot identify a unique workspace Skill target.");
        }
        const record = state.installed[input.slug] ?? await synthesizeWorkspaceRecord(input.slug, inventory);
        const detail = record.detail;
        if (input.enabled && detail) confirm(detail, input.confirmation);
        updateOperation(id, { progress: 70, phase: "persisting" });
        const previousState = state;
        const nextRecord: InstalledRecord = { ...record, enabled: input.enabled, detail: detail ?? record.detail };
        const nextState: SkillState = {
          ...state,
          installed: { ...state.installed, [input.slug]: nextRecord },
        };
        if (!runtime) {
          await writeState(statePath, nextState);
          state = nextState;
          return;
        }
        const journalPath = join(transactionDir, `${id}.json`);
        let journal: ToggleJournal = {
          operationId: id,
          slug: input.slug,
          action: "toggle",
          phase: "prepared",
          previousRecord: record,
          nextRecord,
        };
        await writeJsonAtomic(journalPath, journal);
        let runtimeAttempted = false;
        const runtimeId = runtimeItem?.id ?? input.slug;
        try {
          runtimeAttempted = true;
          const enabled = !(await runtime.setEnabled(runtimeId, input.enabled)).disabled;
          if (enabled !== input.enabled) throw new Error("OpenClaw Skill enable readback mismatch.");
          journal = { ...journal, phase: "runtime-changed" };
          await writeJsonAtomic(journalPath, journal);
          await writeState(statePath, nextState);
          state = nextState;
          journal = { ...journal, phase: "state-persisted" };
          await writeJsonAtomic(journalPath, journal);
          await rm(journalPath, { force: true });
          await syncDirectory(transactionDir);
        } catch (error) {
          state = previousState;
          if (runtimeAttempted) {
            try {
              const compensated = await runtime.setEnabled(runtimeId, record.enabled);
              if (compensated.disabled === record.enabled) throw new Error("OpenClaw Skill compensation readback mismatch.");
            } catch {
              throw error;
            }
          }
          try {
            await writeState(statePath, previousState);
            await rm(journalPath, { force: true });
            await syncDirectory(transactionDir);
          } catch {
            throw error;
          }
          throw error;
        }
      });
      await tasks.get(operation.id);
      return operations.get(operation.id)!;
    },
    async operation(id) {
      const operation = operations.get(id);
      if (!operation) throw domainError("NOT_FOUND", "Skill operation not found.");
      return operation;
    },
    async waitForOperation(id) {
      await tasks.get(id);
      const operation = operations.get(id);
      if (!operation) throw domainError("NOT_FOUND", "Skill operation not found.");
      return operation;
    },
  };
}
