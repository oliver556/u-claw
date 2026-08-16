import { expect, test } from "@playwright/test";

import { installBrowserTestBridge } from "./browser-test-bridge";

test.beforeEach(async ({ page }) => installBrowserTestBridge(page));

test("public capability page hides Provider management", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/#/capabilities");

  await expect(page.getByRole("heading", { name: "技能" })).toBeVisible();
  await expect(page.getByText("尚未安装技能")).toBeVisible();
  await expect(page.getByRole("tab", { name: "模型" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "模型 Provider" })).toHaveCount(0);
});
