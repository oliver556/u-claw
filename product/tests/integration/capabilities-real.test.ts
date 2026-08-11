import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveSkillRuntimeRegistration } from "../../desktop/src/main.js";
import { parseSkillMarkdownFrontmatter, validateSkillBundle } from "../../desktop/src/skills/bundle-validator.js";
import { createFixtureSkillHubClient } from "../../desktop/src/skills/fixture-client.js";
import { createSkillService, type SkillService } from "../../desktop/src/skills/skill-service.js";
import { createSkillHubClient } from "../../desktop/src/skills/skillhub-client.js";
import { createDesktopMainOptions } from "../../desktop/src/wiring/create-desktop-main-options.js";

const runRealOpenClaw = process.env.UCLAW_RUN_REAL_OPENCLAW === "1";
const runRealSkillHub = process.env.UCLAW_RUN_REAL_SKILLHUB === "1";
const openClawEntry = resolve(process.env.OPENCLAW_PACKAGE_DIR ?? join(homedir(), ".uclaw/core/node_modules/openclaw"), "openclaw.mjs");
const runtimeRoot = resolve(process.env.UCLAW_RUNTIME_DIR ?? join(homedir(), ".uclaw"));
const nodeExecutable = resolve(process.env.OPENCLAW_NODE_BIN ?? join(runtimeRoot, "runtime/node-mac-arm64/bin/node"));
const portableSkills = resolve(import.meta.dirname, "../../../portable/skills-cn");
const roots: string[] = [];
const processes: ChildProcess[] = [];

const proposalContent = (name: string, description: string, instruction: string) => `---
name: "${name}"
description: "${description}"
status: proposal
version: "v1"
date: "2026-08-12T00:00:00.000Z"
---

# ${name}

${instruction}
`;

async function reservePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not reserve a Gateway port.");
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

async function waitForPort(port: number, child: ChildProcess, diagnostic: () => string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`OpenClaw Gateway exited before readiness (${child.exitCode}): ${diagnostic()}`);
    try {
      await new Promise<void>((resolveConnect, reject) => {
        const socket = connect({ host: "127.0.0.1", port });
        socket.once("connect", () => { socket.destroy(); resolveConnect(); });
        socket.once("error", reject);
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("OpenClaw Gateway readiness timed out.");
}

async function stopGateway(child: ChildProcess): Promise<void> {
  const index = processes.indexOf(child);
  if (index >= 0) processes.splice(index, 1);
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      once(child, "exit"),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("OpenClaw Gateway shutdown timed out.")), 10_000); }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

afterEach(async () => {
  await Promise.allSettled(processes.splice(0).map(stopGateway));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!runRealSkillHub)("real SkillHub free catalog", () => {
  it("searches the official free catalog and validates a downloaded Skill bundle", async () => {
    const client = createSkillHubClient();
    const result = await client.search({
      query: "googleslides-automation",
      category: "office-efficiency",
      cursor: null,
      pageSize: 20,
    });
    expect(result.mode).toBe("live");
    expect(result.items).not.toHaveLength(0);
    expect(result.items.every((item) => item.pricingType === "free")).toBe(true);

    const catalogItem = result.items.find((item) => item.slug === "googleslides-automation");
    expect(catalogItem).toMatchObject({ slug: "googleslides-automation", version: "1.0.0", pricingType: "free" });
    const detail = await client.detail(catalogItem!.slug);
    expect(detail).toMatchObject({ slug: catalogItem!.slug, version: catalogItem!.version, pricingType: "free", mode: "live" });

    const bundle = await client.download(detail.slug);
    expect(bundle.entries.some((entry) => entry.type === "file" && entry.path === "SKILL.md")).toBe(true);
    expect(validateSkillBundle(bundle, detail).files.some((file) => file.path === "SKILL.md")).toBe(true);
  }, 60_000);
});

describe.skipIf(!runRealOpenClaw)("real OpenClaw Skill lifecycle", () => {
  it("persists install, disable, restart, and uninstall through production wiring", async () => {
    await access(openClawEntry);
    await access(nodeExecutable);
    await access(portableSkills);
    expect((await readdir(portableSkills, { withFileTypes: true })).filter((entry) => entry.isDirectory())).toHaveLength(17);
    expect(JSON.parse(await readFile(join(dirname(openClawEntry), "package.json"), "utf8"))).toMatchObject({
      name: "openclaw",
      version: "2026.7.1-2",
    });

    const root = await mkdtemp(join(tmpdir(), "uclaw-capabilities-real-"));
    roots.push(root);
    const dataDir = join(root, "data");
    const cacheDir = join(root, "cache");
    const workspaceDir = join(dataDir, "workspace");
    const workspaceSkills = join(workspaceDir, "skills");
    const openClawStateDir = join(dataDir, "openclaw-state");
    const configPath = join(dataDir, "config", "openclaw.json");
    await Promise.all([
      mkdir(cacheDir, { recursive: true }),
      mkdir(workspaceSkills, { recursive: true }),
      mkdir(openClawStateDir, { recursive: true }),
      mkdir(dirname(configPath), { recursive: true }),
    ]);
    const token = "uclaw-real-skill-token";
    await writeFile(configPath, `${JSON.stringify({
      gateway: { mode: "local", bind: "loopback", auth: { mode: "token", token } },
      agents: { defaults: { workspace: workspaceDir, skipBootstrap: true } },
    }, null, 2)}\n`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      UCLAW_RUNTIME_DIR: runtimeRoot,
      UCLAW_OPENCLAW_ENTRY: openClawEntry,
      UCLAW_NODE_BIN: nodeExecutable,
      UCLAW_DATA_DIR: dataDir,
      UCLAW_PORTABLE_SKILLS_DIR: portableSkills,
      OPENCLAW_STATE_DIR: openClawStateDir,
      OPENCLAW_CONFIG_PATH: configPath,
    };
    const port = await reservePort();
    const registryClient = runRealSkillHub ? createSkillHubClient() : createFixtureSkillHubClient();

    const start = async () => {
      const options = await createDesktopMainOptions(env);
      const launch = options.buildGatewayLaunchOptions(port) as {
        executable: string;
        args: string[];
        cwd: string;
        env: NodeJS.ProcessEnv;
      };
      const child = options.spawn(launch.executable, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        stdio: ["ignore", "pipe", "pipe"],
      }) as unknown as ChildProcess;
      let gatewayStderr = "";
      child.stderr?.on("data", (chunk) => { gatewayStderr = `${gatewayStderr}${String(chunk)}`.slice(-8_000); });
      processes.push(child);
      await waitForPort(port, child, () => gatewayStderr.trim());
      await options.probeCapabilities(port, new AbortController().signal);
      const registration = resolveSkillRuntimeRegistration(options.domainRegistrations);
      if (registration === undefined) throw new Error("Production Skill runtime is not registered.");
      const service = await createSkillService({
        dataDir,
        workspaceRoot: workspaceSkills,
        managedRoot: join(openClawStateDir, "skills"),
        bundledRoots: registration.bundledRoots,
        runtime: registration.runtime,
        client: registryClient,
      });
      return { options, child, service };
    };

    let running = await start();
    let service: SkillService | undefined = running.service;

    const created = await service.proposalCreate({
      name: "uclaw-real-proposal",
      description: "U-Claw real proposal lifecycle smoke",
      content: proposalContent("uclaw-real-proposal", "U-Claw real proposal lifecycle smoke", "Return the exact text requested by the user."),
      goal: "Exercise real Skill Workshop lifecycle",
      evidence: "U-Claw CAP-006 integration smoke",
    });
    expect(created.record).toMatchObject({ kind: "create", status: "pending", target: { skillName: "uclaw-real-proposal" } });
    expect((await service.proposalsList()).proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.record.id, status: "pending", skillName: "uclaw-real-proposal" }),
    ]));
    expect(await service.proposalInspect(created.record.id)).toMatchObject({ record: { id: created.record.id, status: "pending" } });

    const revised = await service.proposalRevise({
      proposalId: created.record.id,
      description: "Revised U-Claw real proposal lifecycle smoke",
      content: proposalContent("uclaw-real-proposal", "Revised U-Claw real proposal lifecycle smoke", "Return concise exact text requested by the user."),
      goal: "Exercise real Skill Workshop revision",
      evidence: "U-Claw CAP-006 revised integration smoke",
    });
    expect(revised.record).toMatchObject({ id: created.record.id, kind: "create", status: "pending" });
    const applied = await service.proposalAction(created.record.id, "apply", "Real integration smoke");
    expect(applied).toMatchObject({ record: { id: created.record.id, status: "applied" } });
    await expect(readFile(join(workspaceSkills, "uclaw-real-proposal", "SKILL.md"), "utf8")).resolves.toContain("Return concise exact text");

    const update = await service.proposalUpdate({
      skillName: "uclaw-real-proposal",
      description: "Update U-Claw real proposal lifecycle smoke",
      content: proposalContent("uclaw-real-proposal", "Update U-Claw real proposal lifecycle smoke", "Return exact text and include one verification line."),
      goal: "Exercise real Skill Workshop update",
      evidence: "U-Claw CAP-006 update integration smoke",
    });
    expect(update.record).toMatchObject({ kind: "update", status: "pending", target: { skillName: "uclaw-real-proposal" } });

    const rejected = await service.proposalCreate({
      name: "uclaw-real-rejected",
      description: "U-Claw real rejected proposal smoke",
      content: proposalContent("uclaw-real-rejected", "U-Claw real rejected proposal smoke", "This proposal is rejected by the lifecycle smoke."),
    });
    expect(await service.proposalAction(rejected.record.id, "reject", "Lifecycle smoke rejection")).toMatchObject({
      id: rejected.record.id, status: "rejected", statusReason: "Lifecycle smoke rejection",
    });

    const quarantined = await service.proposalCreate({
      name: "uclaw-real-quarantined",
      description: "U-Claw real quarantined proposal smoke",
      content: proposalContent("uclaw-real-quarantined", "U-Claw real quarantined proposal smoke", "This proposal is quarantined by the lifecycle smoke."),
    });
    expect(await service.proposalAction(quarantined.record.id, "quarantine", "Lifecycle smoke quarantine")).toMatchObject({
      id: quarantined.record.id, status: "quarantined", statusReason: "Lifecycle smoke quarantine",
    });

    const revisionRequested = await service.proposalCreate({
      name: "uclaw-real-revision-request",
      description: "U-Claw real revision request smoke",
      content: proposalContent("uclaw-real-revision-request", "U-Claw real revision request smoke", "Return a concise response."),
    });
    const revisionRun = await service.proposalRequestRevision({
      proposalId: revisionRequested.record.id,
      instructions: "Add an explicit verification step.",
      sessionKey: "agent:main:uclaw-real-revision-request",
      targetAgentId: "main",
    });
    expect(revisionRun).toMatchObject({ status: expect.stringMatching(/^(?:started|in_flight|ok)$/u) });
    expect(revisionRun.runId).not.toHaveLength(0);

    const curator = await service.curatorStatus();
    expect(curator).toMatchObject({ counts: { active: expect.any(Number), stale: expect.any(Number), archived: expect.any(Number) } });
    expect(curator.counts.active + curator.counts.stale + curator.counts.archived).toBe(curator.skills.length);

    const lifecycleSlug = runRealSkillHub ? "googleslides-automation" : "workspace-reader";
    if (runRealSkillHub) {
      const live = await service.search({
        query: lifecycleSlug,
        category: "office-efficiency",
        cursor: null,
        pageSize: 20,
      });
      expect(live).toMatchObject({ mode: "live", items: expect.arrayContaining([
        expect.objectContaining({ slug: lifecycleSlug, pricingType: "free", mode: "live" }),
      ]) });
    }
    const detail = await service.detail(lifecycleSlug);
    const confirmation = { permissionFingerprint: detail.permissionFingerprint, acceptedRisk: detail.risk };
    const install = await service.waitForOperation((await service.startInstall({ slug: detail.slug, confirmation })).id);
    expect(install.state).toBe("succeeded");
    const installedMarkdown = await readFile(join(workspaceSkills, detail.slug, "SKILL.md"), "utf8");
    expect(parseSkillMarkdownFrontmatter(installedMarkdown).slug ?? detail.slug).toBe(detail.slug);
    expect((await service.runtimeStatus()).skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: detail.slug, disabled: false, source: expect.stringContaining("workspace") }),
    ]));

    const disabled = await service.setEnabled({ slug: detail.slug, enabled: false, confirmation: null });
    expect(disabled.state).toBe("succeeded");
    expect((await service.runtimeStatus()).skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: detail.slug, disabled: true, source: expect.stringContaining("workspace") }),
    ]));
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      skills: { entries: { [detail.slug]: { enabled: false } } },
    });

    const enabled = await service.setEnabled({ slug: detail.slug, enabled: true, confirmation });
    expect(enabled.state).toBe("succeeded");
    expect((await service.runtimeStatus()).skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: detail.slug, disabled: false, source: expect.stringContaining("workspace") }),
    ]));
    const disabledAgain = await service.setEnabled({ slug: detail.slug, enabled: false, confirmation: null });
    expect(disabledAgain.state).toBe("succeeded");

    service = undefined;
    await running.options.dispose?.();
    await stopGateway(running.child);
    running = await start();
    service = running.service;
    expect((await service.runtimeStatus()).skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: detail.slug, disabled: true, source: expect.stringContaining("workspace") }),
    ]));
    expect(await service.installed()).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: detail.slug, enabled: false }),
    ]));

    const uninstall = await service.waitForOperation((await service.startUninstall(detail.slug)).id);
    expect(uninstall.state).toBe("succeeded");
    await expect(access(join(workspaceSkills, detail.slug, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await service.runtimeStatus()).skills.some((item) => item.id === detail.slug && item.source.toLowerCase().includes("workspace"))).toBe(false);

    await running.options.dispose?.();
    await stopGateway(running.child);
  }, 60_000);
});
