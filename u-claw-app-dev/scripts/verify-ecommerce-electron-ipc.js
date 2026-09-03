#!/usr/bin/env node
"use strict";

/**
 * Starts real Electron and verifies the ecommerce Prompt Pack IPC is registered
 * through the preload bridge. This catches stale-main-process regressions that
 * static bundle checks cannot see.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const appRoot = path.resolve(__dirname, "..");
const devDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uclaw-ecommerce-ipc-"));
const debugPort = 9460 + Math.floor(Math.random() * 100);
const children = [];

/**
 * Sleeps while Electron boots and exposes its DevTools endpoint.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for an HTTP endpoint to respond with JSON.
 */
async function waitForJSON(url, timeoutMs = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/**
 * Opens a Chrome DevTools Protocol socket to the first Electron page.
 */
async function openCDP() {
  const list = await waitForJSON(`http://127.0.0.1:${debugPort}/json/list`);
  const page = list.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
  if (!page) throw new Error("Electron CDP page not found");

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const message = { id: ++id, method, params };
          pending.set(message.id, { res, rej });
          ws.send(JSON.stringify(message));
        });
      },
      close() {
        ws.close();
      },
    });
    ws.onerror = reject;
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.rej(new Error(message.error.message));
      else waiter.res(message.result);
    };
  });
}

/**
 * Evaluates JavaScript in the renderer and unwraps promise results.
 */
function makeEval(cdp) {
  return (expression) => cdp
    .send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    .then((result) => {
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || "renderer evaluation failed");
      }
      return result.result.value;
    });
}

/**
 * Calls the real preload-exposed Prompt Pack function with a minimal manifest.
 */
async function assertPromptPackIPC() {
  const cdp = await openCDP();
  try {
    await cdp.send("Runtime.enable");
    const evalJS = makeEval(cdp);
    for (let i = 0; i < 80; i += 1) {
      const ready = await evalJS("document.readyState");
      const hasBridge = await evalJS("Boolean(window.uclaw?.generateEcommercePromptPack)");
      if (ready === "complete" && hasBridge) break;
      await sleep(250);
    }

    const result = await evalJS(`(async () => {
      try {
        const payload = {
          requestId: "ipc-verifier-prompt-pack",
          taskSignature: "ipc-verifier-signature",
          outputTypes: ["main_image", "detail_image"],
          outputCounts: { main_image: 1, detail_image: 1 },
          manifest: {
            id: "ipc-verifier-prompt-pack",
            name: "IPC验证商品",
            platform: "douyin",
            platform_label: "抖音电商",
            output_types: ["main_image", "detail_image"],
            output_counts: { main_image: 1, detail_image: 1 },
            input: {
              category: "测试类目",
              audience: "测试人群",
              selling_points: ["轻便", "耐用"],
              image_count: 1
            },
            output: { size_rule: "1:1" },
            language: { id: "zh-CN", label: "中文" },
            visual_style: { id: "clean_studio", label: "清爽棚拍" },
            aspect_ratio: { id: "ratio_1_1", label: "1:1" }
          },
          images: []
        };
        const promptPack = await window.uclaw.generateEcommercePromptPack(payload);
        return {
          ok: promptPack?.ok === true,
          requestId: promptPack?.requestId || "",
          slotCount: Array.isArray(promptPack?.slots) ? promptPack.slots.length : 0,
          slotIds: Array.isArray(promptPack?.slots) ? promptPack.slots.map((slot) => slot.id) : [],
          firstTitle: promptPack?.slots?.[0]?.title || "",
          firstPromptHasProduct: String(promptPack?.slots?.[0]?.prompt || "").includes("IPC验证商品")
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    })()`);

    if (result?.error && /No handler registered/i.test(result.error)) {
      throw new Error(`Prompt Pack IPC handler not registered: ${result.error}`);
    }
    if (
      !result?.ok ||
      result.slotCount < 2 ||
      !result.slotIds?.includes("KV1") ||
      !result.slotIds?.includes("D1") ||
      !result.firstPromptHasProduct
    ) {
      throw new Error(`Prompt Pack IPC returned unexpected result: ${JSON.stringify(result)}`);
    }
    return result;
  } finally {
    cdp.close();
  }
}

/**
 * Stops Electron and removes transient verifier data.
 */
function cleanup() {
  for (const child of children.reverse()) {
    try { child.kill("SIGTERM"); } catch {}
  }
  try { fs.rmSync(devDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}
}

(async () => {
  try {
    const child = spawn(path.join(appRoot, "node_modules", ".bin", "electron"), [
      ".",
      "--dev",
      `--remote-debugging-port=${debugPort}`,
    ], {
      cwd: appRoot,
      env: {
        ...process.env,
        UCLAW_SKIP_ACTIVATION_GATE: "1",
        UCLAW_DEV_DATA_DIR: devDataDir,
        UCLAW_PORTABLE_WORK_DATA_DIR: devDataDir,
        UCLAW_PORTABLE_DATA_DIR: devDataDir,
      },
      stdio: "ignore",
    });
    children.push(child);
    const result = await assertPromptPackIPC();
    console.log(JSON.stringify({ ok: true, step: "ecommerce_electron_ipc", result }));
  } finally {
    cleanup();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
