import { describe, expect, it } from "vitest";

import { AttachmentImportInputSchema, AttachmentIpcRequestSchema, AttachmentSchema } from "../src/index.js";

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
});
