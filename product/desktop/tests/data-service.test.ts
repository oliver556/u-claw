import { link, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureFsSafePython } from "@openclaw/fs-safe";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it } from "vitest";

import { createDataService } from "../src/data/data-service.js";

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "uclaw-data-service-"));
  const workspace = join(dataDir, "workspace");
  await mkdir(join(workspace, "notes"), { recursive: true });
  await writeFile(join(workspace, "notes", "plan.md"), "plan v1", "utf8");
  await writeFile(join(workspace, "MEMORY.md"), "long term", "utf8");
  await mkdir(join(workspace, "memory"));
  await writeFile(join(workspace, "memory", "2026-08-09.md"), "daily body", "utf8");
  return { dataDir, workspace, service: createDataService({ dataDir }) };
}

describe("data service", () => {
  afterEach(() => {
    __setFsSafeTestHooksForTest(undefined);
    configureFsSafePython({ mode: "auto" });
  });

  it("pages and searches user files without exposing memory or absolute paths", async () => {
    const { dataDir, service } = await fixture();
    await writeFile(join(dataDir, "workspace", "notes", "todo.txt"), "todo", "utf8");
    const page = await service.dispatch({ method: "workspace.list", requestId: "1", params: { parentId: "notes", query: "p", limit: 1 } });
    expect(page).toMatchObject({ ok: true, result: { items: [{ id: "notes/plan.md", name: "plan.md", kind: "file" }], hasMore: false } });
    expect(JSON.stringify(page)).not.toContain(dataDir);
    const root = await service.dispatch({ method: "workspace.list", requestId: "2", params: { limit: 50 } });
    expect(JSON.stringify(root)).not.toMatch(/MEMORY\.md|"memory"/);
  });

  it("rejects symlink and hardlink traversal", async () => {
    const { workspace, service } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "uclaw-outside-"));
    await writeFile(join(outside, "secret.md"), "secret", "utf8");
    await symlink(outside, join(workspace, "linked"), "dir");
    await link(join(outside, "secret.md"), join(workspace, "notes", "hard.md"));
    for (const entryId of ["linked/secret.md", "notes/hard.md"]) {
      await expect(service.dispatch({ method: "workspace.read", requestId: entryId, params: { entryId } })).resolves.toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    }
  });

  it.each(["memory.md", "Memory/2026-08-09.md", "agents.md"])(
    "protects control and memory domains with Windows-compatible case folding: %s",
    async (entryId) => {
      const { service } = await fixture();
      await expect(service.dispatch({
        method: "workspace.read", requestId: entryId, params: { entryId },
      })).resolves.toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    },
  );

  it.each(["memory.md", "Memory/2026-08-09.md"])(
    "accepts only canonical OpenClaw memory domain casing: %s",
    async (memoryId) => {
      const { service } = await fixture();
      await expect(service.dispatch({
        method: "memory.read", requestId: memoryId, params: { memoryId },
      })).resolves.toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    },
  );

  it("rejects a parent directory swapped to an outside symlink during read", async () => {
    const { workspace, service } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "uclaw-race-outside-"));
    await writeFile(join(outside, "plan.md"), "outside secret", "utf8");
    let swapped = false;
    __setFsSafeTestHooksForTest({
      afterPreOpenLstat: async (filePath) => {
        if (swapped || !filePath.endsWith(join("notes", "plan.md"))) return;
        swapped = true;
        await rename(join(workspace, "notes"), join(workspace, "notes-original"));
        await symlink(outside, join(workspace, "notes"), "dir");
      },
    });

    const response = await service.dispatch({
      method: "workspace.read", requestId: "race", params: { entryId: "notes/plan.md" },
    });
    expect(swapped).toBe(true);
    expect(response).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(JSON.stringify(response)).not.toContain("outside secret");
  });

  it.each(["workspace.open", "workspace.reveal"] as const)(
    "fails closed for %s until a handle-bound native helper is available",
    async (method) => {
      const { dataDir } = await fixture();
      const service = createDataService({ dataDir });
      const response = await service.dispatch({
        method, requestId: method, params: { entryId: "notes/plan.md" },
      });
      expect(response).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    },
  );

  it("detects stale writes and preserves the current file", async () => {
    const { workspace, service } = await fixture();
    const read = await service.dispatch({ method: "workspace.read", requestId: "read", params: { entryId: "notes/plan.md" } }) as any;
    await writeFile(join(workspace, "notes", "plan.md"), "external update", "utf8");
    const response = await service.dispatch({
      method: "workspace.rename", requestId: "rename",
      params: { entryId: "notes/plan.md", name: "renamed.md", version: read.result.entry.version },
    });
    expect(response).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    await expect(readFile(join(workspace, "notes", "plan.md"), "utf8")).resolves.toBe("external update");
  });

  it("edits and deletes only OpenClaw-readable Markdown memory with version checks", async () => {
    const { workspace, service } = await fixture();
    const listed = await service.dispatch({ method: "memory.list", requestId: "list", params: { query: "2026", limit: 20 } }) as any;
    expect(listed.result.items.map((item: any) => item.id)).toEqual(["memory/2026-08-09.md"]);
    const read = await service.dispatch({ method: "memory.read", requestId: "read", params: { memoryId: "memory/2026-08-09.md" } }) as any;
    const written = await service.dispatch({ method: "memory.write", requestId: "write", params: { memoryId: read.result.memory.id, content: "updated body", version: read.result.memory.version } }) as any;
    expect(written).toMatchObject({ ok: true, result: { memory: { id: "memory/2026-08-09.md" } } });
    await expect(readFile(join(workspace, "memory", "2026-08-09.md"), "utf8")).resolves.toBe("updated body");
    const crossDomain = await service.dispatch({ method: "memory.delete", requestId: "bad", params: { memoryId: "notes/plan.md", version: "x", confirmed: true } });
    expect(crossDomain).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("does not report success when memory changes again immediately after atomic replacement", async () => {
    const { workspace, service } = await fixture();
    const read = await service.dispatch({
      method: "memory.read", requestId: "read", params: { memoryId: "MEMORY.md" },
    }) as any;
    configureFsSafePython({ mode: "off" });
    __setFsSafeTestHooksForTest({
      afterPinnedWriteFallbackRename: async (targetPath) => {
        if (targetPath.endsWith("MEMORY.md")) await writeFile(targetPath, "external update", "utf8");
      },
    });
    const response = await service.dispatch({
      method: "memory.write", requestId: "write",
      params: { memoryId: "MEMORY.md", content: "our update", version: read.result.memory.version },
    });
    expect(response).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    await expect(readFile(join(workspace, "MEMORY.md"), "utf8")).resolves.toBe("external update");
  });

  it("binds memory versions to a SHA-256 content identity", async () => {
    const { service } = await fixture();
    const read = await service.dispatch({
      method: "memory.read", requestId: "hash-version", params: { memoryId: "MEMORY.md" },
    }) as any;
    expect(read.result.memory.version).toMatch(/^sha256:[a-f0-9]{64}:/);
  });

  it("returns offline state without leaking host paths or memory bodies", async () => {
    const { dataDir, service } = await fixture();
    await service.setAvailableForTest(false);
    const response = await service.dispatch({ method: "memory.list", requestId: "offline", params: { limit: 20 } });
    expect(response).toMatchObject({ ok: false, error: { code: "USB_MISSING", retryable: true } });
    expect(JSON.stringify(response)).not.toContain(dataDir);
    expect(JSON.stringify(response)).not.toContain("daily body");
  });
});
