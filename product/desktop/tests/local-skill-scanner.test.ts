import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_LOCAL_SKILL_ENTRIES,
  MAX_LOCAL_SKILL_MARKDOWN_BYTES,
  scanLocalSkills,
} from "../src/skills/local-skill-scanner.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("local Skill scanner", () => {
  it("scans all original portable Chinese Skills and OpenClaw workspace installs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-skill-scan-"));
    roots.push(dataDir);
    const workspaceRoot = join(dataDir, "workspace", "skills");
    await mkdir(workspaceRoot, { recursive: true });
    await cp(resolve(import.meta.dirname, "../../../portable/skills-cn/china-weather"), join(workspaceRoot, "china-weather"), { recursive: true });
    const result = await scanLocalSkills({
      bundledRoots: [resolve(import.meta.dirname, "../../../portable/skills-cn")],
      managedRoot: join(dataDir, ".openclaw", "skills"), workspaceRoot,
    });
    expect(result.items.filter((item) => item.origin === "portable-bundled")).toHaveLength(17);
    expect(result.items.some((item) => item.origin === "workspace-installed")).toBe(true);
    expect(result.conflicts.get("china-weather")).toContain("workspace-installed");
  });

  it("scans Tencent SkillHub namespace installs one level below the workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-skill-namespace-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace", "skills");
    const skillRoot = join(workspaceRoot, "@user_ab5ae6ee", "unclecheng-reduce-ai-perception-v2");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(join(skillRoot, "SKILL.md"), "---\nname: humanizer\ndescription: Remove AI writing patterns\nversion: 4.1.0\n---\n");

    const result = await scanLocalSkills({ bundledRoots: [], managedRoot: join(root, "managed"), workspaceRoot });

    expect(result.items).toEqual([expect.objectContaining({
      id: "unclecheng-reduce-ai-perception-v2",
      name: "humanizer",
      directoryKey: "unclecheng-reduce-ai-perception-v2",
      markdown: expect.stringContaining("Remove AI writing patterns"),
      origin: "workspace-installed",
    })]);
  });

  it("keeps slug, runtime name, directory identity, and complete markdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-skill-identities-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace", "skills");
    const skillRoot = join(workspaceRoot, "@user_bddf3fe6", "contextweave-interactive-architecture");
    await mkdir(skillRoot, { recursive: true });
    const markdown = "---\nname: interactive-architecture-diagram\nslug: contextweave-interactive-architecture\ndisplayName: 架构图一键生成\ndescription: Build architecture diagrams\nversion: 1.2.0\n---\n\n# Architecture\n\n- Parse requirements\n";
    await writeFile(join(skillRoot, "SKILL.md"), markdown);

    const result = await scanLocalSkills({ bundledRoots: [], managedRoot: join(root, "managed"), workspaceRoot });

    expect(result.items).toEqual([expect.objectContaining({
      id: "contextweave-interactive-architecture",
      name: "架构图一键生成",
      runtimeName: "interactive-architecture-diagram",
      directoryKey: "contextweave-interactive-architecture",
      markdown,
    })]);
  });

  it("rejects symlinked Skill entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-skill-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "uclaw-skill-outside-"));
    roots.push(root, outside);
    await writeFile(join(outside, "SKILL.md"), "---\nname: outside\ndescription: outside\n---\n");
    await mkdir(join(root, "skills"), { recursive: true });
    await symlink(outside, join(root, "skills", "outside"));
    const result = await scanLocalSkills({ bundledRoots: [], managedRoot: join(root, "skills"), workspaceRoot: join(root, "workspace") });
    expect(result.errors).toEqual([expect.objectContaining({ id: "outside" })]);
  });

  it("marks duplicate ids within one workspace root and across bundled roots as conflicts", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-skill-duplicate-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    const bundledA = join(root, "bundled-a");
    const bundledB = join(root, "bundled-b");
    await Promise.all([workspaceRoot, bundledA, bundledB].map((path) => mkdir(path, { recursive: true })));
    for (const [path, slug] of [
      [join(workspaceRoot, "one"), "workspace-shared"],
      [join(workspaceRoot, "two"), "workspace-shared"],
      [join(bundledA, "a"), "bundled-shared"],
      [join(bundledB, "b"), "bundled-shared"],
    ] as const) {
      await mkdir(path);
      await writeFile(join(path, "SKILL.md"), `---\nslug: ${slug}\nname: Shared\ndescription: Shared id\n---\n`);
    }

    const result = await scanLocalSkills({ bundledRoots: [bundledA, bundledB], managedRoot: join(root, "managed"), workspaceRoot });

    expect(result.conflicts.get("workspace-shared")).toEqual(["workspace-installed", "workspace-installed"]);
    expect(result.conflicts.get("bundled-shared")).toEqual(["portable-bundled", "portable-bundled"]);
  });

  it("fails closed for an overpopulated root without interrupting other roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-skill-entry-limit-"));
    roots.push(root);
    const crowded = join(root, "crowded");
    const workspaceRoot = join(root, "workspace");
    await Promise.all([crowded, workspaceRoot].map((path) => mkdir(path, { recursive: true })));
    await Promise.all(Array.from({ length: MAX_LOCAL_SKILL_ENTRIES + 1 }, async (_, index) => {
      const path = join(crowded, `skill-${index}`);
      await mkdir(path);
      await writeFile(join(path, "SKILL.md"), `---\nname: Skill ${index}\ndescription: Entry\n---\n`);
    }));
    const valid = join(workspaceRoot, "valid");
    await mkdir(valid);
    await writeFile(join(valid, "SKILL.md"), "---\nname: Valid\ndescription: Valid\n---\n");

    const result = await scanLocalSkills({ bundledRoots: [crowded], managedRoot: join(root, "managed"), workspaceRoot });

    expect(result.items).toEqual([expect.objectContaining({ id: "valid", origin: "workspace-installed" })]);
    expect(result.errors).toHaveLength(MAX_LOCAL_SKILL_ENTRIES + 1);
    expect(result.errors.every((error) => error.origin === "portable-bundled")).toBe(true);
  });

  it("rejects an oversized SKILL.md and continues scanning siblings", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-skill-size-limit-"));
    roots.push(root);
    const managedRoot = join(root, "managed");
    const oversized = join(managedRoot, "oversized");
    const valid = join(managedRoot, "valid");
    await Promise.all([oversized, valid].map((path) => mkdir(path, { recursive: true })));
    await writeFile(join(oversized, "SKILL.md"), Buffer.alloc(MAX_LOCAL_SKILL_MARKDOWN_BYTES + 1, 0x61));
    await writeFile(join(valid, "SKILL.md"), "---\nname: Valid\ndescription: Valid\n---\n");

    const result = await scanLocalSkills({ bundledRoots: [], managedRoot, workspaceRoot: join(root, "workspace") });

    expect(result.items).toEqual([expect.objectContaining({ id: "valid" })]);
    expect(result.errors).toEqual([{ id: "oversized", origin: "managed-installed" }]);
  });
});
