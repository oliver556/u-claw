import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { AttachmentManager, AttachmentServiceError } from "../src/index.js";

describe("AttachmentManager", () => {
  const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "../fixtures/openclaw-2026.7.1-2/attachments.json"), "utf8"));

  it.each(["image", "text"])("imports the real %s attachment fixture", async (kind) => {
    const sample = fixture.cases.find((item: { kind: string }) => item.kind === kind).requestFrame.params.attachments[0];
    const size = Buffer.from(sample.content, "base64").byteLength;
    const manager = new AttachmentManager();
    await expect(manager.import({ name: sample.fileName, mediaType: sample.mimeType, size, contentBase64: sample.content }))
      .resolves.toMatchObject({ state: "ready", file: { name: sample.fileName, mediaType: sample.mimeType, size } });
  });

  it("maps the real oversized fixture to FILE_TOO_LARGE", async () => {
    const sample = fixture.cases.find((item: { kind: string }) => item.kind === "oversized").requestFrame.params.attachments[0];
    const size = Buffer.from(sample.content, "base64").byteLength;
    const error = await new AttachmentManager({ maxBytes: 1048 }).import({
      name: sample.fileName, mediaType: sample.mimeType, size, contentBase64: sample.content,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AttachmentServiceError);
    expect((error as AttachmentServiceError).uclawError.code).toBe("FILE_TOO_LARGE");
  });

  it("validates size and MIME from bytes with explicit errors", async () => {
    const manager = new AttachmentManager({ maxBytes: 8 });
    const oversized = await manager.import({ name: "large.txt", mediaType: "text/plain", size: 9, contentBase64: "MTIzNDU2Nzg5" }).catch((error: unknown) => error);
    expect(oversized).toBeInstanceOf(AttachmentServiceError);
    expect((oversized as AttachmentServiceError).uclawError.code).toBe("FILE_TOO_LARGE");

    const mismatch = await manager.import({ name: "fake.png", mediaType: "image/png", size: 8, contentBase64: "Y29udHJhY3Q=" }).catch((error: unknown) => error);
    expect(mismatch).toBeInstanceOf(AttachmentServiceError);
    expect((mismatch as AttachmentServiceError).uclawError.code).toBe("FILE_TYPE_UNSUPPORTED");
  });

  it("moves failed attachments back through validating and ready on retry", async () => {
    const manager = new AttachmentManager();
    const imported = await manager.import({ name: "fixture.txt", mediaType: "text/plain", size: 8, contentBase64: "Y29udHJhY3Q=" });
    manager.markUploading(imported.id, 0.5);
    manager.markFailed(imported.id, { code: "UNAVAILABLE", message: "发送失败", retryable: true });
    const states = [];
    for await (const attachment of manager.prepare(imported.id)) states.push(attachment.state);
    expect(states).toEqual(["validating", "ready"]);
  });

  it("does not regress an attached terminal state during prepare", async () => {
    const manager = new AttachmentManager();
    const imported = await manager.import({ name: "fixture.txt", mediaType: "text/plain", size: 8, contentBase64: "Y29udHJhY3Q=" });
    manager.markAttached(imported.id);
    const states = [];
    for await (const attachment of manager.prepare(imported.id)) states.push(attachment.state);
    expect(states).toEqual(["attached"]);
    expect(await manager.get(imported.id)).toMatchObject({ state: "attached", progress: 1 });
  });
});
