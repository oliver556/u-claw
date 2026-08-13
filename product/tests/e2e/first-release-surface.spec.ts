import { expect, test, type Page } from "@playwright/test";

const retainedPrimaryLabels = ["工作", "能力", "连接", "用量", "余额", "系统"] as const;
const hiddenPrimaryLabels = ["文件", "记忆", "自动化"] as const;
const hiddenChannelLabels = ["Telegram", "QQ Bot", "飞书", "企业微信", "Discord"] as const;
const hiddenSystemLabels = ["诊断", "设备与运行", "语音与通知", "产品授权", "备份与存储"] as const;

async function installFirstReleaseBridge(page: Page) {
  await page.addInitScript(() => {
    const ok = (request: any, result: unknown) => ({
      method: request.method,
      requestId: request.requestId,
      ok: true,
      result,
    });
    const wechat = {
      channelId: "wechat-personal",
      status: "disconnected",
      loginState: "idle",
      capability: "available",
      plugin: { id: "openclaw-weixin", requiredVersion: "2.4.6", status: "installed" },
    };

    (window as any).uclaw = {
      client: {
        subscribe: () => () => undefined,
        invoke: async (request: any) => {
          if (request.method === "gateway.negotiate") {
            return ok(request, { protocolVersion: 4, methods: [], events: [], features: {} });
          }
          if (request.method === "sessions.list") {
            return ok(request, { items: [], nextCursor: null, hasMore: false });
          }
          if (request.method === "session-organizer.get") {
            return ok(request, { schemaVersion: 1, groups: [], sessions: [] });
          }
          if (["gateway.watch-status", "subscriptions.cancel"].includes(request.method)) {
            return ok(request, null);
          }
          throw new Error(`unexpected client method ${request.method}`);
        },
      },
      channels: {
        invoke: async (request: any) => {
          if (request.method.startsWith("channels.wechat-")) return ok(request, wechat);
          throw new Error(`unexpected channel method ${request.method}`);
        },
      },
      release: {
        invoke: async (request: any) => {
          if (request.method === "release.recovery") {
            return ok(request, { state: "clean", message: "无待恢复更新。" });
          }
          if (request.method === "release.check") {
            return ok(request, {
              state: "up-to-date",
              checkedAt: "2026-08-14T00:00:00.000Z",
              currentVersion: "0.1.0",
              channel: "stable",
            });
          }
          if (request.method === "uninstall.preview") {
            return ok(request, { previewToken: "uninstall-preview", scopes: [] });
          }
          throw new Error(`unexpected release method ${request.method}`);
        },
      },
      window: { invoke: async (request: any) => ok(request, null) },
    };
  });
}

async function expectNoOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }))).toEqual({ document: 0, body: 0 });
}

async function expectHiddenTitlebarSurface(page: Page) {
  await expect(page.getByRole("button", { name: "打开全局搜索" })).toHaveCount(0);
  await expect(page.getByText("搜索会话、文件或能力")).toHaveCount(0);
  await expect(page.locator(".model-status")).toHaveCount(0);
  await expect(page.getByText("模型加载中")).toHaveCount(0);
  await page.keyboard.press("Control+K");
  await expect(page.getByRole("dialog", { name: "全局搜索" })).toHaveCount(0);
}

async function expectFirstReleaseNavigation(page: Page, mobile: boolean) {
  const navigation = page.getByRole("navigation", { name: "主导航" });
  for (const label of hiddenPrimaryLabels) {
    await expect(navigation.getByRole("link", { name: label })).toHaveCount(0);
  }

  if (!mobile) {
    for (const label of retainedPrimaryLabels) {
      await expect(navigation.getByRole("link", { name: label })).toBeVisible();
    }
    return;
  }

  for (const label of retainedPrimaryLabels.slice(0, 4)) {
    await expect(navigation.getByRole("link", { name: label })).toBeVisible();
  }
  await navigation.getByRole("button", { name: "更多" }).click();
  const moreMenu = page.getByRole("menu", { name: "更多导航" });
  for (const label of retainedPrimaryLabels.slice(4)) {
    await expect(moreMenu.getByRole("menuitem", { name: label })).toBeVisible();
  }
  for (const label of hiddenPrimaryLabels) {
    await expect(moreMenu.getByRole("menuitem", { name: label })).toHaveCount(0);
  }
  await page.keyboard.press("Escape");
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`first release surface is complete at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    const mobile = viewport.width <= 680;
    await page.setViewportSize(viewport);
    await installFirstReleaseBridge(page);
    await page.goto("/");

    await expectFirstReleaseNavigation(page, mobile);
    await expectHiddenTitlebarSurface(page);
    await expect(page.getByRole("banner").getByRole("button", { name: "打开任务活动中心" })).toBeVisible();
    await expectNoOverflow(page);

    await page.getByRole("link", { name: "连接" }).click();
    await expect(page.getByRole("region", { name: "个人微信连接" })).toBeVisible();
    await expect(page.getByRole("button", { name: "新增连接" })).toHaveCount(0);
    await expect(page.getByLabel("渠道筛选器")).toHaveCount(0);
    for (const label of hiddenChannelLabels) {
      await expect(page.getByText(label, { exact: true })).toHaveCount(0);
    }
    await expectNoOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`connections-${viewport.width}x${viewport.height}.png`), fullPage: true });

    if (mobile) {
      await page.getByRole("button", { name: "更多" }).click();
      await page.getByRole("menuitem", { name: "系统" }).click();
    } else {
      await page.getByRole("link", { name: "系统" }).click();
    }
    const systemTabs = page.getByRole("tablist", { name: "系统工具" });
    await expect(systemTabs.getByRole("tab", { name: "发布更新" })).toHaveAttribute("aria-selected", "true");
    await expect(systemTabs.getByRole("tab", { name: "外观" })).toBeVisible();
    for (const label of hiddenSystemLabels) {
      await expect(systemTabs.getByRole("tab", { name: label })).toHaveCount(0);
    }
    await expect(systemTabs.getByRole("tab")).toHaveCount(2);
    await expectNoOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`system-${viewport.width}x${viewport.height}.png`), fullPage: true });
  });
}
