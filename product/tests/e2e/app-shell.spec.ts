import { expect, test } from "@playwright/test";

import { installBrowserTestBridge } from "./browser-test-bridge";

test.beforeEach(async ({ page }) => installBrowserTestBridge(page));

const destinations = [
  ["工作", "/"],
  ["文件", "/files"],
  ["记忆", "/memory"],
  ["能力", "/capabilities"],
  ["连接", "/connections"],
  ["系统", "/system"],
] as const;

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page) {
  await expect.poll(() => page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }))).toEqual({ document: 0, body: 0 });
}

test("all six primary destinations are reachable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  for (const [label, path] of destinations) {
    await page.getByRole("link", { name: label }).click();
    await expect(page).toHaveURL(new RegExp(`#${path}$`));
    await expect(page.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
  }
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 960, height: 640 },
  { width: 1180, height: 700 },
  { width: 900, height: 700 },
  { width: 680, height: 800 },
  { width: 901, height: 640 },
  { width: 390, height: 844 },
]) {
  test(`${viewport.width}x${viewport.height} has no horizontal overflow`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expectNoHorizontalOverflow(page);
  });
}

test("keyboard focus is visible on primary navigation and drawer controls", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await page.goto("/");

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "跳到主要内容" })).toBeFocused();
  await page.keyboard.press("Tab");
  const focused = page.locator(":focus-visible");
  await expect(focused).toHaveCount(1);
  await expect(focused).toHaveCSS("outline-style", "solid");

  const closeSessions = page.getByRole("button", { name: "收起会话栏" });
  await closeSessions.focus();
  await expect(closeSessions).toHaveCSS("outline-style", "solid");
});

test("mobile navigation reaches destinations hidden under More", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "更多" }).click();
  await page.getByRole("menuitem", { name: "系统" }).click();
  await expect(page).toHaveURL(/#\/system$/);
});

test("mobile More menu closes when Tab moves focus away", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "更多" }).click();
  await expect(page.getByRole("menuitem", { name: "连接" })).toBeFocused();

  await page.keyboard.press("Tab");

  await expect(page.getByRole("menu", { name: "更多导航" })).toBeHidden();
});

test("mobile titlebar and icon controls preserve touch target sizes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.locator(".titlebar")).toHaveCSS("height", "48px");
  for (const control of [
    page.getByRole("button", { name: "打开全局搜索" }),
    page.getByRole("button", { name: "打开任务活动中心" }),
    page.getByRole("button", { name: "关闭" }),
    page.getByRole("button", { name: "展开会话栏" }),
  ]) {
    const box = await control.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }

  await page.getByRole("button", { name: "展开会话栏" }).click();
  const sessionSearch = await page.locator(".session-search").boundingBox();
  expect(sessionSearch?.height).toBeGreaterThanOrEqual(44);
});

test("task activity center fits the 390px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "打开任务活动中心" }).click();

  const center = page.getByRole("complementary", { name: "全局任务活动中心" });
  await expect(center).toBeVisible();
  const box = await center.boundingBox();
  expect(box?.x).toBe(0);
  expect(box?.width).toBe(390);
  expect(box?.height).toBe(738);
  await expectNoHorizontalOverflow(page);
});

test("icon-only window controls expose tooltips", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  await page.getByRole("button", { name: "最大化" }).hover();
  await expect(page.getByRole("tooltip", { name: "最大化" })).toBeVisible();
});

test("secondary destinations use the full workspace beside navigation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("link", { name: "文件" }).click();

  const rail = await page.getByRole("navigation", { name: "主导航" }).boundingBox();
  const main = await page.getByRole("main").boundingBox();
  expect(main?.x).toBe(rail!.x + rail!.width);
  expect(main?.width).toBe(1440 - rail!.width);
  await expect(page.locator(".workspace-grid")).toHaveClass(/secondary-layout/);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`file and memory managers fit ${viewport.width}px and expose native states`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    for (const [label, searchName, emptyText] of [
      ["文件", "搜索工作区文件", "当前文件夹为空"],
      ["记忆", "搜索 AI 记忆", "还没有 AI 记忆"],
    ] as const) {
      await page.getByRole("link", { name: label }).click();
      await expect(page.getByRole("heading", { name: label })).toBeVisible();
      await expect(page.getByRole("searchbox", { name: searchName })).toBeVisible();
      await expect(page.getByText(emptyText)).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });
}

test("global search traps focus and restores the trigger", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "打开全局搜索" });
  await trigger.focus();
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "全局搜索" });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "全局搜索" })).toBeFocused();
  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press("Tab");
    await expect(dialog.locator(":focus")).toHaveCount(1);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("global search portal does not move the workspace grid", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await page.goto("/");
  const workspace = page.locator(".workspace-grid");
  const before = await workspace.boundingBox();

  await page.getByRole("button", { name: "打开全局搜索" }).click();
  await expect(page.getByRole("dialog", { name: "全局搜索" })).toBeVisible();
  await expect(page.locator(".command-modal .ant-modal-content")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  expect(await workspace.boundingBox()).toEqual(before);
  await expect(page.locator(".app-shell > .ant-modal-root")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "全局搜索" })).toBeHidden();
  expect(await workspace.boundingBox()).toEqual(before);
});
