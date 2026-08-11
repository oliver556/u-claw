import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFixtureSkillHubClient } from "../../desktop/src/skills/fixture-client.js";
import { createSkillService } from "../../desktop/src/skills/skill-service.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("Skill fixture lifecycle integration", () => {
  it("searches, installs, disables, and uninstalls in the portable data root", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-skill-integration-"));
    roots.push(dataDir);
    const workspaceRoot = join(dataDir, "workspace", "skills");
    const service = await createSkillService({ dataDir, workspaceRoot, client: createFixtureSkillHubClient() });
    const page = await service.search({ query: "工作区", cursor: null, pageSize: 20 });
    const detail = await service.detail(page.items[0].slug);
    const confirmation = { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk };
    await service.waitForOperation((await service.startInstall({ slug: detail.slug, confirmation })).id);
    expect(await readFile(join(workspaceRoot, detail.slug, "SKILL.md"), "utf8")).toContain(detail.slug);
    await service.setEnabled({ slug: detail.slug, enabled: false, confirmation });
    expect((await service.installed())[0].enabled).toBe(false);
    await service.waitForOperation((await service.startUninstall(detail.slug)).id);
    expect(await service.installed()).toEqual([]);
    const restarted = await createSkillService({ dataDir, workspaceRoot, client: createFixtureSkillHubClient() });
    expect(await restarted.installed()).toEqual([]);
  });
});
