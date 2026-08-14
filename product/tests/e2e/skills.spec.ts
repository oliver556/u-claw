import { expect, test } from "@playwright/test";
import type { SkillCatalogItem, SkillIpcRequest, SkillIpcResponse, SkillOperation, SkillRuntimeInventory } from "@uclaw/shared";

import { installBrowserTestBridge } from "./browser-test-bridge";

const installedSkill = {
  slug: "command-runner", name: "命令运行器", description: "运行批准命令", version: "1.0.0",
  pricingType: "free", enabled: true, installedVersion: "1.0.0", updateAvailable: false,
  source: { provider: "skillhub", url: "https://api.skillhub.cn/api/v1/skills/command-runner" },
  permissions: [{ kind: "command", access: "execute", target: "git", risk: "high", reason: "执行 Git 命令" }],
  permissionFingerprint: "e2e-permission", risk: "high", mode: "fixture",
  categories: [],
} satisfies SkillCatalogItem;

async function installSkillBridge(page: import("@playwright/test").Page) {
  await installBrowserTestBridge(page);
  await page.addInitScript((skill) => {
    let current = { ...skill };
    let operationSequence = 0;
    const operations = new Map<string, SkillOperation>();
    const runtimeStatus = (): SkillRuntimeInventory => ({
      workspaceDir: "/fixture/workspace",
      managedSkillsDir: "/fixture/managed-skills",
      skills: [{
        id: current.slug,
        name: current.name,
        description: current.description,
        source: "workspace",
        bundled: false,
        disabled: !current.enabled,
        eligible: current.enabled,
        modelVisible: current.enabled,
        userInvocable: true,
        commandVisible: current.enabled,
        availability: current.enabled ? "available" : "disabled",
        missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
        conflicts: [],
      }],
    });
    const invoke = async (request: SkillIpcRequest): Promise<SkillIpcResponse> => {
      if (request.method === "skills.installed") {
        return { method: "skills.installed", requestId: request.requestId, ok: true, result: [current] } satisfies SkillIpcResponse;
      }
      if (request.method === "skills.runtime-status") {
        return { method: "skills.runtime-status", requestId: request.requestId, ok: true, result: runtimeStatus() } satisfies SkillIpcResponse;
      }
      if (request.method === "skills.set-enabled") {
        if (request.params.slug !== current.slug) throw new Error(`Unexpected browser test Skill: ${request.params.slug}`);
        current = { ...current, enabled: request.params.enabled };
        const operation = {
          id: `skill-operation-${++operationSequence}`,
          slug: current.slug,
          action: current.enabled ? "enable" : "disable",
          state: "succeeded",
          progress: 100,
          phase: "complete",
        } satisfies SkillOperation;
        operations.set(operation.id, operation);
        return { method: "skills.set-enabled", requestId: request.requestId, ok: true, result: operation } satisfies SkillIpcResponse;
      }
      if (request.method === "skills.operation") {
        const operation = operations.get(request.params.operationId);
        if (!operation) throw new Error(`Unexpected browser test Skill operation: ${request.params.operationId}`);
        return { method: "skills.operation", requestId: request.requestId, ok: true, result: operation } satisfies SkillIpcResponse;
      }
      throw new Error(`Unexpected browser test Skill method: ${request.method}`);
    };
    Object.defineProperty(window, "uclaw", { configurable: true, writable: true, value: { ...((window as any).uclaw ?? {}), skills: { invoke } } });
  }, installedSkill);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`public Skill view fits ${viewport.width}px and exposes installed state only`, async ({ page }) => {
    await installSkillBridge(page);
    await page.setViewportSize(viewport);
    await page.goto("/#/capabilities");

    await expect(page.getByRole("heading", { name: "技能" })).toBeVisible();
    await expect(page.getByText("命令运行器")).toBeVisible();
    await expect(page.getByRole("switch", { name: "禁用 命令运行器" })).toBeVisible();
    await expect(page.getByRole("tablist", { name: "技能视图" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "安装 命令运行器" })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  });
}

test("installed Skill can be disabled and enabled without bridge errors", async ({ page }) => {
  await installSkillBridge(page);
  await page.goto("/#/capabilities");

  await page.getByRole("switch", { name: "禁用 命令运行器" }).click();
  await expect(page.getByRole("switch", { name: "启用 命令运行器" })).toBeVisible();
  await expect(page.getByText("已禁用")).toBeVisible();

  await page.getByRole("switch", { name: "启用 命令运行器" }).click();
  const confirmation = page.getByRole("dialog", { name: "确认启用命令运行器" });
  await confirmation.getByRole("checkbox").check();
  await confirmation.getByRole("button", { name: "确认启用" }).click();
  await expect(page.getByRole("switch", { name: "禁用 命令运行器" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
