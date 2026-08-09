import { expect, test } from "@playwright/test";

async function installMaintenanceBridge(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const ok = (request: any, result: any) => ({ method: request.method, requestId: request.requestId, ok: true, result });
    (window as any).uclaw = { data: { invoke: async (request: any) => {
      if (request.method === "data.status") return ok(request, { state: "available", writable: true });
      if (request.method === "backup.preview") return ok(request, { previewToken: "preview-e2e", target: "当前 U 盘受控备份区", consistency: "runtime-coordination-required", trigger: "manual", retainLatest: 3, collections: [
        { id: "workspace-user-files", label: "用户文件", fileCount: 8, bytes: 4096, risk: "normal" },
        { id: "openclaw-memory", label: "记忆", fileCount: 2, bytes: 1024, risk: "sensitive" },
        { id: "openclaw-sessions", label: "会话", fileCount: 12, bytes: 8192, risk: "sensitive" },
        { id: "uclaw-configuration", label: "配置、skills/plugins/MCP 与渠道", fileCount: 6, bytes: 2048, risk: "sensitive" },
      ], totalFileCount: 28, totalBytes: 15360, warnings: ["当前 runtime 无全局 snapshot/CAS，创建将安全拒绝。"] });
      if (request.method === "backup.list") return ok(request, { items: [] });
      if (request.method === "storage.stats") return ok(request, { state: "available", totalBytes: 9000, categories: ["configuration", "sessions", "memory", "capabilities", "logs", "cache", "temporary-downloads", "user-files", "backups"].map((id, index) => ({ id, label: ["配置", "会话", "记忆", "能力包", "日志", "缓存", "临时/下载", "用户文件", "备份"][index], bytes: 1000, fileCount: 1, protected: index < 4 || index === 7 })) });
      if (request.method === "cleanup.preview") return ok(request, { previewToken: "preview-cleanup", candidates: [{ id: "cache:electron", label: "Electron 可重建缓存", bytes: 1000, fileCount: 1, reason: "可重建缓存" }], totalBytes: 1000, totalFileCount: 1, protectedCategories: ["configuration", "sessions", "memory", "capabilities", "user-files"] });
      if (request.method === "factory-reset.preview") return ok(request, { previewToken: "preview-reset", consistency: "coordinated", recovery: "none", delete: [{ id: "uclaw-owned-state", label: "U-Claw 配置与运行状态", fileCount: 3, bytes: 90 }], preserve: [{ id: "user-files", label: "用户工作文件" }, { id: "backups", label: "备份" }], warnings: ["执行时将暂停 OpenClaw 写入。"] });
      throw new Error(`unexpected ${request.method}`);
    } } };
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`maintenance center fits ${viewport.width}px and exposes backup restore storage states`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await installMaintenanceBridge(page);
    await page.goto("/#/system");
    await page.getByRole("tab", { name: "备份与存储" }).click();
    await expect(page.getByRole("heading", { name: "数据维护" })).toBeVisible();
    await expect(page.getByText("配置、skills/plugins/MCP 与渠道")).toBeVisible();
    await expect(page.getByRole("button", { name: "创建备份" })).toBeDisabled();
    await page.getByRole("tab", { name: "恢复", exact: true }).click();
    await expect(page.getByText("还没有备份")).toBeVisible();
    await page.getByRole("tab", { name: "空间" }).click();
    await expect(page.getByText("Electron 可重建缓存")).toBeVisible();
    await page.getByRole("tab", { name: "恢复出厂" }).click();
    await expect(page.getByText("用户工作文件")).toBeVisible();
    await page.getByRole("button", { name: "预览并恢复出厂" }).click();
    await expect(page.getByRole("button", { name: "确认恢复出厂" })).toBeDisabled();
    await page.getByLabel("输入 RESET U-CLAW 确认").fill("RESET U-CLAW");
    await expect(page.getByRole("button", { name: "确认恢复出厂" })).toBeEnabled();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`maintenance-${viewport.width}.png`), fullPage: true });
  });
}
