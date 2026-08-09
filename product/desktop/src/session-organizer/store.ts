import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  SessionGroupSchema,
  SessionOrganizerDocumentSchema,
  emptySessionOrganizer,
  type SessionGroup,
  type SessionOrganizerDocument,
  type SessionOrganizerEntry,
} from "@uclaw/shared";

interface StoreOptions {
  rename?: typeof rename;
  createId?: () => string;
}

export interface SessionOrganizerStore {
  load(): Promise<SessionOrganizerDocument>;
  setPinned(sessionId: string, pinned: boolean): Promise<SessionOrganizerDocument>;
  createGroup(name: string): Promise<SessionGroup>;
  renameGroup(groupId: string, name: string): Promise<SessionGroup>;
  assignGroup(sessionId: string, groupId: string | null): Promise<SessionOrganizerDocument>;
  removeSession(sessionId: string): Promise<SessionOrganizerDocument>;
}

export function resolveSessionOrganizerPath(dataRoot: string): string {
  if (!dataRoot || dataRoot.includes("\0") || !isAbsolute(dataRoot)) throw new Error("Invalid session organizer data root.");
  return join(resolve(dataRoot), "uclaw", "session-organizer.json");
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
  if (info.isSymbolicLink()) throw new Error("Session organizer path contains a symbolic link.");
  if (!info.isDirectory()) throw new Error("Session organizer directory is invalid.");
}

class FileSessionOrganizerStore implements SessionOrganizerStore {
  private readonly dataRoot: string;
  private readonly path: string;
  private readonly directory: string;
  private readonly replace: typeof rename;
  private readonly createId: () => string;
  private pending: Promise<void> = Promise.resolve();

  constructor(dataRoot: string, options: StoreOptions) {
    this.dataRoot = resolve(dataRoot);
    this.path = resolveSessionOrganizerPath(this.dataRoot);
    this.directory = join(this.dataRoot, "uclaw");
    this.replace = options.rename ?? rename;
    this.createId = options.createId ?? (() => `group-${randomUUID()}`);
  }

  load(): Promise<SessionOrganizerDocument> {
    return this.pending.then(() => this.readNow());
  }

  setPinned(sessionId: string, pinned: boolean): Promise<SessionOrganizerDocument> {
    return this.mutate((document) => {
      const current = document.sessions.find((entry) => entry.sessionId === sessionId);
      return this.replaceEntry(document, {
        sessionId,
        pinned,
        ...(current?.groupId === undefined ? {} : { groupId: current.groupId }),
      });
    });
  }

  createGroup(name: string): Promise<SessionGroup> {
    const group = SessionGroupSchema.parse({ id: this.createId(), name });
    return this.enqueue(async () => {
      const document = await this.readNow();
      if (document.groups.some((item) => item.id === group.id || item.name === group.name)) throw new Error("Session group already exists.");
      await this.writeNow({ ...document, groups: [...document.groups, group] });
      return group;
    });
  }

  renameGroup(groupId: string, name: string): Promise<SessionGroup> {
    return this.enqueue(async () => {
      const document = await this.readNow();
      if (!document.groups.some((group) => group.id === groupId)) throw new Error("Session group was not found.");
      const group = SessionGroupSchema.parse({ id: groupId, name });
      if (document.groups.some((item) => item.id !== groupId && item.name === group.name)) throw new Error("Session group already exists.");
      await this.writeNow({ ...document, groups: document.groups.map((item) => item.id === groupId ? group : item) });
      return group;
    });
  }

  assignGroup(sessionId: string, groupId: string | null): Promise<SessionOrganizerDocument> {
    return this.mutate((document) => {
      if (groupId !== null && !document.groups.some((group) => group.id === groupId)) throw new Error("Session group was not found.");
      const current = document.sessions.find((entry) => entry.sessionId === sessionId);
      return this.replaceEntry(document, {
        sessionId,
        pinned: current?.pinned ?? false,
        ...(groupId === null ? {} : { groupId }),
      });
    });
  }

  removeSession(sessionId: string): Promise<SessionOrganizerDocument> {
    return this.mutate((document) => ({ ...document, sessions: document.sessions.filter((entry) => entry.sessionId !== sessionId) }));
  }

  private replaceEntry(document: SessionOrganizerDocument, entry: SessionOrganizerEntry): SessionOrganizerDocument {
    const sessions = document.sessions.filter((item) => item.sessionId !== entry.sessionId);
    if (entry.pinned || entry.groupId !== undefined) sessions.push(entry);
    sessions.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
    return { ...document, sessions };
  }

  private mutate(transform: (document: SessionOrganizerDocument) => SessionOrganizerDocument): Promise<SessionOrganizerDocument> {
    return this.enqueue(async () => {
      const document = SessionOrganizerDocumentSchema.parse(transform(await this.readNow()));
      await this.writeNow(document);
      return document;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readNow(): Promise<SessionOrganizerDocument> {
    await ensureDirectory(this.dataRoot);
    await ensureDirectory(this.directory);
    const info = await pathInfo(this.path);
    if (info === null) return emptySessionOrganizer();
    if (info.isSymbolicLink()) throw new Error("Session organizer file is a symbolic link.");
    if (!info.isFile()) throw new Error("Session organizer file is invalid.");
    try {
      return SessionOrganizerDocumentSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch {
      return emptySessionOrganizer();
    }
  }

  private async writeNow(document: SessionOrganizerDocument): Promise<void> {
    await ensureDirectory(this.dataRoot);
    await ensureDirectory(this.directory);
    const target = await pathInfo(this.path);
    if (target?.isSymbolicLink()) throw new Error("Session organizer file is a symbolic link.");
    if (target !== null && !target.isFile()) throw new Error("Session organizer file is invalid.");
    const tempPath = `${this.path}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let replaced = false;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(SessionOrganizerDocumentSchema.parse(document), null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.replace(tempPath, this.path);
      replaced = true;
    } finally {
      await handle?.close().catch(() => undefined);
      if (!replaced) await unlink(tempPath).catch(() => undefined);
    }
  }
}

export function createSessionOrganizerStore(dataRoot: string, options: StoreOptions = {}): SessionOrganizerStore {
  return new FileSessionOrganizerStore(dataRoot, options);
}
