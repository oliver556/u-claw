import { expect, test } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const uclawRuntime = process.env.UCLAW_REAL_RUNTIME_DIR ?? join(process.env.HOME ?? "", ".uclaw");
const nodeBin = join(uclawRuntime, "runtime", "node-mac-arm64", "bin", "node");
const openClawEntry = join(uclawRuntime, "core", "node_modules", "openclaw", "openclaw.mjs");
const desktopEntry = resolve("desktop/dist/entry.js");

async function launchDesktop(dataDir: string, cacheDir: string, wiringModule: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [desktopEntry],
    env: {
      ...process.env,
      UCLAW_RUNTIME_DIR: uclawRuntime,
      UCLAW_OPENCLAW_ENTRY: openClawEntry,
      UCLAW_NODE_BIN: nodeBin,
      UCLAW_DATA_DIR: dataDir,
      UCLAW_CACHE_DIR: cacheDir,
      UCLAW_DESKTOP_WIRING_MODULE: wiringModule,
      OPENCLAW_CONFIG_PATH: join(dataDir, ".openclaw", "openclaw.json"),
    },
  });
}

test("production Electron creates a real OpenClaw session and reads it after restart", async () => {
  await Promise.all([access(nodeBin), access(openClawEntry), access(desktopEntry)]);
  const root = await mkdtemp(join(tmpdir(), "uclaw-work-chat-real-"));
  const dataDir = join(root, "data");
  const cacheDir = join(root, "cache");
  const openClawState = join(dataDir, ".openclaw");
  const workspace = join(dataDir, "workspace");
  const wiringModule = resolve("desktop", "dist", `session-smoke-wiring-${process.pid}.mjs`);
  const token = `work-chat-${process.pid}-${Date.now()}`;
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
  await writeFile(wiringModule, `
import { createDesktopMainOptions as createProductionOptions } from "./wiring/create-desktop-main-options.js";

const unavailable = async () => { throw new Error("Plugin lifecycle is outside session smoke scope."); };

export async function createDesktopMainOptions(env) {
  const options = await createProductionOptions(env);
  return {
    ...options,
    probeCapabilities: async () => {
      const capabilities = await options.client.gateway.negotiate();
      return { helloOk: true, methods: [...capabilities.methods] };
    },
    pluginRuntime: {
      installed: async () => [],
      installFromPath: unavailable,
      uninstall: unavailable,
      setEnabled: unavailable,
    },
  };
}
`, "utf8");

  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop(dataDir, cacheDir, wiringModule);
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
    await app.close();
    app = undefined;

    app = await launchDesktop(dataDir, cacheDir, wiringModule);
    const restartedWindow = await app.firstWindow();
    await expect(restartedWindow.getByRole("button", { name: /^新会话，/ })).toBeVisible();
    await restartedWindow.getByRole("button", { name: /^新会话，/ }).click();
    await expect(restartedWindow.getByRole("heading", { name: "新会话" })).toBeVisible();
  } finally {
    await app?.close().catch(() => undefined);
    await rm(wiringModule, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});
