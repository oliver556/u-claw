import { expect, test } from "@playwright/test";

import { installBrowserTestBridge } from "./browser-test-bridge";

async function installReleaseBridge(page: import("@playwright/test").Page) {
  await installBrowserTestBridge(page);
  await page.addInitScript(() => {
    const ok = (request: any, result: any) => ({ method: request.method, requestId: request.requestId, ok: true, result });
    (window as any).uclaw = { ...((window as any).uclaw ?? {}), release: { invoke: async (request: any) => {
      if (request.method === "release.recovery") return ok(request, { state: "clean", message: "无待恢复更新。" });
      if (request.method === "release.check") return ok(request, { state: "available", checkedAt: "2026-08-09T00:00:00.000Z", currentVersion: "0.1.0", channel: "stable", update: { id: "release-42", version: "0.2.0", channel: "stable", publishedAt: "2026-08-09T00:00:00.000Z", notes: ["安全更新", "恢复流程改进"], compatibility: { platform: "win32", arch: "x64", runtimeId: "openclaw-2026.7.1-2-win-x64" }, bytes: 128, mandatory: false, previewToken: "preview-42" } });
      if (request.method === "uninstall.preview") return ok(request, { previewToken: "uninstall-token", scopes: [
        { id: "application", label: "U-Claw 应用", selected: false, protected: false, available: false, detail: "由 Windows 卸载器移除" },
        { id: "usb-user-data", label: "U 盘用户数据", selected: false, protected: true, available: false, detail: "默认永久保留" },
        { id: "host-cache", label: "本机 U-Claw 缓存", selected: true, protected: false, available: true, detail: "仅 marker 证明归属的缓存" },
      ] });
      throw new Error(`unexpected ${request.method}`);
    } }, window: { invoke: async (request: any) => ok(request, null) } };
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`release center fits ${viewport.width}px and exposes secure update and uninstall boundaries`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport); await installReleaseBridge(page); await page.goto("/#/system");
    await page.getByRole("tab", { name: "发布更新" }).click();
    await expect(page.getByText("0.2.0")).toBeVisible(); await expect(page.getByText("win32 · x64")).toBeVisible();
    await expect(page.getByRole("button", { name: "打开 Doctor" })).toBeVisible();
    await expect(page.getByRole("button", { name: "打开 CLI 控制台" })).toBeVisible();
    await page.getByRole("tab", { name: "卸载与清理" }).click(); await expect(page.getByText("默认永久保留")).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`release-${viewport.width}.png`), fullPage: true });
  });
}
