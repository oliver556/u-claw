import {
  AttachmentImportInputSchema,
  AttachmentSchema,
  MAX_ATTACHMENT_BYTES,
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
  if (mediaType === "text/plain") {
    if (bytes.includes(0)) return false;
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; } catch { return false; }
  }
  return false;
}

export class AttachmentManager implements AttachmentService {
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

  resolveForSend(id: string): OpenClawAttachment {
    const stored = this.require(id);
    if (stored.attachment.state !== "ready" && stored.attachment.state !== "attached") {
      throw new AttachmentServiceError("INVALID_ARGUMENT", "附件尚未准备完成。");
    }
    return {
      type: IMAGE_MEDIA_TYPES.has(stored.attachment.file.mediaType) ? "image" : "file",
      fileName: stored.attachment.file.name,
      mimeType: stored.attachment.file.mediaType,
      content: stored.contentBase64,
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
