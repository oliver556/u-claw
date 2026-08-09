import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  UClawErrorSchema,
  SkillDetailSchema,
  type CapabilityRisk,
  type SkillCatalogItem,
  type SkillConfirmation,
  type SkillDetail,
  type SkillOperation,
} from "@uclaw/shared";

import { validateSkillBundle } from "./bundle-validator.js";
import type { SkillHubClient } from "./fixture-client.js";

type InstalledRecord = { slug: string; version: string; enabled: boolean; detail?: SkillDetail };
type SkillState = { schemaVersion: 1; installed: Record<string, InstalledRecord> };
type ReplaceJournal = { operationId: string; slug: string; action: "replace"; target: string; staging: string; backup: string; phase: "staged" | "backed-up" | "replaced"; previousRecord: InstalledRecord | null; nextRecord: InstalledRecord };
type RemoveJournal = { operationId: string; slug: string; action: "remove"; target: string; staging: string; backup: string; phase: "staged" | "backed-up" | "committed"; previousRecord: InstalledRecord };
type Journal = ReplaceJournal | RemoveJournal;

export interface SkillMutationInput { slug: string; confirmation: SkillConfirmation | null }
export interface SkillService {
  search(input: { query: string; cursor: string | null; pageSize: number }): Promise<{ items: SkillCatalogItem[]; nextCursor: string | null; hasMore: boolean; mode: "fixture" | "live" }>;
  detail(slug: string): Promise<SkillDetail>;
  installed(): Promise<SkillCatalogItem[]>;
  startInstall(input: SkillMutationInput): Promise<SkillOperation>;
  startUpdate(input: SkillMutationInput): Promise<SkillOperation>;
  startUninstall(slug: string): Promise<SkillOperation>;
  setEnabled(input: SkillMutationInput & { enabled: boolean }): Promise<SkillOperation>;
  operation(id: string): Promise<SkillOperation>;
  waitForOperation(id: string): Promise<SkillOperation>;
}

const riskOrder: CapabilityRisk[] = ["low", "medium", "high", "critical"];
const emptyState = (): SkillState => ({ schemaVersion: 1, installed: {} });

function domainError(code: "FORBIDDEN" | "CONFIRMATION_REQUIRED" | "NOT_FOUND" | "CONFLICT", message: string) {
  return UClawErrorSchema.parse({ code, message, retryable: false, recoveryActions: [], causeDetails: {} });
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function pathExists(path: string): Promise<boolean> {
  try { await readFile(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EISDIR") return true;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    try { await readdir(path); return true; } catch { return false; }
  }
}

async function recoverTransactions(transactionDir: string, statePath: string): Promise<void> {
  const names = await readdir(transactionDir).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const journalPath = join(transactionDir, name);
    const journal = await readJson<Journal | null>(journalPath, null);
    if (!journal) continue;
    const state = await readJson<SkillState>(statePath, emptyState());
    if (journal.action === "replace") {
      const replacementMoved = await pathExists(journal.target) && !(await pathExists(journal.staging));
      if (journal.phase === "replaced" || replacementMoved) {
        await writeJsonAtomic(statePath, { ...state, installed: { ...state.installed, [journal.slug]: journal.nextRecord } });
        await rm(journal.backup, { recursive: true, force: true });
      } else {
        if (await pathExists(journal.backup)) {
          await rm(journal.target, { recursive: true, force: true });
          await rename(journal.backup, journal.target);
        }
        const installed = { ...state.installed };
        if (journal.previousRecord) installed[journal.slug] = journal.previousRecord;
        else delete installed[journal.slug];
        await writeJsonAtomic(statePath, { ...state, installed });
      }
    } else if (journal.phase === "committed") {
      const installed = { ...state.installed };
      delete installed[journal.slug];
      await writeJsonAtomic(statePath, { ...state, installed });
      await rm(journal.backup, { recursive: true, force: true });
    } else {
      if (await pathExists(journal.backup) && !(await pathExists(journal.target))) await rename(journal.backup, journal.target);
      await writeJsonAtomic(statePath, { ...state, installed: { ...state.installed, [journal.slug]: journal.previousRecord } });
    }
    await rm(journal.staging, { recursive: true, force: true });
    await rm(journalPath, { force: true });
  }
}

export async function createSkillService({
  dataDir,
  client,
  runMutation = (operation) => operation(),
}: {
  dataDir: string;
  client: SkillHubClient;
  runMutation?: <T>(operation: () => Promise<T>) => Promise<T>;
}): Promise<SkillService> {
  const root = join(dataDir, "capabilities");
  const skillsDir = join(root, "skills");
  const transactionDir = join(root, ".skill-transactions");
  const statePath = join(root, "skill-state.json");
  await mkdir(skillsDir, { recursive: true });
  await mkdir(transactionDir, { recursive: true });
  await recoverTransactions(transactionDir, statePath);
  let state = await readJson<SkillState>(statePath, emptyState());
  const operations = new Map<string, SkillOperation>();
  const tasks = new Map<string, Promise<void>>();

  const normalize = (detail: SkillDetail): SkillDetail => {
    const risk = detail.permissions.reduce<CapabilityRisk>((highest, permission) =>
      riskOrder.indexOf(permission.risk) > riskOrder.indexOf(highest) ? permission.risk : highest, "low");
    const permissionFingerprint = createHash("sha256").update(JSON.stringify(detail.permissions)).digest("hex");
    return { ...detail, risk, permissionFingerprint };
  };
  const project = (detail: SkillDetail): SkillCatalogItem => {
    const normalized = normalize(detail);
    const record = state.installed[detail.slug];
    return {
      slug: normalized.slug,
      name: normalized.name,
      description: normalized.description,
      version: normalized.version,
      pricingType: normalized.pricingType,
      installedVersion: record?.version ?? null,
      enabled: record?.enabled ?? false,
      updateAvailable: record !== undefined && record.version !== normalized.version,
      source: normalized.source,
      permissions: normalized.permissions,
      permissionFingerprint: normalized.permissionFingerprint,
      risk: normalized.risk,
      mode: normalized.mode,
    };
  };
  const loadRemoteDetail = async (slug: string): Promise<SkillDetail> => {
    const found = await client.detail(slug).catch(() => { throw domainError("NOT_FOUND", "Skill not found."); });
    const parsed = SkillDetailSchema.parse(found);
    if (parsed.pricingType === "paid") throw domainError("FORBIDDEN", "Paid Skills are not available.");
    const normalized = normalize(parsed);
    return { ...normalized, ...project(normalized) };
  };
  const loadDetail = async (slug: string): Promise<SkillDetail> => {
    try { return await loadRemoteDetail(slug); }
    catch (error) {
      if ((error as { code?: unknown })?.code === "FORBIDDEN") throw error;
      const snapshot = state.installed[slug]?.detail;
      if (snapshot) return { ...normalize(snapshot), ...project(snapshot) };
      throw error;
    }
  };
  const confirm = (detail: SkillDetail, confirmation: SkillConfirmation | null): void => {
    if (!confirmation || confirmation.permissionFingerprint !== detail.permissionFingerprint ||
      riskOrder.indexOf(confirmation.acceptedRisk) < riskOrder.indexOf(detail.risk)) {
      throw domainError("CONFIRMATION_REQUIRED", "Skill permissions require explicit confirmation.");
    }
  };
  const updateOperation = (id: string, patch: Partial<SkillOperation>) => {
    const current = operations.get(id);
    if (current) operations.set(id, { ...current, ...patch });
  };
  const start = (slug: string, action: SkillOperation["action"], task: (id: string) => Promise<void>): SkillOperation => {
    const operation: SkillOperation = { id: randomUUID(), slug, action, state: "queued", progress: 0, phase: "queued" };
    operations.set(operation.id, operation);
    const running = Promise.resolve().then(() => runMutation(async () => {
      updateOperation(operation.id, { state: "running", progress: 5, phase: "downloading" });
      try {
        await task(operation.id);
        updateOperation(operation.id, { state: "succeeded", progress: 100, phase: "complete" });
      } catch (error) {
        updateOperation(operation.id, { state: "failed", phase: "failed", error: "Skill operation failed. Retry or restart U-Claw for recovery." });
      }
    })).catch(() => {
      updateOperation(operation.id, { state: "failed", phase: "failed", error: "Skill operation failed. Retry or restart U-Claw for recovery." });
    });
    tasks.set(operation.id, running);
    void running.finally(() => tasks.delete(operation.id));
    return operation;
  };
  const installOrUpdate = async (detail: SkillDetail, action: "install" | "update", operationId: string): Promise<void> => {
    const bundle = await client.download(detail.slug);
    updateOperation(operationId, { progress: 25, phase: "validating" });
    const validated = validateSkillBundle(bundle, detail);
    const target = join(skillsDir, detail.slug);
    const staging = join(skillsDir, `.${detail.slug}.${operationId}.staging`);
    const backup = join(skillsDir, `.${detail.slug}.${operationId}.backup`);
    const journalPath = join(transactionDir, `${operationId}.json`);
    const stateBeforeOperation = state;
    const previousRecord = stateBeforeOperation.installed[detail.slug] ?? null;
    const nextRecord: InstalledRecord = { slug: detail.slug, version: detail.version, enabled: true, detail };
    let backedUp = false;
    let replaced = false;
    try {
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
      updateOperation(operationId, { progress: 50, phase: "staging" });
      for (const file of validated.files) {
        const destination = join(staging, ...file.path.split("/"));
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, file.content, { mode: 0o600 });
      }
      let journal: ReplaceJournal = { operationId, slug: detail.slug, action: "replace", target, staging, backup, phase: "staged", previousRecord, nextRecord };
      await writeJsonAtomic(journalPath, journal);
      if (await pathExists(target)) {
        await rename(target, backup);
        backedUp = true;
        journal = { ...journal, phase: "backed-up" };
        await writeJsonAtomic(journalPath, journal);
        if (client.failAfterBackup) throw new Error("Simulated interrupted replacement.");
      } else if (action === "update") throw domainError("NOT_FOUND", "Installed Skill not found.");
      updateOperation(operationId, { progress: 75, phase: "replacing" });
      await rename(staging, target);
      replaced = true;
      journal = { ...journal, phase: "replaced" };
      await writeJsonAtomic(journalPath, journal);
      state = { ...state, installed: { ...state.installed, [detail.slug]: nextRecord } };
      updateOperation(operationId, { progress: 90, phase: "persisting" });
      await writeJsonAtomic(statePath, state);
      await rm(backup, { recursive: true, force: true });
      await rm(journalPath, { force: true });
    } catch (error) {
      state = stateBeforeOperation;
      if (client.failAfterBackup && backedUp && !replaced) throw error;
      if (replaced) await rm(target, { recursive: true, force: true });
      if (backedUp && await pathExists(backup) && !(await pathExists(target))) await rename(backup, target);
      await writeJsonAtomic(statePath, stateBeforeOperation);
      await rm(staging, { recursive: true, force: true });
      await rm(backup, { recursive: true, force: true });
      await rm(journalPath, { force: true });
      throw error;
    }
  };

  return {
    async search(input) {
      const page = await client.search(input);
      const free = page.items.map((item) => SkillDetailSchema.parse(item)).filter((item) => item.pricingType === "free").map(project);
      return { ...page, items: free };
    },
    detail: loadDetail,
    async installed() {
      const items: SkillCatalogItem[] = [];
      for (const [slug, record] of Object.entries(state.installed)) {
        const detail = record.detail ?? await client.detail(slug);
        items.push(project(detail));
      }
      return items;
    },
    async startInstall(input) {
      const detail = await loadRemoteDetail(input.slug);
      if (state.installed[input.slug]) throw domainError("CONFLICT", "Skill is already installed.");
      confirm(detail, input.confirmation);
      return start(input.slug, "install", (id) => installOrUpdate(detail, "install", id));
    },
    async startUpdate(input) {
      const detail = await loadRemoteDetail(input.slug);
      if (!state.installed[input.slug]) throw domainError("NOT_FOUND", "Installed Skill not found.");
      confirm(detail, input.confirmation);
      return start(input.slug, "update", (id) => installOrUpdate(detail, "update", id));
    },
    async startUninstall(slug) {
      const previousRecord = state.installed[slug];
      if (!previousRecord) throw domainError("NOT_FOUND", "Installed Skill not found.");
      return start(slug, "uninstall", async (id) => {
        updateOperation(id, { progress: 50, phase: "replacing" });
        const target = join(skillsDir, slug);
        const backup = join(skillsDir, `.${slug}.${id}.backup`);
        const staging = join(skillsDir, `.${slug}.${id}.staging`);
        const journalPath = join(transactionDir, `${id}.json`);
        let journal: RemoveJournal = { operationId: id, slug, action: "remove", target, staging, backup, phase: "staged", previousRecord };
        await writeJsonAtomic(journalPath, journal);
        try {
          await rename(target, backup);
          journal = { ...journal, phase: "backed-up" };
          await writeJsonAtomic(journalPath, journal);
          const installed = { ...state.installed };
          delete installed[slug];
          state = { ...state, installed };
          await writeJsonAtomic(statePath, state);
          journal = { ...journal, phase: "committed" };
          await writeJsonAtomic(journalPath, journal);
          await rm(backup, { recursive: true, force: true });
          await rm(journalPath, { force: true });
        } catch (error) {
          if (await pathExists(backup) && !(await pathExists(target))) await rename(backup, target);
          state = { ...state, installed: { ...state.installed, [slug]: previousRecord } };
          await writeJsonAtomic(statePath, state);
          await rm(journalPath, { force: true });
          throw error;
        }
      });
    },
    async setEnabled(input) {
      const record = state.installed[input.slug];
      if (!record) throw domainError("NOT_FOUND", "Installed Skill not found.");
      const detail = input.enabled ? record.detail ?? await loadRemoteDetail(input.slug) : record.detail;
      if (input.enabled) confirm(detail!, input.confirmation);
      const action = input.enabled ? "enable" : "disable";
      const operation = start(input.slug, action, async (id) => {
        updateOperation(id, { progress: 70, phase: "persisting" });
        state = { ...state, installed: { ...state.installed, [input.slug]: { ...record, enabled: input.enabled, detail: detail ?? record.detail } } };
        await writeJsonAtomic(statePath, state);
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
