import { expect, test } from "@playwright/test";

const detail = {
  packageKind: "plugin", slug: "openclaw-shell-tools", name: "命令工具包", description: "提供原生命令扩展", version: "2.0.0",
  installedVersion: null, enabled: false, updateAvailable: false,
  source: { provider: "fixture", url: "https://plugins.openclaw.ai/openclaw-shell-tools", packaged: true },
  integritySha256: "0".repeat(64),
  availability: "installable", compatibility: { state: "compatible", openClawVersion: "2026.7.1-2" },
  permissions: [{ kind: "command", access: "execute", target: "approved commands", risk: "high", reason: "执行用户批准的本地命令" }],
  permissionFingerprint: "e2e-plugin-permission", risk: "high", nativeCode: true, commandExecution: true, mode: "fixture",
  manifest: {
    id: "openclaw-shell-tools",
    configSchema: { type: "object", additionalProperties: false, properties: {} },
    packageName: "@uclaw/openclaw-shell-tools",
    entry: "./dist/index.js",
    minHostVersion: ">=2026.7.1-2",
    pluginApi: ">=2026.7.1-2",
  },
};

async function installPluginBridge(page: import("@playwright/test").Page) {
  await page.addInitScript((plugin) => {
    const listeners = new Set<(event: unknown) => void>();
    const success = (request: any, result: unknown) => ({ method: request.method, requestId: request.requestId, ok: true, result });
    const invoke = async (request: any) => {
      if (request.method === "plugins.search") return { method: request.method, requestId: request.requestId, ok: true, result: { items: [plugin], nextCursor: null, hasMore: false, mode: "fixture", repositoryVerified: false } };
      if (request.method === "plugins.detail") return { method: request.method, requestId: request.requestId, ok: true, result: plugin };
      if (request.method === "plugins.install") return { method: request.method, requestId: request.requestId, ok: true, result: { id: "plugin-e2e", slug: plugin.slug, action: "install", state: "running", progress: 50, phase: "replacing" } };
      if (request.method === "plugins.ui-descriptors") return { method: request.method, requestId: request.requestId, ok: true, result: [{ id: "shell.inspect", pluginId: plugin.slug, pluginName: plugin.name, surface: "session", label: "检查命令权限", description: "显示当前会话权限" }] };
      if (request.method === "plugins.session-action") return { method: request.method, requestId: request.requestId, ok: true, result: { ok: true, result: { success: true } } };
      return { method: request.method, requestId: request.requestId, ok: true, result: { id: "plugin-e2e", slug: plugin.slug, action: "install", state: "succeeded", progress: 100, phase: "complete" } };
    };
    Object.defineProperty(window, "uclaw", { configurable: true, value: {
      client: {
        subscribe(listener: (event: unknown) => void) { listeners.add(listener); return () => listeners.delete(listener); },
        async invoke(request: any) {
          if (request.method === "gateway.negotiate") return success(request, { protocolVersion: 4, methods: [], events: [], features: {} });
          if (request.method === "sessions.list") return success(request, { items: [], nextCursor: null, hasMore: false });
          if (request.method === "gateway.watch-status" || request.method === "subscriptions.cancel") return success(request, null);
          throw new Error(`Unexpected client IPC method: ${request.method}`);
        },
      },
      plugins: { invoke },
    } });
  }, detail);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`Plugin lifecycle UI fits ${viewport.width}px and confirms native command risk`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installPluginBridge(page);
    await page.goto("/");
    await page.getByRole("link", { name: "能力" }).click();
    await page.getByRole("tab", { name: "插件" }).click();
    await expect(page.getByText("Fixture 数据，真实插件仓库未验收")).toBeVisible();
    await expect(page.getByText("命令工具包")).toBeVisible();
    await page.getByRole("button", { name: "安装 命令工具包" }).click();
    await expect(page.getByRole("dialog", { name: "确认安装命令工具包" })).toContainText("原生代码");
    await expect(page.getByRole("dialog", { name: "确认安装命令工具包" })).toContainText("命令执行");
    await page.getByRole("checkbox", { name: "我已了解插件高风险权限" }).check();
    await page.getByRole("button", { name: "确认安装" }).click();
    await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    await page.getByRole("tab", { name: "会话操作" }).click();
    await expect(page.getByText("检查命令权限")).toBeVisible();
    await page.getByRole("button", { name: "执行 检查命令权限" }).click();
    await expect(page.getByText("操作已完成")).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  });
}
