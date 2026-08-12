import { expect, test } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const runtime = join(process.env.HOME ?? "", ".uclaw");

test("creates a session group through the production Electron UI and reads it back after reload", async () => {
  let app: ElectronApplication | undefined;
  const root = await mkdtemp(join(tmpdir(), "uclaw-session-organizer-"));
  const dataDir = join(root, "data");
  const cacheDir = join(root, "cache");
  try {
    await mkdir(join(dataDir, ".openclaw"), { recursive: true });
    await mkdir(cacheDir, { recursive: true });
    await cp(join(runtime, "data/.openclaw/openclaw.json"), join(dataDir, ".openclaw/openclaw.json"));
    app = await electron.launch({
      args: [resolve("desktop/dist/entry.js")],
      env: {
        ...process.env,
        UCLAW_RUNTIME_DIR: runtime,
        UCLAW_OPENCLAW_ENTRY: join(runtime, "core/node_modules/openclaw/openclaw.mjs"),
        UCLAW_NODE_BIN: join(runtime, `runtime/node-mac-${process.arch}/bin/node`),
        UCLAW_DATA_DIR: dataDir,
        UCLAW_CACHE_DIR: cacheDir,
        OPENCLAW_CONFIG_PATH: join(dataDir, ".openclaw/openclaw.json"),
      },
    });
    const page = await app.firstWindow();
    const name = `验收分组-${Date.now()}`;
    await page.getByRole("button", { name: "新建分组" }).click();
    await page.getByRole("textbox", { name: "分组名称" }).fill(name);
    await page.getByRole("button", { name: "创建分组" }).click();
    const groupLabel = page.locator(".session-group-bar > div > span", { hasText: name });
    await expect(groupLabel).toBeVisible();
    await page.getByRole("button", { name: `筛选分组 ${name}` }).click();
    await expect(page.getByRole("button", { name: `筛选分组 ${name}` })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: `筛选分组 ${name}` }).click();
    if (await page.getByRole("textbox", { name: "给 U-Claw 发送消息" }).count() === 0) {
      await page.getByRole("button", { name: "新建会话", exact: true }).first().click();
      await expect(page.getByRole("textbox", { name: "给 U-Claw 发送消息" })).toBeVisible();
    }
    await expect(page.locator(".canvas-head")).toHaveCount(0);
    await expect(page.getByRole("complementary", { name: "上下文舱" })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "会话模型" })).toBeAttached();
    await expect(page.getByRole("combobox", { name: "下一条消息 Skill" })).toBeAttached();
    await page.reload();
    await expect(groupLabel).toBeVisible();
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
