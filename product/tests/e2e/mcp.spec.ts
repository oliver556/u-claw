import { expect, test } from "@playwright/test";

import { installBrowserTestBridge } from "./browser-test-bridge";

test.beforeEach(async ({ page }) => installBrowserTestBridge(page));

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`public capability page hides MCP management at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/#/capabilities");

    await expect(page.getByRole("heading", { name: "技能" })).toBeVisible();
    await expect(page.getByText("尚未安装技能")).toBeVisible();
    await expect(page.getByRole("tab", { name: "MCP" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "MCP、工具与审批" })).toHaveCount(0);
  });
}
