import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import type { PathLike, RmOptions } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createFixtureSkillHubClient, tagSkillHubFailure } from "../src/skills/fixture-client.js";
import { createSkillService } from "../src/skills/skill-service.js";
import type { OpenClawSkillRuntime } from "../src/skills/openclaw-skill-runtime.js";
import { formalProposalRecord } from "./skill-proposal-fixture.js";

const roots: string[] = [];
const makeRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "uclaw-skill-test-"));
  roots.push(root);
  return root;
};

const emptyMissing = { bins: [], anyBins: [], env: [], config: [], os: [] };
function runtimeFor(workspaceRoot: string, overrides: Partial<OpenClawSkillRuntime> = {}): OpenClawSkillRuntime {
  const status = vi.fn(async () => {
    const names = await import("node:fs/promises").then(({ readdir }) => readdir(workspaceRoot).catch(() => []));
    return {
      workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills",
      skills: names.filter((name) => !name.startsWith(".")).map((name) => ({
        id: name, name, source: "workspace", bundled: false, disabled: false, eligible: true,
        modelVisible: true, userInvocable: true, commandVisible: true, availability: "available" as const,
        missing: emptyMissing, conflicts: [],
      })),
    };
  });
  return {
    status,
    setEnabled: vi.fn(async (skillKey, enabled) => ({
      id: skillKey, name: skillKey, source: "workspace", bundled: false, disabled: !enabled, eligible: enabled,
      modelVisible: enabled, userInvocable: true, commandVisible: enabled,
      availability: enabled ? "available" : "disabled", missing: emptyMissing, conflicts: [],
    })),
    curatorStatus: vi.fn(), curatorAction: vi.fn(), listProposals: vi.fn(), inspectProposal: vi.fn(), proposalAction: vi.fn(),
    ...overrides,
  } as OpenClawSkillRuntime;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("portable Skill service", () => {
  it("installs into the authoritative workspace and survives service recreation", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    const runtime = runtimeFor(workspaceRoot);
    const service = await createSkillService({ dataDir, workspaceRoot, runtime, client: createFixtureSkillHubClient() });
    const detail = await service.detail("workspace-reader");
    await service.waitForOperation((await service.startInstall({
      slug: detail.slug, confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);
    expect(await readFile(join(workspaceRoot, detail.slug, "SKILL.md"), "utf8")).toContain("workspace-reader");

    const rebuilt = await createSkillService({ dataDir, workspaceRoot, runtime, client: createFixtureSkillHubClient() });
    expect(await rebuilt.installed()).toEqual([expect.objectContaining({ slug: detail.slug, installedVersion: detail.version })]);
  });

  /** Reproduces SkillHub slugs that OpenClaw exposes under the SKILL.md runtime name. */
  it("accepts OpenClaw install readback by the frontmatter runtime name", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    const fixture = createFixtureSkillHubClient();
    const baseDetail = await fixture.detail("workspace-reader");
    const imaDetail = {
      ...baseDetail,
      slug: "ima-skills",
      name: "IMA Skills",
      source: { provider: "skillhub" as const, url: "https://api.skillhub.cn/api/v1/skills/ima-skills" },
      manifest: { ...baseDetail.manifest, id: "ima-skills" },
    };
    const client = {
      ...fixture,
      detail: vi.fn(async (slug: string) => {
        if (slug !== imaDetail.slug) throw tagSkillHubFailure(new Error("Skill not found."), "not-found");
        return imaDetail;
      }),
      download: vi.fn(async (slug: string) => {
        if (slug !== imaDetail.slug) throw tagSkillHubFailure(new Error("Skill not found."), "not-found");
        const bundle = await fixture.download(slug);
        const entries = bundle.entries.map((entry) => {
          if (entry.path !== "SKILL.md" || entry.contentBase64 === undefined) return entry;
          const markdown = Buffer.from(entry.contentBase64, "base64").toString("utf8")
            .replace(`slug: ${slug}\n`, "")
            .replace(`name: ${slug}`, "name: ima-skill");
          return { ...entry, size: Buffer.byteLength(markdown), contentBase64: Buffer.from(markdown).toString("base64") };
        });
        return { ...bundle, entries, checksumSha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex") };
      }),
    };
    const runtime = runtimeFor(workspaceRoot, { status: vi.fn(async () => ({
      workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills", skills: [{
        id: "ima-skill", name: "ima-skill", source: "workspace", bundled: false, disabled: false,
        eligible: true, modelVisible: true, userInvocable: true, commandVisible: true,
        availability: "available" as const, missing: emptyMissing, conflicts: [],
      }],
    })) });
    const service = await createSkillService({ dataDir, workspaceRoot, runtime, client });
    const detail = await service.detail(imaDetail.slug);

    const result = await service.waitForOperation((await service.startInstall({
      slug: detail.slug,
      confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);

    expect(result).toMatchObject({ state: "succeeded", progress: 100, phase: "complete" });
    expect(client.download).toHaveBeenCalledWith(imaDetail.slug);
    await expect(readFile(join(workspaceRoot, detail.slug, "SKILL.md"), "utf8")).resolves.toContain("name: ima-skill");
    expect(JSON.parse(await readFile(join(dataDir, "capabilities", "skill-state.json"), "utf8"))).toMatchObject({
      installed: { "ima-skills": { slug: "ima-skills", version: imaDetail.version, enabled: true } },
    });
    const rebuilt = await createSkillService({ dataDir, workspaceRoot, runtime, client });
    expect(await rebuilt.installed()).toEqual([
      expect.objectContaining({ slug: "ima-skills", installedVersion: imaDetail.version, enabled: true }),
    ]);
  });

  it("rolls back files and metadata when OpenClaw install readback fails", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    const runtime = runtimeFor(workspaceRoot, { status: vi.fn(async () => { throw new Error("gateway offline"); }) });
    const service = await createSkillService({ dataDir, workspaceRoot, runtime, client: createFixtureSkillHubClient() });
    const detail = await service.detail("workspace-reader");
    const result = await service.waitForOperation((await service.startInstall({
      slug: detail.slug, confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);
    expect(result.state).toBe("failed");
    await expect(access(join(workspaceRoot, detail.slug))).rejects.toMatchObject({ code: "ENOENT" });
    const rebuilt = await createSkillService({ dataDir, workspaceRoot, client: createFixtureSkillHubClient() });
    expect(await rebuilt.installed()).toEqual([]);
  });

  it("does not let a local scan masquerade as successful OpenClaw readback", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    const runtime = runtimeFor(workspaceRoot, { status: vi.fn(async () => ({
      workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills", skills: [],
    })) });
    const service = await createSkillService({ dataDir, workspaceRoot, runtime, client: createFixtureSkillHubClient() });
    const detail = await service.detail("workspace-reader");
    const result = await service.waitForOperation((await service.startInstall({
      slug: detail.slug, confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);
    expect(result.state).toBe("failed");
    await expect(access(join(workspaceRoot, detail.slug))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports persisted Skills disabled when OpenClaw no longer returns the workspace item", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    const initial = await createSkillService({
      dataDir, workspaceRoot, runtime: runtimeFor(workspaceRoot), client: createFixtureSkillHubClient(),
    });
    const detail = await initial.detail("workspace-reader");
    await initial.waitForOperation((await initial.startInstall({
      slug: detail.slug, confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);

    const missingRuntime = runtimeFor(workspaceRoot, { status: vi.fn(async () => ({
      workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills", skills: [],
    })) });
    const rebuilt = await createSkillService({
      dataDir, workspaceRoot, runtime: missingRuntime, client: createFixtureSkillHubClient(),
    });

    expect(await rebuilt.installed()).toEqual([expect.objectContaining({ slug: detail.slug, enabled: false })]);
  });

  it("reports legacy local Skills disabled when OpenClaw omits the workspace item", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    await mkdir(workspaceRoot, { recursive: true });
    await cp(new URL("../../../portable/skills-cn/china-weather", import.meta.url), join(workspaceRoot, "china-weather"), { recursive: true });
    await mkdir(join(dataDir, "capabilities"), { recursive: true });
    await writeFile(join(dataDir, "capabilities", "skill-state.json"), JSON.stringify({
      schemaVersion: 1,
      installed: { "china-weather": { slug: "china-weather", version: "1.0.0", enabled: true } },
    }));
    const runtime = runtimeFor(workspaceRoot, { status: vi.fn(async () => ({
      workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills", skills: [],
    })) });
    const service = await createSkillService({
      dataDir, workspaceRoot, runtime, client: createFixtureSkillHubClient(),
    });

    expect(await service.installed()).toEqual([expect.objectContaining({ slug: "china-weather", enabled: false })]);
    expect(await service.runtimeStatus()).toEqual(expect.objectContaining({ skills: [
      expect.objectContaining({ id: "china-weather", disabled: true, availability: "not-detected" }),
    ] }));
  });

  it("maps a namespaced local slug to the OpenClaw runtime name and uses that key for toggles", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    const skillRoot = join(workspaceRoot, "@user_bddf3fe6", "contextweave-interactive-architecture");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(join(skillRoot, "SKILL.md"), "---\nname: interactive-architecture-diagram\nslug: contextweave-interactive-architecture\ndescription: Build architecture diagrams\nversion: 1.2.0\n---\n\n# Architecture\n");
    let disabled = false;
    const setEnabled = vi.fn(async (skillKey: string, enabled: boolean) => {
      disabled = !enabled;
      return { id: skillKey, name: skillKey, source: "workspace", bundled: false, disabled, eligible: enabled, modelVisible: enabled, userInvocable: true, commandVisible: enabled, availability: enabled ? "available" as const : "disabled" as const, missing: emptyMissing, conflicts: [] };
    });
    const runtime = runtimeFor(workspaceRoot, {
      status: vi.fn(async () => ({ workspaceDir: "w", managedSkillsDir: "m", skills: [{
        id: "interactive-architecture-diagram", name: "interactive-architecture-diagram", source: "workspace", bundled: false,
        disabled, eligible: !disabled, modelVisible: !disabled, userInvocable: true, commandVisible: !disabled,
        availability: disabled ? "disabled" as const : "available" as const, missing: emptyMissing, conflicts: [],
      }] })),
      setEnabled,
    });
    const service = await createSkillService({ dataDir, workspaceRoot, runtime, client: createFixtureSkillHubClient() });

    expect(await service.runtimeStatus()).toEqual(expect.objectContaining({ skills: [expect.objectContaining({
      id: "contextweave-interactive-architecture", runtimeId: "interactive-architecture-diagram", availability: "available",
    })] }));
    expect(await service.localDetail("contextweave-interactive-architecture")).toMatchObject({ markdown: expect.stringContaining("# Architecture") });
    expect((await service.setEnabled({ slug: "contextweave-interactive-architecture", enabled: false, confirmation: null })).state).toBe("succeeded");
    expect(setEnabled).toHaveBeenCalledWith("interactive-architecture-diagram", false);
  });

  it("serializes concurrent installs without losing either authoritative record", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    const service = await createSkillService({ dataDir, workspaceRoot, runtime: runtimeFor(workspaceRoot), client: createFixtureSkillHubClient() });
    const details = await Promise.all([service.detail("workspace-reader"), service.detail("command-runner")]);
    const operations = await Promise.all(details.map((detail) => service.startInstall({
      slug: detail.slug, confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })));
    await Promise.all(operations.map((operation) => service.waitForOperation(operation.id)));
    expect((await service.installed()).map((item) => item.slug).sort()).toEqual(["command-runner", "workspace-reader"]);
    const rebuilt = await createSkillService({ dataDir, workspaceRoot, client: createFixtureSkillHubClient() });
    expect((await rebuilt.installed()).map((item) => item.slug).sort()).toEqual(["command-runner", "workspace-reader"]);
  });

  it("rejects an untrusted journal without touching paths outside the workspace", async () => {
    const dataDir = await makeRoot();
    const outside = await makeRoot();
    const marker = join(outside, "keep.txt");
    await writeFile(marker, "keep");
    const transactions = join(dataDir, "capabilities", ".skill-transactions");
    await mkdir(transactions, { recursive: true });
    await writeFile(join(transactions, "evil.json"), JSON.stringify({
      operationId: "evil", slug: "workspace-reader", action: "remove", phase: "committed",
      previousRecord: { slug: "workspace-reader", version: "1.0.0", enabled: true }, target: outside,
    }));
    await expect(createSkillService({ dataDir, client: createFixtureSkillHubClient() })).rejects.toThrow();
    await expect(readFile(marker, "utf8")).resolves.toBe("keep");
  });

  it("rejects a symlinked authoritative workspace root", async () => {
    const dataDir = await makeRoot();
    const outside = await makeRoot();
    await mkdir(join(dataDir, "workspace"), { recursive: true });
    await symlink(outside, join(dataDir, "workspace", "skills"));
    await expect(createSkillService({
      dataDir, workspaceRoot: join(dataDir, "workspace", "skills"), client: createFixtureSkillHubClient(),
    })).rejects.toThrow(/symlink|unsafe/i);
  });

  it("rescans bundled, managed, and workspace roots and passes conflicts to runtime", async () => {
    const dataDir = await makeRoot();
    const bundledRoot = join(dataDir, "portable-skills");
    const managedRoot = join(dataDir, "managed-skills");
    const workspaceRoot = join(dataDir, "workspace-skills");
    await Promise.all([bundledRoot, managedRoot, workspaceRoot].map((root) => mkdir(root, { recursive: true })));
    await cp(new URL("../../../portable/skills-cn/china-weather", import.meta.url), join(bundledRoot, "china-weather"), { recursive: true });
    await cp(new URL("../../../portable/skills-cn/china-weather", import.meta.url), join(workspaceRoot, "china-weather"), { recursive: true });
    const runtime = runtimeFor(workspaceRoot);
    const service = await createSkillService({ dataDir, bundledRoots: [bundledRoot], managedRoot, workspaceRoot, runtime, client: createFixtureSkillHubClient() });
    expect((await service.installed()).some((item) => item.slug === "china-weather")).toBe(true);
    const inventory = await service.runtimeStatus();
    expect(inventory.skills.find((item) => item.id === "china-weather")).toMatchObject({ availability: "conflict" });
    expect(runtime.status).toHaveBeenCalledWith(expect.any(Map));
  });

  it("lists only workspace Skills as installed while keeping managed and bundled runtime status", async () => {
    const dataDir = await makeRoot();
    const bundledRoot = join(dataDir, "bundled");
    const managedRoot = join(dataDir, ".openclaw", "skills");
    const workspaceRoot = join(dataDir, "workspace", "skills");
    await Promise.all([bundledRoot, managedRoot, workspaceRoot].map((root) => mkdir(root, { recursive: true })));
    await cp(new URL("../../../portable/skills-cn/china-weather", import.meta.url), join(bundledRoot, "china-weather"), { recursive: true });
    await cp(new URL("../../../portable/skills-cn/china-search", import.meta.url), join(managedRoot, "china-search"), { recursive: true });
    await cp(new URL("../../../portable/skills-cn/china-translate", import.meta.url), join(workspaceRoot, "china-translate"), { recursive: true });
    const runtime = runtimeFor(workspaceRoot, { status: vi.fn(async () => ({
      workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills", skills: [
        { id: "china-search", name: "china-search", source: "managed", bundled: false, disabled: true, eligible: false, modelVisible: false, userInvocable: true, commandVisible: false, availability: "disabled" as const, missing: emptyMissing, conflicts: [] },
        { id: "china-translate", name: "china-translate", source: "workspace", bundled: false, disabled: false, eligible: false, modelVisible: false, userInvocable: true, commandVisible: false, availability: "missing-dependency" as const, missing: { ...emptyMissing, bins: ["missing-bin"] }, conflicts: [] },
      ],
    })) });
    const service = await createSkillService({ dataDir, bundledRoots: [bundledRoot], managedRoot, workspaceRoot, runtime, client: createFixtureSkillHubClient() });
    expect(await service.installed()).toEqual([
      expect.objectContaining({ slug: "china-translate", enabled: true, source: { provider: "openclaw", origin: "workspace" } }),
    ]);
    expect(await service.runtimeStatus()).toEqual(expect.objectContaining({ skills: expect.arrayContaining([
      expect.objectContaining({ id: "china-search", disabled: true, source: "managed" }),
      expect.objectContaining({ id: "china-translate", disabled: false, source: "workspace" }),
    ]) }));
  });

  it("rejects a workspace toggle when a bundled namesake conflicts regardless of runtime order", async () => {
    const dataDir = await makeRoot();
    const bundledRoot = join(dataDir, "bundled");
    const workspaceRoot = join(dataDir, "workspace", "skills");
    await Promise.all([bundledRoot, workspaceRoot].map((root) => mkdir(root, { recursive: true })));
    await cp(new URL("../../../portable/skills-cn/china-weather", import.meta.url), join(bundledRoot, "china-weather"), { recursive: true });
    await cp(new URL("../../../portable/skills-cn/china-weather", import.meta.url), join(workspaceRoot, "china-weather"), { recursive: true });
    const setEnabled = vi.fn();
    const runtime = runtimeFor(workspaceRoot, { setEnabled, status: vi.fn(async () => ({
      workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills", skills: [
        { id: "china-weather", name: "china-weather", source: "bundled", bundled: true, disabled: false, eligible: true, modelVisible: true, userInvocable: true, commandVisible: true, availability: "conflict" as const, missing: emptyMissing, conflicts: ["portable-bundled", "workspace-installed"] },
        { id: "china-weather", name: "china-weather", source: "workspace", bundled: false, disabled: false, eligible: false, modelVisible: false, userInvocable: true, commandVisible: false, availability: "conflict" as const, missing: emptyMissing, conflicts: ["portable-bundled", "workspace-installed"] },
      ],
    })) });
    const service = await createSkillService({ dataDir, bundledRoots: [bundledRoot], workspaceRoot, runtime, client: createFixtureSkillHubClient() });
    expect((await service.setEnabled({ slug: "china-weather", enabled: false, confirmation: null })).state).toBe("failed");
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it("manages a pre-existing workspace Skill without skill-state metadata", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    await mkdir(workspaceRoot, { recursive: true });
    await cp(new URL("../../../portable/skills-cn/china-weather", import.meta.url), join(workspaceRoot, "china-weather"), { recursive: true });
    const runtime = runtimeFor(workspaceRoot);
    const service = await createSkillService({ dataDir, workspaceRoot, runtime, client: createFixtureSkillHubClient() });
    expect(await service.installed()).toEqual([expect.objectContaining({ slug: "china-weather", source: { provider: "openclaw", origin: "workspace" } })]);
    expect((await service.setEnabled({ slug: "china-weather", enabled: false, confirmation: null })).state).toBe("succeeded");
    expect((await service.setEnabled({ slug: "china-weather", enabled: true, confirmation: null })).state).toBe("succeeded");
    const removed = await service.waitForOperation((await service.startUninstall("china-weather")).id);
    expect(removed.state).toBe("succeeded");
    await expect(access(join(workspaceRoot, "china-weather"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("toggles a pre-existing workspace Skill without loading remote detail", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    await mkdir(workspaceRoot, { recursive: true });
    await cp(new URL("../../../portable/skills-cn/china-weather", import.meta.url), join(workspaceRoot, "china-weather"), { recursive: true });
    const client = createFixtureSkillHubClient();
    client.detail = vi.fn(async () => { throw new Error("remote unavailable"); });
    const runtime = runtimeFor(workspaceRoot);
    const service = await createSkillService({ dataDir, workspaceRoot, runtime, client });

    expect((await service.setEnabled({ slug: "china-weather", enabled: false, confirmation: null })).state).toBe("succeeded");
    expect((await service.setEnabled({ slug: "china-weather", enabled: true, confirmation: null })).state).toBe("succeeded");
    expect(client.detail).not.toHaveBeenCalled();
  });

  it("keeps the permission confirmation cause when re-enabling an installed Skill", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    const runtime = runtimeFor(workspaceRoot);
    const service = await createSkillService({ dataDir, workspaceRoot, runtime, client: createFixtureSkillHubClient() });
    const detail = await service.detail("workspace-reader");
    await service.waitForOperation((await service.startInstall({
      slug: detail.slug,
      confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);
    expect((await service.setEnabled({ slug: detail.slug, enabled: false, confirmation: null })).state).toBe("succeeded");

    const failed = await service.setEnabled({ slug: detail.slug, enabled: true, confirmation: null });

    expect(failed).toMatchObject({
      state: "failed",
      error: "Skill permissions require explicit confirmation.",
    });
  });

  it("retains a durable toggle journal when state persistence and runtime compensation both fail", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    const initial = await createSkillService({ dataDir, workspaceRoot, client: createFixtureSkillHubClient() });
    const detail = await initial.detail("workspace-reader");
    await initial.waitForOperation((await initial.startInstall({ slug: detail.slug, confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk } })).id);
    let disabled = false;
    let rejectCompensation = false;
    const runtime = runtimeFor(workspaceRoot, {
      status: vi.fn(async () => ({
        workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills", skills: [{
          id: detail.slug, name: detail.slug, source: "workspace", bundled: false, disabled, eligible: !disabled,
          modelVisible: !disabled, userInvocable: true, commandVisible: !disabled,
          availability: disabled ? "disabled" as const : "available" as const, missing: emptyMissing, conflicts: [],
        }],
      })),
      setEnabled: vi.fn(async (_slug, enabled) => {
        if (rejectCompensation && enabled) throw new Error("compensation failed");
        disabled = !enabled;
        rejectCompensation = !enabled;
        return { id: detail.slug, name: detail.slug, source: "workspace", bundled: false, disabled, eligible: enabled, modelVisible: enabled, userInvocable: true, commandVisible: enabled, availability: enabled ? "available" as const : "disabled" as const, missing: emptyMissing, conflicts: [] };
      }),
    });
    const failing = await createSkillService({
      dataDir, workspaceRoot, runtime, client: createFixtureSkillHubClient(),
      writeState: async () => { throw new Error("disk full"); },
    });
    expect((await failing.setEnabled({ slug: detail.slug, enabled: false, confirmation: null })).state).toBe("failed");
    expect(await readdir(join(dataDir, "capabilities", ".skill-transactions"))).toEqual([expect.stringMatching(/\.json$/)]);

    const recovered = await createSkillService({ dataDir, workspaceRoot, runtime, client: createFixtureSkillHubClient() });
    expect(await recovered.installed()).toEqual([expect.objectContaining({ slug: detail.slug, enabled: false })]);
    expect(await readdir(join(dataDir, "capabilities", ".skill-transactions"))).toEqual([]);
  });

  it("defers toggle recovery while Gateway is offline and reconciles when runtime returns", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    const initial = await createSkillService({ dataDir, workspaceRoot, client: createFixtureSkillHubClient() });
    const detail = await initial.detail("workspace-reader");
    await initial.waitForOperation((await initial.startInstall({
      slug: detail.slug, confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);
    const root = join(dataDir, "capabilities");
    const state = JSON.parse(await readFile(join(root, "skill-state.json"), "utf8"));
    const previousRecord = state.installed[detail.slug];
    const journalPath = join(root, ".skill-transactions", "offline-toggle.json");
    await writeFile(journalPath, `${JSON.stringify({
      operationId: "offline-toggle", slug: detail.slug, action: "toggle", phase: "runtime-changed",
      previousRecord, nextRecord: { ...previousRecord, enabled: false },
    })}\n`);
    let offline = true;
    const runtime = runtimeFor(workspaceRoot, { status: vi.fn(async () => {
      if (offline) throw new Error("Gateway offline");
      return {
        workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills", skills: [{
          id: detail.slug, name: detail.slug, source: "workspace", bundled: false, disabled: true, eligible: false,
          modelVisible: false, userInvocable: true, commandVisible: false, availability: "disabled" as const,
          missing: emptyMissing, conflicts: [],
        }],
      };
    }) });

    const started = await createSkillService({ dataDir, workspaceRoot, runtime, client: createFixtureSkillHubClient() });
    expect(await readdir(join(root, ".skill-transactions"))).toEqual(["offline-toggle.json"]);
    offline = false;
    await started.runtimeStatus();
    expect(await started.installed()).toEqual([expect.objectContaining({ slug: detail.slug, enabled: false })]);
    expect(await readdir(join(root, ".skill-transactions"))).toEqual([]);
  });

  it("keeps replacement recovery pending while OpenClaw is offline and replays it after authoritative readback", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    const initial = await createSkillService({ dataDir, workspaceRoot, client: createFixtureSkillHubClient() });
    const detail = await initial.detail("workspace-reader");
    await initial.waitForOperation((await initial.startInstall({
      slug: detail.slug, confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);
    const root = join(dataDir, "capabilities");
    const statePath = join(root, "skill-state.json");
    const previousRecord = JSON.parse(await readFile(statePath, "utf8")).installed[detail.slug];
    const journalPath = join(root, ".skill-transactions", "offline-replace.json");
    await writeFile(statePath, `${JSON.stringify({ schemaVersion: 1, installed: {} })}\n`);
    await writeFile(journalPath, `${JSON.stringify({
      operationId: "offline-replace", slug: detail.slug, action: "replace", phase: "replaced",
      previousRecord: null, nextRecord: previousRecord,
    })}\n`);
    let offline = true;
    const runtime = runtimeFor(workspaceRoot, { status: vi.fn(async () => {
      if (offline) throw new Error("Gateway offline");
      return {
        workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills", skills: [{
          id: detail.slug, name: detail.slug, source: "workspace", bundled: false, disabled: false, eligible: true,
          modelVisible: true, userInvocable: true, commandVisible: true, availability: "available" as const,
          missing: emptyMissing, conflicts: [],
        }],
      };
    }) });

    const recovered = await createSkillService({ dataDir, workspaceRoot, runtime, client: createFixtureSkillHubClient() });
    expect(await readdir(join(root, ".skill-transactions"))).toEqual(["offline-replace.json"]);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ schemaVersion: 1, installed: {} });
    offline = false;
    await recovered.runtimeStatus();
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ installed: { [detail.slug]: previousRecord } });
    expect(await readdir(join(root, ".skill-transactions"))).toEqual([]);
  });

  it("replays a pending toggle before uninstalling the same Skill", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    const initial = await createSkillService({ dataDir, workspaceRoot, client: createFixtureSkillHubClient() });
    const detail = await initial.detail("workspace-reader");
    await initial.waitForOperation((await initial.startInstall({
      slug: detail.slug, confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);
    const root = join(dataDir, "capabilities");
    const statePath = join(root, "skill-state.json");
    const previousRecord = JSON.parse(await readFile(statePath, "utf8")).installed[detail.slug];
    await writeFile(join(root, ".skill-transactions", "pending-toggle.json"), `${JSON.stringify({
      operationId: "pending-toggle", slug: detail.slug, action: "toggle", phase: "runtime-changed",
      previousRecord, nextRecord: { ...previousRecord, enabled: false },
    })}\n`);
    let offline = true;
    const disabled = true;
    const runtime = runtimeFor(workspaceRoot, { status: vi.fn(async () => {
      if (offline) throw new Error("Gateway offline");
      return { workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills",
      skills: await readdir(workspaceRoot).catch(() => []).then((names) => names.filter((name) => !name.startsWith(".")).map((name) => ({
        id: name, name, source: "workspace", bundled: false, disabled, eligible: !disabled,
        modelVisible: !disabled, userInvocable: true, commandVisible: !disabled,
        availability: disabled ? "disabled" as const : "available" as const, missing: emptyMissing, conflicts: [],
      }))),
    }; }) });
    const service = await createSkillService({ dataDir, workspaceRoot, runtime, client: createFixtureSkillHubClient() });
    offline = false;
    const result = await service.waitForOperation((await service.startUninstall(detail.slug)).id);

    expect(result.state).toBe("succeeded");
    expect(await readdir(join(root, ".skill-transactions"))).toEqual([]);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ schemaVersion: 1, installed: {} });
  });

  it("serializes deferred recovery behind an active mutation", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    const initial = await createSkillService({ dataDir, workspaceRoot, client: createFixtureSkillHubClient() });
    const detail = await initial.detail("workspace-reader");
    await initial.waitForOperation((await initial.startInstall({
      slug: detail.slug, confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);
    const root = join(dataDir, "capabilities");
    const previousRecord = JSON.parse(await readFile(join(root, "skill-state.json"), "utf8")).installed[detail.slug];
    await writeFile(join(root, ".skill-transactions", "queued-toggle.json"), `${JSON.stringify({
      operationId: "queued-toggle", slug: detail.slug, action: "toggle", phase: "runtime-changed",
      previousRecord, nextRecord: { ...previousRecord, enabled: false },
    })}\n`);
    let offline = true;
    let releaseMutation!: () => void;
    const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const events: string[] = [];
    const runtime = runtimeFor(workspaceRoot, { status: vi.fn(async () => {
      events.push("status");
      if (offline) throw new Error("Gateway offline");
      return {
        workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills", skills: [{
          id: detail.slug, name: detail.slug, source: "workspace", bundled: false, disabled: true, eligible: false,
          modelVisible: false, userInvocable: true, commandVisible: false, availability: "disabled" as const,
          missing: emptyMissing, conflicts: [],
        }],
      };
    }) });
    const service = await createSkillService({
      dataDir, workspaceRoot, runtime, client: createFixtureSkillHubClient(),
      runMutation: async (operation) => { events.push("mutation-start"); await mutationGate; const result = await operation(); events.push("mutation-end"); return result; },
    });
    offline = false;
    const detailForUpdate = await service.detail(detail.slug);
    const active = await service.startUpdate({ slug: detail.slug, confirmation: {
      permissionFingerprint: detailForUpdate.permissionFingerprint, acceptedRisk: detailForUpdate.risk,
    } });
    const readback = service.runtimeStatus();
    await Promise.resolve();
    expect(events).toEqual(["status", "mutation-start"]);
    releaseMutation();
    await service.waitForOperation(active.id);
    await readback;
    expect(events.indexOf("mutation-end")).toBeLessThan(events.lastIndexOf("status"));
  });

  it("keeps a toggle journal pending when OpenClaw omits an existing authoritative Skill", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    const initial = await createSkillService({ dataDir, workspaceRoot, client: createFixtureSkillHubClient() });
    const detail = await initial.detail("workspace-reader");
    await initial.waitForOperation((await initial.startInstall({
      slug: detail.slug, confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);
    const root = join(dataDir, "capabilities");
    const statePath = join(root, "skill-state.json");
    const previousRecord = JSON.parse(await readFile(statePath, "utf8")).installed[detail.slug];
    await writeFile(join(root, ".skill-transactions", "missing-runtime-toggle.json"), `${JSON.stringify({
      operationId: "missing-runtime-toggle", slug: detail.slug, action: "toggle", phase: "runtime-changed",
      previousRecord, nextRecord: { ...previousRecord, enabled: false },
    })}\n`);
    const runtime = runtimeFor(workspaceRoot, { status: vi.fn(async () => ({
      workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills", skills: [],
    })) });

    const service = await createSkillService({ dataDir, workspaceRoot, runtime, client: createFixtureSkillHubClient() });
    expect(await readdir(join(root, ".skill-transactions"))).toEqual(["missing-runtime-toggle.json"]);
    expect(await service.installed()).toEqual([expect.objectContaining({ slug: detail.slug, enabled: false })]);
  });

  it("clears a toggle journal when the authoritative Skill file is already absent", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    const initial = await createSkillService({ dataDir, workspaceRoot, client: createFixtureSkillHubClient() });
    const detail = await initial.detail("workspace-reader");
    await initial.waitForOperation((await initial.startInstall({
      slug: detail.slug, confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);
    const root = join(dataDir, "capabilities");
    const statePath = join(root, "skill-state.json");
    const previousRecord = JSON.parse(await readFile(statePath, "utf8")).installed[detail.slug];
    await writeFile(join(root, ".skill-transactions", "removed-toggle.json"), `${JSON.stringify({
      operationId: "removed-toggle", slug: detail.slug, action: "toggle", phase: "runtime-changed",
      previousRecord, nextRecord: { ...previousRecord, enabled: false },
    })}\n`);
    await import("node:fs/promises").then(({ rm }) => rm(join(workspaceRoot, detail.slug), { recursive: true }));
    const runtime = runtimeFor(workspaceRoot, { status: vi.fn(async () => ({
      workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills", skills: [],
    })) });

    const service = await createSkillService({ dataDir, workspaceRoot, runtime, client: createFixtureSkillHubClient() });
    expect(await service.installed()).toEqual([]);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ schemaVersion: 1, installed: {} });
    expect(await readdir(join(root, ".skill-transactions"))).toEqual([]);
  });

  it("blocks lifecycle mutations while an authoritative journal remains unresolved", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    const initial = await createSkillService({ dataDir, workspaceRoot, client: createFixtureSkillHubClient() });
    const detail = await initial.detail("workspace-reader");
    await initial.waitForOperation((await initial.startInstall({
      slug: detail.slug, confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);
    const root = join(dataDir, "capabilities");
    const previousRecord = JSON.parse(await readFile(join(root, "skill-state.json"), "utf8")).installed[detail.slug];
    await writeFile(join(root, ".skill-transactions", "blocked-toggle.json"), `${JSON.stringify({
      operationId: "blocked-toggle", slug: detail.slug, action: "toggle", phase: "runtime-changed",
      previousRecord, nextRecord: { ...previousRecord, enabled: false },
    })}\n`);
    const runtime = runtimeFor(workspaceRoot, { status: vi.fn(async () => { throw new Error("Gateway offline"); }) });
    const service = await createSkillService({ dataDir, workspaceRoot, runtime, client: createFixtureSkillHubClient() });
    vi.mocked(runtime.status).mockClear();

    const result = await service.waitForOperation((await service.startUninstall(detail.slug)).id);
    expect(result.state).toBe("failed");
    await expect(access(join(workspaceRoot, detail.slug))).resolves.toBeUndefined();
    expect(await readdir(join(root, ".skill-transactions"))).toEqual(["blocked-toggle.json"]);
    expect(runtime.status).toHaveBeenCalledTimes(1);
  });

  it("rejects install when an unmanaged workspace Skill already occupies the slug", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    await mkdir(join(workspaceRoot, "workspace-reader"), { recursive: true });
    await writeFile(join(workspaceRoot, "workspace-reader", "SKILL.md"), "---\nslug: workspace-reader\nname: Existing\ndescription: Existing workspace Skill\nversion: local\n---\n");
    const service = await createSkillService({ dataDir, workspaceRoot, runtime: runtimeFor(workspaceRoot), client: createFixtureSkillHubClient() });
    const detail = await service.detail("workspace-reader");

    await expect(service.startInstall({
      slug: detail.slug, confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(readFile(join(workspaceRoot, detail.slug, "SKILL.md"), "utf8")).resolves.toContain("Existing workspace Skill");
  });

  it("does not accept a bundled namesake as workspace install readback", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    const runtime = runtimeFor(workspaceRoot, { status: vi.fn(async () => ({
      workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills", skills: [{
        id: "workspace-reader", name: "workspace-reader", source: "bundled", bundled: true, disabled: false,
        eligible: true, modelVisible: true, userInvocable: true, commandVisible: true, availability: "available" as const, missing: emptyMissing, conflicts: [],
      }],
    })) });
    const service = await createSkillService({ dataDir, workspaceRoot, runtime, client: createFixtureSkillHubClient() });
    const detail = await service.detail("workspace-reader");
    const result = await service.waitForOperation((await service.startInstall({ slug: detail.slug, confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk } })).id);
    expect(result.state).toBe("failed");
  });

  it("uninstalls workspace content even when a bundled namesake remains", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    let installed = true;
    const runtime = runtimeFor(workspaceRoot, { status: vi.fn(async () => ({
      workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills", skills: [
        { id: "workspace-reader", name: "workspace-reader", source: "bundled", bundled: true, disabled: false, eligible: true, modelVisible: true, userInvocable: true, commandVisible: true, availability: "available" as const, missing: emptyMissing, conflicts: [] },
        ...(installed ? [{ id: "workspace-reader", name: "workspace-reader", source: "workspace", bundled: false, disabled: false, eligible: true, modelVisible: true, userInvocable: true, commandVisible: true, availability: "available" as const, missing: emptyMissing, conflicts: [] }] : []),
      ],
    })) });
    const service = await createSkillService({ dataDir, workspaceRoot, runtime, client: createFixtureSkillHubClient() });
    const detail = await service.detail("workspace-reader");
    await service.waitForOperation((await service.startInstall({ slug: detail.slug, confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk } })).id);
    installed = false;
    const result = await service.waitForOperation((await service.startUninstall(detail.slug)).id);
    expect(result.state).toBe("succeeded");
  });

  it("passes curator and proposal operations through the runtime", async () => {
    const dataDir = await makeRoot();
    const runtime = runtimeFor(join(dataDir, "workspace", "skills"), {
      curatorStatus: vi.fn(async () => ({ marker: "curator" } as never)),
      proposalAction: vi.fn(async () => formalProposalRecord),
    });
    const service = await createSkillService({ dataDir, runtime, client: createFixtureSkillHubClient() });
    await expect(service.curatorStatus()).resolves.toEqual({ marker: "curator" });
    await expect(service.proposalAction("proposal-1", "apply", "reviewed")).resolves.toEqual(formalProposalRecord);
  });

  it("serializes curator and proposal mutations through the lifecycle mutation queue", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let mutations = 0;
    const dataDir = await makeRoot();
    const runtime = runtimeFor(join(dataDir, "workspace", "skills"), {
      curatorAction: vi.fn(async () => { events.push("curator-runtime"); return {} as never; }),
      updateProposal: vi.fn(async () => { events.push("proposal-runtime"); return formalProposalRecord as never; }),
    });
    const service = await createSkillService({
      dataDir, runtime, client: createFixtureSkillHubClient(),
      runMutation: async (operation) => {
        mutations += 1;
        const current = mutations;
        events.push(`mutation-${current}-start`);
        if (current === 1) await firstGate;
        const result = await operation();
        events.push(`mutation-${current}-end`);
        return result;
      },
    });

    const curator = service.curatorAction("workspace-reader", "pin");
    const proposal = service.proposalUpdate({ skillName: "workspace-reader", content: "updated" });
    await Promise.resolve();
    expect(events).toEqual(["mutation-1-start"]);
    releaseFirst();
    await Promise.all([curator, proposal]);
    expect(events).toEqual([
      "mutation-1-start", "curator-runtime", "mutation-1-end",
      "mutation-2-start", "proposal-runtime", "mutation-2-end",
    ]);
  });

  it("blocks curator and proposal mutations while transaction recovery is unresolved", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    const initial = await createSkillService({ dataDir, workspaceRoot, client: createFixtureSkillHubClient() });
    const detail = await initial.detail("workspace-reader");
    await initial.waitForOperation((await initial.startInstall({
      slug: detail.slug, confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);
    const root = join(dataDir, "capabilities");
    const previousRecord = JSON.parse(await readFile(join(root, "skill-state.json"), "utf8")).installed[detail.slug];
    await writeFile(join(root, ".skill-transactions", "blocked-write-toggle.json"), `${JSON.stringify({
      operationId: "blocked-write-toggle", slug: detail.slug, action: "toggle", phase: "runtime-changed",
      previousRecord, nextRecord: { ...previousRecord, enabled: false },
    })}\n`);
    const curatorAction = vi.fn();
    const updateProposal = vi.fn();
    const runtime = runtimeFor(workspaceRoot, {
      status: vi.fn(async () => { throw new Error("Gateway offline"); }), curatorAction, updateProposal,
    });
    const service = await createSkillService({ dataDir, workspaceRoot, runtime, client: createFixtureSkillHubClient() });

    await expect(service.curatorAction(detail.slug, "pin")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service.proposalUpdate({ skillName: detail.slug, content: "updated" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(curatorAction).not.toHaveBeenCalled();
    expect(updateProposal).not.toHaveBeenCalled();
  });

  it("keeps background mutations tracked until the operation settles", async () => {
    let mutationCalls = 0;
    const runMutation = async <T>(operation: () => Promise<T>) => { mutationCalls += 1; return operation(); };
    const service = await createSkillService({ dataDir: await makeRoot(), client: createFixtureSkillHubClient(), runMutation });
    const detail = await service.detail("workspace-reader");
    const operation = await service.startInstall({
      slug: detail.slug,
      confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    });
    await service.waitForOperation(operation.id);
    expect(mutationCalls).toBe(1);
  });

  it("fails a queued mutation when the consistency coordinator rejects it", async () => {
    const runMutation = async <T>(_operation: () => Promise<T>): Promise<T> => { throw new Error("runtime unavailable"); };
    const service = await createSkillService({ dataDir: await makeRoot(), client: createFixtureSkillHubClient(), runMutation });
    const detail = await service.detail("workspace-reader");
    const operation = await service.startInstall({
      slug: detail.slug,
      confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    });

    await expect(service.waitForOperation(operation.id)).resolves.toMatchObject({ state: "failed" });
  });

  it("searches only free fixture Skills with cursor pagination", async () => {
    const service = await createSkillService({ dataDir: await makeRoot(), client: createFixtureSkillHubClient() });
    const first = await service.search({ query: "", sort: "downloads", cursor: null, pageSize: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ pricingType: "free", ownerName: "U-Claw Fixtures", downloads: 879, requiresKey: false });
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

  it.each([
    [tagSkillHubFailure(Object.assign(new Error("missing"), { status: 404 }), "not-found"), "NOT_FOUND"],
    [tagSkillHubFailure(new Error("identity changed"), "identity-conflict"), "CONFLICT"],
    [tagSkillHubFailure(new Error("gateway offline"), "upstream-unavailable"), "UNAVAILABLE"],
  ])("classifies remote detail failures without disguising them as not found", async (failure, code) => {
    const fixture = createFixtureSkillHubClient();
    const service = await createSkillService({
      dataDir: await makeRoot(),
      client: { ...fixture, detail: vi.fn(async () => { throw failure; }) },
    });

    await expect(service.detail("workspace-reader")).rejects.toMatchObject({ code });
  });

  it.each([
    ["forbidden", "FORBIDDEN"],
    ["upstream-invalid", "UNAVAILABLE"],
  ] as const)("does not let an installed snapshot hide a %s live detail failure", async (reason, code) => {
    const dataDir = await makeRoot();
    const initial = await createSkillService({ dataDir, client: createFixtureSkillHubClient() });
    const detail = await initial.detail("workspace-reader");
    await initial.waitForOperation((await initial.startInstall({
      slug: detail.slug,
      confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);
    const fixture = createFixtureSkillHubClient();
    const failing = await createSkillService({
      dataDir,
      client: { ...fixture, detail: vi.fn(async () => { throw tagSkillHubFailure(new Error("rejected"), reason); }) },
    });

    await expect(failing.detail("workspace-reader")).rejects.toMatchObject({ code });
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

  it("does not let installation refresh replace the identity the user confirmed", async () => {
    const fixture = createFixtureSkillHubClient();
    let detailCalls = 0;
    const client = {
      ...fixture,
      mode: "live" as const,
      detail: vi.fn(async (slug: string, expectedVersion?: string) => ({
        ...(await fixture.detail(slug, expectedVersion)),
        mode: "live" as const,
        identityFingerprint: (detailCalls++ === 0 ? "a" : "b").repeat(64),
      })),
      download: vi.fn(fixture.download),
    };
    const service = await createSkillService({ dataDir: await makeRoot(), client });
    const shown = await service.detail("workspace-reader", "1.0.0");

    await expect(service.startInstall({
      slug: shown.slug,
      expectedVersion: shown.version,
      confirmation: {
        permissionFingerprint: shown.permissionFingerprint,
        identityFingerprint: shown.identityFingerprint,
        acceptedRisk: shown.risk,
      },
    })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect(client.download).not.toHaveBeenCalled();
    expect(client.detail).toHaveBeenNthCalledWith(2, "workspace-reader", "1.0.0", true);
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
    expect(await readFile(join(dataDir, "capabilities", "skills", detail.slug, "SKILL.md"), "utf8"))
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
      expect(completed.state, invalidBundle).toBe("failed");
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

  it("forward-completes a verified replacement when backup cleanup fails", async () => {
    const dataDir = await makeRoot();
    const initial = await createSkillService({ dataDir, client: createFixtureSkillHubClient() });
    const detail = await initial.detail("workspace-reader");
    const confirmation = { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk } as const;
    await initial.waitForOperation((await initial.startInstall({ slug: detail.slug, confirmation })).id);
    let failedCleanup = false;
    const removePath = vi.fn(async (path: PathLike, options?: RmOptions) => {
      if (!failedCleanup && String(path).endsWith(".backup")) {
        failedCleanup = true;
        throw new Error("cleanup failed");
      }
      await import("node:fs/promises").then(({ rm }) => rm(path, options));
    });
    const options = {
      dataDir, client: createFixtureSkillHubClient({ versionOverride: { "workspace-reader": "1.1.0" } }), removePath,
    };
    const updating = await createSkillService(options);
    const next = await updating.detail(detail.slug);
    const result = await updating.waitForOperation((await updating.startUpdate({
      slug: detail.slug, confirmation: { permissionFingerprint: next.permissionFingerprint, acceptedRisk: next.risk },
    })).id);

    expect(removePath).toHaveBeenCalled();
    expect(result.state).toBe("failed");
    await expect(readFile(join(dataDir, "capabilities", "skills", detail.slug, "SKILL.md"), "utf8")).resolves.toContain("version: 1.1.0");
    expect(JSON.parse(await readFile(join(dataDir, "capabilities", "skill-state.json"), "utf8"))).toMatchObject({
      installed: { [detail.slug]: { version: "1.1.0" } },
    });
    const missingRuntime = runtimeFor(join(dataDir, "capabilities", "skills"), { status: vi.fn(async () => ({
      workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills", skills: [],
    })) });
    const recovered = await createSkillService({ dataDir, runtime: missingRuntime, client: createFixtureSkillHubClient() });
    expect(await recovered.installed()).toEqual([expect.objectContaining({ slug: detail.slug, version: "1.1.0" })]);
    expect(await readdir(join(dataDir, "capabilities", ".skill-transactions"))).toEqual([]);
  });

  it("preserves disabled state across update and validates the OpenClaw readback", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    let disabled = false;
    const runtime = runtimeFor(workspaceRoot, {
      status: vi.fn(async () => ({
        workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills",
        skills: await readdir(workspaceRoot).catch(() => []).then((names) => names.filter((name) => !name.startsWith(".")).map((name) => ({
          id: name, name, source: "workspace", bundled: false, disabled, eligible: !disabled,
          modelVisible: !disabled, userInvocable: true, commandVisible: !disabled,
          availability: disabled ? "disabled" as const : "available" as const, missing: emptyMissing, conflicts: [],
        }))),
      })),
      setEnabled: vi.fn(async (skillKey, enabled) => {
        disabled = !enabled;
        return { id: skillKey, name: skillKey, source: "workspace", bundled: false, disabled, eligible: enabled, modelVisible: enabled, userInvocable: true, commandVisible: enabled, availability: enabled ? "available" as const : "disabled" as const, missing: emptyMissing, conflicts: [] };
      }),
    });
    const initial = await createSkillService({ dataDir, workspaceRoot, runtime, client: createFixtureSkillHubClient() });
    const detail = await initial.detail("workspace-reader");
    const confirmation = { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk } as const;
    await initial.waitForOperation((await initial.startInstall({ slug: detail.slug, confirmation })).id);
    expect((await initial.setEnabled({ slug: detail.slug, enabled: false, confirmation: null })).state).toBe("succeeded");

    const updated = await createSkillService({
      dataDir, workspaceRoot, runtime,
      client: createFixtureSkillHubClient({ versionOverride: { "workspace-reader": "1.1.0" } }),
    });
    const next = await updated.detail(detail.slug);
    expect((await updated.waitForOperation((await updated.startUpdate({ slug: detail.slug, confirmation: {
      permissionFingerprint: next.permissionFingerprint, acceptedRisk: next.risk,
    } })).id)).state).toBe("succeeded");
    expect((await updated.installed())[0]).toMatchObject({ installedVersion: "1.1.0", enabled: false });
    expect(JSON.parse(await readFile(join(dataDir, "capabilities", "skill-state.json"), "utf8"))).toMatchObject({
      installed: { [detail.slug]: { version: "1.1.0", enabled: false } },
    });
  });

  it("rolls back update when OpenClaw enablement differs from persisted state", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    let disabled = false;
    const runtime = runtimeFor(workspaceRoot, {
      status: vi.fn(async () => ({
        workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills",
        skills: await readdir(workspaceRoot).catch(() => []).then((names) => names.filter((name) => !name.startsWith(".")).map((name) => ({
          id: name, name, source: "workspace", bundled: false, disabled, eligible: !disabled,
          modelVisible: !disabled, userInvocable: true, commandVisible: !disabled,
          availability: disabled ? "disabled" as const : "available" as const, missing: emptyMissing, conflicts: [],
        }))),
      })),
      setEnabled: vi.fn(async (skillKey, enabled) => {
        disabled = !enabled;
        return { id: skillKey, name: skillKey, source: "workspace", bundled: false, disabled, eligible: enabled, modelVisible: enabled, userInvocable: true, commandVisible: enabled, availability: enabled ? "available" as const : "disabled" as const, missing: emptyMissing, conflicts: [] };
      }),
    });
    const initial = await createSkillService({ dataDir, workspaceRoot, runtime, client: createFixtureSkillHubClient() });
    const detail = await initial.detail("workspace-reader");
    const confirmation = { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk } as const;
    await initial.waitForOperation((await initial.startInstall({ slug: detail.slug, confirmation })).id);
    await initial.setEnabled({ slug: detail.slug, enabled: false, confirmation: null });
    disabled = false;

    const updated = await createSkillService({
      dataDir, workspaceRoot, runtime,
      client: createFixtureSkillHubClient({ versionOverride: { "workspace-reader": "1.1.0" } }),
    });
    const next = await updated.detail(detail.slug);
    const result = await updated.waitForOperation((await updated.startUpdate({ slug: detail.slug, confirmation: {
      permissionFingerprint: next.permissionFingerprint, acceptedRisk: next.risk,
    } })).id);
    expect(result.state).toBe("failed");
    expect(JSON.parse(await readFile(join(dataDir, "capabilities", "skill-state.json"), "utf8"))).toMatchObject({
      installed: { [detail.slug]: { version: "1.0.0", enabled: false } },
    });
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
      operationId: "power-loss", slug: detail.slug, action: "remove",
      phase: "backed-up", previousRecord: { slug: detail.slug, version: detail.version, enabled: true },
    })}\n`);

    const recovered = await createSkillService({ dataDir, client });
    expect((await recovered.installed())[0]).toMatchObject({ slug: detail.slug, enabled: true });
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toContain(detail.slug);
  });

  it("forward-completes a verified uninstall when backup cleanup fails", async () => {
    const dataDir = await makeRoot();
    const initial = await createSkillService({ dataDir, client: createFixtureSkillHubClient() });
    const detail = await initial.detail("workspace-reader");
    await initial.waitForOperation((await initial.startInstall({
      slug: detail.slug, confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);
    let failedCleanup = false;
    const removePath = vi.fn(async (path: PathLike, options?: RmOptions) => {
      if (!failedCleanup && String(path).endsWith(".backup")) {
        failedCleanup = true;
        throw new Error("cleanup failed");
      }
      await import("node:fs/promises").then(({ rm }) => rm(path, options));
    });
    const options = { dataDir, client: createFixtureSkillHubClient(), removePath };
    const service = await createSkillService(options);
    const result = await service.waitForOperation((await service.startUninstall(detail.slug)).id);

    expect(removePath).toHaveBeenCalled();
    expect(result.state).toBe("failed");
    await expect(access(join(dataDir, "capabilities", "skills", detail.slug))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(join(dataDir, "capabilities", "skill-state.json"), "utf8"))).toEqual({ schemaVersion: 1, installed: {} });
    const staleRuntime = runtimeFor(join(dataDir, "capabilities", "skills"), { status: vi.fn(async () => ({
      workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills", skills: [{
        id: detail.slug, name: detail.slug, source: "workspace", bundled: false, disabled: false, eligible: true,
        modelVisible: true, userInvocable: true, commandVisible: true, availability: "available" as const,
        missing: emptyMissing, conflicts: [],
      }],
    })) });
    const recovered = await createSkillService({ dataDir, runtime: staleRuntime, client: createFixtureSkillHubClient() });
    expect(await recovered.installed()).toEqual([]);
    expect(await readdir(join(dataDir, "capabilities", ".skill-transactions"))).toEqual([]);
  });

  it("recovers after uninstall readback rollback restores files but cannot restore state", async () => {
    const dataDir = await makeRoot();
    const workspaceRoot = join(dataDir, "workspace", "skills");
    const client = createFixtureSkillHubClient();
    const initial = await createSkillService({ dataDir, workspaceRoot, client });
    const detail = await initial.detail("workspace-reader");
    const confirmation = { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk } as const;
    await initial.waitForOperation((await initial.startInstall({ slug: detail.slug, confirmation })).id);
    const runtime = runtimeFor(workspaceRoot, { status: vi.fn(async () => ({
      workspaceDir: "OpenClaw workspace", managedSkillsDir: "OpenClaw managed skills", skills: [{
        id: detail.slug, name: detail.slug, source: "workspace", bundled: false, disabled: false, eligible: true,
        modelVisible: true, userInvocable: true, commandVisible: true, availability: "available" as const,
        missing: emptyMissing, conflicts: [],
      }],
    })) });
    let stateWrites = 0;
    const interrupted = await createSkillService({
      dataDir, workspaceRoot, runtime, client,
      writeState: async (path, state) => {
        stateWrites += 1;
        if (stateWrites === 2) throw new Error("power loss during rollback state restore");
        await writeFile(path, `${JSON.stringify(state)}\n`);
      },
    });

    expect((await interrupted.waitForOperation((await interrupted.startUninstall(detail.slug)).id)).state).toBe("failed");
    await expect(readFile(join(workspaceRoot, detail.slug, "SKILL.md"), "utf8")).resolves.toContain(detail.slug);
    expect(await readdir(join(dataDir, "capabilities", ".skill-transactions"))).toEqual([expect.stringMatching(/\.json$/u)]);

    const recovered = await createSkillService({ dataDir, workspaceRoot, client });
    expect((await recovered.installed())[0]).toMatchObject({ slug: detail.slug, version: detail.version, enabled: true });
    expect(await readdir(join(dataDir, "capabilities", ".skill-transactions"))).toEqual([]);
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
      operationId: "rename-window", slug: detail.slug, action: "replace",
      phase: "staged", previousRecord, nextRecord: previousRecord,
    })}\n`);
    const restored = await createSkillService({ dataDir, client });
    expect((await restored.installed())[0].slug).toBe(detail.slug);

    const replacedJournal = join(root, ".skill-transactions", "replaced-window.json");
    await writeFile(statePath, `${JSON.stringify({ schemaVersion: 1, installed: {} })}\n`);
    await writeFile(replacedJournal, `${JSON.stringify({
      operationId: "replaced-window", slug: detail.slug, action: "replace",
      phase: "replaced", previousRecord: null, nextRecord: previousRecord,
    })}\n`);
    const completed = await createSkillService({ dataDir, client });
    expect((await completed.installed())[0].slug).toBe(detail.slug);
  });

  it("rolls back a prepared replacement journal before staging starts", async () => {
    const dataDir = await makeRoot();
    const client = createFixtureSkillHubClient();
    const service = await createSkillService({ dataDir, client });
    const detail = await service.detail("workspace-reader");
    await service.waitForOperation((await service.startInstall({
      slug: detail.slug, confirmation: { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk },
    })).id);
    const root = join(dataDir, "capabilities");
    const statePath = join(root, "skill-state.json");
    const previousRecord = JSON.parse(await readFile(statePath, "utf8")).installed[detail.slug];
    await writeFile(join(root, ".skill-transactions", "prepared-replace.json"), `${JSON.stringify({
      operationId: "prepared-replace", slug: detail.slug, action: "replace", phase: "prepared",
      previousRecord, nextRecord: { ...previousRecord, version: "1.1.0" },
    })}\n`);

    const recovered = await createSkillService({ dataDir, client });
    expect((await recovered.installed())[0]).toMatchObject({ slug: detail.slug, version: detail.version });
    expect(await readdir(join(root, ".skill-transactions"))).toEqual([]);
  });

  it("restores backup when replacement rollback crashes after deleting target", async () => {
    const dataDir = await makeRoot();
    const client = createFixtureSkillHubClient();
    const service = await createSkillService({ dataDir, client });
    const detail = await service.detail("workspace-reader");
    const confirmation = { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk } as const;
    await service.waitForOperation((await service.startInstall({ slug: detail.slug, confirmation })).id);
    const root = join(dataDir, "capabilities");
    const statePath = join(root, "skill-state.json");
    const previousRecord = JSON.parse(await readFile(statePath, "utf8")).installed[detail.slug];
    const target = join(root, "skills", detail.slug);
    const backup = join(root, "skills", `.${detail.slug}.replace-crash.backup`);
    await rename(target, backup);
    await writeFile(join(root, ".skill-transactions", "replace-crash.json"), `${JSON.stringify({
      operationId: "replace-crash", slug: detail.slug, action: "replace", phase: "rolling-back",
      previousRecord, nextRecord: { ...previousRecord, version: "1.1.0" },
    })}\n`);

    const recovered = await createSkillService({ dataDir, client });
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toContain(detail.slug);
    expect((await recovered.installed())[0]).toMatchObject({ version: "1.0.0", enabled: true });
    expect(await readdir(join(root, ".skill-transactions"))).toEqual([]);
  });

  it("restores uninstall state when rollback already moved backup back to target", async () => {
    const dataDir = await makeRoot();
    const client = createFixtureSkillHubClient();
    const service = await createSkillService({ dataDir, client });
    const detail = await service.detail("workspace-reader");
    const confirmation = { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk } as const;
    await service.waitForOperation((await service.startInstall({ slug: detail.slug, confirmation })).id);
    const root = join(dataDir, "capabilities");
    const statePath = join(root, "skill-state.json");
    const previousRecord = JSON.parse(await readFile(statePath, "utf8")).installed[detail.slug];
    await writeFile(statePath, `${JSON.stringify({ schemaVersion: 1, installed: {} })}\n`);
    await writeFile(join(root, ".skill-transactions", "remove-rollback.json"), `${JSON.stringify({
      operationId: "remove-rollback", slug: detail.slug, action: "remove", phase: "committed", previousRecord,
    })}\n`);

    const recovered = await createSkillService({ dataDir, client });
    expect(await readFile(join(root, "skills", detail.slug, "SKILL.md"), "utf8")).toContain(detail.slug);
    expect((await recovered.installed())[0]).toMatchObject({ version: detail.version, enabled: true });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ installed: { [detail.slug]: previousRecord } });
    expect(await readdir(join(root, ".skill-transactions"))).toEqual([]);
  });
});
