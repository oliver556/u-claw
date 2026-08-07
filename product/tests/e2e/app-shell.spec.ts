import { expect, test } from "@playwright/test";

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
    await expect(page).toHaveURL(new RegExp(`${path === "/" ? "/$" : `${path}$`}`));
    await expect(page.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
  }
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 960, height: 640 },
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

  const closeContext = page.getByRole("button", { name: "收起上下文舱" });
  await closeContext.focus();
  await expect(closeContext).toHaveCSS("outline-style", "solid");
});

test("mobile navigation reaches destinations hidden under More", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "更多" }).click();
  await page.getByRole("menuitem", { name: "系统" }).click();
  await expect(page).toHaveURL(/\/system$/);
});

test("mobile titlebar and icon controls preserve touch target sizes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.locator(".titlebar")).toHaveCSS("height", "48px");
  for (const control of [
    page.getByRole("button", { name: "打开全局搜索" }),
    page.getByRole("button", { name: "关闭" }),
    page.getByRole("button", { name: "展开会话栏" }),
    page.getByRole("button", { name: "展开上下文舱" }),
  ]) {
    const box = await control.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }

  await page.getByRole("button", { name: "展开会话栏" }).click();
  const sessionSearch = await page.locator(".session-search").boundingBox();
  expect(sessionSearch?.height).toBeGreaterThanOrEqual(44);
});

test("icon-only window controls expose tooltips", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  await page.getByRole("button", { name: "最大化" }).hover();
  await expect(page.getByRole("tooltip", { name: "最大化" })).toBeVisible();
});
