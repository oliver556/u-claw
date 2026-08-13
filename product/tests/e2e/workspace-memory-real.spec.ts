import { expect, test } from "@playwright/test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const uclawRuntime = process.env.UCLAW_REAL_RUNTIME_DIR ?? join(process.env.HOME ?? "", ".uclaw");
const nodeBin = join(uclawRuntime, "runtime", "node-mac-arm64", "bin", "node");
const openClawEntry = join(uclawRuntime, "core", "node_modules", "openclaw", "openclaw.mjs");
const desktopEntry = resolve("desktop/dist/entry.js");

async function launchDesktop(dataDir: string, cacheDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [desktopEntry, "--uclaw-startup-mode=normal"],
    env: {
      ...process.env,
      UCLAW_RUNTIME_DIR: uclawRuntime,
      UCLAW_OPENCLAW_ENTRY: openClawEntry,
      UCLAW_NODE_BIN: nodeBin,
      UCLAW_DATA_DIR: dataDir,
      UCLAW_CACHE_DIR: cacheDir,
      OPENCLAW_CONFIG_PATH: join(dataDir, ".openclaw", "openclaw.json"),
    },
  });
}

async function openFile(page: Page, name: string, content: string): Promise<void> {
  await page.getByRole("button", { name: `查看 ${name}` }).click();
  await expect(page.getByLabel("文件内容")).toHaveValue(content);
}

async function openMemory(page: Page, title: string, content: string): Promise<void> {
  await page.getByRole("button", { name: `查看 ${title}` }).click();
  await expect(page.getByLabel("记忆正文")).toHaveValue(content);
}

test("production Electron keeps workspace files and Markdown memory authoritative across renderer reload and restart", async () => {
  await Promise.all([access(nodeBin), access(openClawEntry), access(desktopEntry)]);
  const root = await mkdtemp(join(tmpdir(), "uclaw-workspace-memory-real-"));
  const dataDir = join(root, "data");
  const cacheDir = join(root, "cache");
  const workspace = join(dataDir, "workspace");
  const openClawState = join(dataDir, ".openclaw");
  const token = `workspace-memory-${process.pid}-${Date.now()}`;
  await Promise.all([
    mkdir(join(workspace, "docs"), { recursive: true }),
    mkdir(join(workspace, "archive"), { recursive: true }),
    mkdir(join(workspace, "memory"), { recursive: true }),
    mkdir(openClawState, { recursive: true }),
    mkdir(cacheDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(workspace, "docs", "plan.md"), "plan v1", "utf8"),
    writeFile(join(workspace, "MEMORY.md"), "root memory v1", { encoding: "utf8", mode: 0o600 }),
    writeFile(join(workspace, "memory", "daily.md"), "daily v1", { encoding: "utf8", mode: 0o600 }),
    writeFile(join(openClawState, "openclaw.json"), `${JSON.stringify({
      gateway: { mode: "local", bind: "loopback", auth: { mode: "token", token } },
      agents: { defaults: { workspace, skipBootstrap: true }, list: [{ id: "main", default: true, workspace }] },
    }, null, 2)}\n`, "utf8"),
  ]);

  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop(dataDir, cacheDir);
    let page = await app.firstWindow();

    await page.getByRole("link", { name: "文件" }).click();
    await expect(page.getByRole("heading", { name: "文件" })).toBeVisible();
    const workspaceSearch = page.getByRole("searchbox", { name: "搜索工作区文件" });
    await workspaceSearch.fill("plan");
    await expect(page.getByRole("button", { name: "查看 plan.md" })).toBeVisible();
    await workspaceSearch.fill("");
    await page.getByRole("button", { name: "查看 docs" }).click();
    await openFile(page, "plan.md", "plan v1");
    await page.getByRole("button", { name: "打开 plan.md" }).click();
    await expect(page.locator(".data-manager")).toHaveAttribute("data-last-mutation", "workspace.open:succeeded");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByRole("button", { name: "定位 plan.md" }).click();
    await expect(page.locator(".data-manager")).toHaveAttribute("data-last-mutation", "workspace.reveal:succeeded");
    await expect(page.getByRole("alert")).toHaveCount(0);

    await page.getByRole("button", { name: "重命名 plan.md" }).click();
    await page.getByLabel("新名称").fill("renamed.md");
    await page.getByRole("button", { name: "确认重命名" }).click();
    await expect(page.getByRole("button", { name: "移动 renamed.md" })).toBeVisible();
    await expect(page.getByLabel("文件内容")).toHaveValue("plan v1");
    await page.getByRole("button", { name: "移动 renamed.md" }).click();
    await page.getByLabel("目标文件夹").fill("archive");
    await page.getByRole("button", { name: "确认移动" }).click();
    await expect(page.getByText("archive/renamed.md")).toBeVisible();
    await expect(page.getByLabel("文件内容")).toHaveValue("plan v1");
    expect(await readFile(join(workspace, "archive", "renamed.md"), "utf8")).toBe("plan v1");

    await page.reload();
    await expect(page.getByRole("heading", { name: "文件" })).toBeVisible();
    const reloadedWorkspaceSearch = page.getByRole("searchbox", { name: "搜索工作区文件" });
    await reloadedWorkspaceSearch.fill("renamed");
    await expect(page.getByRole("button", { name: "查看 renamed.md" })).toBeVisible();
    await reloadedWorkspaceSearch.fill("");
    await page.getByRole("button", { name: "查看 archive" }).click();
    await openFile(page, "renamed.md", "plan v1");
    await page.getByRole("button", { name: "删除 renamed.md" }).click();
    await page.getByRole("button", { name: "确认删除" }).click();
    await expect(page.getByText("当前文件夹为空")).toBeVisible();

    await page.getByRole("link", { name: "记忆" }).click();
    let memorySearch = page.getByRole("searchbox", { name: "搜索 AI 记忆" });
    await memorySearch.fill("daily");
    await openMemory(page, "daily", "daily v1");
    await page.getByLabel("记忆正文").fill("daily v2");
    await page.getByRole("button", { name: "保存记忆" }).click();
    await expect(page.locator(".data-manager")).toHaveAttribute("data-last-mutation", "memory.write:succeeded");
    await expect(page.getByLabel("记忆正文")).toHaveValue("daily v2");
    await expect(page.getByRole("button", { name: "保存记忆" })).toBeDisabled();

    await page.reload();
    memorySearch = page.getByRole("searchbox", { name: "搜索 AI 记忆" });
    await memorySearch.fill("daily");
    await openMemory(page, "daily", "daily v2");
    await page.getByRole("button", { name: "删除 daily" }).click();
    await page.getByRole("button", { name: "确认删除" }).click();
    await expect(page.getByText("还没有 AI 记忆")).toBeVisible();

    await memorySearch.fill("");
    await openMemory(page, "长期记忆", "root memory v1");
    await page.getByLabel("记忆正文").fill("root memory v2");
    await page.getByRole("button", { name: "保存记忆" }).click();
    await expect(page.locator(".data-manager")).toHaveAttribute("data-last-mutation", "memory.write:succeeded");
    await expect(page.getByLabel("记忆正文")).toHaveValue("root memory v2");
    await expect(page.getByRole("button", { name: "保存记忆" })).toBeDisabled();
    await app.close();
    app = undefined;

    app = await launchDesktop(dataDir, cacheDir);
    page = await app.firstWindow();
    await page.getByRole("link", { name: "记忆" }).click();
    await openMemory(page, "长期记忆", "root memory v2");
    await expect(page.getByRole("button", { name: "查看 daily" })).toHaveCount(0);
    await page.getByRole("link", { name: "文件" }).click();
    await page.getByRole("button", { name: "查看 archive" }).click();
    await expect(page.getByText("当前文件夹为空")).toBeVisible();

    expect(await readFile(join(workspace, "MEMORY.md"), "utf8")).toBe("root memory v2");
    await expect(access(join(workspace, "memory", "daily.md"))).rejects.toThrow();
    await expect(access(join(workspace, "archive", "renamed.md"))).rejects.toThrow();
    expect(await readdir(join(workspace, "archive"))).toEqual([]);
    expect((await stat(join(workspace, "MEMORY.md"))).mode & 0o777).toBe(0o600);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
