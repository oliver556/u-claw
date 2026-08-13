import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupAttachmentCache, startAttachmentCleanup } from "../src/attachments/attachment-cleanup.js";

describe("attachment cleanup", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  async function fixture() {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-attachment-cleanup-"));
    roots.push(dataDir);
    const root = join(dataDir, "uclaw", "attachments");
    await mkdir(join(root, "objects", "expired"), { recursive: true });
    await mkdir(join(root, "objects", "active"), { recursive: true });
    await mkdir(join(root, "imports", "partial"), { recursive: true });
    for (const id of ["expired", "active"]) await writeFile(join(root, "objects", id, "metadata.json"), JSON.stringify({ id, lastUsedAt: 1 }));
    await writeFile(join(root, "imports", "partial", "content.part"), "partial");
    const old = new Date(1);
    await utimes(join(root, "imports", "partial"), old, old);
    return { dataDir, root };
  }

  it("deletes files and intermediate imports older than 24 hours but protects draft/queue references", async () => {
    const { dataDir, root } = await fixture();
    const result = await cleanupAttachmentCache({ dataDir, now: () => 25 * 60 * 60 * 1000, referencedAttachmentIds: new Set(["active"]) });
    expect(result).toEqual({ removedAttachments: 1, removedImports: 1 });
    await expect(import("node:fs/promises").then(({ stat }) => stat(join(root, "objects", "expired")))).rejects.toThrow();
    await expect(import("node:fs/promises").then(({ stat }) => stat(join(root, "objects", "active")))).resolves.toBeDefined();
    expect(JSON.parse(await readFile(join(root, "objects", "active", "metadata.json"), "utf8")).lastUsedAt).toBe(25 * 60 * 60 * 1000);
  });

  it("runs cleanup immediately at startup and provides a disposer", async () => {
    const { dataDir, root } = await fixture();
    const controller = startAttachmentCleanup({ dataDir, now: () => 25 * 60 * 60 * 1000, referencedAttachmentIds: () => new Set() , intervalMs: 60_000 });
    await controller.started;
    await expect(import("node:fs/promises").then(({ stat }) => stat(join(root, "objects", "expired")))).rejects.toThrow();
    controller.dispose();
  });

  it("rejects a cache root symlink instead of deleting outside paths", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-cleanup-link-"));
    const outside = await mkdtemp(join(tmpdir(), "uclaw-cleanup-outside-"));
    roots.push(dataDir, outside);
    await mkdir(join(dataDir, "uclaw"));
    await import("node:fs/promises").then(({ symlink }) => symlink(outside, join(dataDir, "uclaw", "attachments")));
    await expect(cleanupAttachmentCache({ dataDir })).rejects.toThrow(/symlink|unsafe/i);
  });
});
