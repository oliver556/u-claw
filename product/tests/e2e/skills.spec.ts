import { expect, test } from "@playwright/test";

import { installBrowserTestBridge } from "./browser-test-bridge";

const installedSkill = {
  slug: "command-runner", name: "命令运行器", description: "运行批准命令", version: "1.0.0",
  pricingType: "free", enabled: true, installedVersion: "1.0.0", updateAvailable: false,
  source: { provider: "skillhub", url: "https://api.skillhub.cn/api/v1/skills/command-runner" },
  permissions: [{ kind: "command", access: "execute", target: "git", risk: "high", reason: "执行 Git 命令" }],
  permissionFingerprint: "e2e-permission", risk: "high", mode: "fixture",
  manifest: { kind: "skill", id: "command-runner", version: "1.0.0", entry: "index.js" },
};

async function installSkillBridge(page: import("@playwright/test").Page) {
  await installBrowserTestBridge(page);
  await page.addInitScript((skill) => {
    const invoke = async (request: any) => ({ method: request.method, requestId: request.requestId, ok: true, result: request.method === "skills.installed" ? [skill] : null });
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
