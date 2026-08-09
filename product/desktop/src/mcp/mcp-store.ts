import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  MCP_CONFIG_VERSION,
  McpConfigDocumentSchema,
  McpServerDraftSchema,
  McpSnapshotSchema,
  UClawErrorSchema,
  type ManagedMcpServerSummary,
  type McpConfigDocument,
  type McpServerConfigEntry,
  type McpServerDraft,
  type McpSnapshot,
  type UClawError,
} from "@uclaw/shared";

import { assessMcpStdioPolicy } from "./stdio-policy.js";

export interface McpStore {
  list(): Promise<McpSnapshot>;
  create(server: McpServerDraft): Promise<McpSnapshot>;
  update(serverId: string, server: McpServerDraft): Promise<McpSnapshot>;
  remove(serverId: string): Promise<McpSnapshot>;
  setEnabled(serverId: string, enabled: boolean): Promise<McpSnapshot>;
  confirmRisk(serverId: string, fingerprint: string): Promise<McpSnapshot>;
  record(serverId: string, update: Partial<Pick<McpServerConfigEntry, "status" | "capabilitySummary" | "toolNames" | "resourceSchemes" | "lastCheckedAt" | "lastError">>): Promise<ManagedMcpServerSummary>;
  getForRuntime(serverId: string): Promise<McpServerConfigEntry>;
}

export interface CreateMcpStoreOptions {
  dataDir: string;
  runtimeAvailable(): boolean;
  writeAtomically?: (path: string, body: string) => Promise<void>;
}

const configFileName = "mcp-config.v1.json";
const emptyCapabilities = { tools: 0, resources: 0, prompts: 0 } as const;

function mcpError(code: UClawError["code"], message: string, retryable = false): UClawError {
  return UClawErrorSchema.parse({ code, message, retryable, recoveryActions: retryable ? ["retry"] : [], causeDetails: {} });
}

async function defaultAtomicWrite(path: string, body: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.${configFileName}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function pathInfo(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function ensureSafeDirectory(path: string): Promise<void> {
  const existing = await pathInfo(path);
  if (existing === null) await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error("MCP storage contains a symbolic link.");
  if (!info.isDirectory()) throw new Error("MCP storage directory is invalid.");
}

async function ensureSafeAncestors(boundary: string, path: string): Promise<void> {
  const resolved = resolve(path);
  const resolvedBoundary = resolve(boundary);
  const child = relative(resolvedBoundary, resolved);
  if (child.startsWith("..") || isAbsolute(child)) throw new Error("MCP storage is outside its portable boundary.");
  const ancestors: string[] = [];
  for (let current = resolved; ; current = dirname(current)) {
    ancestors.push(current);
    if (current === resolvedBoundary) break;
  }
  for (const ancestor of ancestors.reverse()) {
    const info = await lstat(ancestor);
    if (info.isSymbolicLink()) throw new Error("MCP storage ancestor contains a symbolic link.");
    if (!info.isDirectory()) throw new Error("MCP storage ancestor is invalid.");
  }
}

function hint(secret: string): string {
  return secret.length <= 4 ? "...****" : `...${secret.slice(-4)}`;
}

function toSummary(server: McpServerConfigEntry, runtimeAvailable: boolean): ManagedMcpServerSummary {
  const state = {
    status: !server.enabled ? "disabled" : runtimeAvailable ? server.status ?? "disconnected" : "unavailable",
    capabilitySummary: server.capabilitySummary ?? emptyCapabilities,
    toolNames: server.toolNames ?? [],
    resourceSchemes: server.resourceSchemes ?? [],
    ...(server.lastCheckedAt ? { lastCheckedAt: server.lastCheckedAt } : {}),
    ...(server.lastError ? { lastError: server.lastError } : {}),
  } as const;
  if (server.transport === "stdio") {
    const policy = assessMcpStdioPolicy(server);
    const risk = !policy.confirmationRequired ? "none"
      : server.confirmedRiskFingerprint === policy.fingerprint ? "confirmed" : "confirmation-required";
    return {
      id: server.id, name: server.name, enabled: server.enabled, transport: server.transport,
      executableId: server.executableId, risk,
      ...(risk === "confirmation-required" ? { riskFingerprint: policy.fingerprint } : {}),
      ...state,
    };
  }
  const { authentication } = server;
  return {
    id: server.id, name: server.name, enabled: server.enabled, transport: server.transport,
    endpointHint: new URL(server.url).hostname,
    authentication: authentication.type === "none"
      ? { type: "none", configured: false }
      : authentication.type === "bearer"
        ? { type: "bearer", configured: authentication.secret !== undefined, ...(authentication.secret ? { hint: hint(authentication.secret) } : {}) }
        : { type: "header", headerName: authentication.headerName, configured: authentication.secret !== undefined, ...(authentication.secret ? { hint: hint(authentication.secret) } : {}) },
    ...state,
  };
}

export function createMcpStore({ dataDir, runtimeAvailable, writeAtomically = defaultAtomicWrite }: CreateMcpStoreOptions): McpStore {
  const validDataDir = Boolean(dataDir) && !dataDir.includes("\0") && isAbsolute(dataDir);
  const storageRoot = validDataDir ? resolve(dataDir) : dataDir;
  const portableBoundary = validDataDir ? dirname(storageRoot) : dataDir;
  const storageDirectory = join(storageRoot, "mcp");
  const configPath = join(storageDirectory, configFileName);
  let loaded: McpConfigDocument | undefined;
  let degraded = false;
  let queue = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const ensureStorageBoundary = async (): Promise<void> => {
    if (!validDataDir) throw new Error("Invalid MCP data root.");
    await ensureSafeDirectory(storageRoot);
    await ensureSafeAncestors(portableBoundary, storageRoot);
    await ensureSafeDirectory(storageDirectory);
    const target = await pathInfo(configPath);
    if (target?.isSymbolicLink()) throw new Error("MCP configuration is a symbolic link.");
    if (target !== null && !target.isFile()) throw new Error("MCP configuration is invalid.");
  };
  const load = async (): Promise<McpConfigDocument> => {
    if (loaded) return loaded;
    try {
      await ensureStorageBoundary();
      loaded = McpConfigDocumentSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
    } catch (error) {
      degraded = (error as NodeJS.ErrnoException).code !== "ENOENT";
      loaded = { schemaVersion: MCP_CONFIG_VERSION, servers: [] };
    }
    return loaded;
  };
  const snapshot = (document: McpConfigDocument): McpSnapshot => McpSnapshotSchema.parse({
    schemaVersion: MCP_CONFIG_VERSION,
    storage: degraded ? { state: "degraded", message: "MCP 配置损坏，已降级为空配置。" } : { state: "healthy" },
    runtime: runtimeAvailable() ? { state: "available" } : { state: "unavailable", reason: "locked-runtime-no-mcp-rpc" },
    servers: document.servers.map((server) => toSummary(server, runtimeAvailable())),
  });
  const commit = async (document: McpConfigDocument): Promise<McpSnapshot> => {
    const parsed = McpConfigDocumentSchema.parse(document);
    try {
      await ensureStorageBoundary();
      await writeAtomically(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
    }
    catch { throw mcpError("DATA_WRITE_FAILED", "MCP configuration could not be saved.", true); }
    loaded = parsed;
    degraded = false;
    return snapshot(parsed);
  };
  const mutate = (change: (document: McpConfigDocument) => void): Promise<McpSnapshot> => serialize(async () => {
    const document = await load();
    if (degraded) throw mcpError("DATA_WRITE_FAILED", "MCP configuration is degraded and cannot be changed.");
    const next = structuredClone(document);
    change(next);
    return commit(next);
  });
  const requireServer = (document: McpConfigDocument, serverId: string): McpServerConfigEntry => {
    const server = document.servers.find(({ id }) => id === serverId);
    if (!server) throw mcpError("NOT_FOUND", "MCP server was not found.");
    return server;
  };
  return {
    list: () => serialize(async () => snapshot(await load())),
    create: (draft) => mutate((document) => {
      const server = McpServerDraftSchema.parse(draft);
      if (document.servers.some(({ id }) => id === server.id)) throw mcpError("CONFLICT", "MCP server ID already exists.");
      if (server.transport === "stdio" && !assessMcpStdioPolicy(server).allowed) throw mcpError("FORBIDDEN", "stdio configuration is blocked by policy.");
      document.servers.push(server);
    }),
    update: (serverId, draft) => mutate((document) => {
      const index = document.servers.findIndex(({ id }) => id === serverId);
      if (index < 0) throw mcpError("NOT_FOUND", "MCP server was not found.");
      const server = McpServerDraftSchema.parse(draft);
      if (server.id !== serverId) throw mcpError("INVALID_ARGUMENT", "MCP server ID cannot be changed.");
      if (server.transport === "stdio" && !assessMcpStdioPolicy(server).allowed) throw mcpError("FORBIDDEN", "stdio configuration is blocked by policy.");
      const previous = document.servers[index];
      if (server.transport === "stdio" && previous.transport === "stdio") {
        const fingerprint = assessMcpStdioPolicy(server).fingerprint;
        if (previous.confirmedRiskFingerprint === fingerprint) (server as McpServerConfigEntry).confirmedRiskFingerprint = fingerprint;
      }
      if (server.transport !== "stdio" && previous.transport !== "stdio" && server.authentication.type !== "none" && server.authentication.secret === undefined && previous.authentication.type === server.authentication.type) {
        server.authentication.secret = previous.authentication.secret;
      }
      document.servers[index] = server;
    }),
    remove: (serverId) => mutate((document) => {
      const index = document.servers.findIndex(({ id }) => id === serverId);
      if (index < 0) throw mcpError("NOT_FOUND", "MCP server was not found.");
      document.servers.splice(index, 1);
    }),
    setEnabled: (serverId, enabled) => mutate((document) => { requireServer(document, serverId).enabled = enabled; }),
    confirmRisk: (serverId, fingerprint) => mutate((document) => {
      const server = requireServer(document, serverId);
      if (server.transport !== "stdio") throw mcpError("INVALID_ARGUMENT", "Only stdio servers require risk confirmation.");
      const assessment = assessMcpStdioPolicy(server);
      if (!assessment.allowed || assessment.fingerprint !== fingerprint) throw mcpError("CONFLICT", "MCP risk fingerprint changed.");
      server.confirmedRiskFingerprint = fingerprint;
    }),
    record: (serverId, update) => serialize(async () => {
      const document = await load();
      if (degraded) throw mcpError("DATA_WRITE_FAILED", "MCP configuration is degraded and cannot be changed.");
      const next = structuredClone(document);
      Object.assign(requireServer(next, serverId), update);
      const saved = await commit(next);
      return saved.servers.find(({ id }) => id === serverId)!;
    }),
    getForRuntime: (serverId) => serialize(async () => structuredClone(requireServer(await load(), serverId))),
  };
}
