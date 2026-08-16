import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import {
  MAX_ATTACHMENT_BYTES, MAX_VIDEO_ATTACHMENT_BYTES, UClawErrorSchema,
  AttachmentMediaTypeSchema, attachmentCategoryForMediaType, type Attachment, type AttachmentImportBeginInput,
  type AttachmentImportChunkInput, type AttachmentImportFinishInput, type AttachmentImportInput,
  type AttachmentMediaType, type AttachmentService,
} from "@uclaw/shared";

interface ImportMetadata extends AttachmentImportBeginInput { id: string; offset: number; createdAt: number }
interface StoredMetadata { id: string; name: string; mediaType: AttachmentMediaType; size: number; createdAt: number; lastUsedAt: number }

export interface AttachmentCacheOptions {
  dataDir: string;
  now?: () => number;
  id?: () => string;
  availableBytes?: (path: string) => Promise<number>;
}
export interface AttachmentCache extends AttachmentService {
  beginImport(input: AttachmentImportBeginInput): Promise<{ importId: string }>;
  importChunk(input: AttachmentImportChunkInput): Promise<{ nextOffset: number }>;
  finishImport(input: AttachmentImportFinishInput): Promise<Attachment>;
  importFile(path: string): Promise<Attachment>;
  readPreview(id: string, range?: { offset: number; length: number }): Promise<Buffer>;
}

const error = (code: string, message: string) => UClawErrorSchema.parse({ code, message, retryable: false });
const validId = (id: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw error("FILE_OUTSIDE_ALLOWED_ROOT", "Attachment path escapes controlled root.");
  return id;
};
const limitFor = (mediaType: string) => mediaType.startsWith("video/") ? MAX_VIDEO_ATTACHMENT_BYTES : MAX_ATTACHMENT_BYTES;
const prefix = (bytes: Buffer, values: readonly number[]) => values.every((value, index) => bytes[index] === value);
const mediaTypes: Record<string, AttachmentMediaType> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".pdf": "application/pdf", ".txt": "text/plain",
};
function matchesMime(bytes: Buffer, mediaType: AttachmentMediaType): boolean {
  if (mediaType === "image/png") return prefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (mediaType === "image/jpeg") return prefix(bytes, [0xff, 0xd8, 0xff]);
  if (mediaType === "image/gif") return /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"));
  if (mediaType === "image/webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (mediaType === "application/pdf") return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  if (mediaType === "video/webm") return prefix(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
  if (mediaType === "video/mp4" || mediaType === "video/quicktime") {
    if (bytes.subarray(4, 8).toString("ascii") !== "ftyp") return false;
    return mediaType === "video/quicktime" ? bytes.subarray(8, 12).toString("ascii") === "qt  " : bytes.subarray(8, 12).toString("ascii") !== "qt  ";
  }
  return mediaType === "text/plain" && !bytes.includes(0) && Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes);
}
function toAttachment(metadata: StoredMetadata): Attachment {
  return { id: metadata.id, file: { id: metadata.id, name: metadata.name, mediaType: metadata.mediaType, size: metadata.size, kind: "attachment", relativePath: `uclaw/attachments/objects/${metadata.id}/content` }, category: attachmentCategoryForMediaType(metadata.mediaType), state: "ready" };
}

export function createAttachmentCache(options: AttachmentCacheOptions): AttachmentCache {
  const now = options.now ?? Date.now;
  const makeId = options.id ?? randomUUID;
  const references = new Map<string, number>();
  const free = options.availableBytes ?? (async (path: string) => { const info = await statfs(path); return info.bavail * info.bsize; });
  const roots = async () => {
    const data = options.dataDir;
    const paths = [data, join(data, "uclaw"), join(data, "uclaw", "attachments"), join(data, "uclaw", "attachments", "imports"), join(data, "uclaw", "attachments", "objects")];
    for (const path of paths) {
      const before = await lstat(path).catch((caught: NodeJS.ErrnoException) => caught.code === "ENOENT" ? undefined : Promise.reject(caught));
      if (before?.isSymbolicLink()) throw new Error(`Unsafe attachment symlink: ${path}`);
      await mkdir(path, { recursive: true });
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe attachment directory: ${path}`);
    }
    return { root: paths[2], imports: paths[3], objects: paths[4] };
  };
  const importDir = async (id: string) => join((await roots()).imports, validId(id));
  const objectDir = async (id: string) => join((await roots()).objects, validId(id));
  const readImport = async (id: string) => JSON.parse(await readFile(join(await importDir(id), "metadata.json"), "utf8")) as ImportMetadata;
  const readStored = async (id: string): Promise<StoredMetadata> => {
    try {
      const dir = await objectDir(id);
      const info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) throw error("FILE_OUTSIDE_ALLOWED_ROOT", "Unsafe attachment path.");
      return JSON.parse(await readFile(join(dir, "metadata.json"), "utf8")) as StoredMetadata;
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "ENOENT") throw error("NOT_FOUND", "Attachment not found.");
      throw caught;
    }
  };
  const beginImport = async (input: AttachmentImportBeginInput) => {
    const limit = limitFor(input.mediaType);
    if (input.size > limit) throw error("FILE_TOO_LARGE", `Attachment exceeds ${limit} bytes.`);
    const cache = await roots();
    if (await free(cache.root) < input.size) throw error("USB_READ_ONLY", "Insufficient free space for attachment import.");
    const id = validId(makeId());
    const dir = join(cache.imports, id);
    await mkdir(dir);
    await writeFile(join(dir, "metadata.json"), JSON.stringify({ ...input, id, offset: 0, createdAt: now() } satisfies ImportMetadata), { flag: "wx", mode: 0o600 });
    const handle = await open(join(dir, "content.part"), "wx", 0o600); await handle.close();
    return { importId: id };
  };
  const importChunk = async (input: AttachmentImportChunkInput) => {
    const metadata = await readImport(input.importId);
    if (input.offset !== metadata.offset) throw error("CONFLICT", "Attachment chunk offset is not contiguous.");
    const chunk = Buffer.from(input.contentBase64, "base64");
    if (!chunk.length || chunk.toString("base64").replace(/=+$/, "") !== input.contentBase64.replace(/=+$/, "")) throw error("INVALID_ARGUMENT", "Invalid Base64 chunk.");
    const nextOffset = metadata.offset + chunk.length;
    if (nextOffset > metadata.size || nextOffset > limitFor(metadata.mediaType)) throw error("FILE_TOO_LARGE", "Attachment chunk exceeds declared size.");
    const dir = await importDir(input.importId);
    const handle = await open(join(dir, "content.part"), "r+");
    try { await handle.write(chunk, 0, chunk.length, metadata.offset); await handle.sync(); } finally { await handle.close(); }
    await writeFile(join(dir, "metadata.json"), JSON.stringify({ ...metadata, offset: nextOffset }), { mode: 0o600 });
    return { nextOffset };
  };
  const finishImport = async (input: AttachmentImportFinishInput) => {
    const metadata = await readImport(input.importId);
    if (metadata.offset !== metadata.size) throw error("CONFLICT", "Attachment import is incomplete.");
    const source = await importDir(input.importId);
    const part = join(source, "content.part");
    if ((await stat(part)).size !== metadata.size) throw error("CONFLICT", "Attachment size changed before completion.");
    const header = Buffer.alloc(Math.min(metadata.size, 64));
    const handle = await open(part, "r");
    try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
    if (!matchesMime(header, metadata.mediaType)) throw error("FILE_TYPE_UNSUPPORTED", "Attachment content does not match declared MIME type.");
    const stored: StoredMetadata = { id: metadata.id, name: metadata.name, mediaType: metadata.mediaType, size: metadata.size, createdAt: metadata.createdAt, lastUsedAt: now() };
    await rename(join(source, "content.part"), join(source, "content"));
    await writeFile(join(source, "metadata.json"), JSON.stringify(stored), { mode: 0o600 });
    await rename(source, await objectDir(metadata.id));
    return toAttachment(stored);
  };
  const get = async (id: string) => toAttachment(await readStored(id));
  const importFile = async (path: string) => {
    const source = await lstat(path);
    if (!source.isFile() || source.isSymbolicLink()) throw error("FILE_OUTSIDE_ALLOWED_ROOT", "Selected attachment must be a regular non-symlink file.");
    const mediaType = mediaTypes[extname(path).toLowerCase()];
    if (!mediaType) throw error("FILE_TYPE_UNSUPPORTED", "Attachment MIME type is unsupported.");
    const { importId } = await beginImport({ name: basename(path), mediaType, size: source.size });
    let input;
    try { input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "ELOOP") throw error("FILE_OUTSIDE_ALLOWED_ROOT", "Selected attachment must not be a symlink.");
      throw caught;
    }
    try {
      const opened = await input.stat();
      if (!opened.isFile() || opened.size !== source.size || opened.ino !== source.ino || opened.dev !== source.dev) throw error("CONFLICT", "Selected attachment changed during import.");
      let offset = 0;
      const buffer = Buffer.alloc(4 * 1024 * 1024);
      while (offset < source.size) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, source.size - offset), offset);
        if (!bytesRead) throw error("CONFLICT", "Selected attachment changed during import.");
        await importChunk({ importId, offset, contentBase64: buffer.subarray(0, bytesRead).toString("base64") });
        offset += bytesRead;
      }
      const after = await lstat(path);
      if (after.isSymbolicLink() || after.size !== source.size || after.ino !== source.ino || after.dev !== source.dev) throw error("CONFLICT", "Selected attachment changed during import.");
      return await finishImport({ importId });
    } catch (caught) {
      await rm(await importDir(importId), { recursive: true, force: true });
      throw caught;
    } finally { await input.close(); }
  };
  return {
    beginImport, importChunk, finishImport, importFile, get,
    async import(input: AttachmentImportInput) {
      const parsed = AttachmentMediaTypeSchema.safeParse(input.mediaType);
      if (!parsed.success) throw error("FILE_TYPE_UNSUPPORTED", "Attachment MIME type is unsupported.");
      const { importId } = await beginImport({ name: input.name, mediaType: parsed.data, size: input.size });
      try { await importChunk({ importId, offset: 0, contentBase64: input.contentBase64 }); return await finishImport({ importId }); }
      catch (caught) { await rm(await importDir(importId), { recursive: true, force: true }); throw caught; }
    },
    async *prepare(id: string) {
      const metadata = await readStored(id);
      const updated = { ...metadata, lastUsedAt: now() };
      await writeFile(join(await objectDir(id), "metadata.json"), JSON.stringify(updated), { mode: 0o600 });
      yield toAttachment(updated);
    },
    async cancel(id: string) { await rm(await importDir(id), { recursive: true, force: true }); },
    async remove(id: string) { await rm(await objectDir(id), { recursive: true, force: true }); },
    async retain(id: string) {
      await readStored(id);
      references.set(id, (references.get(id) ?? 0) + 1);
    },
    async release(id: string) {
      await readStored(id);
      const remaining = Math.max(0, (references.get(id) ?? 0) - 1);
      if (remaining === 0) references.delete(id);
      else references.set(id, remaining);
      const metadata = await readStored(id);
      await writeFile(join(await objectDir(id), "metadata.json"), JSON.stringify({ ...metadata, lastUsedAt: now() }), { mode: 0o600 });
    },
    referencedAttachmentIds: () => new Set(references.keys()),
    async readPreview(id: string, range = { offset: 0, length: MAX_ATTACHMENT_BYTES }) {
      await readStored(id);
      const content = join(await objectDir(id), "content");
      const info = await lstat(content);
      if (!info.isFile() || info.isSymbolicLink()) throw error("FILE_OUTSIDE_ALLOWED_ROOT", "Unsafe attachment preview path.");
      if (!Number.isSafeInteger(range.offset) || range.offset < 0 || !Number.isSafeInteger(range.length) || range.length < 0 || range.length > MAX_ATTACHMENT_BYTES) {
        throw error("INVALID_ARGUMENT", "Invalid attachment preview range.");
      }
      const length = Math.min(range.length, Math.max(0, info.size - range.offset));
      const bytes = Buffer.alloc(length);
      const handle = await open(content, "r");
      try { await handle.read(bytes, 0, length, range.offset); } finally { await handle.close(); }
      return bytes;
    },
  };
}
