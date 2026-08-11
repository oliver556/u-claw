import { link, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureFsSafePython } from "@openclaw/fs-safe";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";

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

  it("searches nested workspace paths from the authoritative root", async () => {
    const { workspace, service } = await fixture();
    await mkdir(join(workspace, "nested", ".private"), { recursive: true });
    await writeFile(join(workspace, "nested", ".private", "leak.md"), "hidden", "utf8");
    const response = await service.dispatch({
      method: "workspace.list", requestId: "nested-search", params: { query: "plan", limit: 20 },
    }) as any;

    expect(response.result.items.map((item: any) => item.id)).toEqual(["notes/plan.md"]);
    const protectedSearch = await service.dispatch({
      method: "workspace.list", requestId: "protected-search", params: { query: "2026-08-09", limit: 20 },
    }) as any;
    expect(protectedSearch.result.items).toEqual([]);
    const hiddenSearch = await service.dispatch({
      method: "workspace.list", requestId: "hidden-search", params: { query: ".private", limit: 20 },
    }) as any;
    expect(hiddenSearch.result.items).toEqual([]);
  });

  it.each([
    { searchLimits: { maxDepth: 1, maxEntries: 100, maxBytes: 10_000 }, setup: async (workspace: string) => mkdir(join(workspace, "one", "two"), { recursive: true }), query: "missing" },
    { searchLimits: { maxDepth: 10, maxEntries: 1, maxBytes: 10_000 }, setup: async (workspace: string) => writeFile(join(workspace, "second.txt"), "2", "utf8"), query: "missing" },
  ])("fails closed when search exceeds a filesystem budget", async ({ searchLimits, setup, query }) => {
    const { dataDir, workspace } = await fixture();
    await setup(workspace);
    const service = createDataService({ dataDir, searchLimits });
    await expect(service.dispatch({
      method: "workspace.list", requestId: "budget", params: { query, limit: 20 },
    })).resolves.toMatchObject({ ok: false, error: { code: "FILE_TOO_LARGE" } });
  });

  it("applies byte budgets to searched memory bodies but not workspace path listings", async () => {
    const { dataDir, workspace } = await fixture();
    await writeFile(join(workspace, "memory", "attachment.bin"), "x".repeat(100), "utf8");
    const bounded = createDataService({ dataDir, searchLimits: { maxDepth: 10, maxEntries: 100, maxBytes: 20 } });
    await expect(bounded.dispatch({
      method: "memory.list", requestId: "memory-non-markdown-byte-budget", params: { query: "daily", limit: 20 },
    })).resolves.toMatchObject({ ok: true });
    const service = createDataService({ dataDir, searchLimits: { maxDepth: 10, maxEntries: 100, maxBytes: 5 } });
    await expect(service.dispatch({
      method: "workspace.list", requestId: "workspace-byte-budget", params: { query: "plan", limit: 20 },
    })).resolves.toMatchObject({ ok: true });
    await expect(service.dispatch({
      method: "memory.list", requestId: "memory-byte-budget", params: { query: "daily", limit: 20 },
    })).resolves.toMatchObject({ ok: false, error: { code: "FILE_TOO_LARGE" } });
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

  it("rejects hidden segments anywhere in the OpenClaw memory domain", async () => {
    const { workspace, service } = await fixture();
    await mkdir(join(workspace, "memory", "archive", ".private"), { recursive: true });
    await writeFile(join(workspace, "memory", "archive", ".private", "secret.md"), "secret", "utf8");

    await expect(service.dispatch({
      method: "memory.read", requestId: "hidden-memory", params: { memoryId: "memory/archive/.private/secret.md" },
    })).resolves.toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

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

  it("opens and reveals only after the trusted shell adapter verifies the pinned target", async () => {
    const { dataDir, workspace } = await fixture();
    const invoked: Array<{ action: string; path: string }> = [];
    const service = createDataService({
      dataDir,
      workspaceShell: {
        invoke: async (action, target) => {
          await target.verify();
          invoked.push({ action, path: target.path });
        },
      },
    });

    for (const method of ["workspace.open", "workspace.reveal"] as const) {
      await expect(service.dispatch({
        method, requestId: method, params: { entryId: "notes/plan.md" },
      })).resolves.toMatchObject({ ok: true, result: null });
    }
    expect(invoked).toEqual([
      { action: "open", path: join(workspace, "notes", "plan.md") },
      { action: "reveal", path: join(workspace, "notes", "plan.md") },
    ]);
  });

  it("rejects a workspace target replaced after pinning but before the shell action", async () => {
    const { dataDir, workspace } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "uclaw-shell-race-"));
    await writeFile(join(outside, "secret.md"), "secret", "utf8");
    const shellAction = vi.fn();
    const service = createDataService({
      dataDir,
      workspaceShell: {
        invoke: async (_action, target) => {
          await rename(target.path, `${target.path}.original`);
          await symlink(join(outside, "secret.md"), target.path, "file");
          await target.verify();
          shellAction();
        },
      },
    });

    await expect(service.dispatch({
      method: "workspace.open", requestId: "replace", params: { entryId: "notes/plan.md" },
    })).resolves.toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(shellAction).not.toHaveBeenCalled();
  });

  it("rejects a workspace target modified in place after pinning but before the shell action", async () => {
    const { dataDir } = await fixture();
    const shellAction = vi.fn();
    const service = createDataService({
      dataDir,
      workspaceShell: {
        invoke: async (_action, target) => {
          await writeFile(target.path, "changed after pin", "utf8");
          await target.verify();
          shellAction();
        },
      },
    });

    await expect(service.dispatch({
      method: "workspace.open", requestId: "rewrite", params: { entryId: "notes/plan.md" },
    })).resolves.toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(shellAction).not.toHaveBeenCalled();
  });

  it("does not report shell success when the target is replaced during the OS action", async () => {
    const { dataDir } = await fixture();
    const service = createDataService({
      dataDir,
      workspaceShell: {
        invoke: async (_action, target) => {
          await rename(target.path, `${target.path}.original`);
          await writeFile(target.path, "replacement", "utf8");
        },
      },
    });
    await expect(service.dispatch({
      method: "workspace.open", requestId: "replace-during-action", params: { entryId: "notes/plan.md" },
    })).resolves.toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it.each(["linked/secret.md", "linked-inside/plan.md", "notes/hard.md"])("rejects unsafe shell target %s", async (entryId) => {
    const { dataDir, workspace } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "uclaw-shell-outside-"));
    await writeFile(join(outside, "secret.md"), "secret", "utf8");
    await symlink(outside, join(workspace, "linked"), "dir");
    await symlink(join(workspace, "notes"), join(workspace, "linked-inside"), "dir");
    await link(join(outside, "secret.md"), join(workspace, "notes", "hard.md"));
    const invoke = vi.fn();
    const service = createDataService({ dataDir, workspaceShell: { invoke } });

    await expect(service.dispatch({
      method: "workspace.reveal", requestId: entryId, params: { entryId },
    })).resolves.toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects shell path traversal before reaching the adapter", async () => {
    const { dataDir } = await fixture();
    const invoke = vi.fn();
    const service = createDataService({ dataDir, workspaceShell: { invoke } });

    await expect(service.dispatch({
      method: "workspace.open", requestId: "escape", params: { entryId: "../secret.md" },
    } as any)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

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

  it("does not delete a workspace object swapped after version validation", async () => {
    const { workspace, service } = await fixture();
    const read = await service.dispatch({ method: "workspace.read", requestId: "read-delete-race", params: { entryId: "notes/plan.md" } }) as any;
    configureFsSafePython({ mode: "off" });
    let swapped = false;
    __setFsSafeTestHooksForTest({
      beforeRootFallbackMutation: async (operation, targetPath) => {
        if (swapped || operation !== "move" || !targetPath.includes(".uclaw-data-staging")) return;
        swapped = true;
        await rename(join(workspace, "notes", "plan.md"), join(workspace, "notes", "original.md"));
        await writeFile(join(workspace, "notes", "plan.md"), "external replacement", "utf8");
      },
    });
    await expect(service.dispatch({
      method: "workspace.delete", requestId: "delete-race",
      params: { entryId: "notes/plan.md", version: read.result.entry.version, confirmed: true },
    })).resolves.toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(swapped).toBe(true);
    await expect(readFile(join(workspace, "notes", "plan.md"), "utf8")).resolves.toBe("external replacement");
  });

  it("fails closed and rolls back when a workspace source inode changes during move", async () => {
    const { workspace, service } = await fixture();
    const read = await service.dispatch({
      method: "workspace.read", requestId: "move-race-read", params: { entryId: "notes/plan.md" },
    }) as any;
    configureFsSafePython({ mode: "off" });
    let swapped = false;
    __setFsSafeTestHooksForTest({
      beforeRootFallbackMutation: async (operation, targetPath) => {
        if (swapped || operation !== "move" || !targetPath.endsWith(join("notes", "renamed.md"))) return;
        swapped = true;
        await rename(join(workspace, "notes", "plan.md"), join(workspace, "notes", "plan-original.md"));
        await writeFile(join(workspace, "notes", "plan.md"), "replacement", "utf8");
      },
    });

    await expect(service.dispatch({
      method: "workspace.rename", requestId: "move-race",
      params: { entryId: "notes/plan.md", name: "renamed.md", version: read.result.entry.version },
    })).resolves.toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(swapped).toBe(true);
    await expect(readFile(join(workspace, "notes", "plan.md"), "utf8")).resolves.toBe("replacement");
  });

  it("lets an injected coordinator own the versioned mutation boundary", async () => {
    const { dataDir, service: reader } = await fixture();
    const read = await reader.dispatch({
      method: "memory.read", requestId: "read", params: { memoryId: "MEMORY.md" },
    }) as any;
    const contexts: unknown[] = [];
    const service = createDataService({
      dataDir,
      mutationCoordinator: {
        runVersioned: async (context, operation) => {
          contexts.push(context);
          return operation();
        },
      },
    });

    await expect(service.dispatch({
      method: "memory.write", requestId: "write",
      params: { memoryId: "MEMORY.md", content: "coordinated", version: read.result.memory.version },
    })).resolves.toMatchObject({ ok: true });
    expect(contexts).toEqual([{
      method: "memory.write", id: "MEMORY.md", expectedVersion: read.result.memory.version,
    }]);
  });

  it("rejects an external change made before the coordinator enters the optimistic CAS operation", async () => {
    const { dataDir, workspace, service: reader } = await fixture();
    const read = await reader.dispatch({
      method: "memory.read", requestId: "read", params: { memoryId: "MEMORY.md" },
    }) as any;
    const service = createDataService({
      dataDir,
      mutationCoordinator: {
        runVersioned: async (_context, operation) => {
          await writeFile(join(workspace, "MEMORY.md"), "external update", "utf8");
          return operation();
        },
      },
    });

    await expect(service.dispatch({
      method: "memory.write", requestId: "write",
      params: { memoryId: "MEMORY.md", content: "our update", version: read.result.memory.version },
    })).resolves.toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    await expect(readFile(join(workspace, "MEMORY.md"), "utf8")).resolves.toBe("external update");
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

  it("searches Markdown memory content and persists edits and deletes across service recreation", async () => {
    const { dataDir, workspace, service } = await fixture();
    const searched = await service.dispatch({
      method: "memory.list", requestId: "content-search", params: { query: "daily body", limit: 20 },
    }) as any;
    expect(searched.result.items.map((item: any) => item.id)).toEqual(["memory/2026-08-09.md"]);

    const original = await service.dispatch({
      method: "memory.read", requestId: "read-before-restart", params: { memoryId: "memory/2026-08-09.md" },
    }) as any;
    await service.dispatch({
      method: "memory.write", requestId: "write-before-restart",
      params: { memoryId: original.result.memory.id, content: "persisted body", version: original.result.memory.version },
    });

    const restarted = createDataService({ dataDir });
    const persisted = await restarted.dispatch({
      method: "memory.read", requestId: "read-after-restart", params: { memoryId: "memory/2026-08-09.md" },
    }) as any;
    expect(persisted.result.content).toBe("persisted body");
    await restarted.dispatch({
      method: "memory.delete", requestId: "delete-before-restart",
      params: { memoryId: persisted.result.memory.id, version: persisted.result.memory.version, confirmed: true },
    });

    const restartedAgain = createDataService({ dataDir });
    await expect(restartedAgain.dispatch({
      method: "memory.read", requestId: "read-after-delete-restart", params: { memoryId: "memory/2026-08-09.md" },
    })).resolves.toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    await expect(readFile(join(workspace, "MEMORY.md"), "utf8")).resolves.toBe("long term");
  });

  it("recovers an authority file staged by an interrupted mutation after service recreation", async () => {
    const { dataDir, workspace } = await fixture();
    const transactionDir = join(workspace, ".uclaw-data-staging", "interrupted");
    await mkdir(transactionDir, { recursive: true });
    await writeFile(join(transactionDir, "journal.json"), `${JSON.stringify({ schemaVersion: 1, id: "MEMORY.md" })}\n`, "utf8");
    await rename(join(workspace, "MEMORY.md"), join(transactionDir, "payload"));

    const restarted = createDataService({ dataDir });
    await expect(restarted.dispatch({
      method: "memory.read", requestId: "recover-staged-memory", params: { memoryId: "MEMORY.md" },
    })).resolves.toMatchObject({ ok: true, result: { content: "long term" } });
  });

  it("garbage-collects an empty transaction left before journal creation or after cleanup", async () => {
    const { dataDir, workspace } = await fixture();
    await mkdir(join(workspace, ".uclaw-data-staging", "empty-transaction"), { recursive: true });
    const restarted = createDataService({ dataDir });
    await expect(restarted.dispatch({
      method: "memory.read", requestId: "recover-empty-transaction", params: { memoryId: "MEMORY.md" },
    })).resolves.toMatchObject({ ok: true, result: { content: "long term" } });
  });

  it("persists workspace rename, move and delete across service recreation", async () => {
    const { dataDir, service } = await fixture();
    const original = await service.dispatch({
      method: "workspace.read", requestId: "workspace-original", params: { entryId: "notes/plan.md" },
    }) as any;
    const renamed = await service.dispatch({
      method: "workspace.rename", requestId: "workspace-rename",
      params: { entryId: original.result.entry.id, name: "renamed.md", version: original.result.entry.version },
    }) as any;
    const moved = await createDataService({ dataDir }).dispatch({
      method: "workspace.move", requestId: "workspace-move",
      params: { entryId: renamed.result.id, version: renamed.result.version },
    }) as any;
    const restarted = createDataService({ dataDir });
    const readBack = await restarted.dispatch({
      method: "workspace.read", requestId: "workspace-read-back", params: { entryId: moved.result.id },
    }) as any;
    expect(readBack.result.content).toBe("plan v1");
    await restarted.dispatch({
      method: "workspace.delete", requestId: "workspace-delete",
      params: { entryId: readBack.result.entry.id, version: readBack.result.entry.version, confirmed: true },
    });
    await expect(createDataService({ dataDir }).dispatch({
      method: "workspace.read", requestId: "workspace-read-deleted", params: { entryId: moved.result.id },
    })).resolves.toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("does not report success when memory changes again immediately after atomic replacement", async () => {
    const { workspace, service } = await fixture();
    const read = await service.dispatch({
      method: "memory.read", requestId: "read", params: { memoryId: "MEMORY.md" },
    }) as any;
    configureFsSafePython({ mode: "off" });
    __setFsSafeTestHooksForTest({
      afterOpen: async (targetPath) => {
        if (targetPath.endsWith(join("workspace", "MEMORY.md"))) {
          await rename(targetPath, `${targetPath}.our-write`);
          await writeFile(targetPath, "external update", "utf8");
        }
      },
    });
    const response = await service.dispatch({
      method: "memory.write", requestId: "write",
      params: { memoryId: "MEMORY.md", content: "our update", version: read.result.memory.version },
    });
    expect(response).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    await expect(readFile(join(workspace, "MEMORY.md"), "utf8")).resolves.toBe("external update");
  });

  it("does not overwrite memory swapped after version validation", async () => {
    const { workspace, service } = await fixture();
    const read = await service.dispatch({ method: "memory.read", requestId: "read-write-race", params: { memoryId: "MEMORY.md" } }) as any;
    configureFsSafePython({ mode: "off" });
    let swapped = false;
    __setFsSafeTestHooksForTest({
      beforeRootFallbackMutation: async (operation, targetPath) => {
        if (swapped || operation !== "move" || !targetPath.includes(".uclaw-data-staging")) return;
        swapped = true;
        await rename(join(workspace, "MEMORY.md"), join(workspace, "original-memory.md"));
        await writeFile(join(workspace, "MEMORY.md"), "external memory", "utf8");
      },
    });
    await expect(service.dispatch({
      method: "memory.write", requestId: "write-race",
      params: { memoryId: "MEMORY.md", content: "our memory", version: read.result.memory.version },
    })).resolves.toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(swapped).toBe(true);
    await expect(readFile(join(workspace, "MEMORY.md"), "utf8")).resolves.toBe("external memory");
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

  it("dispatches path-free maintenance previews and fails closed without runtime coordination", async () => {
    const { dataDir } = await fixture();
    const cacheRoot = await mkdtemp(join(tmpdir(), "uclaw-maintenance-cache-"));
    const cacheDir = join(cacheRoot, "runtime");
    await mkdir(join(cacheDir, "electron"), { recursive: true });
    await writeFile(join(cacheRoot, ".uclaw-cache.json"), `${JSON.stringify({ schemaVersion: 1, product: "U-Claw", purpose: "rebuildable-cache" })}\n`);
    const service = createDataService({ dataDir, cacheDir });
    const preview = await service.dispatch({ method: "backup.preview", requestId: "preview", params: {} });
    expect(preview.ok).toBe(true);
    expect(JSON.stringify(preview)).not.toContain(dataDir);
    if (!preview.ok || preview.method !== "backup.preview") throw new Error("preview failed");
    const create = await service.dispatch({
      method: "backup.create", requestId: "create",
      params: { collectionIds: ["openclaw-memory"], previewToken: preview.result.previewToken, trigger: "manual", retainLatest: 3, confirmed: true },
    });
    expect(create).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    expect(JSON.stringify(create)).not.toContain(dataDir);
  });

  it("blocks maintenance writes while an interrupted artifact needs recovery", async () => {
    const { dataDir } = await fixture();
    const cacheRoot = await mkdtemp(join(tmpdir(), "uclaw-maintenance-cache-"));
    const cacheDir = join(cacheRoot, "runtime");
    await mkdir(join(cacheDir, "electron"), { recursive: true });
    await writeFile(join(cacheDir, "electron", "entry.bin"), "cache");
    await writeFile(join(cacheRoot, ".uclaw-cache.json"), `${JSON.stringify({ schemaVersion: 1, product: "U-Claw", purpose: "rebuildable-cache" })}\n`);
    const service = createDataService({ dataDir, cacheDir });
    const preview = await service.dispatch({ method: "cleanup.preview", requestId: "preview", params: { candidateIds: ["cache:electron"] } });
    if (!preview.ok || preview.method !== "cleanup.preview") throw new Error("preview failed");
    await mkdir(join(dataDir, "backups", ".backup-interrupted.staging"), { recursive: true });

    await expect(service.dispatch({
      method: "cleanup.execute", requestId: "execute",
      params: { candidateIds: ["cache:electron"], previewToken: preview.result.previewToken, confirmed: true },
    })).resolves.toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });

  it("tracks cleanup background work through the runtime mutation coordinator", async () => {
    const { dataDir } = await fixture();
    const cacheRoot = await mkdtemp(join(tmpdir(), "uclaw-maintenance-cache-"));
    const cacheDir = join(cacheRoot, "runtime");
    await mkdir(join(cacheDir, "electron"), { recursive: true });
    await writeFile(join(cacheDir, "electron", "entry.bin"), "cache");
    await writeFile(join(cacheRoot, ".uclaw-cache.json"), `${JSON.stringify({ schemaVersion: 1, product: "U-Claw", purpose: "rebuildable-cache" })}\n`);
    let releaseMutation!: () => void;
    let trackedWrites = 0;
    const runTrackedWrite = async <T>(operation: () => Promise<T>): Promise<T> => {
      trackedWrites += 1;
      await new Promise<void>((resolve) => { releaseMutation = resolve; });
      return operation();
    };
    const service = createDataService({
      dataDir,
      cacheDir,
      mutationCoordinator: {
        runVersioned: async (_context, operation) => operation(),
        runTrackedWrite,
      },
    });
    const preview = await service.dispatch({ method: "cleanup.preview", requestId: "preview", params: { candidateIds: ["cache:electron"] } });
    if (!preview.ok || preview.method !== "cleanup.preview") throw new Error("preview failed");
    const execute = await service.dispatch({
      method: "cleanup.execute", requestId: "execute",
      params: { candidateIds: ["cache:electron"], previewToken: preview.result.previewToken, confirmed: true },
    });
    if (!execute.ok || execute.method !== "cleanup.execute") throw new Error("execute failed");

    await vi.waitFor(() => expect(trackedWrites).toBe(1));
    expect(await service.dispatch({ method: "maintenance.operation-get", requestId: "before-release", params: { operationId: execute.result.id } }))
      .toMatchObject({ ok: true, result: { state: "queued" } });
    releaseMutation();
    await vi.waitFor(async () => expect(await service.dispatch({ method: "maintenance.operation-get", requestId: "after-release", params: { operationId: execute.result.id } }))
      .toMatchObject({ ok: true, result: { state: "completed" } }));
  });
});
