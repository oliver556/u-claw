import { expect, test } from "@playwright/test";

async function installDiagnosticsFixture(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const log = { id: "fixture-log-1", timestamp: "2026-08-09T01:00:00.000Z", level: "info", source: "desktop", message: "Gateway ready." };
    const system = { product: { name: "U-Claw", version: "fixture" }, runtime: { node: "24.15.0", electron: "40.10.6", openclaw: "2026.7.1-2" }, platform: "win32", architecture: "x64", gateway: { status: "ready", port: 18789 }, proxy: "已配置（值已隐藏）", portableData: { state: "available", writable: true }, storage: { totalBytes: 1000, freeBytes: 400, usedBytes: 600 } };
    const invoke = async (request: any) => {
      if (request.method === "logs.list") return { method: request.method, requestId: request.requestId, ok: true, result: { items: [log], nextCursor: null, hasMore: false } };
      if (request.method === "system.get") return { method: request.method, requestId: request.requestId, ok: true, result: system };
      if (request.method === "config.get") return { method: request.method, requestId: request.requestId, ok: true, result: { content: '{"gateway":{"port":18789},"token":"[REDACTED]"}', entries: [{ path: "gateway.port", value: "18789" }], truncated: false } };
      if (request.method === "doctor.run") return { method: request.method, requestId: request.requestId, ok: true, result: { state: "issues", adapter: "openclaw", checks: [{ id: "gateway", label: "Gateway", level: "warning", summary: "Gateway 可用但存在建议项。", suggestion: "复检受控配置。" }] } };
      if (request.method === "network.run") return { method: request.method, requestId: request.requestId, ok: true, result: { mode: "intranet-only", checks: ["portable-data", "runtime", "gateway", "local-port", "dns", "provider", "channels", "capabilities"].map((id) => ({ id, label: id, level: id === "provider" ? "warning" : "info", summary: id === "provider" ? "外网不可用，内网功能仍可使用。" : "检查通过。", durationMs: 10 })), proxy: { configured: true, noProxyConfigured: true } } };
      if (request.method.endsWith(".export")) return { method: request.method, requestId: request.requestId, ok: true, result: { name: request.params.fileName, relativePath: `exports/diagnostics/${request.params.fileName}`, bytes: 10, createdAt: "2026-08-09T01:00:00.000Z" } };
      throw new Error("Fixture supports diagnostics display only.");
    };
    (window as any).uclaw = { diagnostics: { invoke } };
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`diagnostics fixture fits ${viewport.width}px without secret or overflow`, async ({ page }) => {
    await installDiagnosticsFixture(page);
    await page.setViewportSize(viewport);
    await page.goto("/#/system");
    await expect(page.getByText("Gateway ready.")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("private prompt");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await page.getByRole("tab", { name: "系统信息" }).click();
    await expect(page.getByText("24.15.0")).toBeVisible();
    await page.getByRole("tab", { name: "OpenClaw Doctor" }).click();
    await expect(page.getByText("Gateway 可用但存在建议项。")).toBeVisible();
    await page.getByRole("tab", { name: "网络诊断" }).click();
    await expect(page.getByText("内网可用，外网不可用")).toBeVisible();
    await page.getByRole("tab", { name: "原始配置" }).click();
    await expect(page.getByText("gateway.port")).toBeVisible();
    await expect(page.getByText("[REDACTED]", { exact: false })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("proxy.example");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    if (viewport.width === 390) {
      for (const button of [page.getByRole("button", { name: "搜索配置" }), page.getByRole("button", { name: "导出脱敏配置" })]) {
        expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      }
    }
  });
}
