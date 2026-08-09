import { expect, test, type Page } from "@playwright/test";

const initialChannels = [
  {
    id: "telegram-main", kind: "telegram", name: "Telegram Main", mode: "bot",
    configured: true, enabled: true, status: "connected", capability: "available",
    credentialHints: { botToken: "...0001" }, lastCheckedAt: "2026-08-09T02:03:04.000Z",
  },
  {
    id: "qq-bot-main", kind: "qq-bot", name: "QQ Bot Main", mode: "app",
    configured: true, enabled: true, status: "needs-action", capability: "unavailable",
    capabilityReason: "Runtime plugin is not packaged.", credentialHints: { appId: "...-app", clientSecret: "...0002" },
    error: { category: "capability", code: "CAPABILITY_UNAVAILABLE", message: "当前运行时未提供该渠道能力。", retryable: false },
  },
  {
    id: "feishu-main", kind: "feishu", name: "Feishu Main", mode: "webhook",
    configured: true, enabled: true, status: "needs-action", capability: "unavailable",
    capabilityReason: "Runtime plugin is not packaged.", credentialHints: { appId: "...-app", appSecret: "...0003", verificationToken: "...0004", encryptKey: "...0005" },
    error: { category: "authentication", code: "AUTHENTICATION_FAILED", message: "渠道鉴权失败。", retryable: false },
  },
  {
    id: "wecom-main", kind: "wecom", name: "WeCom Main", mode: "websocket",
    configured: true, enabled: false, status: "needs-action", capability: "unavailable",
    capabilityReason: "Runtime plugin is not packaged.", credentialHints: { botId: "...-bot", secret: "...0006" },
    error: { category: "network", code: "NETWORK_ERROR", message: "渠道网络连接失败。", retryable: true },
  },
] as const;

async function installChannelBridge(page: Page) {
  await page.addInitScript((seed) => {
    let snapshot: any = { schemaVersion: 1, channels: structuredClone(seed) };
    const success = (request: any, result: unknown) => ({ method: request.method, requestId: request.requestId, ok: true, result });
    Object.defineProperty(window, "uclaw", {
      configurable: true,
      value: {
        channels: {
          async invoke(request: any) {
            if (request.method === "channels.create") {
              const channel = request.params.channel;
              const credentialHints = Object.fromEntries(Object.entries(channel.credentials).map(([key, value]) => [key, `...${String(value).slice(-4)}`]));
              snapshot = { ...snapshot, channels: [...snapshot.channels, { ...channel, configured: true, status: "pending-verification", capability: channel.kind === "telegram" ? "available" : "unavailable", credentialHints }] };
            }
            if (request.method === "channels.update") {
              const channel = request.params.channel;
              const credentialHints = Object.fromEntries(Object.entries(channel.credentials).map(([key, value]) => [key, `...${String(value).slice(-4)}`]));
              snapshot = { ...snapshot, channels: snapshot.channels.map((entry: any) => entry.id === request.params.channelId ? { ...entry, ...channel, credentialHints, status: "pending-verification" } : entry) };
            }
            if (request.method === "channels.remove") snapshot = { ...snapshot, channels: snapshot.channels.filter((entry: any) => entry.id !== request.params.channelId) };
            if (request.method === "channels.set-enabled") snapshot = { ...snapshot, channels: snapshot.channels.map((entry: any) => entry.id === request.params.channelId ? { ...entry, enabled: request.params.enabled } : entry) };
            if (request.method === "channels.test" || request.method === "channels.reconnect") {
              const result = { channelId: request.params.channelId, status: request.method === "channels.test" ? "connected" : "connecting", checkedAt: "2026-08-09T03:04:05.000Z" };
              snapshot = { ...snapshot, channels: snapshot.channels.map((entry: any) => entry.id === result.channelId ? { ...entry, status: result.status, lastCheckedAt: result.checkedAt, error: undefined } : entry) };
              return success(request, result);
            }
            if (request.method === "channels.cancel") return success(request, null);
            return success(request, snapshot);
          },
        },
      },
    });
  }, initialChannels);
}

test.beforeEach(async ({ page }) => installChannelBridge(page));

test("desktop channel page shows real capability boundaries and manages Telegram lifecycle", async ({ page }) => {
  const firstToken = "fixture-telegram-secret-1001";
  const replacementToken = "fixture-telegram-secret-2002";
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/connections");

  await expect(page.getByRole("heading", { name: "渠道连接" })).toBeVisible();
  await expect(page.getByText("Telegram Main")).toBeVisible();
  await expect(page.getByText("QQ Bot Main")).toBeVisible();
  await expect(page.getByText("Feishu Main")).toBeVisible();
  await expect(page.getByText("WeCom Main")).toBeVisible();
  await expect(page.getByText("Capability unavailable")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "测试 QQ Bot Main" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "测试 Feishu Main" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "测试 WeCom Main" })).toBeDisabled();

  await page.getByRole("button", { name: "新增连接" }).click();
  await expect(page.getByRole("dialog", { name: "新增渠道连接" })).toBeVisible();
  await page.getByLabel("渠道 ID").fill("telegram-alerts");
  await page.getByLabel("连接名称").fill("Telegram Alerts");
  await page.getByLabel("Bot Token").fill(firstToken);
  await page.getByRole("button", { name: "保存渠道" }).click();
  await expect(page.getByText("Telegram Alerts")).toBeVisible();
  await expect(page.getByText("...1001")).toBeVisible();
  await expect(page.getByText(firstToken)).toHaveCount(0);

  await page.getByRole("button", { name: "测试 Telegram Alerts" }).click();
  await expect(page.locator("article").filter({ hasText: "Telegram Alerts" })).toContainText("已连接");
  await page.getByRole("switch", { name: "停用 Telegram Alerts" }).click();
  await expect(page.getByRole("switch", { name: "启用 Telegram Alerts" })).toBeVisible();
  await page.getByRole("switch", { name: "启用 Telegram Alerts" }).click();
  await page.getByRole("button", { name: "重连 Telegram Alerts" }).click();
  await expect(page.locator("article").filter({ hasText: "Telegram Alerts" })).toContainText("连接中");

  await page.getByRole("button", { name: "编辑 Telegram Alerts" }).click();
  await expect(page.getByRole("dialog", { name: "编辑渠道连接" })).toBeVisible();
  await expect(page.getByLabel("Bot Token")).toHaveValue("");
  await page.getByLabel("连接名称").fill("Telegram Alerts Updated");
  await page.getByLabel("Bot Token").fill(replacementToken);
  await page.getByRole("button", { name: "保存渠道" }).click();
  await expect(page.getByText("Telegram Alerts Updated")).toBeVisible();
  await expect(page.getByText("...2002")).toBeVisible();
  await expect(page.getByText(replacementToken)).toHaveCount(0);

  await page.getByRole("button", { name: "删除 Telegram Alerts Updated" }).click();
  await expect(page.getByText("删除渠道连接？")).toBeVisible();
  await page.getByRole("tooltip").filter({ hasText: "删除渠道连接？" }).getByRole("button", { name: /删\s*除/ }).click();
  await expect(page.getByText("Telegram Alerts Updated")).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toMatch(/fixture-telegram-secret|fixture-(?:qq|feishu|wecom)-(?:secret|token|aes)/iu);
});

test("390px channel page keeps filters, details, and recovery actions usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/connections");

  await expect(page.getByRole("heading", { name: "渠道连接" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "渠道筛选" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "状态筛选" })).toBeVisible();
  await expect(page.getByText("Telegram Main")).toBeVisible();
  await expect(page.getByRole("button", { name: "重连 Telegram Main" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }))).toEqual({ document: 0, body: 0 });

  const rows = page.locator(".channel-row");
  for (let index = 0; index < await rows.count(); index += 1) {
    const box = await rows.nth(index).boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect(box?.width).toBeLessThanOrEqual(390);
  }
});

test("offline channel load retries into an empty state without exposing bridge errors", async ({ page }) => {
  const privateError = "network failed with fixture-private-token-3003";
  await page.addInitScript((errorText) => {
    let attempts = 0;
    Object.defineProperty(window, "uclaw", {
      configurable: true,
      value: {
        channels: {
          async invoke(request: any) {
            attempts += 1;
            if (attempts === 1) throw new Error(errorText);
            return { method: request.method, requestId: request.requestId, ok: true, result: { schemaVersion: 1, channels: [] } };
          },
        },
      },
    });
  }, privateError);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/connections");

  await expect(page.getByText("渠道配置暂时不可用")).toBeVisible();
  await expect(page.getByText(privateError)).toHaveCount(0);
  await page.getByRole("button", { name: "重试加载渠道" }).click();
  await expect(page.getByText("还没有渠道配置")).toBeVisible();
});
