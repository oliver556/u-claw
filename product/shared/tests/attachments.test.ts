import { describe, expect, it } from "vitest";

import {
  AttachmentCategorySchema,
  AttachmentImportBeginInputSchema,
  AttachmentImportChunkInputSchema,
  AttachmentImportInputSchema,
  AttachmentIpcRequestSchema,
  AttachmentSchema,
  MAX_ATTACHMENT_BASE64_LENGTH,
  MAX_VIDEO_ATTACHMENT_BYTES,
} from "../src/index.js";

describe("attachment contracts", () => {
  it("models queue progress and retryable failures without exposing a path", () => {
    const attachment = AttachmentSchema.parse({
      id: "attachment-1",
      file: { id: "file-1", name: "fixture.png", mediaType: "image/png", size: 68, kind: "attachment" },
      state: "failed",
      progress: 0.5,
      error: { code: "UNAVAILABLE", message: "附件发送失败", retryable: true },
    });
    expect(attachment).toMatchObject({ state: "failed", progress: 0.5 });
    expect(JSON.stringify(attachment)).not.toContain("path");
  });

  it("accepts bytes for drag-drop but rejects renderer supplied paths", () => {
    const input = { name: "fixture.txt", mediaType: "text/plain", size: 8, contentBase64: "Y29udHJhY3Q=" };
    expect(AttachmentImportInputSchema.parse(input)).toEqual(input);
    expect(AttachmentIpcRequestSchema.parse({ method: "import", requestId: "request-1", params: input })).toBeTruthy();
    expect(AttachmentIpcRequestSchema.parse({ method: "get", requestId: "request-get", params: { attachmentId: "attachment-1" } })).toBeTruthy();
    expect(() => AttachmentIpcRequestSchema.parse({ method: "import", requestId: "request-2", params: { ...input, path: "C:\\secret.txt" } })).toThrow();
  });

  it("rejects oversized Base64 before attachment import", () => {
    expect(() => AttachmentImportInputSchema.parse({
      name: "large.txt",
      mediaType: "text/plain",
      size: 1,
      contentBase64: "A".repeat(MAX_ATTACHMENT_BASE64_LENGTH + 4),
    })).toThrow();
  });

  it("classifies supported image, video, and file MIME types", () => {
    expect(AttachmentCategorySchema.parse("video")).toBe("video");
    for (const mediaType of ["video/mp4", "video/quicktime", "video/webm"]) {
      expect(AttachmentImportBeginInputSchema.parse({ name: "clip.mp4", mediaType, size: 1 })).toMatchObject({ mediaType });
    }
    expect(() => AttachmentImportBeginInputSchema.parse({ name: "clip.avi", mediaType: "video/x-msvideo", size: 1 })).toThrow();
  });

  it("accepts video up to 500 MB and rejects larger files", () => {
    expect(AttachmentImportBeginInputSchema.parse({
      name: "clip.mp4",
      mediaType: "video/mp4",
      size: MAX_VIDEO_ATTACHMENT_BYTES,
    })).toBeTruthy();
    expect(() => AttachmentImportBeginInputSchema.parse({
      name: "clip.mp4",
      mediaType: "video/mp4",
      size: MAX_VIDEO_ATTACHMENT_BYTES + 1,
    })).toThrow();
  });

  it("keeps large bytes in bounded chunks and forbids video in legacy Base64 import", () => {
    expect(AttachmentImportChunkInputSchema.parse({
      importId: "import-1",
      offset: 0,
      contentBase64: "Y2h1bms=",
    })).toBeTruthy();
    expect(() => AttachmentImportInputSchema.parse({
      name: "clip.mp4",
      mediaType: "video/mp4",
      size: 8,
      contentBase64: "Y2h1bms=",
    })).toThrow();
  });
});
