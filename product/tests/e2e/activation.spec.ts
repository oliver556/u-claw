import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type FixtureMode = "success" | "invalid" | "offline" | "bound-other" | "write-failure" | "recovery";

const activationCode = "ABCDEFGHJKMNPQRSTVWXYZ2345";
const browserProblems = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const problems: string[] = [];
  browserProblems.set(page, problems);
  page.on("console", (message) => { if (message.type() === "error") problems.push(`console: ${message.text()}`); });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
});

test.afterEach(async ({ page }) => {
  expect(browserProblems.get(page) ?? []).toEqual([]);
});

// Browser E2E verifies the renderer contract. Native Electron exit 20 and Launcher
// restart behavior remain covered by desktop and Go tests referenced by integration.
async function installActivationFixture(page: Page, mode: FixtureMode): Promise<void> {
  await page.addInitScript(({ fixtureMode }) => {
    type Status = { state: string; code?: string };
    const calls: Array<{ method: string; input?: unknown }> = [];
    let mode = fixtureMode;
    let current: Status = { state: "checking" };
    let commitIndex = 0;
    const progress = ["server-bound", "writing", "verifying", "committing"];
    const bridge = Object.freeze({
      async preflight(): Promise<Status> {
        calls.push({ method: "preflight" });
        const forced = sessionStorage.getItem("uclaw-activation-fixture-status");
        if (forced) return current = JSON.parse(forced) as Status;
        current = mode === "recovery" ? { state: "recovery-required", code: "RECOVERY_INPUT_REQUIRED" } : { state: "input" };
        return current;
      },
      async submit(input: unknown): Promise<Status> {
        calls.push({ method: "submit", input });
        if (mode === "invalid") return current = { state: "error", code: "ACTIVATION_INVALID" };
        if (mode === "offline") return current = { state: "error", code: "ACTIVATION_SERVICE_UNAVAILABLE" };
        if (mode === "bound-other") return current = { state: "error", code: "ACTIVATION_CODE_ALREADY_BOUND" };
        if (mode === "write-failure") return current = { state: "recovery-required", code: "RECOVERY_REQUIRED" };
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        return current = { state: "complete" };
      },
      async commit(): Promise<Status> {
        calls.push({ method: "commit" });
        const state = progress[Math.min(commitIndex++, progress.length - 1)];
        return current = { state };
      },
      async cancel(): Promise<Status> { calls.push({ method: "cancel" }); return current; },
      async close(): Promise<Status> { calls.push({ method: "close" }); return current; },
    });
    Object.defineProperty(window, "uclawActivation", { configurable: false, value: bridge });
    Object.defineProperty(window, "__activationFixture", { value: {
      calls,
      setMode(next: FixtureMode) { mode = next; },
      setStatus(next: Status) { sessionStorage.setItem("uclaw-activation-fixture-status", JSON.stringify(next)); },
    } });
  }, { fixtureMode: mode });
}

async function fillActivation(page: Page): Promise<void> {
  await page.getByRole("textbox", { name: "激活码" }).fill(activationCode);
}

async function installNormalFixture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const listeners = new Set<(event: unknown) => void>();
    const now = "2026-08-13T00:00:00.000Z";
    const session = { id: "activated", title: "已激活工作台", createdAt: now, updatedAt: now, pinned: false, status: "idle", model: { id: "openai/gpt-5", label: "GPT-5", providerId: "openai" } };
    const success = (request: { method: string; requestId: string }, result: unknown) => ({ method: request.method, requestId: request.requestId, ok: true, result });
    Object.defineProperty(window, "uclaw", { configurable: false, value: { client: {
      subscribe(listener: (event: unknown) => void) { listeners.add(listener); return () => listeners.delete(listener); },
      async invoke(request: { method: string; requestId: string; params: Record<string, unknown> }) {
        if (request.method === "gateway.negotiate") return success(request, { protocolVersion: 4, methods: ["sessions.list", "sessions.get", "chat.history"], events: ["chat"], features: { attachments: false, approvalResolve: false } });
        if (request.method === "gateway.get-status") return success(request, { connectionState: "ready", protocolVersion: 4, phase: "available", processAlive: true, serviceReady: true, businessAvailable: true, since: now, attempt: 0, openClawVersion: "2026.7.1-2", usb: { state: "available", dataWritable: true } });
        if (request.method === "gateway.watch-status") {
          setTimeout(() => listeners.forEach((listener) => listener({
            event: "gateway.status",
            subscriptionId: request.params.subscriptionId,
            payload: { connectionState: "ready", protocolVersion: 4, phase: "available", processAlive: true, serviceReady: true, businessAvailable: true, since: now, attempt: 0, openClawVersion: "2026.7.1-2", usb: { state: "available", dataWritable: true } },
          })), 0);
          return success(request, null);
        }
        if (request.method === "sessions.list") return success(request, { items: [session], nextCursor: null, hasMore: false });
        if (request.method === "sessions.get") return success(request, session);
        if (request.method === "session-organizer.get") return success(request, { schemaVersion: 1, groups: [], sessions: [] });
        if (request.method === "chat.list") return success(request, { items: [], nextCursor: null, hasMore: false });
        if (request.method === "approvals.list-pending") return success(request, []);
        if (request.method === "subscriptions.cancel") return success(request, null);
        throw new Error(`Unexpected normal IPC method: ${request.method}`);
      },
    } } });
  });
}

async function expectNoOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({
    x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }))).toEqual({ x: 0, y: 0 });
}

test("restricted bridge completes first activation without exposing normal IPC", async ({ page }) => {
  await installActivationFixture(page, "success");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "激活这套 U-Claw" })).toBeVisible();
  expect(await page.evaluate(() => Object.keys((window as any).uclawActivation ?? {}).sort())).toEqual(["cancel", "close", "commit", "preflight", "submit"]);
  expect(await page.evaluate(() => "uclaw" in window)).toBe(false);
  await fillActivation(page);
  await page.getByRole("button", { name: "激活当前 U 盘" }).click();
  await expect(page.getByText("这套 U-Claw 已可使用")).toBeVisible();
  await expectNoOverflow(page);
  expect(await page.evaluate(() => (window as any).__activationFixture.calls.filter((call: any) => call.method === "submit"))).toEqual([
    { method: "submit", input: { activationCode } },
  ]);
});

test("validates 26-character input and preserves real keyboard order", async ({ page }) => {
  await installActivationFixture(page, "success");
  await page.goto("/");
  await page.getByRole("textbox", { name: "激活码" }).fill("short");
  await page.getByRole("button", { name: "激活当前 U 盘" }).click();
  await expect(page.getByText("请输入 26 位激活码")).toBeVisible();
  expect(await page.evaluate(() => (window as any).__activationFixture.calls.filter((call: any) => call.method === "submit"))).toEqual([]);

  await fillActivation(page);
  await page.getByRole("link", { name: "跳到主要内容" }).focus();
  const order: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press("Tab");
    order.push(await page.evaluate(() => {
      const active = document.activeElement as HTMLElement;
      return active.getAttribute("aria-label") || active.id || active.textContent?.trim() || "";
    }));
  }
  expect(order).toEqual(["关闭", "activation-code", "显示激活码", "激活当前 U 盘"]);
});

for (const [mode, message] of [
  ["invalid", "激活码不正确"],
  ["offline", "激活服务暂时不可用"],
] as const) test(`shows ${mode} failure and retries after recovery`, async ({ page }) => {
  await installActivationFixture(page, mode);
  await page.goto("/");
  await fillActivation(page);
  await page.getByRole("button", { name: "激活当前 U 盘" }).click();
  await expect(page.getByText(message)).toBeVisible();
  await page.evaluate(() => (window as any).__activationFixture.setMode("success"));
  await page.getByRole("button", { name: "重试" }).click();
  await expect(page.getByRole("heading", { name: "激活这套 U-Claw" })).toBeVisible();
  await fillActivation(page);
  await page.getByRole("button", { name: "激活当前 U 盘" }).click();
  await expect(page.getByText("这套 U-Claw 已可使用")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__activationFixture.calls.filter((call: any) => call.method === "submit").length)).toBe(2);
});

for (const [mode, heading] of [
  ["recovery", "继续完成本次激活"],
  ["write-failure", "继续完成本次激活"],
] as const) test(`keeps same-disk recovery for ${mode}`, async ({ page }) => {
  await installActivationFixture(page, mode);
  await page.goto("/");
  if (mode === "write-failure") {
    await fillActivation(page);
    await page.getByRole("button", { name: "激活当前 U 盘" }).click();
  }
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  await expect(page.getByText("检测到当前 U 盘有未完成的激活记录")).toBeVisible();
  await page.evaluate(() => (window as any).__activationFixture.setMode("success"));
  await fillActivation(page);
  await page.getByRole("button", { name: "继续恢复" }).click();
  await expect(page.getByText("这套 U-Claw 已可使用")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__activationFixture.calls.filter((call: any) => call.method === "submit").length)).toBe(mode === "write-failure" ? 2 : 1);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`activation states fit ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await installActivationFixture(page, "success");
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expectNoOverflow(page);
    const shell = await page.getByTestId("activation-shell").boundingBox();
    expect(shell).toMatchObject({ x: 0, y: 0, width: viewport.width, height: viewport.height });
    for (const status of [
      { state: "checking" }, { state: "input" }, { state: "submitting" },
      { state: "server-bound" }, { state: "writing" }, { state: "verifying" },
      { state: "committing" }, { state: "complete" },
      { state: "error", code: "ACTIVATION_INVALID" },
      { state: "error", code: "ACTIVATION_SERVICE_UNAVAILABLE" },
      { state: "error", code: "ACTIVATION_CODE_ALREADY_BOUND" },
      { state: "recovery-required", code: "RECOVERY_INPUT_REQUIRED" },
      { state: "recovery-required", code: "RECOVERY_REQUIRED" },
    ]) {
      await page.evaluate((next) => (window as any).__activationFixture.setStatus(next), status);
      await page.reload();
      await expect.poll(() => page.evaluate(() => document.querySelector("[role=status], [role=alert], .activation-form-area") !== null)).toBe(true);
      await expectNoOverflow(page);
    }
  });
}

test("normal restart renders the workspace only after activation mode is gone", async ({ page }) => {
  await installNormalFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect(page.getByRole("button", { name: /已激活工作台/ })).toBeVisible();
  await expect(page.getByTestId("activation-shell")).toHaveCount(0);
});

test("built preload exposes only the restricted activation bridge in a real Electron window", async () => {
  const root = await mkdtemp(join(tmpdir(), "uclaw-activation-preload-"));
  const main = join(root, "main.cjs");
  const html = join(root, "index.html");
  const createReady = join(root, "create-ready");
  const navigateReady = join(root, "navigate-ready");
  const preload = resolve("desktop/dist/preload.cjs");
  let app: ElectronApplication | undefined;
  try {
    await writeFile(html, "<!doctype html><html><body>activation preload</body></html>");
    await writeFile(main, `const { existsSync } = require("node:fs");\nconst { app, BrowserWindow } = require("electron");\nlet window;\napp.whenReady().then(() => { const createTimer = setInterval(() => { if (!existsSync(${JSON.stringify(createReady)})) return; clearInterval(createTimer); window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, additionalArguments: ["--uclaw-startup-mode=activation-only"] } }); void window.loadURL("data:text/html,<title>listener-handshake</title>"); const navigateTimer = setInterval(() => { if (!existsSync(${JSON.stringify(navigateReady)})) return; clearInterval(navigateTimer); window.webContents.session.setPreloads([${JSON.stringify(preload)}]); void window.loadFile(${JSON.stringify(html)}); }, 10); }, 10); });\n`);
    app = await electron.launch({ args: [main] });
    const electronProblems: string[] = [];
    const pagePromise = new Promise<Page>((resolvePage) => {
      app!.once("window", (page) => {
        page.on("console", (message) => { if (message.type() === "error") electronProblems.push(`console: ${message.text()}`); });
        page.on("pageerror", (error) => electronProblems.push(`pageerror: ${error.message}`));
        resolvePage(page);
      });
    });
    await writeFile(createReady, "ready");
    const page = await pagePromise;
    await writeFile(navigateReady, "ready");
    await page.waitForURL(/^file:/u);
    await expect.poll(() => page.evaluate(() => Object.keys((window as any).uclawActivation ?? {}).sort())).toEqual(["cancel", "close", "commit", "preflight", "submit"]);
    expect(await page.evaluate(() => ({ normal: "uclaw" in window, electron: "electron" in window }))).toEqual({ normal: false, electron: false });
    expect(electronProblems).toEqual([]);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
