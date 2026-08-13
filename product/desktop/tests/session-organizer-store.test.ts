import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createSessionOrganizerStore, resolveSessionOrganizerPath } from "../src/session-organizer/store.js";

async function dataRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return join(root, "usb", ".uclaw", "data");
}

describe("session organizer USB store", () => {
  it("uses the fixed relative location on different drive roots and rejects path escape inputs", () => {
    const first = resolveSessionOrganizerPath(join(tmpdir(), "drive-e", ".uclaw", "data"));
    const second = resolveSessionOrganizerPath(join(tmpdir(), "drive-f", ".uclaw", "data"));
    expect(relative(join(tmpdir(), "drive-e"), first)).toBe(join(".uclaw", "data", "uclaw", "session-organizer.json"));
    expect(relative(join(tmpdir(), "drive-f"), second)).toBe(join(".uclaw", "data", "uclaw", "session-organizer.json"));
    expect(() => resolveSessionOrganizerPath("relative/data")).toThrow(/data root/i);
    expect(() => resolveSessionOrganizerPath(`${tmpdir()}\0escape`)).toThrow(/data root/i);
  });

  it("degrades corrupt or unknown JSON to empty metadata", async () => {
    const dataDir = await dataRoot("uclaw-organizer-corrupt-");
    const path = resolveSessionOrganizerPath(dataDir);
    await mkdir(join(dataDir, "uclaw"), { recursive: true });
    await writeFile(path, "{broken", "utf8");
    await expect(createSessionOrganizerStore(dataDir).load()).resolves.toEqual({ schemaVersion: 1, groups: [], sessions: [] });
    await writeFile(path, JSON.stringify({ schemaVersion: 99, groups: [], sessions: [] }), "utf8");
    await expect(createSessionOrganizerStore(dataDir).load()).resolves.toEqual({ schemaVersion: 1, groups: [], sessions: [] });
  });

  it("serializes concurrent writes without losing updates", async () => {
    const store = createSessionOrganizerStore(await dataRoot("uclaw-organizer-concurrent-"));
    await Promise.all([store.setPinned("session-a", true), store.setPinned("session-b", true), store.assignGroup("session-c", null)]);
    await expect(store.load()).resolves.toMatchObject({ sessions: [{ sessionId: "session-a", pinned: true }, { sessionId: "session-b", pinned: true }] });
  });

  it("flushes a same-directory temp file and preserves the old version when atomic replace fails", async () => {
    const dataDir = await dataRoot("uclaw-organizer-atomic-");
    await createSessionOrganizerStore(dataDir).setPinned("session-a", true);
    const path = resolveSessionOrganizerPath(dataDir);
    const before = await readFile(path, "utf8");
    const rename = vi.fn(async () => { throw new Error("atomic replace failed"); });
    await expect(createSessionOrganizerStore(dataDir, { rename }).setPinned("session-a", false)).rejects.toThrow("atomic replace failed");
    expect(await readFile(path, "utf8")).toBe(before);
    expect(rename).toHaveBeenCalledWith(expect.stringMatching(/session-organizer\.json\..+\.tmp$/), path);
  });

  it("rejects organizer directory symlinks", async () => {
    const dataDir = await dataRoot("uclaw-organizer-link-");
    const outside = await mkdtemp(join(tmpdir(), "uclaw-organizer-outside-"));
    await mkdir(dataDir, { recursive: true });
    await symlink(outside, join(dataDir, "uclaw"), "dir");
    await expect(createSessionOrganizerStore(dataDir).setPinned("session-a", true)).rejects.toThrow(/symbolic link/i);
    await expect(lstat(join(outside, "session-organizer.json"))).rejects.toThrow();
  });

  it("rejects a symlinked data root before creating organizer files", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-organizer-root-link-"));
    const outside = await mkdtemp(join(tmpdir(), "uclaw-organizer-root-outside-"));
    const linkedDataRoot = join(root, "data");
    await symlink(outside, linkedDataRoot, "dir");

    await expect(createSessionOrganizerStore(linkedDataRoot).setPinned("session-a", true)).rejects.toThrow(/symbolic link/i);
    await expect(lstat(join(outside, "uclaw", "session-organizer.json"))).rejects.toThrow();
  });

  it("supports group lifecycle and removes orphaned metadata after authoritative deletion", async () => {
    const store = createSessionOrganizerStore(await dataRoot("uclaw-organizer-groups-"), { createId: () => "group-1" });
    const group = await store.createGroup("发布计划");
    expect(group).toEqual({ id: "group-1", name: "发布计划" });
    await store.assignGroup("session-a", group.id);
    await store.setPinned("session-a", true);
    await store.renameGroup(group.id, "正式发布");
    await store.assignGroup("session-a", null);
    await store.removeSession("session-a");
    await expect(store.load()).resolves.toEqual({ schemaVersion: 1, groups: [{ id: "group-1", name: "正式发布" }], sessions: [] });
  });

  it("removes a group without deleting sessions and preserves pinned metadata", async () => {
    const store = createSessionOrganizerStore(await dataRoot("uclaw-organizer-remove-group-"), { createId: () => "group-1" });
    const group = await store.createGroup("客户项目");
    await store.assignGroup("session-pinned", group.id);
    await store.setPinned("session-pinned", true);
    await store.assignGroup("session-plain", group.id);

    await expect(store.removeGroup(group.id)).resolves.toEqual({
      schemaVersion: 1,
      groups: [],
      sessions: [{ sessionId: "session-pinned", pinned: true }],
    });
  });
});
