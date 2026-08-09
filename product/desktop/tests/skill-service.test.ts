import { mkdir, mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFixtureSkillHubClient } from "../src/skills/fixture-client.js";
import { createSkillService } from "../src/skills/skill-service.js";

const roots: string[] = [];
const makeRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "uclaw-skill-test-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("portable Skill service", () => {
  it("searches only free fixture Skills with cursor pagination", async () => {
    const service = await createSkillService({ dataDir: await makeRoot(), client: createFixtureSkillHubClient() });
    const first = await service.search({ query: "", cursor: null, pageSize: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0].pricingType).toBe("free");
    expect(first.mode).toBe("fixture");
    expect(first.hasMore).toBe(true);
    const second = await service.search({ query: "", cursor: first.nextCursor, pageSize: 1 });
    expect(second.items[0].slug).not.toBe(first.items[0].slug);
  });

  it("rechecks detail pricing before installation", async () => {
    const fixture = createFixtureSkillHubClient({ detailPricingOverride: { "workspace-reader": "paid" } });
    const service = await createSkillService({ dataDir: await makeRoot(), client: fixture });
    await expect(service.startInstall({
      slug: "workspace-reader",
      confirmation: { permissionFingerprint: "stale", acceptedRisk: "high" },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("does not let an installed snapshot bypass a paid detail response", async () => {
    const dataDir = await makeRoot();
    const initial = await createSkillService({ dataDir, client: createFixtureSkillHubClient() });
    const detail = await initial.detail("workspace-reader");
    await initial.waitForOperation((await initial.startInstall({
      slug: detail.slug,
      confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);
    const paid = await createSkillService({
      dataDir,
      client: createFixtureSkillHubClient({ detailPricingOverride: { "workspace-reader": "paid" } }),
    });
    await expect(paid.detail("workspace-reader")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("requires the exact permission fingerprint and explicit high-risk confirmation", async () => {
    const service = await createSkillService({ dataDir: await makeRoot(), client: createFixtureSkillHubClient() });
    const detail = await service.detail("command-runner");
    await expect(service.startInstall({ slug: detail.slug, confirmation: null }))
      .rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    await expect(service.startInstall({
      slug: detail.slug,
      confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: "medium" },
    })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
  });

  it("installs into the portable data directory and persists enable state", async () => {
    const dataDir = await makeRoot();
    const service = await createSkillService({ dataDir, client: createFixtureSkillHubClient() });
    const detail = await service.detail("workspace-reader");
    const operation = await service.startInstall({
      slug: detail.slug,
      confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    });
    const completed = await service.waitForOperation(operation.id);
    expect(completed.state).toBe("succeeded");
    expect(completed.progress).toBe(100);
    expect(await readFile(join(dataDir, "capabilities", "skills", detail.slug, "SKILL.json"), "utf8"))
      .toContain(detail.slug);
    await service.setEnabled({
      slug: detail.slug,
      enabled: false,
      confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    });
    expect((await service.installed())[0].enabled).toBe(false);
  });

  it("rejects path escape, symlink, archive bomb, and malformed manifest bundles", async () => {
    for (const invalidBundle of ["path-escape", "symlink", "hardlink", "duplicate-path", "archive-bomb", "bad-manifest", "permission-mismatch"] as const) {
      const dataDir = await makeRoot();
      const service = await createSkillService({ dataDir, client: createFixtureSkillHubClient({ invalidBundle: invalidBundle as never }) });
      const detail = await service.detail("workspace-reader");
      const operation = await service.startInstall({
        slug: detail.slug,
        confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
      });
      const completed = await service.waitForOperation(operation.id);
      expect(completed.state).toBe("failed");
      await expect(stat(join(dataDir, "capabilities", "skills", detail.slug))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("restores the prior version after interrupted atomic replacement", async () => {
    const dataDir = await makeRoot();
    const stable = createFixtureSkillHubClient();
    const service = await createSkillService({ dataDir, client: stable });
    const detail = await service.detail("workspace-reader");
    const confirmation = { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk } as const;
    await service.waitForOperation((await service.startInstall({ slug: detail.slug, confirmation })).id);

    const failing = await createSkillService({ dataDir, client: createFixtureSkillHubClient({ failAfterBackup: true }) });
    await failing.waitForOperation((await failing.startUpdate({ slug: detail.slug, confirmation })).id);
    const recovered = await createSkillService({ dataDir, client: stable });
    expect((await recovered.installed())[0].version).toBe("1.0.0");
  });

  it("updates an installed Skill to a newer free fixture version", async () => {
    const dataDir = await makeRoot();
    const initial = await createSkillService({ dataDir, client: createFixtureSkillHubClient() });
    const firstDetail = await initial.detail("workspace-reader");
    await initial.waitForOperation((await initial.startInstall({
      slug: firstDetail.slug,
      confirmation: { permissionFingerprint: firstDetail.permissionFingerprint, acceptedRisk: firstDetail.risk },
    })).id);

    const updated = await createSkillService({
      dataDir,
      client: createFixtureSkillHubClient({ versionOverride: { "workspace-reader": "1.1.0" } }),
    });
    const catalogItem = (await updated.search({ query: "workspace", cursor: null, pageSize: 20 })).items[0];
    expect(catalogItem).toMatchObject({ installedVersion: "1.0.0", version: "1.1.0", updateAvailable: true });
    const nextDetail = await updated.detail(catalogItem.slug);
    const completed = await updated.waitForOperation((await updated.startUpdate({
      slug: nextDetail.slug,
      confirmation: { permissionFingerprint: nextDetail.permissionFingerprint, acceptedRisk: nextDetail.risk },
    })).id);
    expect(completed.state).toBe("succeeded");
    expect((await updated.installed())[0]).toMatchObject({ installedVersion: "1.1.0", version: "1.1.0", updateAvailable: false });
  });

  it("rolls back an interrupted uninstall including its persisted record", async () => {
    const dataDir = await makeRoot();
    const client = createFixtureSkillHubClient();
    const service = await createSkillService({ dataDir, client });
    const detail = await service.detail("workspace-reader");
    const confirmation = { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk } as const;
    await service.waitForOperation((await service.startInstall({ slug: detail.slug, confirmation })).id);

    const root = join(dataDir, "capabilities");
    const target = join(root, "skills", detail.slug);
    const backup = join(root, "skills", `.${detail.slug}.power-loss.backup`);
    const staging = join(root, "skills", `.${detail.slug}.power-loss.staging`);
    await rename(target, backup);
    await writeFile(join(root, "skill-state.json"), `${JSON.stringify({ schemaVersion: 1, installed: {} })}\n`);
    await mkdir(join(root, ".skill-transactions"), { recursive: true });
    await writeFile(join(root, ".skill-transactions", "power-loss.json"), `${JSON.stringify({
      operationId: "power-loss", slug: detail.slug, action: "remove", target, staging, backup,
      phase: "backed-up", previousRecord: { slug: detail.slug, version: detail.version, enabled: true },
    })}\n`);

    const recovered = await createSkillService({ dataDir, client });
    expect((await recovered.installed())[0]).toMatchObject({ slug: detail.slug, enabled: true });
    expect(await readFile(join(target, "SKILL.json"), "utf8")).toContain(detail.slug);
  });

  it("does not expose filesystem paths or secrets through operation errors", async () => {
    const client = createFixtureSkillHubClient();
    const service = await createSkillService({
      dataDir: await makeRoot(),
      client: { ...client, download: async () => { throw new Error("/private/secret password=hunter2"); } },
    });
    const detail = await service.detail("workspace-reader");
    const operation = await service.startInstall({
      slug: detail.slug,
      confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    });
    const failed = await service.waitForOperation(operation.id);
    expect(failed.state).toBe("failed");
    expect(JSON.stringify(failed)).not.toMatch(/private|hunter2|password/);
  });

  it("recomputes aggregate risk from permissions instead of trusting detail risk", async () => {
    const client = createFixtureSkillHubClient();
    const service = await createSkillService({
      dataDir: await makeRoot(),
      client: { ...client, detail: async (slug) => ({ ...(await client.detail(slug)), risk: "low" }) },
    });
    const detail = await service.detail("command-runner");
    expect(detail.risk).toBe("high");
    await expect(service.startInstall({
      slug: detail.slug,
      confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: "low" },
    })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
  });

  it("manages installed Skills from the USB snapshot while the catalog is offline", async () => {
    const dataDir = await makeRoot();
    const client = createFixtureSkillHubClient();
    const service = await createSkillService({ dataDir, client });
    const detail = await service.detail("workspace-reader");
    const confirmation = { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk } as const;
    await service.waitForOperation((await service.startInstall({ slug: detail.slug, confirmation })).id);
    const offline = await createSkillService({
      dataDir,
      client: { ...client, detail: async () => { throw new Error("offline"); }, search: async () => { throw new Error("offline"); } },
    });
    expect(await offline.installed()).toEqual([expect.objectContaining({ slug: detail.slug, enabled: true })]);
    await offline.setEnabled({ slug: detail.slug, enabled: false, confirmation: null });
    expect((await offline.installed())[0].enabled).toBe(false);
  });

  it("recovers rename-before-journal and replaced-before-state power-loss windows", async () => {
    const dataDir = await makeRoot();
    const client = createFixtureSkillHubClient();
    const service = await createSkillService({ dataDir, client });
    const detail = await service.detail("workspace-reader");
    const confirmation = { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk } as const;
    await service.waitForOperation((await service.startInstall({ slug: detail.slug, confirmation })).id);
    const root = join(dataDir, "capabilities");
    const statePath = join(root, "skill-state.json");
    const originalState = JSON.parse(await readFile(statePath, "utf8"));
    const previousRecord = originalState.installed[detail.slug];
    const target = join(root, "skills", detail.slug);
    const backup = join(root, "skills", `.${detail.slug}.rename-window.backup`);
    const staging = join(root, "skills", `.${detail.slug}.rename-window.staging`);
    await rename(target, backup);
    await mkdir(staging, { recursive: true });
    await writeFile(join(root, ".skill-transactions", "rename-window.json"), `${JSON.stringify({
      operationId: "rename-window", slug: detail.slug, action: "replace", target, staging, backup,
      phase: "staged", previousRecord, nextRecord: previousRecord,
    })}\n`);
    const restored = await createSkillService({ dataDir, client });
    expect((await restored.installed())[0].slug).toBe(detail.slug);

    const replacedJournal = join(root, ".skill-transactions", "replaced-window.json");
    await writeFile(statePath, `${JSON.stringify({ schemaVersion: 1, installed: {} })}\n`);
    await writeFile(replacedJournal, `${JSON.stringify({
      operationId: "replaced-window", slug: detail.slug, action: "replace", target,
      staging: join(root, "skills", ".unused-staging"), backup: join(root, "skills", ".unused-backup"),
      phase: "replaced", previousRecord: null, nextRecord: previousRecord,
    })}\n`);
    const completed = await createSkillService({ dataDir, client });
    expect((await completed.installed())[0].slug).toBe(detail.slug);
  });
});
