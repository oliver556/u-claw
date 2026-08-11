import { expect, test } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const uclawRuntime = process.env.UCLAW_REAL_RUNTIME_DIR ?? join(process.env.HOME ?? "", ".uclaw");
const nodeBin = join(uclawRuntime, "runtime", "node-mac-arm64", "bin", "node");
const openClawEntry = join(uclawRuntime, "core", "node_modules", "openclaw", "openclaw.mjs");
const desktopEntry = resolve("desktop/dist/entry.js");

async function launchDesktop(dataDir: string, cacheDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [desktopEntry],
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

test("production Electron persists real OpenClaw sessions and Provider configuration without wiring overrides", async () => {
  await Promise.all([access(nodeBin), access(openClawEntry), access(desktopEntry)]);
  const root = await mkdtemp(join(tmpdir(), "uclaw-work-chat-real-"));
  const dataDir = join(root, "data");
  const cacheDir = join(root, "cache");
  const openClawState = join(dataDir, ".openclaw");
  const workspace = join(dataDir, "workspace");
  const token = `work-chat-${process.pid}-${Date.now()}`;
  const providerSecret = `provider-smoke-${process.pid}-${Date.now()}`;
  await Promise.all([
    mkdir(openClawState, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(cacheDir, { recursive: true }),
  ]);
  await writeFile(join(openClawState, "openclaw.json"), `${JSON.stringify({
    gateway: { mode: "local", bind: "loopback", auth: { mode: "token", token } },
    agents: {
      defaults: { workspace, skipBootstrap: true },
      list: [{ id: "main", default: true, workspace }],
    },
  }, null, 2)}\n`, "utf8");
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop(dataDir, cacheDir);
    const firstWindow = await app.firstWindow();
    const initialSessions = await firstWindow.evaluate(() => window.uclaw?.client.invoke({
      method: "sessions.list",
      requestId: "session-smoke-list-before-write",
      params: {},
    }));
    expect(initialSessions, JSON.stringify(initialSessions)).toMatchObject({ ok: true, method: "sessions.list" });
    await expect(firstWindow.getByRole("button", { name: "新建会话" }).first()).toBeVisible();
    await firstWindow.getByRole("button", { name: "新建会话" }).first().click();
    await expect(firstWindow.getByRole("heading", { name: "新会话" })).toBeVisible();
    await expect(firstWindow.getByRole("button", { name: /^新会话，/ })).toBeVisible();

    await firstWindow.getByRole("link", { name: "能力" }).click();
    await expect(firstWindow.getByRole("heading", { name: "模型 Provider" })).toBeVisible();
    await firstWindow.getByRole("button", { name: "新增 Provider" }).click();
    await firstWindow.getByLabel("Provider ID").fill("smoke-provider");
    await firstWindow.getByLabel("显示名称").fill("Smoke Provider");
    await firstWindow.getByLabel("Base URL").fill("http://127.0.0.1:18797/v1");
    await firstWindow.getByLabel("模型名").fill("smoke-model");
    await firstWindow.getByRole("button", { name: "保存 Provider" }).click();
    await expect(firstWindow.getByText("Smoke Provider")).toBeVisible();
    await firstWindow.getByRole("button", { name: "管理 Smoke Provider API Key" }).click();
    await firstWindow.getByLabel("新 API Key").fill(providerSecret);
    await firstWindow.getByRole("button", { name: "保存 Key" }).click();
    await expect(firstWindow.getByText(`...${providerSecret.slice(-4)}`)).toBeVisible();
    await expect(firstWindow.getByText(providerSecret)).toHaveCount(0);

    await firstWindow.getByRole("button", { name: "管理 OpenClaw 配置" }).click();
    const configEditor = firstWindow.getByLabel("OpenClaw 配置 JSON");
    await expect(configEditor).not.toHaveValue("");
    const configBefore = await configEditor.inputValue();
    await firstWindow.getByRole("button", { name: "应用 OpenClaw 配置" }).click();
    await expect(configEditor).toHaveValue(configBefore);

    const credentialPath = join(dataDir, ".uclaw", "provider-credentials.v1.json");
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(credentialPath, "utf8")).toContain(providerSecret);
    expect(await readFile(join(dataDir, "providers", "provider-config.v1.json"), "utf8")).not.toContain(providerSecret);
    await app.close();
    app = undefined;

    app = await launchDesktop(dataDir, cacheDir);
    const restartedWindow = await app.firstWindow();
    await expect(restartedWindow.getByRole("button", { name: /^新会话，/ })).toBeVisible();
    await restartedWindow.getByRole("button", { name: /^新会话，/ }).click();
    await expect(restartedWindow.getByRole("heading", { name: "新会话" })).toBeVisible();
    const sessions = await restartedWindow.evaluate(() => window.uclaw?.client.invoke({
      method: "sessions.list", requestId: "session-smoke-list-after-restart", params: {},
    }));
    expect(sessions).toMatchObject({ ok: true, result: { items: [expect.objectContaining({ id: expect.any(String) })] } });
    const sessionId = (sessions as { result: { items: Array<{ id: string }> } }).result.items[0]!.id;
    const advanced = await restartedWindow.evaluate(async (id) => Promise.all([
      window.uclaw?.sessionAdvanced?.invoke({ method: "sessions.files.list", requestId: "advanced-files", params: { sessionId: id } }),
      window.uclaw?.sessionAdvanced?.invoke({ method: "sessions.checkpoints.list", requestId: "advanced-checkpoints", params: { sessionId: id } }),
    ]), sessionId);
    expect(advanced).toEqual([
      expect.objectContaining({ ok: true, method: "sessions.files.list" }),
      expect.objectContaining({ ok: true, method: "sessions.checkpoints.list" }),
    ]);
    await restartedWindow.getByRole("tab", { name: "高级" }).click();
    await expect(restartedWindow.getByText("会话文件与历史")).toBeVisible();

    await restartedWindow.getByRole("link", { name: "能力" }).click();
    await expect(restartedWindow.getByText("Smoke Provider")).toBeVisible();
    await expect(restartedWindow.getByText(`...${providerSecret.slice(-4)}`)).toBeVisible();
    const removed = await restartedWindow.evaluate(async () => {
      const remove = await window.uclaw?.providers?.invoke({
        method: "providers.remove", requestId: "provider-smoke-remove", params: { providerId: "smoke-provider" },
      });
      const readback = await window.uclaw?.providers?.invoke({
        method: "providers.list", requestId: "provider-smoke-list-after-remove", params: {},
      });
      return { remove, readback };
    });
    expect(removed).toMatchObject({
      remove: { ok: true, method: "providers.remove" },
      readback: { ok: true, result: { providers: expect.not.arrayContaining([expect.objectContaining({ id: "smoke-provider" })]) } },
    });
    expect(await readFile(credentialPath, "utf8")).not.toContain(providerSecret);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
