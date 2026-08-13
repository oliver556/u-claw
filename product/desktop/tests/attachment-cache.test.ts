import { lstat, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createAttachmentCache } from "../src/attachments/attachment-cache.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("body")]);

describe("attachment cache", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  async function setup(options: Record<string, unknown> = {}) {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-attachment-cache-"));
    roots.push(dataDir);
    return { dataDir, cache: createAttachmentCache({ dataDir, ...options }) };
  }

  it("streams chunks into the portable cache and publishes only after an atomic finish", async () => {
    const { dataDir, cache } = await setup();
    const { importId } = await cache.beginImport!({ name: "pixel.png", mediaType: "image/png", size: PNG.length });
    await cache.importChunk!({ importId, offset: 0, contentBase64: PNG.subarray(0, 8).toString("base64") });
    await expect(cache.get(importId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await cache.importChunk!({ importId, offset: 8, contentBase64: PNG.subarray(8).toString("base64") });
    const attachment = await cache.finishImport!({ importId });

    expect(attachment).toMatchObject({ category: "image", state: "ready", file: { name: "pixel.png", mediaType: "image/png", size: PNG.length } });
    expect(attachment.file.relativePath).toMatch(/^uclaw\/attachments\/objects\//);
    expect(await cache.readPreview(attachment.id)).toEqual(PNG);
    expect((await readdir(join(dataDir, "uclaw", "attachments", "imports"))).length).toBe(0);
  });

  it("rejects MIME spoofing, oversized declarations, out-of-order chunks, and insufficient free space", async () => {
    const { cache } = await setup({ availableBytes: vi.fn(async () => PNG.length - 1) });
    await expect(cache.beginImport!({ name: "pixel.png", mediaType: "image/png", size: PNG.length }))
      .rejects.toMatchObject({ code: "USB_READ_ONLY" });

    const { cache: normal } = await setup();
    await expect(normal.beginImport!({ name: "large.mp4", mediaType: "video/mp4", size: 500 * 1024 * 1024 + 1 }))
      .rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    const { importId } = await normal.beginImport!({ name: "fake.png", mediaType: "image/png", size: 4 });
    await expect(normal.importChunk!({ importId, offset: 1, contentBase64: Buffer.from("nope").toString("base64") }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await normal.importChunk!({ importId, offset: 0, contentBase64: Buffer.from("nope").toString("base64") });
    await expect(normal.finishImport!({ importId })).rejects.toMatchObject({ code: "FILE_TYPE_UNSUPPORTED" });
  });

  it("removes cancelled imports and refuses symlinked cache roots or escaped preview ids", async () => {
    const { dataDir, cache } = await setup();
    const { importId } = await cache.beginImport!({ name: "pixel.png", mediaType: "image/png", size: PNG.length });
    await cache.cancel(importId);
    await expect(lstat(join(dataDir, "uclaw", "attachments", "imports", importId))).rejects.toThrow();
    await expect(cache.readPreview("../outside")).rejects.toMatchObject({ code: "FILE_OUTSIDE_ALLOWED_ROOT" });

    const linkedData = await mkdtemp(join(tmpdir(), "uclaw-attachment-linked-"));
    const outside = await mkdtemp(join(tmpdir(), "uclaw-attachment-outside-"));
    roots.push(linkedData, outside);
    await writeFile(join(outside, "marker"), "safe");
    await symlink(outside, join(linkedData, "uclaw"));
    const linked = createAttachmentCache({ dataDir: linkedData });
    await expect(linked.beginImport!({ name: "pixel.png", mediaType: "image/png", size: PNG.length })).rejects.toThrow(/symlink|unsafe/i);
    expect(await readFile(join(outside, "marker"), "utf8")).toBe("safe");
  });

  it("refreshes last use when preparing an attachment for send", async () => {
    let now = 10;
    const { dataDir, cache } = await setup({ now: () => now });
    const { importId } = await cache.beginImport!({ name: "pixel.png", mediaType: "image/png", size: PNG.length });
    await cache.importChunk!({ importId, offset: 0, contentBase64: PNG.toString("base64") });
    const attachment = await cache.finishImport!({ importId });
    now = 20;
    for await (const _state of cache.prepare(attachment.id)) { /* consume */ }
    const metadata = JSON.parse(await readFile(join(dataDir, "uclaw", "attachments", "objects", attachment.id, "metadata.json"), "utf8"));
    expect(metadata.lastUsedAt).toBe(20);
  });

  it("imports a selected source file without renderer Base64 and rejects source symlinks", async () => {
    const { dataDir, cache } = await setup();
    const source = join(dataDir, "selected.png");
    await writeFile(source, PNG);
    const attachment = await cache.importFile(source);
    expect(await cache.readPreview(attachment.id)).toEqual(PNG);

    const linked = join(dataDir, "linked.png");
    await symlink(source, linked);
    await expect(cache.importFile(linked)).rejects.toMatchObject({ code: "FILE_OUTSIDE_ALLOWED_ROOT" });
  });
});
