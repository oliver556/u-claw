import { expect, test, type Page } from "@playwright/test";

import { installBrowserTestBridge } from "./browser-test-bridge";

const settingsKey = "uclaw.settings.v1";

async function openAppearance(page: Page) {
  await page.getByRole("link", { name: "系统" }).click();
  await page.getByRole("tab", { name: "外观" }).click();
  return page.getByRole("radiogroup", { name: "主题模式" });
}

async function assertNoLightSurfaceLeak(page: Page) {
  const leaks = await page.locator("body *:visible").evaluateAll((elements) => elements.flatMap((element) => {
    if (element.closest(".wechat-qr-frame, .brand-mark")) return [];
    const rect = element.getBoundingClientRect();
    const color = getComputedStyle(element).backgroundColor;
    const channels = color.match(/[\d.]+/g)?.map(Number);
    if (!channels || channels.length < 3) return [];
    const [red, green, blue, alpha = 1] = channels;
    if (alpha < 0.5) return [];
    return red > 245 && green > 245 && blue > 245
      ? [{ tag: element.tagName, className: element.className, color, width: rect.width, height: rect.height }]
      : [];
  }));
  expect(leaks).toEqual([]);
}

async function assertSemanticTextContrast(page: Page) {
  const ratios = await page.evaluate(() => {
    const parse = (value: string) => {
      const normalized = value.trim();
      if (/^#[0-9a-f]{6}$/i.test(normalized)) {
        return [1, 3, 5].map((index) => Number.parseInt(normalized.slice(index, index + 2), 16)).concat(1);
      }
      const channels = normalized.match(/[\d.]+/g)?.map(Number) ?? [];
      return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0, channels[3] ?? 1];
    };
    const blend = (foreground: number[], background: number[]) => foreground.slice(0, 3).map((value, index) => value * foreground[3] + background[index] * (1 - foreground[3]));
    const luminance = (color: number[]) => {
      const linear = color.map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const contrast = (foreground: string, background: string) => {
      const bg = parse(background);
      const fg = blend(parse(foreground), bg);
      const high = Math.max(luminance(fg), luminance(bg));
      const low = Math.min(luminance(fg), luminance(bg));
      return (high + 0.05) / (low + 0.05);
    };
    const style = getComputedStyle(document.documentElement);
    const canvas = style.getPropertyValue("--uclaw-bg-canvas");
    return {
      primary: contrast(style.getPropertyValue("--uclaw-text-primary"), canvas),
      secondary: contrast(style.getPropertyValue("--uclaw-text-secondary"), canvas),
      link: contrast(style.getPropertyValue("--uclaw-primary-text"), canvas),
    };
  });
  expect(ratios.primary).toBeGreaterThanOrEqual(4.5);
  expect(ratios.secondary).toBeGreaterThanOrEqual(4.5);
  expect(ratios.link).toBeGreaterThanOrEqual(3);
}

test.beforeEach(async ({ page }) => {
  await installBrowserTestBridge(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await page.evaluate((key) => localStorage.removeItem(key), settingsKey);
  await page.reload();
});

test("switches light, dark and system themes and persists reloads", async ({ page }) => {
  const chooser = await openAppearance(page);
  await chooser.getByText("深色", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await assertSemanticTextContrast(page);
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").appearance?.theme, settingsKey)).toBe("dark");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  const restoredChooser = await openAppearance(page);
  await restoredChooser.getByText("浅色", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await assertSemanticTextContrast(page);
  await restoredChooser.getByText("跟随系统", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").appearance?.theme, settingsKey)).toBe("system");
});

test("restores a dark first frame before the renderer module runs", async ({ page }) => {
  await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ appearance: { theme: "dark" } })), settingsKey);
  await page.route("**/src/main.tsx", (route) => route.abort());
  await page.goto("/?first-frame=dark");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const surfaces = await page.evaluate(() => ({
    html: getComputedStyle(document.documentElement).backgroundColor,
    body: getComputedStyle(document.body).backgroundColor,
    root: getComputedStyle(document.getElementById("root")!).backgroundColor,
  }));
  expect(surfaces).toEqual({ html: "rgb(20, 20, 20)", body: "rgb(20, 20, 20)", root: "rgb(20, 20, 20)" });
});

test("keeps every primary route and overlay on dark semantic surfaces", async ({ page }) => {
  await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ appearance: { theme: "dark" } })), settingsKey);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  const routes = [
    { name: "工作", hash: "#/", root: ".work-canvas" },
    { name: "文件", hash: "#/files", root: ".data-manager" },
    { name: "记忆", hash: "#/memory", root: ".data-manager" },
    { name: "能力", hash: "#/capabilities", root: ".capabilities-view" },
    { name: "连接", hash: "#/connections", root: ".channel-settings" },
    { name: "系统", hash: "#/system", root: ".system-center" },
  ];
  for (const route of routes) {
    await page.getByRole("link", { name: route.name }).click();
    await expect(page).toHaveURL(new RegExp(`${route.hash.replace("/", "\\/")}$`));
    await expect(page.locator(route.root)).toBeVisible();
    await assertNoLightSurfaceLeak(page);
  }

  await page.getByRole("button", { name: "打开任务活动中心" }).click();
  await expect(page.locator(".task-activity-center")).toBeVisible();
  await assertNoLightSurfaceLeak(page);

  await page.getByRole("button", { name: "打开全局搜索" }).click();
  await expect(page.locator(".command-modal")).toBeVisible();
  await assertNoLightSurfaceLeak(page);
});
