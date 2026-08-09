import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFixturePluginRegistryClient } from "../src/plugins/fixture-client.js";
import { createFixturePluginRuntime } from "../src/plugins/fixture-runtime.js";
import { createPluginService } from "../src/plugins/plugin-service.js";

const roots: string[] = [];
async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "uclaw-plugin-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const createService = (dataDir: string, client = createFixturePluginRegistryClient()) =>
  createPluginService({ dataDir, client, runtime: createFixturePluginRuntime(dataDir) });

describe("Plugin service", () => {
  it("keeps background mutations tracked until the operation settles", async () => {
    const dataDir = await makeRoot();
    let mutationCalls = 0;
    const runMutation = async <T>(operation: () => Promise<T>) => { mutationCalls += 1; return operation(); };
    const service = await createPluginService({
      dataDir,
      client: createFixturePluginRegistryClient(),
      runtime: createFixturePluginRuntime(dataDir),
      runMutation,
    });
    const detail = await service.detail("openclaw-calendar");
    const operation = await service.startInstall({
      slug: detail.slug,
      confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    });
    await service.waitForOperation(operation.id);
    expect(mutationCalls).toBe(1);
  });

  it("uses a plugin fixture registry, never SkillHub", async () => {
    const service = await createService(await makeRoot());
    const page = await service.search({ query: "", cursor: null, pageSize: 20 });
    expect(page.mode).toBe("fixture");
    expect(page.items.length).toBeGreaterThan(2);
    expect(page.items.every((item) => item.packageKind === "plugin")).toBe(true);
    expect(page.items.map((item) => item.source.provider)).toEqual(expect.arrayContaining(["fixture", "external"]));
    expect(page.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ availability: "unpackaged" }),
      expect.objectContaining({ availability: "incompatible" }),
    ]));
  });

  it("installs into OpenClaw extensions and persists enablement in portable config", async () => {
    const dataDir = await makeRoot();
    const service = await createService(dataDir);
    const detail = await service.detail("openclaw-calendar");
    const confirmation = { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk };
    const installed = await service.waitForOperation((await service.startInstall({ slug: detail.slug, confirmation })).id);
    expect(installed.state).toBe("succeeded");
    expect(await readFile(join(dataDir, ".openclaw", "extensions", detail.slug, "openclaw.plugin.json"), "utf8")).toContain(detail.slug);
    expect(JSON.parse(await readFile(join(dataDir, ".openclaw", "openclaw.json"), "utf8")).plugins.entries[detail.slug]).toEqual({ enabled: true });
    expect(await readFile(join(dataDir, "capabilities", "plugin-state.json"), "utf8")).toContain('"packageKind": "plugin"');
  });

  it("installs a bundle shaped like locked OpenClaw 2026.7.1-2 plugins", async () => {
    const dataDir = await makeRoot();
    const service = await createService(dataDir);
    const detail = await service.detail("openclaw-calendar");
    await service.waitForOperation((await service.startInstall({
      slug: detail.slug,
      confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);
    const root = join(dataDir, ".openclaw", "extensions", detail.slug);
    expect(JSON.parse(await readFile(join(root, "openclaw.plugin.json"), "utf8"))).toMatchObject({
      id: detail.slug,
      configSchema: { type: "object" },
    });
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toMatchObject({
      name: "@uclaw/openclaw-calendar",
      version: detail.version,
      openclaw: { extensions: ["./dist/index.js"] },
    });
  });

  it("requires explicit confirmation for native code or command execution", async () => {
    const service = await createService(await makeRoot());
    const detail = await service.detail("openclaw-shell-tools");
    expect(detail).toMatchObject({ risk: "high", nativeCode: true, commandExecution: true });
    await expect(service.startInstall({ slug: detail.slug, confirmation: null })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    await expect(service.startInstall({
      slug: detail.slug,
      confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: "medium" },
    })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
  });

  it("blocks unpackaged and incompatible external plugins", async () => {
    const service = await createService(await makeRoot());
    for (const slug of ["community-wechat-preview", "legacy-openclaw-plugin"]) {
      const detail = await service.detail(slug);
      await expect(service.startInstall({
        slug,
        confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
      })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    }
  });

  it("does not update or uninstall plugins not managed by U-Claw", async () => {
    const dataDir = await makeRoot();
    let runtimeRecord = {
      slug: "openclaw-calendar",
      name: "Bundled calendar",
      description: "Runtime-owned Plugin",
      version: "1.0.0",
      enabled: true,
      origin: "bundled" as const,
      source: "runtime",
    };
    const service = await createPluginService({
      dataDir,
      client: createFixturePluginRegistryClient(),
      runtime: {
        installed: async () => [{ ...runtimeRecord }],
        installFromPath: async () => undefined,
        uninstall: async () => undefined,
        setEnabled: async (_slug, enabled) => { runtimeRecord = { ...runtimeRecord, enabled }; },
      },
    });
    const unknown = (await service.installed())[0];
    expect(unknown).toMatchObject({
      compatibility: { state: "unknown" },
      integrityVerified: false,
      managedByUClaw: false,
      risk: "high",
    });
    await service.setEnabled({ slug: runtimeRecord.slug, enabled: false, confirmation: null });
    expect(runtimeRecord.enabled).toBe(false);
    await expect(service.setEnabled({ slug: runtimeRecord.slug, enabled: true, confirmation: null })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    await service.setEnabled({
      slug: runtimeRecord.slug,
      enabled: true,
      confirmation: { permissionFingerprint: unknown.permissionFingerprint, acceptedRisk: "high" },
    });
    expect(runtimeRecord.enabled).toBe(true);
    await expect(service.startUpdate({ slug: runtimeRecord.slug, confirmation: null })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const uninstall = await service.startUninstall(runtimeRecord.slug);
    expect((await service.waitForOperation(uninstall.id)).state).toBe("failed");
  });

  it.each(["path-escape", "symlink", "hardlink", "duplicate-path", "case-duplicate", "archive-bomb", "bad-manifest", "bad-checksum", "missing-entry", "incompatible", "windows-ads", "windows-device", "windows-trailing", "ancestor-conflict"] as const)(
    "rejects unsafe bundle: %s",
    async (invalidBundle) => {
      const dataDir = await makeRoot();
      const service = await createService(dataDir, createFixturePluginRegistryClient({ invalidBundle }));
      const detail = await service.detail("openclaw-calendar");
      const operation = await service.startInstall({
        slug: detail.slug,
        confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
      });
      expect((await service.waitForOperation(operation.id)).state).toBe("failed");
      expect(await service.installed()).toEqual([]);
    },
  );

  it("rolls back an interrupted update and recovers after restart", async () => {
    const dataDir = await makeRoot();
    const initial = await createService(dataDir);
    const detail = await initial.detail("openclaw-calendar");
    const confirmation = { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk };
    await initial.waitForOperation((await initial.startInstall({ slug: detail.slug, confirmation })).id);
    const interrupted = await createService(dataDir, createFixturePluginRegistryClient({ versionOverride: { "openclaw-calendar": "1.3.0" }, failAfterBackup: true }));
    const next = await interrupted.detail(detail.slug);
    const failed = await interrupted.waitForOperation((await interrupted.startUpdate({
      slug: next.slug,
      confirmation: { permissionFingerprint: next.permissionFingerprint, acceptedRisk: next.risk },
    })).id);
    expect(failed.state).toBe("failed");
    const recovered = await createService(dataDir);
    expect((await recovered.installed())[0]).toMatchObject({ installedVersion: "1.2.0", enabled: true });
  });

  it("rolls back a runtime replacement when post-install verification fails", async () => {
    const dataDir = await makeRoot();
    const baseRuntime = createFixturePluginRuntime(dataDir);
    const initial = await createPluginService({ dataDir, client: createFixturePluginRegistryClient(), runtime: baseRuntime });
    const detail = await initial.detail("openclaw-calendar");
    await initial.waitForOperation((await initial.startInstall({
      slug: detail.slug,
      confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);
    let installCalls = 0;
    let corruptNextInventory = false;
    const runtime = {
      installed: async () => {
        const records = await baseRuntime.installed();
        if (!corruptNextInventory) return records;
        corruptNextInventory = false;
        return records.map((record) => ({ ...record, version: "corrupt" }));
      },
      installFromPath: async (input: { sourceDir: string; slug: string }) => {
        await baseRuntime.installFromPath(input);
        installCalls += 1;
        if (installCalls === 1) corruptNextInventory = true;
      },
      uninstall: (slug: string) => baseRuntime.uninstall(slug),
      setEnabled: (slug: string, enabled: boolean) => baseRuntime.setEnabled(slug, enabled),
    };
    const updated = await createPluginService({
      dataDir,
      client: createFixturePluginRegistryClient({ versionOverride: { "openclaw-calendar": "1.3.0" } }),
      runtime,
    });
    const next = await updated.detail(detail.slug);
    const operation = await updated.startUpdate({
      slug: next.slug,
      confirmation: { permissionFingerprint: next.permissionFingerprint, acceptedRisk: next.risk },
    });
    expect((await updated.waitForOperation(operation.id)).state).toBe("failed");
    expect((await baseRuntime.installed())[0].version).toBe("1.2.0");
  });

  it("recovers a same-version update from the retained prior package", async () => {
    const dataDir = await makeRoot();
    const initial = await createService(dataDir, createFixturePluginRegistryClient({ contentMarker: "original" }));
    const detail = await initial.detail("openclaw-calendar");
    await initial.waitForOperation((await initial.startInstall({
      slug: detail.slug,
      confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);
    const interrupted = await createService(dataDir, createFixturePluginRegistryClient({
      contentMarker: "replacement",
      failAfterRuntimeInstall: true,
    }));
    const next = await interrupted.detail(detail.slug);
    const operation = await interrupted.startUpdate({
      slug: next.slug,
      confirmation: { permissionFingerprint: next.permissionFingerprint, acceptedRisk: next.risk },
    });
    expect((await interrupted.waitForOperation(operation.id)).state).toBe("failed");
    expect(await readFile(join(dataDir, ".openclaw", "extensions", detail.slug, "dist", "index.js"), "utf8")).toContain("replacement");
    await createService(dataDir);
    expect(await readFile(join(dataDir, ".openclaw", "extensions", detail.slug, "dist", "index.js"), "utf8")).toContain("original");
  });

  it("refuses a tampered retained package during recovery", async () => {
    const dataDir = await makeRoot();
    const initial = await createService(dataDir, createFixturePluginRegistryClient({ contentMarker: "trusted" }));
    const detail = await initial.detail("openclaw-calendar");
    await initial.waitForOperation((await initial.startInstall({
      slug: detail.slug,
      confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);
    await writeFile(join(
      dataDir,
      "capabilities",
      "plugin-packages",
      detail.slug,
      detail.integritySha256,
      "dist",
      "index.js",
    ), "tampered");
    const interrupted = await createService(dataDir, createFixturePluginRegistryClient({
      contentMarker: "replacement",
      failAfterRuntimeInstall: true,
    }));
    const next = await interrupted.detail(detail.slug);
    await interrupted.waitForOperation((await interrupted.startUpdate({
      slug: next.slug,
      confirmation: { permissionFingerprint: next.permissionFingerprint, acceptedRisk: next.risk },
    })).id);
    await expect(createService(dataDir)).rejects.toThrow(/Retained Plugin package/);
  });

  it("restores a Plugin when runtime uninstall fails after removal", async () => {
    const dataDir = await makeRoot();
    const baseRuntime = createFixturePluginRuntime(dataDir);
    const service = await createPluginService({ dataDir, client: createFixturePluginRegistryClient(), runtime: baseRuntime });
    const detail = await service.detail("openclaw-calendar");
    await service.waitForOperation((await service.startInstall({
      slug: detail.slug,
      confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);
    const failing = await createPluginService({
      dataDir,
      client: createFixturePluginRegistryClient(),
      runtime: {
        ...baseRuntime,
        uninstall: async (slug) => { await baseRuntime.uninstall(slug); throw new Error("after removal"); },
      },
    });
    const operation = await failing.startUninstall(detail.slug);
    expect((await failing.waitForOperation(operation.id)).state).toBe("failed");
    expect((await baseRuntime.installed())[0]).toMatchObject({ slug: detail.slug, version: detail.version });
  });

  it("restores enablement when runtime toggle fails after changing state", async () => {
    const dataDir = await makeRoot();
    const baseRuntime = createFixturePluginRuntime(dataDir);
    const service = await createPluginService({ dataDir, client: createFixturePluginRegistryClient(), runtime: baseRuntime });
    const detail = await service.detail("openclaw-calendar");
    await service.waitForOperation((await service.startInstall({
      slug: detail.slug,
      confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);
    let failNextToggle = true;
    const failing = await createPluginService({
      dataDir,
      client: createFixturePluginRegistryClient(),
      runtime: {
        ...baseRuntime,
        setEnabled: async (slug, enabled) => {
          await baseRuntime.setEnabled(slug, enabled);
          if (failNextToggle) { failNextToggle = false; throw new Error("after toggle"); }
        },
      },
    });
    expect((await failing.setEnabled({ slug: detail.slug, enabled: false, confirmation: null })).state).toBe("failed");
    expect((await baseRuntime.installed())[0].enabled).toBe(true);
  });

  it("reconciles U-Claw state from authoritative OpenClaw enablement", async () => {
    const dataDir = await makeRoot();
    const client = createFixturePluginRegistryClient();
    const service = await createService(dataDir, client);
    const detail = await service.detail("openclaw-calendar");
    await service.waitForOperation((await service.startInstall({
      slug: detail.slug,
      confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);
    const statePath = join(dataDir, "capabilities", "plugin-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.installed[detail.slug].enabled = false;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

    const recovered = await createService(dataDir, client);
    expect((await recovered.installed())[0].enabled).toBe(true);
  });

  it("removes stale managed state when OpenClaw no longer reports the Plugin", async () => {
    const dataDir = await makeRoot();
    const runtime = createFixturePluginRuntime(dataDir);
    const initial = await createPluginService({ dataDir, client: createFixturePluginRegistryClient(), runtime });
    const detail = await initial.detail("openclaw-calendar");
    await initial.waitForOperation((await initial.startInstall({
      slug: detail.slug,
      confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);
    await runtime.uninstall(detail.slug);
    const recovered = await createPluginService({ dataDir, client: createFixturePluginRegistryClient(), runtime });
    expect(await recovered.installed()).toEqual([]);
    expect((await recovered.search({ query: detail.slug, cursor: null, pageSize: 20 })).items[0]).toMatchObject({
      installedVersion: null,
      managedByUClaw: false,
    });
    expect(JSON.parse(await readFile(join(dataDir, "capabilities", "plugin-state.json"), "utf8")).installed).toEqual({});
  });

  it("rejects a symlink ancestor in retained package storage", async () => {
    const dataDir = await makeRoot();
    const outside = await makeRoot();
    const packageDir = join(dataDir, "capabilities", "plugin-packages");
    await mkdir(packageDir, { recursive: true });
    await symlink(outside, join(packageDir, "openclaw-calendar"), "dir");
    const service = await createService(dataDir);
    const detail = await service.detail("openclaw-calendar");
    const operation = await service.startInstall({
      slug: detail.slug,
      confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    });
    expect((await service.waitForOperation(operation.id)).state).toBe("failed");
    expect(await service.installed()).toEqual([]);
    expect(await readdir(outside)).toEqual([]);
  });

  it("preserves disabled state across update", async () => {
    const dataDir = await makeRoot();
    const initial = await createService(dataDir);
    const detail = await initial.detail("openclaw-calendar");
    const confirmation = { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk };
    await initial.waitForOperation((await initial.startInstall({ slug: detail.slug, confirmation })).id);
    await initial.setEnabled({ slug: detail.slug, enabled: false, confirmation: null });
    const updated = await createService(dataDir, createFixturePluginRegistryClient({ versionOverride: { "openclaw-calendar": "1.3.0" } }));
    const next = await updated.detail(detail.slug);
    await updated.waitForOperation((await updated.startUpdate({
      slug: next.slug,
      confirmation: { permissionFingerprint: next.permissionFingerprint, acceptedRisk: next.risk },
    })).id);
    expect((await updated.installed())[0]).toMatchObject({ installedVersion: "1.3.0", enabled: false });
  });

  it("serializes concurrent lifecycle mutations without losing installed records", async () => {
    const dataDir = await makeRoot();
    const service = await createService(dataDir);
    const calendar = await service.detail("openclaw-calendar");
    const shell = await service.detail("openclaw-shell-tools");
    const operations = await Promise.all([calendar, shell].map((detail) => service.startInstall({
      slug: detail.slug,
      confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })));
    await Promise.all(operations.map((operation) => service.waitForOperation(operation.id)));
    expect((await service.installed()).map((item) => item.slug).sort()).toEqual([calendar.slug, shell.slug].sort());
  });

  it("rejects tampered journals without touching paths outside controlled roots", async () => {
    const dataDir = await makeRoot();
    const outside = join(dataDir, "outside.txt");
    await writeFile(outside, "keep");
    const transactionDir = join(dataDir, "capabilities", ".plugin-transactions");
    await mkdir(transactionDir, { recursive: true });
    await writeFile(join(transactionDir, "tampered.json"), JSON.stringify({
      operationId: "../../outside",
      slug: "../../outside",
      action: "remove",
      phase: "committed",
      target: outside,
      backup: outside,
      previousRecord: {},
    }));
    await createService(dataDir);
    expect(await readFile(outside, "utf8")).toBe("keep");
  });

  it("commits replacement metadata after restart only when replaced phase was durable", async () => {
    const dataDir = await makeRoot();
    const initial = await createService(dataDir);
    const detail = await initial.detail("openclaw-calendar");
    const confirmation = { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk };
    await initial.waitForOperation((await initial.startInstall({ slug: detail.slug, confirmation })).id);
    const interrupted = await createService(dataDir, createFixturePluginRegistryClient({
        versionOverride: { "openclaw-calendar": "1.3.0" },
        failAtPhase: "replaced",
      }));
    const next = await interrupted.detail(detail.slug);
    const failed = await interrupted.waitForOperation((await interrupted.startUpdate({
      slug: next.slug,
      confirmation: { permissionFingerprint: next.permissionFingerprint, acceptedRisk: next.risk },
    })).id);
    expect(failed.state).toBe("failed");
    const recovered = await createService(dataDir);
    expect((await recovered.installed())[0]).toMatchObject({ installedVersion: "1.3.0", enabled: true });
  });
});
