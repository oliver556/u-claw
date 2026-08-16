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

test("production Electron persists real OpenClaw sessions and Provider configuration without wiring overrides", async () => {
  test.setTimeout(120_000);
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
    await expect(firstWindow.getByRole("button", { name: /^新会话，/ })).toBeVisible();

    const configured = await firstWindow.evaluate(async ({ secret }) => {
      const create = await window.uclaw?.providers?.invoke({
        method: "providers.create", requestId: "provider-smoke-create", params: { provider: {
          id: "smoke-provider", name: "Smoke Provider", enabled: true,
          baseUrl: "http://127.0.0.1:18797/v1", model: "smoke-model",
        } },
      });
      const key = await window.uclaw?.providers?.invoke({
        method: "providers.set-api-key", requestId: "provider-smoke-key", params: { providerId: "smoke-provider", apiKey: secret },
      });
      const config = await window.uclaw?.providers?.invoke({ method: "providers.config-get", requestId: "provider-smoke-config-get", params: {} });
      const apply = config?.ok
        ? await window.uclaw?.providers?.invoke({ method: "providers.config-apply", requestId: "provider-smoke-config-apply", params: { config: config.result.config } })
        : undefined;
      return { create, key, config, apply };
    }, { secret: providerSecret });
    expect(configured).toMatchObject({
      create: { ok: true, method: "providers.create" },
      key: { ok: true, method: "providers.set-api-key" },
      config: { ok: true, method: "providers.config-get" },
      apply: { ok: true, method: "providers.config-apply" },
    });

    await firstWindow.getByRole("link", { name: "自动化" }).click();
    await expect(firstWindow.getByRole("region", { name: "Agent 与定时任务" })).toBeVisible();
    await firstWindow.getByLabel("Agent 名称").fill("smoke-agent");
    await firstWindow.getByLabel("Agent workspace").fill(join(root, "smoke-agent"));
    await firstWindow.getByRole("button", { name: "创建 Agent" }).click();
    await expect(firstWindow.getByRole("button", { name: "查看 Agent smoke-agent" })).toBeVisible();
    await firstWindow.getByRole("tab", { name: "定时任务" }).click();
    await firstWindow.getByLabel("定时任务名称").fill("Smoke schedule");
    await firstWindow.getByLabel("Cron 表达式").fill("0 9 * * *");
    await firstWindow.getByLabel("定时任务消息").fill("authoritative smoke");
    await firstWindow.getByRole("button", { name: "新增定时任务" }).click();
    await expect(firstWindow.getByRole("button", { name: /查看定时任务/ })).toBeVisible();

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
    const removed = await restartedWindow.evaluate(async () => {
      const before = await window.uclaw?.providers?.invoke({
        method: "providers.list", requestId: "provider-smoke-list-before-remove", params: {},
      });
      const remove = await window.uclaw?.providers?.invoke({
        method: "providers.remove", requestId: "provider-smoke-remove", params: { providerId: "smoke-provider" },
      });
      const readback = await window.uclaw?.providers?.invoke({
        method: "providers.list", requestId: "provider-smoke-list-after-remove", params: {},
      });
      return { before, remove, readback };
    });
    expect(removed).toMatchObject({
      before: { ok: true, result: { providers: expect.arrayContaining([expect.objectContaining({ id: "smoke-provider", name: "Smoke Provider", apiKeyHint: `...${providerSecret.slice(-4)}` })]) } },
      remove: { ok: true, method: "providers.remove" },
      readback: { ok: true, result: { providers: expect.not.arrayContaining([expect.objectContaining({ id: "smoke-provider" })]) } },
    });
    expect(await readFile(credentialPath, "utf8")).not.toContain(providerSecret);

    await restartedWindow.getByRole("link", { name: "系统" }).click();
    await restartedWindow.getByRole("tab", { name: "运行审计" }).click();
    await expect(restartedWindow.getByText("OpenClaw 2026.7.1-2")).toBeVisible();
    const doctor = await restartedWindow.evaluate(() => window.uclaw?.diagnostics?.invoke({ method: "doctor.run", requestId: "doctor-production-smoke", params: { timeoutMs: 30_000 } }));
    expect(doctor, JSON.stringify(doctor)).toMatchObject({ ok: true, method: "doctor.run", result: { adapter: "openclaw" } });
    await restartedWindow.getByRole("tab", { name: "OpenClaw Doctor" }).click();
    await expect(restartedWindow.getByText(/OpenClaw (检查通过|发现需处理项)/)).toBeVisible({ timeout: 25_000 });

    await restartedWindow.getByRole("tab", { name: "设备与运行" }).click();
    await expect(restartedWindow.getByRole("region", { name: "设备与运行" })).toBeVisible();
    const systemNode = await restartedWindow.evaluate(async () => ({
      environments: await window.uclaw?.systemNode?.invoke({ method: "environments.list", requestId: "system-node-environments", params: {} }),
      terminal: await window.uclaw?.systemNode?.invoke({ method: "terminal.list", requestId: "system-node-terminal", params: {} }),
    }));
    expect(systemNode).toMatchObject({
      environments: { ok: true, result: { environments: [expect.objectContaining({ id: "gateway", status: "available" })] } },
      terminal: { ok: false, error: { code: "FORBIDDEN" } },
    });
    await restartedWindow.getByRole("tab", { name: "语音与通知" }).click();
    await expect(restartedWindow.getByRole("region", { name: "语音与通知" })).toBeVisible();
    const systemVoice = await restartedWindow.evaluate(async () => ({
      status: await window.uclaw?.systemVoice?.invoke({ method: "talk.runtime.status", requestId: "system-voice-status", params: {} }),
      create: await window.uclaw?.systemVoice?.invoke({ method: "talk.session.create", requestId: "system-voice-create", params: { mode: "realtime" } }),
    }));
    expect(systemVoice.status).toMatchObject({ ok: true, result: { authority: { scope: "owned-runtime" } } });
    expect(systemVoice.create).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^(AUTHORIZATION_REQUIRED|FORBIDDEN)$/) } });
    await restartedWindow.reload();
    await restartedWindow.getByRole("link", { name: "系统" }).click();
    await restartedWindow.getByRole("tab", { name: "语音与通知" }).click();
    await expect(restartedWindow.getByRole("region", { name: "语音与通知" })).toBeVisible();
    await expect(restartedWindow.getByRole("button", { name: "创建客户端 Talk 会话" })).toBeVisible();

    await restartedWindow.getByRole("tab", { name: "产品授权" }).click();
    await expect(restartedWindow.getByRole("region", { name: "产品授权" })).toBeVisible();
    await expect(restartedWindow.getByRole("alert")).toContainText("PRODUCT_SERVICES_NOT_CONFIGURED");
    await expect(restartedWindow.getByRole("button", { name: /制盘|开户|撤销|重制/ })).toHaveCount(0);

    await restartedWindow.getByRole("button", { name: "打开任务活动中心" }).click();
    const taskCenter = restartedWindow.getByRole("region", { name: "Task 活动中心" });
    await expect(taskCenter).toBeVisible();
    await expect(taskCenter.getByRole("alert")).toContainText("not supported", { timeout: 10_000 });

    await restartedWindow.getByRole("link", { name: "自动化" }).click();
    await expect(restartedWindow.getByRole("button", { name: "查看 Agent smoke-agent" })).toBeVisible();
    await restartedWindow.getByRole("tab", { name: "定时任务" }).click();
    const cronButton = restartedWindow.getByRole("button", { name: /查看定时任务/ });
    await expect(cronButton).toBeVisible();
    const cronLabel = await cronButton.getAttribute("aria-label");
    const cronId = cronLabel?.replace("查看定时任务 ", "");
    expect(cronId).toBeTruthy();
    restartedWindow.once("dialog", (dialog) => dialog.accept());
    await restartedWindow.getByRole("button", { name: `删除定时任务 ${cronId}` }).click();
    await restartedWindow.getByRole("tab", { name: "Agent" }).click();
    restartedWindow.once("dialog", (dialog) => dialog.accept());
    await restartedWindow.getByRole("button", { name: "删除 Agent smoke-agent" }).click();
    await expect(restartedWindow.getByRole("button", { name: "查看 Agent smoke-agent" })).toHaveCount(0);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
