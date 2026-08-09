import { expect, test } from "@playwright/test";

const detail = {
  slug: "command-runner", name: "命令运行器", description: "运行批准命令", version: "1.0.0",
  pricingType: "free", enabled: false, installedVersion: null, updateAvailable: false,
  source: { provider: "skillhub", url: "https://api.skillhub.cn/api/v1/skills/command-runner" },
  permissions: [{ kind: "command", access: "execute", target: "git", risk: "high", reason: "执行 Git 命令" }],
  permissionFingerprint: "e2e-permission", risk: "high", mode: "fixture",
  manifest: { kind: "skill", id: "command-runner", version: "1.0.0", entry: "index.js" },
};

async function installSkillBridge(page: import("@playwright/test").Page) {
  await page.addInitScript((skill) => {
    let installed = false;
    const invoke = async (request: any) => {
      const item = { ...skill, installedVersion: installed ? skill.version : null, enabled: installed };
      if (request.method === "skills.search") return { method: request.method, requestId: request.requestId, ok: true, result: { items: [item], nextCursor: null, hasMore: false, mode: "fixture" } };
      if (request.method === "skills.detail") return { method: request.method, requestId: request.requestId, ok: true, result: item };
      if (request.method === "skills.install") return { method: request.method, requestId: request.requestId, ok: true, result: { id: "e2e-op", slug: skill.slug, action: "install", state: "running", progress: 50, phase: "replacing" } };
      installed = true;
      return { method: request.method, requestId: request.requestId, ok: true, result: { id: "e2e-op", slug: skill.slug, action: "install", state: "succeeded", progress: 100, phase: "complete" } };
    };
    Object.defineProperty(window, "uclaw", { configurable: true, value: { skills: { invoke } } });
  }, detail);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`Skill lifecycle UI fits ${viewport.width}px and confirms high risk`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installSkillBridge(page);
    await page.goto("/");
    await page.getByRole("link", { name: "能力" }).click();
    await page.getByRole("tab", { name: "技能" }).click();
    await expect(page.getByText("命令运行器")).toBeVisible();
    await page.getByRole("button", { name: "安装 命令运行器" }).click();
    await expect(page.getByRole("dialog", { name: "确认安装命令运行器" })).toContainText("高风险");
    await page.getByRole("checkbox", { name: "我已了解高风险权限" }).check();
    await page.getByRole("button", { name: "确认安装" }).click();
    await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  });
}
