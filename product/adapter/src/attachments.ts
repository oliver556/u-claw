import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import {
  AttachmentImportInputSchema,
  AttachmentSchema,
  MAX_ATTACHMENT_BYTES,
  MAX_VIDEO_ATTACHMENT_BYTES,
  UClawErrorSchema,
  type Attachment,
  type AttachmentImportInput,
  type AttachmentService,
  type UClawErrorSummary,
} from "@uclaw/shared";

import { AdapterServiceError } from "./transport/rpc-router.js";

export interface OpenClawAttachment {
  type: "image" | "file";
  fileName: string;
  mimeType: string;
  content: string;
}

export interface ResolvedOpenClawAttachment extends OpenClawAttachment {
  byteLength: number;
}

export interface OpenClawAttachmentResolver extends AttachmentService {
  resolveForSend(id: string): ResolvedOpenClawAttachment | Promise<ResolvedOpenClawAttachment>;
  markUploading?(id: string, progress: number): void;
  markAttached?(id: string): void;
  markFailed?(id: string, error: UClawErrorSummary): void;
}

export interface ControlledAttachmentResolverOptions {
  dataRoot: string;
  source: AttachmentService;
  beforeRead?: (id: string) => void | Promise<void>;
  afterInspect?: (id: string) => void | Promise<void>;
}

interface StoredAttachment {
  attachment: Attachment;
  contentBase64: string;
}

export interface AttachmentManagerOptions {
  maxBytes?: number;
  createId?: () => string;
}

export class AttachmentServiceError extends AdapterServiceError {
  constructor(code: "NOT_FOUND" | "FILE_TOO_LARGE" | "FILE_TYPE_UNSUPPORTED" | "INVALID_ARGUMENT", message: string, retryable = false) {
    super(message, UClawErrorSchema.parse({
      code, message, retryable,
      recoveryActions: retryable ? ["retry"] : [], causeDetails: {},
    }));
    this.name = "AttachmentServiceError";
  }
}

const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const FILE_MEDIA_TYPES = new Set(["text/plain", "application/pdf"]);
const VIDEO_MEDIA_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const READ_CHUNK_BYTES = 3 * 1024 * 1024;

function decodedBase64Length(content: string): number {
  if (content === "" || !/^[A-Za-z0-9+/]*={0,2}$/.test(content) || content.length % 4 !== 0) {
    throw new AttachmentServiceError("INVALID_ARGUMENT", "附件内容编码无效。");
  }
  const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  return (content.length / 4) * 3 - padding;
}

function decodeBase64(content: string): Buffer {
  const bytes = Buffer.from(content, "base64");
  if (bytes.toString("base64") !== content) throw new AttachmentServiceError("INVALID_ARGUMENT", "附件内容编码无效。");
  return bytes;
}

function matchesMediaType(bytes: Buffer, mediaType: string): boolean {
  if (mediaType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mediaType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mediaType === "image/gif") return bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a";
  if (mediaType === "image/webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (mediaType === "application/pdf") return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  if (mediaType === "video/webm") return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mediaType === "video/mp4" || mediaType === "video/quicktime") {
    if (bytes.subarray(4, 8).toString("ascii") !== "ftyp") return false;
    return mediaType === "video/quicktime"
      ? bytes.subarray(8, 12).toString("ascii") === "qt  "
      : bytes.subarray(8, 12).toString("ascii") !== "qt  ";
  }
  if (mediaType === "text/plain") {
    if (bytes.includes(0)) return false;
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; } catch { return false; }
  }
  return false;
}

function controlledContentPath(dataRoot: string, relativePath: string | undefined): string {
  if (relativePath === undefined || relativePath.includes("\0") || isAbsolute(relativePath)) {
    throw new AttachmentServiceError("INVALID_ARGUMENT", "附件缓存引用无效。");
  }
  const root = resolve(dataRoot, "uclaw", "attachments", "objects");
  const content = resolve(dataRoot, relativePath);
  const pathFromRoot = relative(root, content);
  if (pathFromRoot === "" || pathFromRoot === ".." || pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(pathFromRoot)) {
    throw new AttachmentServiceError("INVALID_ARGUMENT", "附件缓存引用越出受控目录。");
  }
  return content;
}

export function createControlledAttachmentResolver(options: ControlledAttachmentResolverOptions): OpenClawAttachmentResolver {
  const sendStates = new Map<string, Pick<Attachment, "state" | "progress" | "error">>();
  const withSendState = (attachment: Attachment): Attachment => ({ ...attachment, ...sendStates.get(attachment.id) });
  return {
    ...options.source,
    import: (input) => options.source.import(input),
    get: async (id) => withSendState(await options.source.get(id)),
    async *prepare(id, signal) {
      for await (const attachment of options.source.prepare(id, signal)) yield withSendState(attachment);
    },
    cancel: (id) => options.source.cancel(id),
    async remove(id) {
      await options.source.remove(id);
      sendStates.delete(id);
    },
    markUploading(id, progress) {
      sendStates.set(id, { state: "uploading", progress });
    },
    markAttached(id) {
      sendStates.set(id, { state: "attached", progress: 1 });
    },
    markFailed(id, failure) {
      sendStates.set(id, {
        state: "failed",
        error: { code: failure.code, message: "附件发送失败。", retryable: failure.retryable },
      });
    },
    async resolveForSend(id) {
      const attachment = await options.source.get(id);
      if (attachment.state !== "ready" && attachment.state !== "attached") {
        throw new AttachmentServiceError("INVALID_ARGUMENT", "附件尚未准备完成。");
      }
      const { mediaType, name, size, relativePath } = attachment.file;
      if (![...IMAGE_MEDIA_TYPES, ...VIDEO_MEDIA_TYPES, ...FILE_MEDIA_TYPES].includes(mediaType)) {
        throw new AttachmentServiceError("FILE_TYPE_UNSUPPORTED", `附件 MIME 不受支持：${mediaType}。`);
      }
      const maxBytes = VIDEO_MEDIA_TYPES.has(mediaType) ? MAX_VIDEO_ATTACHMENT_BYTES : MAX_ATTACHMENT_BYTES;
      if (size > maxBytes) throw new AttachmentServiceError("FILE_TOO_LARGE", `附件超过大小限制（${size} > ${maxBytes} bytes）。`);
      const contentPath = controlledContentPath(options.dataRoot, relativePath);
      await options.beforeRead?.(id);
      let before;
      try {
        before = await lstat(contentPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AttachmentServiceError("NOT_FOUND", "附件缓存不存在。");
        throw error;
      }
      if (!before.isFile() || before.isSymbolicLink() || before.size !== size) {
        throw new AttachmentServiceError("INVALID_ARGUMENT", "附件缓存已被替换或大小不匹配。");
      }
      await options.afterInspect?.(id);
      const root = await realpath(resolve(options.dataRoot, "uclaw", "attachments", "objects"));
      const actual = await realpath(contentPath);
      const actualRelative = relative(root, actual);
      if (actualRelative === "" || actualRelative === ".." || actualRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(actualRelative)) {
        throw new AttachmentServiceError("INVALID_ARGUMENT", "附件缓存越出受控目录。");
      }
      const handle = await open(contentPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== size || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) {
          throw new AttachmentServiceError("INVALID_ARGUMENT", "附件缓存已被替换。");
        }
        const header = Buffer.alloc(Math.min(64, size));
        if (header.length > 0) await handle.read(header, 0, header.length, 0);
        if (!matchesMediaType(header, mediaType)) {
          throw new AttachmentServiceError("FILE_TYPE_UNSUPPORTED", `附件 MIME 与内容不符：${mediaType}。`);
        }
        const chunks: string[] = [];
        const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, Math.max(1, size)));
        let offset = 0;
        while (offset < size) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
          if (bytesRead === 0) throw new AttachmentServiceError("INVALID_ARGUMENT", "附件缓存读取不完整。");
          chunks.push(buffer.subarray(0, bytesRead).toString("base64"));
          offset += bytesRead;
        }
        const after = await handle.stat();
        if (after.ino !== opened.ino || after.dev !== opened.dev || after.size !== size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
          throw new AttachmentServiceError("INVALID_ARGUMENT", "附件缓存发送前发生变化。");
        }
        return {
          type: IMAGE_MEDIA_TYPES.has(mediaType) ? "image" : "file",
          fileName: name,
          mimeType: mediaType,
          content: chunks.join(""),
          byteLength: size,
        };
      } finally {
        await handle.close();
      }
    },
  };
}

export class AttachmentManager implements OpenClawAttachmentResolver {
  private readonly items = new Map<string, StoredAttachment>();
  private readonly maxBytes: number;
  private readonly createId: () => string;

  constructor(options: AttachmentManagerOptions = {}) {
    this.maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
    this.createId = options.createId ?? (() => globalThis.crypto.randomUUID());
  }

  async import(input: AttachmentImportInput): Promise<Attachment> {
    const parsed = AttachmentImportInputSchema.parse(input);
    const encodedBytes = decodedBase64Length(parsed.contentBase64);
    if (encodedBytes > this.maxBytes) {
      throw new AttachmentServiceError("FILE_TOO_LARGE", `附件超过大小限制（${encodedBytes} > ${this.maxBytes} bytes）。`);
    }
    const bytes = decodeBase64(parsed.contentBase64);
    if (parsed.size !== bytes.byteLength) throw new AttachmentServiceError("INVALID_ARGUMENT", "附件大小与内容不一致。");
    if (bytes.byteLength > this.maxBytes) throw new AttachmentServiceError("FILE_TOO_LARGE", `附件超过大小限制（${bytes.byteLength} > ${this.maxBytes} bytes）。`);
    if (![...IMAGE_MEDIA_TYPES, ...FILE_MEDIA_TYPES].includes(parsed.mediaType) || !matchesMediaType(bytes, parsed.mediaType)) {
      throw new AttachmentServiceError("FILE_TYPE_UNSUPPORTED", `附件 MIME 与内容不符或不受支持：${parsed.mediaType}。`);
    }
    const id = `attachment-${this.createId()}`;
    const attachment = AttachmentSchema.parse({
      id,
      file: { id: `file-${id}`, name: parsed.name, mediaType: parsed.mediaType, size: parsed.size, kind: "attachment" },
      state: "ready", progress: 0,
    });
    this.items.set(id, { attachment, contentBase64: parsed.contentBase64 });
    return attachment;
  }

  async get(id: string): Promise<Attachment> {
    return this.require(id).attachment;
  }

  async *prepare(id: string, signal?: AbortSignal): AsyncIterable<Attachment> {
    const stored = this.require(id);
    if (signal?.aborted || stored.attachment.state === "cancelled") return;
    if (stored.attachment.state === "ready" || stored.attachment.state === "attached") {
      yield stored.attachment;
      return;
    }
    if (stored.attachment.state === "uploading") {
      throw new AttachmentServiceError("INVALID_ARGUMENT", "附件正在发送，不能重复准备。");
    }
    stored.attachment = AttachmentSchema.parse({ ...stored.attachment, state: "validating", progress: 0, error: undefined });
    yield stored.attachment;
    if (signal?.aborted) return;
    stored.attachment = AttachmentSchema.parse({ ...stored.attachment, state: "ready", progress: 0, error: undefined });
    yield stored.attachment;
  }

  async cancel(id: string): Promise<void> {
    const stored = this.require(id);
    if (stored.attachment.state === "attached") return;
    stored.attachment = AttachmentSchema.parse({ ...stored.attachment, state: "cancelled", error: undefined });
  }

  async remove(id: string): Promise<void> {
    this.require(id);
    this.items.delete(id);
  }

  resolveForSend(id: string): ResolvedOpenClawAttachment {
    const stored = this.require(id);
    if (stored.attachment.state !== "ready" && stored.attachment.state !== "attached") {
      throw new AttachmentServiceError("INVALID_ARGUMENT", "附件尚未准备完成。");
    }
    return {
      type: IMAGE_MEDIA_TYPES.has(stored.attachment.file.mediaType) ? "image" : "file",
      fileName: stored.attachment.file.name,
      mimeType: stored.attachment.file.mediaType,
      content: stored.contentBase64,
      byteLength: stored.attachment.file.size,
    };
  }

  markUploading(id: string, progress: number): void {
    const stored = this.require(id);
    stored.attachment = AttachmentSchema.parse({ ...stored.attachment, state: "uploading", progress, error: undefined });
  }

  markAttached(id: string): void {
    const stored = this.require(id);
    stored.attachment = AttachmentSchema.parse({ ...stored.attachment, state: "attached", progress: 1, error: undefined });
  }

  markFailed(id: string, error: UClawErrorSummary): void {
    const stored = this.require(id);
    stored.attachment = AttachmentSchema.parse({
      ...stored.attachment,
      state: "failed",
      error: { code: error.code, message: "附件发送失败。", retryable: error.retryable },
    });
  }

  private require(id: string): StoredAttachment {
    const stored = this.items.get(id);
    if (stored === undefined) throw new AttachmentServiceError("NOT_FOUND", "附件不存在或已移除。");
    return stored;
  }
}
