import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  ChatQueueAddRequestSchema,
  ChatQueueDocumentSchema,
  ChatQueueUpdateRequestSchema,
  UClawErrorSchema,
  type ChatQueueAddRequest,
  type ChatQueueDocument,
  type ChatQueueItem,
  type ChatQueueUpdateRequest,
  type UClawErrorSummary,
} from "@uclaw/shared";

interface ChatQueueStoreOptions {
  now?: () => Date;
  createId?: () => string;
  replace?: typeof rename;
}

export interface ChatQueueStore {
  list(sessionId: string): Promise<ChatQueueDocument>;
  add(request: ChatQueueAddRequest): Promise<ChatQueueItem>;
  update(request: ChatQueueUpdateRequest): Promise<ChatQueueItem>;
  remove(sessionId: string, itemId: string): Promise<void>;
  claimNext(sessionId: string): Promise<ChatQueueItem | null>;
  claim(sessionId: string, itemId: string): Promise<ChatQueueItem>;
  acknowledge(sessionId: string, itemId: string): Promise<void>;
  fail(sessionId: string, itemId: string, error: UClawErrorSummary): Promise<ChatQueueItem>;
  restore(sessionId: string, itemId: string): Promise<ChatQueueItem>;
  listSessionIds(): Promise<string[]>;
  attachmentReferenceCount(attachmentId: string): Promise<number>;
}

const fileQueues = new Map<string, Promise<void>>();

function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const pending = fileQueues.get(key) ?? Promise.resolve();
  const result = pending.then(operation, operation);
  const settled = result.then(() => undefined, () => undefined);
  fileQueues.set(key, settled);
  void settled.finally(() => {
    if (fileQueues.get(key) === settled) fileQueues.delete(key);
  });
  return result;
}

function queueError(message: string, retryable = false) {
  return UClawErrorSchema.parse({ code: "OPERATION_FAILED", message, retryable, recoveryActions: retryable ? ["retry"] : [], causeDetails: {} });
}

function requireId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512 || value.includes("\0")) throw queueError(`Invalid ${label}.`);
  return trimmed;
}

export function resolveChatQueuePath(dataRoot: string, _sessionId?: string): string {
  if (!dataRoot || dataRoot.includes("\0") || !isAbsolute(dataRoot)) throw queueError("Invalid chat queue data root.");
  return join(resolve(dataRoot), "uclaw", "chat-queue.v1.json");
}

interface QueueAuthority {
  schemaVersion: 1;
  sessions: Record<string, ChatQueueDocument>;
  attachmentReferences: Record<string, number>;
}

const emptyAuthority = (): QueueAuthority => ({ schemaVersion: 1, sessions: {}, attachmentReferences: {} });

function parseAuthority(value: unknown): QueueAuthority {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid authority");
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1 || typeof candidate.sessions !== "object" || candidate.sessions === null || Array.isArray(candidate.sessions)) throw new Error("invalid authority");
  const sessions = Object.fromEntries(Object.entries(candidate.sessions as Record<string, unknown>).map(([sessionId, document]) => {
    const parsed = ChatQueueDocumentSchema.parse(document);
    if (parsed.sessionId !== sessionId) throw new Error("session mismatch");
    return [sessionId, parsed];
  })) as Record<string, ChatQueueDocument>;
  const attachmentReferences: Record<string, number> = {};
  for (const document of Object.values(sessions)) for (const item of document.items) {
    for (const attachmentId of item.attachmentIds) attachmentReferences[attachmentId] = (attachmentReferences[attachmentId] ?? 0) + 1;
  }
  return { schemaVersion: 1, sessions, attachmentReferences };
}

async function pathInfo(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function ensureDirectory(path: string): Promise<void> {
  const existing = await pathInfo(path);
  if (existing === null) await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw queueError("Chat queue storage directory is invalid.");
}

export function createChatQueueStore(dataRoot: string, options: ChatQueueStoreOptions = {}): ChatQueueStore {
  const root = resolve(dataRoot);
  const directory = join(root, "uclaw");
  const path = resolveChatQueuePath(root);
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? (() => `queue-${randomUUID()}`);
  const replace = options.replace ?? rename;

  const readAuthority = async (): Promise<QueueAuthority> => {
    await ensureDirectory(root);
    await ensureDirectory(directory);
    const info = await pathInfo(path);
    if (info === null) return emptyAuthority();
    if (info.isSymbolicLink() || !info.isFile()) throw queueError("Chat queue file is invalid.");
    try {
      return parseAuthority(JSON.parse(await readFile(path, "utf8")));
    } catch {
      throw queueError("Chat queue could not be read.");
    }
  };

  const readNow = async (sessionId: string): Promise<ChatQueueDocument> => {
    const normalizedSessionId = requireId(sessionId, "session ID");
    const authority = await readAuthority();
    return Object.hasOwn(authority.sessions, normalizedSessionId)
      ? authority.sessions[normalizedSessionId]!
      : { schemaVersion: 1, sessionId: normalizedSessionId, items: [] };
  };

  const writeNow = async (authority: QueueAuthority): Promise<void> => {
    const parsed = parseAuthority(authority);
    await ensureDirectory(root);
    await ensureDirectory(directory);
    const target = await pathInfo(path);
    if (target?.isSymbolicLink() || (target !== null && !target.isFile())) throw queueError("Chat queue file is invalid.");
    const temporaryPath = join(dirname(path), `.chat-queue.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let replaced = false;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await replace(temporaryPath, path);
      replaced = true;
    } catch {
      throw queueError("Chat queue could not be saved.", true);
    } finally {
      await handle?.close().catch(() => undefined);
      if (!replaced) await unlink(temporaryPath).catch(() => undefined);
    }
  };

  const transaction = <T>(sessionId: string, change: (document: ChatQueueDocument) => Promise<{ result: T; retain?: string[]; release?: string[] }> | { result: T; retain?: string[]; release?: string[] }): Promise<T> => {
    return serialize(path, async () => {
      const authority = await readAuthority();
      const normalizedSessionId = requireId(sessionId, "session ID");
      const document = Object.hasOwn(authority.sessions, normalizedSessionId)
        ? authority.sessions[normalizedSessionId]!
        : { schemaVersion: 1 as const, sessionId: normalizedSessionId, items: [] };
      const { result } = await change(document);
      const parsed = ChatQueueDocumentSchema.parse(document);
      authority.sessions[normalizedSessionId] = parsed;
      await writeNow(authority);
      return result;
    });
  };

  const find = (document: ChatQueueDocument, itemId: string): ChatQueueItem => {
    const item = document.items.find(({ id }) => id === itemId);
    if (!item) throw UClawErrorSchema.parse({ code: "NOT_FOUND", message: "Chat queue item was not found.", retryable: false, recoveryActions: [], causeDetails: {} });
    return item;
  };

  const setStatus = (sessionId: string, itemId: string, status: ChatQueueItem["status"], error?: UClawErrorSummary) => transaction(sessionId, (document) => {
    const item = find(document, itemId);
    const { error: _currentError, ...withoutError } = item;
    const updated = ChatQueueDocumentSchema.parse({
      ...document,
      items: document.items.map((candidate) => candidate.id === item.id ? {
        ...withoutError, status, updatedAt: now().toISOString(), ...(error === undefined ? {} : { error }),
      } : candidate),
    }).items.find(({ id }) => id === item.id)!;
    document.items = document.items.map((candidate) => candidate.id === item.id ? updated : candidate);
    return { result: updated };
  });

  const remove = (sessionId: string, itemId: string, allowSending = false): Promise<void> => transaction(sessionId, (document) => {
    const item = find(document, itemId);
    if (!allowSending && item.status === "sending") throw UClawErrorSchema.parse({ code: "CONFLICT", message: "Sending chat queue item cannot be removed.", retryable: true, recoveryActions: ["retry"], causeDetails: {} });
    document.items = document.items.filter(({ id }) => id !== itemId);
    return { result: undefined, release: item.attachmentIds };
  });

  return {
    list: (sessionId) => serialize(path, () => readNow(sessionId)),
    add: (input) => {
      const request = ChatQueueAddRequestSchema.parse(input);
      return transaction(request.sessionId, (document) => {
        if (document.items.some(({ idempotencyKey }) => idempotencyKey === request.idempotencyKey)) {
          throw UClawErrorSchema.parse({ code: "CONFLICT", message: "Chat queue idempotency key already exists.", retryable: false, recoveryActions: [], causeDetails: {} });
        }
        const timestamp = now().toISOString();
        const item: ChatQueueItem = {
          ...request, id: createId(), status: "queued", createdAt: timestamp, updatedAt: timestamp,
        };
        document.items.push(item);
        return { result: item, retain: item.attachmentIds };
      });
    },
    update: (input) => {
      const request = ChatQueueUpdateRequestSchema.parse(input);
      return transaction(request.sessionId, (document) => {
        const current = find(document, request.itemId);
        if (current.status === "sending") throw UClawErrorSchema.parse({ code: "CONFLICT", message: "Sending chat queue item cannot be changed.", retryable: true, recoveryActions: ["retry"], causeDetails: {} });
        const nextAttachmentIds = request.attachmentIds ?? current.attachmentIds;
        const { error: _currentError, modelId: currentModelId, skillId: currentSkillId, ...base } = current;
        const updated = {
          ...base,
          ...(request.text === undefined ? {} : { text: request.text }),
          ...(request.attachmentIds === undefined ? {} : { attachmentIds: request.attachmentIds }),
          ...(request.modelId === undefined ? currentModelId === undefined ? {} : { modelId: currentModelId } : request.modelId === null ? {} : { modelId: request.modelId }),
          ...(request.skillId === undefined ? currentSkillId === undefined ? {} : { skillId: currentSkillId } : request.skillId === null ? {} : { skillId: request.skillId }),
          status: "queued" as const, updatedAt: now().toISOString(),
        };
        const parsed = ChatQueueDocumentSchema.parse({ ...document, items: document.items.map((item) => item.id === current.id ? updated : item) });
        const result = parsed.items.find(({ id }) => id === current.id)!;
        document.items = parsed.items;
        return {
          result,
          retain: nextAttachmentIds.filter((id) => !current.attachmentIds.includes(id)),
          release: current.attachmentIds.filter((id) => !nextAttachmentIds.includes(id)),
        };
      });
    },
    remove: (sessionId, itemId) => remove(sessionId, itemId),
    claimNext: (sessionId) => transaction(sessionId, (document) => {
      const next = document.items.find(({ status }) => status === "queued" || status === "sending");
      if (!next) return { result: null };
      const claimed = { ...next, status: "sending" as const, updatedAt: now().toISOString(), error: undefined };
      document.items = document.items.map((item) => item.id === next.id ? claimed : item);
      return { result: claimed };
    }),
    claim: (sessionId, itemId) => setStatus(sessionId, itemId, "sending"),
    acknowledge: (sessionId, itemId) => remove(sessionId, itemId, true),
    fail: (sessionId, itemId, error) => setStatus(sessionId, itemId, "failed", error),
    restore: (sessionId, itemId) => setStatus(sessionId, itemId, "queued"),
    listSessionIds: () => serialize(path, async () => Object.keys((await readAuthority()).sessions).sort()),
    attachmentReferenceCount: (attachmentId) => serialize(path, async () => (await readAuthority()).attachmentReferences[requireId(attachmentId, "attachment ID")] ?? 0),
  };
}
