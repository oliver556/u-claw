#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_GATEWAY_URL = process.env.ECOMMERCE_VERIFY_GATEWAY_URL || "http://127.0.0.1:18789/";
const DEFAULT_CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH || "/Users/biancheng/Library/Application Support/u-claw/.openclaw/openclaw.json";
const DEFAULT_CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const screenshotsDir = path.resolve(__dirname, "..", "..", ".codex-state", "screenshots");

/**
 * Parses optional flags for the ecommerce workbench connected UI verifier.
 */
function parseArgs(argv) {
  const options = {
    gatewayUrl: DEFAULT_GATEWAY_URL,
    configPath: DEFAULT_CONFIG_PATH,
    chromePath: DEFAULT_CHROME_PATH,
    headful: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--headful") {
      options.headful = true;
      continue;
    }

    if (arg === "--gateway-url") {
      index += 1;
      if (index >= argv.length) throw new Error("--gateway-url requires a value");
      options.gatewayUrl = argv[index];
      continue;
    }

    if (arg.startsWith("--gateway-url=")) {
      options.gatewayUrl = arg.slice("--gateway-url=".length);
      continue;
    }

    if (arg === "--config") {
      index += 1;
      if (index >= argv.length) throw new Error("--config requires a value");
      options.configPath = argv[index];
      continue;
    }

    if (arg.startsWith("--config=")) {
      options.configPath = arg.slice("--config=".length);
      continue;
    }

    if (arg === "--chrome") {
      index += 1;
      if (index >= argv.length) throw new Error("--chrome requires a value");
      options.chromePath = argv[index];
      continue;
    }

    if (arg.startsWith("--chrome=")) {
      options.chromePath = arg.slice("--chrome=".length);
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

/**
 * Prints usage for manual connected UI checks.
 */
function printUsage() {
  console.log(`Usage: node scripts/verify-ecommerce-workbench-ui.js [--gateway-url <url>] [--config <path>] [--chrome <path>] [--headful]

Runs connected browser acceptance for the ecommerce image workbench on the Workflows page.

Requires playwright-core on NODE_PATH, for example:
  NODE_PATH=/Users/biancheng/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules node scripts/verify-ecommerce-workbench-ui.js`);
}

/**
 * Loads playwright-core late so static syntax checks do not need browser deps.
 */
function loadPlaywright() {
  try {
    return require("playwright-core");
  } catch (error) {
    throw new Error(`playwright-core not found. Set NODE_PATH to Codex bundled node_modules. ${error.message}`);
  }
}

/**
 * Reads OpenClaw config and returns parsed JSON without printing secrets.
 */
function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`OpenClaw config not found: ${configPath}`);
  }

  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

/**
 * Extracts the Gateway token without logging secret material.
 */
function getGatewayToken(config) {
  const token = config?.gateway?.auth?.token || config?.gateway?.remote?.token;
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("Gateway token missing in OpenClaw config");
  }

  return token;
}

/**
 * Normalizes Gateway URL so route construction is stable.
 */
function normalizeGatewayUrl(value) {
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url.toString();
}

/**
 * Converts dashboard URL into the WebSocket URL expected by login gate.
 */
function toGatewayWebSocketUrl(value) {
  const url = new URL(value);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/**
 * Traverses light DOM plus open shadow roots for generated Control UI widgets.
 */
async function evaluateInDom(page, expression, arg) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.evaluate(
        ({ source, value }) => {
          const allNodes = (root = document) => {
            const nodes = [];
            const visit = (node) => {
              nodes.push(node);
              if (node.shadowRoot) visit(node.shadowRoot);
              for (const child of node.children || []) visit(child);
            };
            visit(root);
            return nodes;
          };
          const fn = new Function("allNodes", "value", source);
          return fn(allNodes, value);
        },
        { source: expression, value: arg },
      );
    } catch (error) {
      if (!String(error?.message || error).includes("Execution context was destroyed") || attempt === 2) throw error;
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(500);
    }
  }

  throw new Error("Unable to evaluate DOM state");
}

/**
 * Runs a small browser evaluation with retry because route-switch checks can
 * intentionally destroy the current execution context while the SPA reloads.
 */
async function evaluateWithRetry(page, callback) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.evaluate(callback);
    } catch (error) {
      if (!String(error?.message || error).includes("Execution context was destroyed") || attempt === 2) throw error;
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(500);
    }
  }

  throw new Error("Unable to evaluate page callback");
}

/**
 * Reads visible text through generated custom elements.
 */
async function getVisibleText(page) {
  return evaluateInDom(
    page,
    `
      const isVisibleElement = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        if (["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(node.tagName)) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      return allNodes()
        .filter(isVisibleElement)
        .map((node) => node.innerText || node.textContent || "")
        .join("\\n");
    `,
  );
}

/**
 * Waits until visible text contains a marker.
 */
async function waitForText(page, text, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let lastText = "";

  while (Date.now() < deadline) {
    try {
      lastText = await getVisibleText(page);
    } catch (error) {
      if (!String(error?.message || error).includes("Execution context was destroyed")) throw error;
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(300);
      continue;
    }
    if (lastText.includes(text)) return;
    await page.waitForTimeout(200);
  }

  throw new Error(`Text not found: ${text}; tail=${JSON.stringify(lastText.slice(-800))}`);
}

/**
 * Connects through token hash first, falling back to login gate form.
 */
async function ensureConnected(page, dashboardUrl, gatewayWebSocketUrl, token) {
  const routeUrl = new URL("tasks", dashboardUrl);
  routeUrl.hash = new URLSearchParams({ token }).toString();

  await page.goto(routeUrl.toString(), { waitUntil: "domcontentloaded" });
  await page.waitForSelector("body", { timeout: 15000 });

  const hasWorkbench = async () => (await getVisibleText(page)).includes("电商主图/详情图");
  if (await hasWorkbench()) return;

  const loginGate = page.locator("openclaw-login-gate");
  if ((await loginGate.count()) === 0) {
    await waitForText(page, "电商主图/详情图", 30000);
    return;
  }

  await page.locator("openclaw-login-gate input").nth(0).fill(gatewayWebSocketUrl);
  await page.locator("openclaw-login-gate input").nth(1).fill(token);
  await page.evaluate(
    ({ gatewayWebSocketUrl: url, token: authToken }) => {
      const inputs = document.querySelectorAll("openclaw-login-gate input");
      const urlInput = inputs[0];
      const tokenInput = inputs[1];
      if (urlInput instanceof HTMLInputElement) {
        urlInput.value = url;
        urlInput.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      }
      if (tokenInput instanceof HTMLInputElement) {
        tokenInput.value = authToken;
        tokenInput.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      }
    },
    { gatewayWebSocketUrl, token },
  );

  await page.locator("openclaw-login-gate button").first().click();
  await waitForText(page, "电商主图/详情图", 30000);
}

/**
 * Waits for the app router to settle after token-hash login rewrites the URL.
 */
async function waitForTasksRouteSettled(page) {
  await page.waitForFunction(
    () => window.location.pathname.endsWith("/tasks") && window.location.hash === "",
    null,
    { timeout: 10000 },
  ).catch(() => {});
  await page.waitForTimeout(500);
}

/**
 * Installs a fake desktop image API after route redirects settle, so the UI
 * acceptance can verify the direct workbench contract without spending quota.
 */
async function installDirectImageApiStub(page) {
  await page.waitForFunction(
    () => Boolean(document.querySelector("openclaw-tasks-page")),
    null,
    { timeout: 15000 },
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.evaluate(() => {
        window.__uclawEcommerceRequests = [];
        window.__uclawEcommerceProgressEvents = [];
        window.__uclawEcommerceProgressListeners = [];
        window.__uclawEcommerceOpenLocalPathCalls = [];
        window.__uclawEcommerceUsageSyncCalls = [];
        const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAA7klEQVR4nO3RAQ0AAAjDMO5fNCCDkC5z0F0l2wFghBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBD+BjNRAAHIph80AAAAAElFTkSuQmCC";
        const localDir = "/tmp/uclaw-ecommerce-fixture";
        const emitProgress = (payload) => {
          window.__uclawEcommerceProgressEvents.push(payload);
          for (const listener of window.__uclawEcommerceProgressListeners) listener(payload);
        };
        window.uclaw = {
          ...(window.uclaw || {}),
          generateEcommerceImages: async (payload) => {
            const outputTypes =
              Array.isArray(payload?.outputTypes) && payload.outputTypes.length
                ? payload.outputTypes
                : Array.isArray(payload?.manifest?.output_types) && payload.manifest.output_types.length
                  ? payload.manifest.output_types
                  : ["main_image", "detail_image"];
            const outputCounts = payload?.outputCounts || payload?.manifest?.output_counts || {};
            const titles = {
              main_image: "主图",
              detail_image: "详情图",
              model_image: "模特图",
            };
            const units = {
              main_image: "张",
              detail_image: "屏",
              model_image: "张",
            };
            const images = outputTypes.flatMap((type) => {
              const count = Number.parseInt(String(outputCounts[type] || 1), 10);
              return Array.from({ length: Number.isFinite(count) ? count : 1 }, (_value, index) => ({
                id: `${type}-${index + 1}-fixture`,
                type,
                title: `${titles[type] || type}${index + 1}${units[type] || "张"}`,
                model: "gpt-image-2",
                mimeType: "image/png",
                dataUrl: png,
                localPath: `${localDir}/${String(index + 1).padStart(2, "0")}-${type}.png`,
                localDir,
                localFileName: `${String(index + 1).padStart(2, "0")}-${type}.png`,
                savedAt: new Date().toISOString(),
              }));
            });
            window.__uclawEcommerceRequests.push({
              method: "uclaw:ecommerce-generate-images",
              payload: {
                platform: payload?.manifest?.platform,
                productName: payload?.manifest?.name,
                language: payload?.manifest?.language,
                visualStyle: payload?.manifest?.visual_style,
                aspectRatio: payload?.manifest?.aspect_ratio,
                outputTypes,
                outputCounts,
                imageCount: Array.isArray(payload?.images) ? payload.images.length : 0,
                fileNames: Array.isArray(payload?.images) ? payload.images.map((item) => item?.fileName) : [],
              },
            });
            const requestId = payload?.manifest?.id || "fixture-request";
            for (let index = 0; index < images.length; index += 1) {
              await new Promise((resolve) => setTimeout(resolve, index === 0 ? 30 : 80));
              emitProgress({
                requestId,
                index,
                total: images.length,
                status: "completed",
                image: images[index],
                generatedCount: index + 1,
                target: { type: images[index].type, title: images[index].title },
              });
            }
            const finalImages = window.__uclawEcommerceReturnPartialImages ? images.slice(0, 1) : images;
            return {
              ok: true,
              requestId,
              provider: "newapi",
              model: "gpt-image-2",
              generatedAt: new Date().toISOString(),
              warnings: [
                ...(finalImages.length < images.length ? ["fixture final response intentionally partial"] : []),
                "用量同步失败：fixture billing failed",
              ],
              images: finalImages,
              billing: { ok: false, message: "fixture billing failed" },
              localDir,
              localManifestPath: `${localDir}/manifest.json`,
            };
          },
          onEcommerceImageProgress: (callback) => {
            window.__uclawEcommerceProgressListeners.push(callback);
            return () => {
              window.__uclawEcommerceProgressListeners = window.__uclawEcommerceProgressListeners.filter(
                (listener) => listener !== callback,
              );
            };
          },
          materializeEcommerceImage: async (payload) => {
            window.__uclawEcommerceMaterializeCalls = [...(window.__uclawEcommerceMaterializeCalls || []), payload];
            return { ok: true, image: { ...payload, dataUrl: png, mimeType: payload?.mimeType || "image/png" } };
          },
          listEcommerceLocalManifests: async () => {
            window.__uclawEcommerceLocalManifestCalls = (window.__uclawEcommerceLocalManifestCalls || 0) + 1;
            return { ok: true, records: window.__uclawEcommerceLocalManifestRecords || [] };
          },
          openEcommerceLocalPath: async (payload) => {
            window.__uclawEcommerceOpenLocalPathCalls.push(payload);
            return { ok: true, path: payload?.path || payload?.localPath || payload?.localDir || "" };
          },
          syncEcommerceImageUsage: async (payload) => {
            window.__uclawEcommerceUsageSyncCalls.push(payload);
            const result = payload?.result || {};
            const images = Array.isArray(payload?.images) ? payload.images : Array.isArray(result.images) ? result.images : [];
            const warnings = (Array.isArray(result.warnings) ? result.warnings : []).filter(
              (warning) => !String(warning || "").startsWith("用量同步失败："),
            );
            return {
              ok: true,
              requestId: payload?.requestId || result.requestId || result.id || "fixture-usage-retry",
              billing: { ok: true, status: "ok", imageCount: images.length },
              usage: { ok: true, models: [{ model: "gpt-image-2", usedQuota: images.length * 50000 }] },
              warnings,
              localManifestPath: payload?.localManifestPath || result.localManifestPath || "/tmp/uclaw-ecommerce-fixture/manifest.json",
              result: {
                ...result,
                id: payload?.requestId || result.requestId || result.id || "fixture-usage-retry",
                requestId: payload?.requestId || result.requestId || result.id || "fixture-usage-retry",
                model: payload?.model || result.model || "gpt-image-2",
                images,
                warnings,
                billing: { ok: true, status: "ok", imageCount: images.length },
                usage: { ok: true },
                localManifestPath: payload?.localManifestPath || result.localManifestPath || "/tmp/uclaw-ecommerce-fixture/manifest.json",
              },
            };
          },
        };
      });
      return;
    } catch (error) {
      if (!String(error?.message || error).includes("Execution context was destroyed") || attempt === 2) throw error;
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(500);
    }
  }
}

/**
 * Verifies an old generated batch with a usage-sync warning can retry billing
 * without regenerating images or losing upstream per-image warnings.
 */
async function verifyUsageSyncRetry(page) {
  await evaluateWithRetry(page, () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAA7klEQVR4nO3RAQ0AAAjDMO5fNCCDkC5z0F0l2wFghBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBD+BjNRAAHIph80AAAAAElFTkSuQmCC";
    const localDir = "/tmp/uclaw-ecommerce-fixture";
    const images = Array.from({ length: 2 }, (_value, index) => ({
      id: `usage-retry-${index + 1}`,
      type: index === 0 ? "main_image" : "detail_image",
      title: index === 0 ? "主图1张" : "详情图2屏",
      model: "gpt-image-2",
      mimeType: "image/png",
      dataUrl: png,
      localPath: `${localDir}/${String(index + 1).padStart(2, "0")}-usage-retry.png`,
      localDir,
      localFileName: `${String(index + 1).padStart(2, "0")}-usage-retry.png`,
    }));
    const record = {
      id: "usage-retry-request",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "completed",
      platformLabel: "抖音电商",
      productName: "短袖",
      languageLabel: "中文",
      styleLabel: "平台自动",
      ratioLabel: "平台自动",
      imageCount: 1,
      outputLabels: "主图1张、详情图1屏",
      requestedOutputCount: 2,
      generatedImageCount: 2,
      model: "gpt-image-2",
      billing: { ok: false, message: "claim ecommerce image usage: ERROR: relation ecommerce_image_usage_events does not exist" },
      localDir,
      localManifestPath: `${localDir}/manifest.json`,
      result: {
        id: "usage-retry-request",
        requestId: "usage-retry-request",
        platform: "douyin",
        platform_label: "抖音电商",
        name: "短袖",
        model: "gpt-image-2",
        images,
        warnings: [
          "详情图1: 该张被上游图片接口拒绝 403，其他已成功图片已保留。原因：openai_error",
          "用量同步失败：claim ecommerce image usage: ERROR: relation ecommerce_image_usage_events does not exist",
        ],
        billing: { ok: false, message: "claim ecommerce image usage: ERROR: relation ecommerce_image_usage_events does not exist" },
        progress: { done: 2, total: 2, status: "completed" },
        localDir,
        localManifestPath: `${localDir}/manifest.json`,
        qa: ["人工复核"],
      },
    };
    localStorage.setItem("uclaw.ecommerceImageRecords.v1", JSON.stringify([record]));
    window.history.pushState({}, "", "/settings/ai-agents");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.waitForFunction(() => !document.querySelector("openclaw-tasks-page"), null, { timeout: 10000 });
  await evaluateWithRetry(page, () => {
    window.history.pushState({}, "", "/tasks");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitForText(page, "短袖", 10000);
  await waitForText(page, "扣费异常", 10000);
  await installDirectImageApiStub(page);
  await page
    .locator("openclaw-tasks-page .uclaw-ecommerce-record")
    .filter({ hasText: "短袖" })
    .locator("button[aria-label='重试同步用量']")
    .click();
  await page.waitForFunction(() => {
    const text = document.querySelector("openclaw-tasks-page")?.innerText || "";
    return (window.__uclawEcommerceUsageSyncCalls?.length || 0) === 1 && !text.includes("扣费异常");
  }, null, { timeout: 10000 });
  await page
    .locator("openclaw-tasks-page .uclaw-ecommerce-record")
    .filter({ hasText: "短袖" })
    .locator("button[aria-label='查看结果']")
    .click();
  await waitForText(page, "抖音电商 已生成图片", 10000);

  const state = await evaluateInDom(
    page,
    `
      const text = document.querySelector("openclaw-tasks-page")?.innerText || "";
      const cards = allNodes().filter((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-generated"));
      const warningBubble = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-warning-bubble"));
      const calls = window.__uclawEcommerceUsageSyncCalls || [];
      const stored = JSON.parse(localStorage.getItem("uclaw.ecommerceImageRecords.v1") || "[]")[0] || {};
      return {
        syncCallCount: calls.length,
        syncRequestId: calls[0]?.requestId || "",
        syncImageCount: Array.isArray(calls[0]?.images) ? calls[0].images.length : -1,
        hasBillingWarning: text.includes("用量同步失败"),
        hasBillingError: text.includes("扣费异常"),
        hasUpstreamWarningBubble: Boolean(warningBubble),
        upstreamWarningBubbleText: (warningBubble?.innerText || warningBubble?.textContent || "").trim(),
        upstreamWarningBubbleTitle: warningBubble?.getAttribute("title") || "",
        generatedCount: cards.length,
        storedBillingOk: Boolean(stored?.billing?.ok || stored?.result?.billing?.ok),
        storedWarningText: JSON.stringify(stored?.result?.warnings || []),
      };
    `,
  );

  if (state.syncCallCount !== 1 || state.syncRequestId !== "usage-retry-request" || state.syncImageCount !== 2) {
    throw new Error(`Usage sync retry called wrong payload: ${JSON.stringify(state)}`);
  }
  if (state.hasBillingWarning || state.hasBillingError || !state.storedBillingOk) {
    throw new Error(`Usage sync retry should clear billing error state: ${JSON.stringify(state)}`);
  }
  if (!state.hasUpstreamWarningBubble || !state.upstreamWarningBubbleText.includes("1 张被上游拒绝") || !state.storedWarningText.includes("该张被上游图片接口拒绝 403")) {
    throw new Error(`Usage sync retry should preserve upstream warning: ${JSON.stringify(state)}`);
  }
  if (state.generatedCount !== 2) {
    throw new Error(`Usage sync retry should preserve generated images: ${JSON.stringify(state)}`);
  }

  await evaluateWithRetry(page, () => {
    localStorage.removeItem("uclaw.ecommerceImageRecords.v1");
    window.history.pushState({}, "", "/settings/ai-agents");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.waitForFunction(() => !document.querySelector("openclaw-tasks-page"), null, { timeout: 10000 });
  await evaluateWithRetry(page, () => {
    window.history.pushState({}, "", "/tasks");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitForText(page, "创建生成任务", 10000);
}

/**
 * Simulates leaving Workflows for Models and coming back, then verifies draft
 * cache restores user input without forcing a generation first.
 */
async function verifyDraftSurvivesRouteSwitch(page) {
  await evaluateWithRetry(page, () => {
    window.__uclawEcommerceDraftBeforeRouteSwitch = JSON.parse(
      localStorage.getItem("uclaw.ecommerceWorkbench.draft.v1") || "null",
    );
    window.history.pushState({}, "", "/settings/ai-agents");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.waitForFunction(() => !document.querySelector("openclaw-tasks-page"), null, { timeout: 10000 });
  await evaluateWithRetry(page, () => {
    window.history.pushState({}, "", "/tasks");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitForText(page, "电商主图/详情图", 10000);
  await waitForText(page, "2 张已选择", 10000);

  const draftState = await evaluateInDom(
    page,
    `
      const workbench = allNodes().find((node) => node instanceof HTMLElement && node.getAttribute("data-uclaw-ecommerce-workbench") === "direct-output");
      const inputs = allNodes().filter((node) => node instanceof HTMLInputElement);
      const selects = allNodes().filter((node) => node instanceof HTMLSelectElement);
      const textarea = allNodes().find((node) => node instanceof HTMLTextAreaElement);
      const files = allNodes().filter((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-file"));
      const modelCard = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-type") && (node.innerText || node.textContent || "").includes("模特图"));
      const detailCard = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-type") && (node.innerText || node.textContent || "").includes("详情图"));
      return {
        platform: workbench?.getAttribute("data-uclaw-ecommerce-platform") || "",
        language: workbench?.getAttribute("data-uclaw-ecommerce-language") || "",
        visualStyle: workbench?.getAttribute("data-uclaw-ecommerce-visual-style") || "",
        aspectRatio: workbench?.getAttribute("data-uclaw-ecommerce-aspect-ratio") || "",
        productName: inputs.find((node) => node.placeholder === "如：便携榨汁杯")?.value || "",
        category: inputs.find((node) => node.placeholder === "如：厨房小电")?.value || "",
        audience: inputs.find((node) => node.placeholder === "默认可不填")?.value || "",
        sellingPoints: textarea?.value || "",
        fileCount: files.length,
        draftFileCount: Array.isArray(window.__uclawEcommerceDraftFiles) ? window.__uclawEcommerceDraftFiles.length : -1,
        draftBefore: window.__uclawEcommerceDraftBeforeRouteSwitch,
        draftAfter: JSON.parse(localStorage.getItem("uclaw.ecommerceWorkbench.draft.v1") || "null"),
        selectValues: selects.map((node) => node.value),
        modelSelected: Boolean(modelCard?.classList.contains("is-active")),
        detailCount: detailCard?.querySelector("input[type='number']")?.value || "",
      };
    `,
  );

  if (draftState.platform !== "amazon" || draftState.language !== "en") {
    throw new Error(`Draft route switch lost platform/language: ${JSON.stringify(draftState)}`);
  }
  if (draftState.visualStyle !== "lifestyle_scene" || draftState.aspectRatio !== "ratio_3_4") {
    throw new Error(`Draft route switch lost style/ratio presets: ${JSON.stringify(draftState)}`);
  }
  if (draftState.productName !== "便携榨汁杯" || draftState.category !== "厨房小电" || draftState.audience !== "通勤白领") {
    throw new Error(`Draft route switch lost product fields: ${JSON.stringify(draftState)}`);
  }
  if (!draftState.sellingPoints.includes("USB-C 充电")) {
    throw new Error(`Draft route switch lost selling points: ${JSON.stringify(draftState)}`);
  }
  if (draftState.fileCount !== 2 || draftState.draftFileCount !== 2) {
    throw new Error(`Draft route switch lost image files: ${JSON.stringify(draftState)}`);
  }
  if (!draftState.modelSelected || draftState.detailCount !== "6") {
    throw new Error(`Draft route switch lost output selection: ${JSON.stringify(draftState)}`);
  }
  if (draftState.draftAfter?.productName !== "便携榨汁杯" || draftState.draftAfter?.outputCounts?.detail_image !== 6) {
    throw new Error(`Draft localStorage payload invalid: ${JSON.stringify(draftState)}`);
  }
  if (draftState.draftAfter?.visualStyle !== "lifestyle_scene" || draftState.draftAfter?.aspectRatio !== "ratio_3_4") {
    throw new Error(`Draft localStorage style/ratio invalid: ${JSON.stringify(draftState)}`);
  }
}

/**
 * Verifies records prefer real result images over optimistic progress counters.
 */
async function verifyPartialRecordStatus(page) {
  await evaluateWithRetry(page, () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAA7klEQVR4nO3RAQ0AAAjDMO5fNCCDkC5z0F0l2wFghBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBD+BjNRAAHIph80AAAAAElFTkSuQmCC";
    const images = Array.from({ length: 5 }, (_value, index) => ({
      id: `partial-record-${index + 1}`,
      type: index === 0 ? "main_image" : "detail_image",
      title: index === 0 ? "主图" : `详情图${index}`,
      model: "gpt-image-2",
      mimeType: "image/png",
      dataUrl: png,
    }));
    const record = {
      id: "partial-record-fixture",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "completed",
      platformLabel: "淘宝/天猫",
      productName: "青花陶瓷碗",
      languageLabel: "中文",
      styleLabel: "平台自动",
      ratioLabel: "1:1 方图",
      imageCount: 1,
      outputLabels: "主图1张、详情图4屏、模特图1张",
      requestedOutputCount: 6,
      generatedImageCount: 6,
      model: "gpt-image-2",
      billing: { ok: false, message: "fixture billing failed" },
      result: {
        platform_label: "淘宝/天猫",
        name: "青花陶瓷碗",
        model: "gpt-image-2",
        images,
        warnings: ["用量同步失败：fixture billing failed"],
        billing: { ok: false, message: "fixture billing failed" },
        progress: { done: 6, total: 6, status: "completed" },
        qa: ["人工复核"],
      },
    };
    localStorage.setItem("uclaw.ecommerceImageRecords.v1", JSON.stringify([record]));
    window.history.pushState({}, "", "/settings/ai-agents");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.waitForFunction(() => !document.querySelector("openclaw-tasks-page"), null, { timeout: 10000 });
  await evaluateWithRetry(page, () => {
    window.history.pushState({}, "", "/tasks");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitForText(page, "青花陶瓷碗", 10000);

  const state = await evaluateInDom(
    page,
    `
      const recordRows = allNodes().filter((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-record"));
      const recordTexts = recordRows.map((node) => (node.innerText || node.textContent || "").replace(/\\s+/g, " ").trim());
      const target = recordTexts.find((text) => text.includes("青花陶瓷碗")) || "";
      const chip = allNodes().find((node) => node instanceof HTMLElement && node.matches(".uclaw-ecommerce-record .chip"));
      return {
        target,
        chipText: (chip?.innerText || chip?.textContent || "").trim(),
        chipClass: chip?.className || "",
      };
    `,
  );

  if (!state.target.includes("计划 6 张/屏") || !state.target.includes("已出 5 张")) {
    throw new Error(`Partial record should show real generated image count, got ${JSON.stringify(state)}`);
  }
  if (state.chipText !== "部分生成" || state.chipClass.includes("chip-ok")) {
    throw new Error(`Partial record should not be marked completed, got ${JSON.stringify(state)}`);
  }
  if (!state.target.includes("扣费异常")) {
    throw new Error(`Partial billing error should stay visible, got ${JSON.stringify(state)}`);
  }

  await evaluateWithRetry(page, () => {
    localStorage.removeItem("uclaw.ecommerceImageRecords.v1");
    window.history.pushState({}, "", "/settings/ai-agents");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.waitForFunction(() => !document.querySelector("openclaw-tasks-page"), null, { timeout: 10000 });
  await evaluateWithRetry(page, () => {
    window.history.pushState({}, "", "/tasks");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitForText(page, "创建生成任务", 10000);
}

/**
 * Verifies generation records render through compact pagination when local
 * history grows beyond the visible page size.
 */
async function verifyRecordPagination(page) {
  await evaluateWithRetry(page, () => {
    const now = Date.now();
    const records = Array.from({ length: 11 }, (_value, index) => {
      const display = String(index + 1).padStart(2, "0");
      return {
        id: `pagination-record-${display}`,
        createdAt: now - index * 1000,
        updatedAt: now - index * 1000,
        status: "completed",
        platformLabel: "抖音电商",
        productName: `分页商品${display}`,
        languageLabel: "中文",
        styleLabel: "平台自动",
        ratioLabel: "1:1 方图",
        imageCount: 1,
        outputLabels: "主图1张",
        requestedOutputCount: 1,
        generatedImageCount: 1,
        model: "gpt-image-2",
        result: {
          id: `pagination-record-${display}`,
          platform_label: "抖音电商",
          name: `分页商品${display}`,
          model: "gpt-image-2",
          images: [],
          warnings: [],
          billing: { status: "ok" },
          progress: { done: 1, total: 1, status: "completed" },
          qa: ["人工复核"],
        },
      };
    });
    localStorage.setItem("uclaw.ecommerceImageRecords.v1", JSON.stringify(records));
    window.history.pushState({}, "", "/settings/ai-agents");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.waitForFunction(() => !document.querySelector("openclaw-tasks-page"), null, { timeout: 10000 });
  await evaluateWithRetry(page, () => {
    window.history.pushState({}, "", "/tasks");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitForText(page, "分页商品01", 10000);
  await waitForText(page, "共 11 条 · 第 1/2 页", 10000);

  const firstPage = await evaluateInDom(
    page,
    `
      const rows = allNodes().filter((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-record"));
      const pager = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-record-pagination"));
      const buttons = pager ? [...pager.querySelectorAll("button")] : [];
      return {
        rowCount: rows.length,
        rowTexts: rows.map((node) => (node.innerText || node.textContent || "").replace(/\\s+/g, " ").trim()),
        pagerText: (pager?.innerText || pager?.textContent || "").replace(/\\s+/g, " ").trim(),
        prevDisabled: Boolean(buttons[0]?.disabled),
        nextDisabled: Boolean(buttons[1]?.disabled),
      };
    `,
  );
  if (firstPage.rowCount !== 10 || !firstPage.prevDisabled || firstPage.nextDisabled) {
    throw new Error(`Record pagination first page invalid: ${JSON.stringify(firstPage)}`);
  }
  if (!firstPage.rowTexts[0]?.includes("分页商品01") || firstPage.rowTexts.some((text) => text.includes("分页商品11"))) {
    throw new Error(`Record pagination first page should show newest 10 only: ${JSON.stringify(firstPage)}`);
  }

  await page.locator("openclaw-tasks-page .uclaw-ecommerce-record-pagination button").filter({ hasText: "下一页" }).click();
  await waitForText(page, "共 11 条 · 第 2/2 页", 10000);
  const secondPage = await evaluateInDom(
    page,
    `
      const rows = allNodes().filter((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-record"));
      const pager = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-record-pagination"));
      const buttons = pager ? [...pager.querySelectorAll("button")] : [];
      return {
        rowCount: rows.length,
        rowTexts: rows.map((node) => (node.innerText || node.textContent || "").replace(/\\s+/g, " ").trim()),
        pagerText: (pager?.innerText || pager?.textContent || "").replace(/\\s+/g, " ").trim(),
        prevDisabled: Boolean(buttons[0]?.disabled),
        nextDisabled: Boolean(buttons[1]?.disabled),
      };
    `,
  );
  if (secondPage.rowCount !== 1 || secondPage.prevDisabled || !secondPage.nextDisabled) {
    throw new Error(`Record pagination second page invalid: ${JSON.stringify(secondPage)}`);
  }
  if (!secondPage.rowTexts[0]?.includes("分页商品11")) {
    throw new Error(`Record pagination second page should show last record: ${JSON.stringify(secondPage)}`);
  }

  await evaluateWithRetry(page, () => {
    localStorage.removeItem("uclaw.ecommerceImageRecords.v1");
    window.history.pushState({}, "", "/settings/ai-agents");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.waitForFunction(() => !document.querySelector("openclaw-tasks-page"), null, { timeout: 10000 });
  await evaluateWithRetry(page, () => {
    window.history.pushState({}, "", "/tasks");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitForText(page, "创建生成任务", 10000);
}

/**
 * Verifies historical records that only retained trusted localPath values can
 * hydrate back into previewable data URLs when the user opens the record.
 */
async function verifyLocalPathOnlyRecordHydration(page) {
  await evaluateWithRetry(page, () => {
    const localDir = "/tmp/uclaw-ecommerce-fixture";
    const images = Array.from({ length: 2 }, (_value, index) => ({
      id: `local-only-${index + 1}`,
      type: index === 0 ? "main_image" : "detail_image",
      title: index === 0 ? "主图" : "详情图1",
      model: "gpt-image-2",
      mimeType: "image/png",
      localPath: `${localDir}/${String(index + 1).padStart(2, "0")}-local-only.png`,
      localDir,
      localFileName: `${String(index + 1).padStart(2, "0")}-local-only.png`,
    }));
    const record = {
      id: "local-path-only-record",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "completed",
      platformLabel: "抖音电商",
      productName: "空气墨盒",
      languageLabel: "中文",
      styleLabel: "白底主图",
      ratioLabel: "1:1 方图",
      imageCount: 1,
      outputLabels: "主图1张、详情图1屏",
      requestedOutputCount: 2,
      generatedImageCount: 2,
      model: "gpt-image-2",
      localDir,
      result: {
        id: "local-path-only-record",
        platform_label: "抖音电商",
        name: "空气墨盒",
        model: "gpt-image-2",
        localDir,
        images,
        warnings: [],
        billing: { status: "ok" },
        progress: { done: 2, total: 2, status: "completed" },
        qa: ["人工复核"],
      },
    };
    localStorage.setItem("uclaw.ecommerceImageRecords.v1", JSON.stringify([record]));
    window.__uclawEcommerceMaterializeCalls = [];
    window.history.pushState({}, "", "/settings/ai-agents");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.waitForFunction(() => !document.querySelector("openclaw-tasks-page"), null, { timeout: 10000 });
  await evaluateWithRetry(page, () => {
    window.history.pushState({}, "", "/tasks");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitForText(page, "空气墨盒", 10000);
  await installDirectImageApiStub(page);
  await page.locator("openclaw-tasks-page .uclaw-ecommerce-record").filter({ hasText: "空气墨盒" }).locator("button[aria-label='查看结果']").click();
  await page.waitForFunction(() => {
    const image = [...document.querySelectorAll("openclaw-tasks-page .uclaw-ecommerce-featured img")][0];
    return image instanceof HTMLImageElement && image.src.startsWith("data:image/");
  }, null, { timeout: 10000 });

  const state = await evaluateInDom(
    page,
    `
      const featuredImage = allNodes().find((node) => node instanceof HTMLImageElement && node.closest(".uclaw-ecommerce-featured"));
      const stripImages = allNodes().filter((node) => node instanceof HTMLImageElement && node.closest(".uclaw-ecommerce-generated"));
      return {
        featuredSrc: featuredImage?.src || "",
        stripSrcs: stripImages.map((node) => node.src || ""),
        materializeCount: window.__uclawEcommerceMaterializeCalls?.length || 0,
      };
    `,
  );
  if (!state.featuredSrc.startsWith("data:image/") || state.stripSrcs.some((src) => !src.startsWith("data:image/"))) {
    throw new Error(`LocalPath-only record did not hydrate into previewable images: ${JSON.stringify(state)}`);
  }
  if (state.materializeCount < 2) {
    throw new Error(`Expected localPath-only record to call materialize IPC for each image, got ${JSON.stringify(state)}`);
  }

  await evaluateWithRetry(page, () => {
    localStorage.removeItem("uclaw.ecommerceImageRecords.v1");
    window.history.pushState({}, "", "/settings/ai-agents");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.waitForFunction(() => !document.querySelector("openclaw-tasks-page"), null, { timeout: 10000 });
  await evaluateWithRetry(page, () => {
    window.history.pushState({}, "", "/tasks");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitForText(page, "创建生成任务", 10000);
}

/**
 * Verifies successful local manifest files can restore the workbench when the
 * browser storage index is missing.
 */
async function verifyLocalManifestAutoImport(page) {
  await evaluateWithRetry(page, () => {
    const localDir = "/tmp/uclaw-ecommerce-manifest-fixture";
    const images = Array.from({ length: 2 }, (_value, index) => ({
      id: `manifest-import-${index + 1}`,
      type: index === 0 ? "main_image" : "detail_image",
      title: index === 0 ? "主图" : "详情图1",
      model: "gpt-image-2",
      mimeType: "image/png",
      localPath: `${localDir}/${String(index + 1).padStart(2, "0")}-manifest.png`,
      localDir,
      localFileName: `${String(index + 1).padStart(2, "0")}-manifest.png`,
      savedAt: new Date().toISOString(),
    }));
    const record = {
      id: "manifest-auto-import-record",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "completed",
      platform: "douyin",
      platformLabel: "抖音电商",
      productName: "云端成功服",
      languageLabel: "中文",
      styleLabel: "白底主图",
      ratioLabel: "1:1 方图",
      imageCount: 1,
      outputTypes: ["main_image", "detail_image"],
      outputCounts: { main_image: 1, detail_image: 1 },
      outputLabels: "主图1张、详情图1屏",
      requestedOutputCount: 2,
      generatedImageCount: 2,
      model: "gpt-image-2",
      localDir,
      localManifestPath: `${localDir}/manifest.json`,
      result: {
        id: "manifest-auto-import-record",
        requestId: "manifest-auto-import-record",
        platform: "douyin",
        platform_label: "抖音电商",
        name: "云端成功服",
        model: "gpt-image-2",
        localDir,
        localManifestPath: `${localDir}/manifest.json`,
        images,
        warnings: [],
        billing: { status: "ok" },
        progress: { done: 2, total: 2, status: "completed" },
        qa: ["人工复核"],
      },
    };
    localStorage.removeItem("uclaw.ecommerceImageRecords.v1");
    window.__uclawEcommerceMaterializeCalls = [];
    window.__uclawEcommerceLocalManifestCalls = 0;
    window.__uclawEcommerceLocalManifestRecords = [record];
    window.history.pushState({}, "", "/settings/ai-agents");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.waitForFunction(() => !document.querySelector("openclaw-tasks-page"), null, { timeout: 10000 });
  await evaluateWithRetry(page, () => {
    window.history.pushState({}, "", "/tasks");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitForText(page, "云端成功服", 10000);
  await page.waitForFunction(() => {
    const image = [...document.querySelectorAll("openclaw-tasks-page .uclaw-ecommerce-featured img")][0];
    return image instanceof HTMLImageElement && image.src.startsWith("data:image/");
  }, null, { timeout: 10000 });

  const state = await evaluateInDom(
    page,
    `
      const record = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-record") && (node.innerText || node.textContent || "").includes("云端成功服"));
      const featuredImage = allNodes().find((node) => node instanceof HTMLImageElement && node.closest(".uclaw-ecommerce-featured"));
      const stripImages = allNodes().filter((node) => node instanceof HTMLImageElement && node.closest(".uclaw-ecommerce-generated"));
      const recordLogButton = record ? [...record.querySelectorAll("button")].find((node) => node.classList.contains("uclaw-ecommerce-log-button")) : null;
      const resultLogButton = allNodes().find((node) => node instanceof HTMLButtonElement && node.classList.contains("uclaw-ecommerce-log-button"));
      const stored = JSON.parse(localStorage.getItem("uclaw.ecommerceImageRecords.v1") || "[]");
      return {
        localManifestCalls: window.__uclawEcommerceLocalManifestCalls || 0,
        materializeCount: window.__uclawEcommerceMaterializeCalls?.length || 0,
        recordText: (record?.innerText || record?.textContent || "").replace(/\\s+/g, " ").trim(),
        featuredSrc: featuredImage?.src || "",
        stripCount: stripImages.length,
        stripDataUrlCount: stripImages.filter((node) => (node.src || "").startsWith("data:image/")).length,
        hasRecordLogButton: Boolean(recordLogButton),
        hasResultLogButton: Boolean(resultLogButton),
        resultLogButtonLabel: resultLogButton?.getAttribute("aria-label") || "",
        resultLogButtonTitle: resultLogButton?.getAttribute("title") || "",
        storedCount: stored.length,
      };
    `,
  );
  if (state.localManifestCalls < 1 || state.storedCount < 1 || !state.recordText.includes("云端成功服")) {
    throw new Error(`Local manifest record was not imported into frontend history: ${JSON.stringify(state)}`);
  }
  if (!state.featuredSrc.startsWith("data:image/") || state.stripCount < 2 || state.stripDataUrlCount < 2) {
    throw new Error(`Local manifest import did not show generated images: ${JSON.stringify(state)}`);
  }
  if (!state.hasResultLogButton || state.resultLogButtonLabel !== "导出日志" || state.resultLogButtonTitle !== "导出日志") {
    throw new Error(`Local manifest import should expose one-click log export: ${JSON.stringify(state)}`);
  }
}

/**
 * Verifies the saved local manifest wins over a stale browser record for the
 * same request, so UI counts and previews match the files already on disk.
 */
async function verifyLocalManifestReplacesStalePartialRecord(page) {
  await evaluateWithRetry(page, () => {
    const localDir = "/tmp/uclaw-ecommerce-manifest-five";
    const requestId = "manifest-replaces-stale-record";
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAA7klEQVR4nO3RAQ0AAAjDMO5fNCCDkC5z0F0l2wFghBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBD+BjNRAAHIph80AAAAAElFTkSuQmCC";
    const images = Array.from({ length: 5 }, (_value, index) => ({
      id: `${requestId}-${index + 1}`,
      type: index === 0 ? "main_image" : "detail_image",
      title: index === 0 ? "主图1张" : `详情图${index}屏`,
      model: "gpt-image-2",
      mimeType: "image/png",
      localPath: `${localDir}/${String(index + 1).padStart(2, "0")}-manifest.png`,
      localDir,
      localFileName: `${String(index + 1).padStart(2, "0")}-manifest.png`,
      savedAt: new Date().toISOString(),
    }));
    const manifestRecord = {
      id: requestId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "completed",
      platform: "douyin",
      platformLabel: "抖音电商",
      productName: "本地五图服",
      languageLabel: "中文",
      styleLabel: "白底主图",
      ratioLabel: "1:1 方图",
      imageCount: 1,
      outputTypes: ["main_image", "detail_image"],
      outputCounts: { main_image: 1, detail_image: 4 },
      outputLabels: "主图1张、详情图4屏",
      requestedOutputCount: 5,
      generatedImageCount: 5,
      model: "gpt-image-2",
      localDir,
      localManifestPath: `${localDir}/manifest.json`,
      result: {
        id: requestId,
        requestId,
        platform: "douyin",
        platform_label: "抖音电商",
        name: "本地五图服",
        model: "gpt-image-2",
        localDir,
        localManifestPath: `${localDir}/manifest.json`,
        images,
        warnings: [],
        billing: { status: "ok" },
        progress: { done: 5, total: 5, status: "completed" },
        qa: ["人工复核"],
      },
    };
    const staleRecord = {
      ...manifestRecord,
      generatedImageCount: 2,
      result: {
        ...manifestRecord.result,
        images: images.slice(0, 2).map((image, index) => ({
          ...image,
          url: `https://expired.invalid/${index + 1}.png`,
        })),
        progress: { done: 2, total: 5, status: "partial" },
      },
    };
    localStorage.setItem("uclaw.ecommerceImageRecords.v1", JSON.stringify([staleRecord]));
    window.__uclawEcommerceMaterializeCalls = [];
    window.__uclawEcommerceLocalManifestCalls = 0;
    window.__uclawEcommerceLocalManifestRecords = [manifestRecord];
    window.uclaw = {
      ...(window.uclaw || {}),
      materializeEcommerceImage: async (payload) => {
        window.__uclawEcommerceMaterializeCalls = [...(window.__uclawEcommerceMaterializeCalls || []), payload];
        return { ok: true, image: { ...payload, dataUrl: png, mimeType: payload?.mimeType || "image/png", url: "" } };
      },
      listEcommerceLocalManifests: async () => {
        window.__uclawEcommerceLocalManifestCalls = (window.__uclawEcommerceLocalManifestCalls || 0) + 1;
        return { ok: true, records: window.__uclawEcommerceLocalManifestRecords || [] };
      },
    };
    window.history.pushState({}, "", "/settings/ai-agents");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.waitForFunction(() => !document.querySelector("openclaw-tasks-page"), null, { timeout: 10000 });
  await evaluateWithRetry(page, () => {
    window.history.pushState({}, "", "/tasks");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitForText(page, "本地五图服", 10000);
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll("openclaw-tasks-page .uclaw-ecommerce-generated img")];
    return images.length >= 5 && images.every((image) => image instanceof HTMLImageElement && image.src.startsWith("data:image/"));
  }, null, { timeout: 10000 });

  const state = await evaluateInDom(
    page,
    `
      const record = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-record") && (node.innerText || node.textContent || "").includes("本地五图服"));
      const resultText = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-result"))?.innerText || "";
      const stripImages = allNodes().filter((node) => node instanceof HTMLImageElement && node.closest(".uclaw-ecommerce-generated"));
      const stored = JSON.parse(localStorage.getItem("uclaw.ecommerceImageRecords.v1") || "[]")[0] || {};
      const storedImages = Array.isArray(stored?.result?.images) ? stored.result.images : [];
      return {
        recordText: (record?.innerText || record?.textContent || "").replace(/\\s+/g, " ").trim(),
        resultText,
        stripCount: stripImages.length,
        stripDataUrlCount: stripImages.filter((node) => (node.src || "").startsWith("data:image/")).length,
        brokenishSrcCount: stripImages.filter((node) => !(node.src || "").startsWith("data:image/")).length,
        materializeCount: window.__uclawEcommerceMaterializeCalls?.length || 0,
        localManifestCalls: window.__uclawEcommerceLocalManifestCalls || 0,
        storedImageCount: storedImages.length,
        storedGeneratedImageCount: stored.generatedImageCount || 0,
        storedHasRemoteUrl: JSON.stringify(stored).includes("https://expired.invalid"),
      };
    `,
  );

  if (!state.recordText.includes("已出 5 张") || !state.resultText.includes("5/5 张结果")) {
    throw new Error(`Local manifest did not replace stale two-image UI record: ${JSON.stringify(state)}`);
  }
  if (state.stripCount < 5 || state.stripDataUrlCount < 5 || state.brokenishSrcCount > 0 || state.materializeCount < 5) {
    throw new Error(`Local manifest images did not hydrate from local files: ${JSON.stringify(state)}`);
  }
  if (state.storedImageCount !== 5 || state.storedGeneratedImageCount !== 5 || state.storedHasRemoteUrl) {
    throw new Error(`Local manifest replacement did not persist the full local index: ${JSON.stringify(state)}`);
  }
}

/**
 * Verifies real generation saves only lightweight local file references, then
 * hydrates those local files after the Workflows route is remounted.
 */
async function verifyGeneratedRecordPersistsViaLocalPath(page, viewportName) {
  const storedState = await page.evaluate(() => {
    const raw = localStorage.getItem("uclaw.ecommerceImageRecords.v1") || "";
    const records = JSON.parse(raw || "[]");
    const record = records.find((item) => item?.productName === "便携榨汁杯") || records[0] || null;
    const images = Array.isArray(record?.result?.images) ? record.result.images : [];
    return {
      rawLength: raw.length,
      rawHasDataUrl: raw.includes("data:image/"),
      rawHasRemoteUrl: /https?:\/\//.test(raw),
      imageCount: images.length,
      localPathCount: images.filter((image) => typeof image?.localPath === "string" && image.localPath.length > 0).length,
      dataUrlCount: images.filter((image) => typeof image?.dataUrl === "string" && image.dataUrl.length > 0).length,
      urlCount: images.filter((image) => typeof image?.url === "string" && image.url.length > 0).length,
      recordText: record ? `${record.productName || ""} ${record.status || ""}` : "",
    };
  });

  if (storedState.rawLength <= 0 || storedState.rawLength > 250000) {
    throw new Error(`${viewportName}: Stored ecommerce record should be small localPath index, got ${JSON.stringify(storedState)}`);
  }
  if (storedState.rawHasDataUrl || storedState.rawHasRemoteUrl || storedState.dataUrlCount > 0 || storedState.urlCount > 0) {
    throw new Error(`${viewportName}: Stored ecommerce record must not persist image bytes or remote URLs, got ${JSON.stringify(storedState)}`);
  }
  if (storedState.imageCount < 10 || storedState.localPathCount !== storedState.imageCount) {
    throw new Error(`${viewportName}: Stored ecommerce record must keep every generated localPath, got ${JSON.stringify(storedState)}`);
  }

  await evaluateWithRetry(page, () => {
    window.__uclawEcommerceMaterializeCalls = [];
    window.history.pushState({}, "", "/settings/ai-agents");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.waitForFunction(() => !document.querySelector("openclaw-tasks-page"), null, { timeout: 10000 });
  await evaluateWithRetry(page, () => {
    window.history.pushState({}, "", "/tasks");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitForText(page, "便携榨汁杯", 10000);
  await installDirectImageApiStub(page);
  await page
    .locator("openclaw-tasks-page .uclaw-ecommerce-record")
    .filter({ hasText: "便携榨汁杯" })
    .locator("button[aria-label='查看结果']")
    .first()
    .click();
  await page.waitForFunction(() => {
    const image = [...document.querySelectorAll("openclaw-tasks-page .uclaw-ecommerce-featured img")][0];
    return image instanceof HTMLImageElement && image.src.startsWith("data:image/");
  }, null, { timeout: 10000 });

  const hydratedState = await evaluateInDom(
    page,
    `
      const featuredImage = allNodes().find((node) => node instanceof HTMLImageElement && node.closest(".uclaw-ecommerce-featured"));
      const stripImages = allNodes().filter((node) => node instanceof HTMLImageElement && node.closest(".uclaw-ecommerce-generated"));
      return {
        featuredSrc: featuredImage?.src || "",
        stripCount: stripImages.length,
        stripDataUrlCount: stripImages.filter((node) => (node.src || "").startsWith("data:image/")).length,
        materializeCount: window.__uclawEcommerceMaterializeCalls?.length || 0,
      };
    `,
  );

  if (!hydratedState.featuredSrc.startsWith("data:image/") || hydratedState.stripCount < 10 || hydratedState.stripDataUrlCount < 10) {
    throw new Error(`${viewportName}: Remounted localPath record did not hydrate into previews, got ${JSON.stringify(hydratedState)}`);
  }
  if (hydratedState.materializeCount < 10) {
    throw new Error(`${viewportName}: Remounted localPath record should materialize each generated image, got ${JSON.stringify(hydratedState)}`);
  }
}

/**
 * Writes a small local PNG fixture for upload interaction.
 */
function writeImageFixture() {
  const file = path.join(os.tmpdir(), `uclaw-ecommerce-fixture-${process.pid}.png`);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAA7klEQVR4nO3RAQ0AAAjDMO5fNCCDkC5z0F0l2wFghBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBD+BjNRAAHIph80AAAAAElFTkSuQmCC",
    "base64",
  );
  fs.writeFileSync(file, png);
  return file;
}

/**
 * Fills workbench controls and returns resulting DOM state.
 */
async function exerciseWorkbench(page, imagePath) {
  await waitForText(page, "创建生成任务", 30000);
  await waitForTasksRouteSettled(page);
  await installDirectImageApiStub(page);

  await page.locator("openclaw-tasks-page select").first().selectOption("amazon");
  await page.locator("openclaw-tasks-page select").nth(2).selectOption("lifestyle_scene");
  await page.locator("openclaw-tasks-page select").nth(3).selectOption("ratio_3_4");
  await page.locator("openclaw-tasks-page input[placeholder='如：便携榨汁杯']").fill("便携榨汁杯");
  await page.locator("openclaw-tasks-page input[placeholder='如：厨房小电']").fill("厨房小电");
  await page.locator("openclaw-tasks-page input[placeholder='默认可不填']").fill("通勤白领");
  await page.locator("openclaw-tasks-page textarea").fill("一杯鲜榨\n可拆洗杯体\nUSB-C 充电");
  await page
    .locator("openclaw-tasks-page .uclaw-ecommerce-type")
    .filter({ hasText: "模特图" })
    .locator("input[type='checkbox']")
    .check();
  await page
    .locator("openclaw-tasks-page .uclaw-ecommerce-type")
    .filter({ hasText: "详情图" })
    .locator("input[type='number']")
    .fill("6");
  await page.locator("openclaw-tasks-page input[type='file']").setInputFiles(imagePath);
  await waitForText(page, "1 张已选择", 10000);
  await page.evaluate(() => {
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAA7klEQVR4nO3RAQ0AAAjDMO5fNCCDkC5z0F0l2wFghBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBD+BjNRAAHIph80AAAAAElFTkSuQmCC"), (char) => char.charCodeAt(0));
    const file = new File([bytes], "pasted-product.png", { type: "image/png" });
    const item = { kind: "file", type: "image/png", getAsFile: () => file };
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { items: [item] } });
    window.dispatchEvent(event);
  });
  await waitForText(page, "2 张已选择", 10000);
  await verifyDraftSurvivesRouteSwitch(page);
  await installDirectImageApiStub(page);
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("openclaw-tasks-page button")].find((node) =>
      (node.innerText || node.textContent || "").includes("创建生成任务"),
    );
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  await page.evaluate(() => {
    window.__uclawEcommerceReturnPartialImages = true;
  });
  await page.locator("openclaw-tasks-page button").filter({ hasText: "创建生成任务" }).click();
  await page.waitForFunction(() => {
    const visit = (root = document, out = []) => {
      for (const child of root.children || []) {
        out.push(child);
        if (child.shadowRoot) visit(child.shadowRoot, out);
        visit(child, out);
      }
      return out;
    };
    const workbench = visit().find((node) => node instanceof HTMLElement && node.getAttribute("data-uclaw-ecommerce-workbench") === "direct-output");
    const button = visit().find((node) => node instanceof HTMLButtonElement && (node.innerText || node.textContent || "").includes("任务已创建"));
    const record = visit().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-record"));
    return (
      button instanceof HTMLButtonElement &&
      button.disabled &&
      (workbench?.innerText || workbench?.textContent || "").includes("待图片接口激活") &&
      (record?.innerText || record?.textContent || "").includes("生成中")
    );
  });
  await waitForText(page, "出一张显示一张", 10000);
  await page.waitForFunction(() => {
    const cards = [...document.querySelectorAll("openclaw-tasks-page .uclaw-ecommerce-generated")];
    return cards.length >= 1 && cards.length < 10;
  });
  await page.evaluate(() => {
    window.__uclawEcommerceSawIncrementalResult = true;
  });
  await waitForText(page, "Amazon 已生成图片", 10000);
  await waitForText(page, "10 张结果", 10000);
  await page.waitForFunction(() => document.querySelectorAll("openclaw-tasks-page .uclaw-ecommerce-generated").length >= 10);
  await page.locator("openclaw-tasks-page .uclaw-ecommerce-record button[aria-label='查看结果']").first().waitFor({ timeout: 10000 });

  return evaluateInDom(
    page,
    `
      const workbench = allNodes().find((node) => node instanceof HTMLElement && node.getAttribute("data-uclaw-ecommerce-workbench") === "direct-output");
      const files = allNodes().filter((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-file"));
      const generatedCards = allNodes().filter((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-generated"));
      const generatedImages = allNodes().filter((node) => node instanceof HTMLImageElement && node.closest(".uclaw-ecommerce-generated"));
      const inputs = allNodes().filter((node) => node instanceof HTMLInputElement);
      const textarea = allNodes().find((node) => node instanceof HTMLTextAreaElement);
      const featured = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-featured"));
      const featuredPreview = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-featured-preview"));
      const featuredImage = allNodes().find((node) => node instanceof HTMLImageElement && node.closest(".uclaw-ecommerce-featured"));
      const featuredTitle = allNodes().find((node) => node instanceof HTMLElement && node.matches(".uclaw-ecommerce-featured strong"));
      const selectedGenerated = generatedCards.find((node) => node.classList.contains("is-selected"));
      const resultBody = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-result-body"));
      const resultStrip = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-result-strip"));
      const qaChips = allNodes().filter((node) => node instanceof HTMLElement && node.matches(".uclaw-ecommerce-qa span"));
      const recordRows = allNodes().filter((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-record"));
      const recordTexts = recordRows.map((node) => (node.innerText || node.textContent || "").replace(/\\s+/g, " ").trim());
      const typeCards = allNodes().filter((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-type"));
      const countControls = allNodes().filter((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-count"));
      const stats = allNodes().filter((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-stat"));
      const layout = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-layout"));
      const panel = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-panel"));
      const side = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-side"));
      const content = document.querySelector(".content");
      const outlet = document.querySelector(".content > openclaw-router-outlet");
      const tasksPage = document.querySelector("openclaw-tasks-page");
      const assetRow = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-asset-row"));
      const drop = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-drop"));
      const progress = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-progress"));
      const updateBanners = allNodes().filter((node) => node instanceof HTMLElement && node.classList.contains("update-banner"));
      const activeTypes = typeCards
        .filter((node) => node.classList.contains("is-active"))
        .map((node) => (node.innerText || node.textContent || "").replace(/\\s+/g, " ").trim());
      const primaryActionButton = allNodes().find(
        (node) =>
          node instanceof HTMLButtonElement &&
          ["创建生成任务", "任务已创建", "重新创建此任务", "创建新任务"].some((text) => (node.innerText || node.textContent || "").includes(text)),
      );
      const logExportButton = allNodes().find((node) => node instanceof HTMLButtonElement && node.classList.contains("uclaw-ecommerce-log-button"));
      const packageButton = allNodes().find((node) => node instanceof HTMLButtonElement && (node.innerText || node.textContent || "").includes("打包下载"));
      const openLocalButtons = allNodes().filter((node) => node instanceof HTMLButtonElement && node.getAttribute("aria-label") === "打开文件夹");
      const deleteRecordButtons = allNodes().filter((node) => node instanceof HTMLButtonElement && node.classList.contains("uclaw-ecommerce-record-delete"));
      const recordIconButtons = allNodes().filter((node) => node instanceof HTMLButtonElement && node.classList.contains("uclaw-ecommerce-icon-button"));
      const openSessionButton = allNodes().find((node) => node instanceof HTMLButtonElement && (node.innerText || node.textContent || "").includes("打开会话"));
      const carousel = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-generated-grid"));
      const warningBubble = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-warning-bubble"));
      const carouselStyle = carousel ? getComputedStyle(carousel) : null;
      const request = window.__uclawEcommerceRequests?.[0] || null;
      const progressEvents = window.__uclawEcommerceProgressEvents || [];
      const rect = workbench?.getBoundingClientRect();
      const countRects = countControls.map((node) => {
        const rect = node.getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height) };
      });
      const typeRects = typeCards.map((node) => {
        const rect = node.getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height) };
      });
      const recordIconButtonRects = recordIconButtons.map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          label: node.getAttribute("aria-label") || "",
          title: node.getAttribute("title") || "",
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      });
      const elementRect = (node) => {
        const rect = node?.getBoundingClientRect?.();
        return rect ? { width: Math.round(rect.width), height: Math.round(rect.height), x: Math.round(rect.x), y: Math.round(rect.y) } : null;
      };
      const visibleStats = stats.filter((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
      const visibleUpdateBanners = updateBanners.filter((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
      return {
        hasWorkbench: Boolean(workbench),
        platform: workbench?.getAttribute("data-uclaw-ecommerce-platform") || "",
        language: workbench?.getAttribute("data-uclaw-ecommerce-language") || "",
        visualStyle: workbench?.getAttribute("data-uclaw-ecommerce-visual-style") || "",
        aspectRatio: workbench?.getAttribute("data-uclaw-ecommerce-aspect-ratio") || "",
        workbenchRect: elementRect(workbench),
        contentRect: elementRect(content),
        outletRect: elementRect(outlet),
        tasksPageRect: elementRect(tasksPage),
        layoutRect: elementRect(layout),
        panelRect: elementRect(panel),
        sideRect: elementRect(side),
        assetRowRect: elementRect(assetRow),
        dropRect: elementRect(drop),
        progressRect: elementRect(progress),
        assetRowColumns: assetRow ? getComputedStyle(assetRow).gridTemplateColumns : "",
        layoutColumns: layout ? getComputedStyle(layout).gridTemplateColumns : "",
        visibleStatCount: visibleStats.length,
        visibleUpdateBannerCount: visibleUpdateBanners.length,
        fileCount: files.length,
        productNameValue: inputs.find((node) => node.placeholder === "如：便携榨汁杯")?.value || "",
        categoryValue: inputs.find((node) => node.placeholder === "如：厨房小电")?.value || "",
        audienceValue: inputs.find((node) => node.placeholder === "默认可不填")?.value || "",
        sellingPointsValue: textarea?.value || "",
        draftAfterTaskCreated: JSON.parse(localStorage.getItem("uclaw.ecommerceWorkbench.draft.v1") || "null"),
        draftFileCountAfterTaskCreated: Array.isArray(window.__uclawEcommerceDraftFiles) ? window.__uclawEcommerceDraftFiles.length : -1,
        generatedCount: generatedCards.length,
        generatedImageCount: generatedImages.length,
        featuredRect: elementRect(featured),
        featuredPreviewRect: elementRect(featuredPreview),
        featuredImageRect: elementRect(featuredImage),
        featuredTitle: (featuredTitle?.innerText || featuredTitle?.textContent || "").trim(),
        selectedGeneratedIndex: selectedGenerated ? generatedCards.indexOf(selectedGenerated) : -1,
        selectedGeneratedTitle: selectedGenerated
          ? (selectedGenerated.querySelector("strong")?.innerText || selectedGenerated.querySelector("strong")?.textContent || "").trim()
          : "",
        resultBodyRect: elementRect(resultBody),
        resultStripRect: elementRect(resultStrip),
        qaCount: qaChips.length,
        recordCount: recordRows.length,
        recordTexts,
        typeCardCount: typeCards.length,
        countRects,
        typeRects,
        activeTypes,
        primaryActionLabel: (primaryActionButton?.innerText || primaryActionButton?.textContent || "").trim(),
        primaryActionDisabled: Boolean(primaryActionButton?.disabled),
        hasLogExportButton: Boolean(logExportButton),
        logExportButtonLabel: logExportButton?.getAttribute("aria-label") || "",
        logExportButtonTitle: logExportButton?.getAttribute("title") || "",
        hasPackageButton: Boolean(packageButton),
        hasWarningBubble: Boolean(warningBubble),
        warningBubbleText: (warningBubble?.innerText || warningBubble?.textContent || "").trim(),
        warningBubbleTitle: warningBubble?.getAttribute("title") || "",
        openLocalButtonCount: openLocalButtons.length,
        deleteRecordButtonCount: deleteRecordButtons.length,
        recordIconButtonRects,
        openLocalPathCalls: window.__uclawEcommerceOpenLocalPathCalls || [],
        hasOpenSessionButton: Boolean(openSessionButton),
        carouselDisplay: carouselStyle?.display || "",
        carouselOverflowX: carouselStyle?.overflowX || "",
        carouselSnapType: carouselStyle?.scrollSnapType || "",
        carouselClientWidth: carousel?.clientWidth || 0,
        carouselScrollWidth: carousel?.scrollWidth || 0,
        request,
        requestCount: window.__uclawEcommerceRequests?.length || 0,
        progressEventCount: progressEvents.length,
        firstProgressStatus: progressEvents[0]?.status || "",
        progressListenerCount: window.__uclawEcommerceProgressListeners?.length ?? -1,
        sawIncrementalResult: Boolean(window.__uclawEcommerceSawIncrementalResult),
        fullTextIncludesUploadShortcuts: (workbench?.innerText || workbench?.textContent || "").includes("选择/拖拽/粘贴图片"),
        fullTextIncludesIncrementalProgress: (workbench?.innerText || workbench?.textContent || "").includes("出一张显示一张"),
        fullTextIncludesThumbnailPreview: (workbench?.innerText || workbench?.textContent || "").includes("点击预览"),
        fullTextIncludesLocalSaved: (workbench?.innerText || workbench?.textContent || "").includes("已保存本地"),
        fullTextIncludesDetailSeriesCount: (workbench?.innerText || workbench?.textContent || "").includes("详情图6屏"),
        finalTextIncludesGeneratingStatus: /正在生成|生成中/.test(workbench?.innerText || workbench?.textContent || ""),
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        width: rect?.width || 0,
        height: rect?.height || 0,
        text: (workbench?.innerText || workbench?.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 800),
      };
    `,
  );
}

/**
 * Runs connected browser acceptance against a live Gateway dashboard.
 */
async function runAcceptance(options) {
  const { chromium } = loadPlaywright();
  const gatewayUrl = normalizeGatewayUrl(options.gatewayUrl);
  const gatewayWebSocketUrl = toGatewayWebSocketUrl(gatewayUrl);
  const token = getGatewayToken(readConfig(options.configPath));
  const imagePath = writeImageFixture();
  const errors = [];
  const viewports = [
    { name: "ultrawide", width: 2560, height: 1410 },
    { name: "design", width: 1440, height: 1024 },
    { name: "desktop", width: 1280, height: 980 },
    { name: "mobile", width: 390, height: 844 },
  ];
  const results = [];

  let browser;

  try {
    browser = await chromium.launch({
      headless: !options.headful,
      executablePath: fs.existsSync(options.chromePath) ? options.chromePath : undefined,
    });

    for (const viewport of viewports) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(`${viewport.name}: ${message.text()}`);
      });
      page.on("pageerror", (error) => errors.push(`${viewport.name}: ${error.message}`));

      await ensureConnected(page, gatewayUrl, gatewayWebSocketUrl, token);
      await verifyPartialRecordStatus(page);
      await installDirectImageApiStub(page);
      await verifyRecordPagination(page);
      await installDirectImageApiStub(page);
      await verifyLocalManifestAutoImport(page);
      await installDirectImageApiStub(page);
      await verifyLocalManifestReplacesStalePartialRecord(page);
      await installDirectImageApiStub(page);
      await verifyUsageSyncRetry(page);
      await installDirectImageApiStub(page);
      await verifyLocalPathOnlyRecordHydration(page);
      const state = await exerciseWorkbench(page, imagePath);

      if (!state.hasWorkbench) throw new Error(`${viewport.name}: Workbench host missing`);
      if (state.visibleUpdateBannerCount !== 0) {
        throw new Error(`${viewport.name}: Ecommerce page should not be pushed down by update banner`);
      }
      if (viewport.name === "design") {
        if (state.visibleStatCount !== 3) throw new Error(`${viewport.name}: Expected three hero stats, got ${state.visibleStatCount}`);
        if (state.workbenchRect.width < 1120 || state.workbenchRect.width > 1140) {
          throw new Error(`${viewport.name}: Workbench should match design canvas width, got ${JSON.stringify(state.workbenchRect)}`);
        }
        if (state.sideRect.width < 410 || state.sideRect.width > 430) {
          throw new Error(`${viewport.name}: Results rail should stay near the large-screen grid width, got ${JSON.stringify(state.sideRect)}`);
        }
        const firstRowTops = new Set(state.typeRects.map((rect) => rect.y).slice(0, 3));
        if (firstRowTops.size !== 1) {
          throw new Error(`${viewport.name}: Three type cards should sit on one row, got ${JSON.stringify(state.typeRects)}`);
        }
      }
      if (viewport.name === "ultrawide") {
        if (state.contentRect.width < 2300 || state.outletRect.width < 2140 || state.tasksPageRect.width < 2140) {
          throw new Error(`${viewport.name}: Route hosts should stretch across large screen, got ${JSON.stringify({
            content: state.contentRect,
            outlet: state.outletRect,
            tasksPage: state.tasksPageRect,
          })}`);
        }
        if (state.workbenchRect.width < 1740 || state.workbenchRect.width > 1900 || state.layoutRect.width < 1740 || state.layoutRect.width > 1900) {
          throw new Error(`${viewport.name}: Workbench should stay dense on ultrawide screens, got ${JSON.stringify({
            workbench: state.workbenchRect,
            layout: state.layoutRect,
          })}`);
        }
        if (state.sideRect.width < 620 || state.sideRect.width > 760) {
          throw new Error(`${viewport.name}: Result rail should grow without oversized zoom feel, got ${JSON.stringify(state.sideRect)}`);
        }
      }
      if (state.platform !== "amazon") throw new Error(`${viewport.name}: Platform did not switch to amazon: ${state.platform}`);
      if (state.language !== "en") throw new Error(`${viewport.name}: Amazon should default image language to English, got ${state.language}`);
      if (state.visualStyle !== "auto") throw new Error(`${viewport.name}: Created task should reset visual style to default, got ${state.visualStyle}`);
      if (state.aspectRatio !== "auto") throw new Error(`${viewport.name}: Created task should reset aspect ratio to default, got ${state.aspectRatio}`);
      if (state.fileCount !== 0) throw new Error(`${viewport.name}: Created task should clear selected image files, got ${state.fileCount}`);
      if (
        state.productNameValue ||
        state.categoryValue ||
        state.audienceValue ||
        state.sellingPointsValue ||
        state.draftAfterTaskCreated !== null ||
        state.draftFileCountAfterTaskCreated !== 0
      ) {
        throw new Error(`${viewport.name}: Created task should clear current form and draft, got ${JSON.stringify({
          productName: state.productNameValue,
          category: state.categoryValue,
          audience: state.audienceValue,
          sellingPoints: state.sellingPointsValue,
          draft: state.draftAfterTaskCreated,
          draftFiles: state.draftFileCountAfterTaskCreated,
        })}`);
      }
      if (!state.dropRect) throw new Error(`${viewport.name}: Upload drop target missing`);
      if (viewport.name === "design") {
        if (state.dropRect.width < 160 || state.dropRect.width > 180) {
          throw new Error(`${viewport.name}: Upload drop target should match design width, got ${JSON.stringify(state.dropRect)}`);
        }
      }
      if (state.typeCardCount !== 3) throw new Error(`${viewport.name}: Expected three output type cards, got ${state.typeCardCount}`);
      const countMaxWidth = viewport.name === "mobile" ? 74 : 82;
      if (!state.countRects?.length || state.countRects.some((rect) => rect.width > countMaxWidth)) {
        throw new Error(`${viewport.name}: Count selector should stay compact, got ${JSON.stringify(state.countRects)}`);
      }
      if (viewport.name === "mobile" && state.typeRects?.some((rect) => rect.width > viewport.width - 48)) {
        throw new Error(`${viewport.name}: Type cards should fit mobile viewport, got ${JSON.stringify(state.typeRects)}`);
      }
      if (state.generatedCount < 10) throw new Error(`${viewport.name}: Progress images must survive final response merge, got ${state.generatedCount}`);
      if (state.generatedImageCount < 10) {
        throw new Error(`${viewport.name}: Expected generated image previews, got ${state.generatedImageCount}`);
      }
      if (!state.featuredRect || !state.featuredImageRect) {
        throw new Error(`${viewport.name}: Featured result preview missing`);
      }
      if (!state.featuredPreviewRect) {
        throw new Error(`${viewport.name}: Featured image should expose clickable zoom preview`);
      }
      if (!state.resultBodyRect || !state.resultStripRect) {
        throw new Error(`${viewport.name}: Result preview should be split into featured and carousel sections`);
      }
      if (!state.sawIncrementalResult) {
        throw new Error(`${viewport.name}: First generated image should render before final batch resolves`);
      }
      if (viewport.name === "design" && state.featuredImageRect.height < 250) {
        throw new Error(`${viewport.name}: Featured result image should be near design height, got ${JSON.stringify(state.featuredImageRect)}`);
      }
      if (state.qaCount < 4) throw new Error(`${viewport.name}: Expected QA chips, got ${state.qaCount}`);
      if (state.recordCount < 1) throw new Error(`${viewport.name}: Expected one generation record, got ${state.recordCount}`);
      if (!state.recordTexts.some((text) => text.includes("扣费异常"))) {
        throw new Error(`${viewport.name}: Billing failure should be visible in generation record, got ${JSON.stringify(state.recordTexts)}`);
      }
      if (!state.recordTexts.some((text) => text.includes("计划 10 张/屏") && text.includes("已出 10 张"))) {
        throw new Error(`${viewport.name}: Generation record should separate planned and generated counts, got ${JSON.stringify(state.recordTexts)}`);
      }
      if (!state.primaryActionDisabled || state.primaryActionLabel !== "创建生成任务" || !state.text.includes("还需：商品图片")) {
        throw new Error(`${viewport.name}: Created task should reset the form to a disabled fresh-create state, got ${JSON.stringify({
          label: state.primaryActionLabel,
          disabled: state.primaryActionDisabled,
          text: state.text,
        })}`);
      }
      if (state.hasPackageButton) throw new Error(`${viewport.name}: Package download should be hidden when local folder is available`);
      if (!state.hasLogExportButton || state.logExportButtonLabel !== "导出日志" || state.logExportButtonTitle !== "导出日志") {
        throw new Error(`${viewport.name}: Compact log export icon missing after generation, got ${JSON.stringify({
          hasLogExportButton: state.hasLogExportButton,
          label: state.logExportButtonLabel,
          title: state.logExportButtonTitle,
        })}`);
      }
      if (!state.hasWarningBubble || !state.warningBubbleText.includes("用量同步待处理")) {
        throw new Error(`${viewport.name}: Warning should render as compact bubble, got ${JSON.stringify({
          hasWarningBubble: state.hasWarningBubble,
          warningBubbleText: state.warningBubbleText,
        })}`);
      }
      if (state.openLocalButtonCount < 1) throw new Error(`${viewport.name}: Open local folder button missing after generation`);
      if (!state.fullTextIncludesLocalSaved) throw new Error(`${viewport.name}: Local saved state missing`);
      if (state.deleteRecordButtonCount < 1) throw new Error(`${viewport.name}: Delete record button missing`);
      if (!state.recordIconButtonRects?.length || state.recordIconButtonRects.some((rect) => rect.width > 38 || rect.height > 38)) {
        throw new Error(`${viewport.name}: Record actions should render as compact icon buttons, got ${JSON.stringify(state.recordIconButtonRects)}`);
      }
      for (const label of ["查看结果", "导出日志", "打开文件夹", "删除记录"]) {
        if (!state.recordIconButtonRects.some((rect) => rect.label === label && rect.title === label)) {
          throw new Error(`${viewport.name}: Missing compact record action ${label}, got ${JSON.stringify(state.recordIconButtonRects)}`);
        }
      }
      if (state.hasOpenSessionButton) throw new Error(`${viewport.name}: Open session button must not appear`);
      if (state.carouselDisplay !== "flex") throw new Error(`${viewport.name}: Generated list should be flex carousel`);
      if (!["auto", "scroll"].includes(state.carouselOverflowX)) {
        throw new Error(`${viewport.name}: Generated list should scroll horizontally, got ${state.carouselOverflowX}`);
      }
      if (!state.carouselSnapType.includes("x")) {
        throw new Error(`${viewport.name}: Generated list should use x scroll snap, got ${state.carouselSnapType}`);
      }
      if (state.carouselScrollWidth <= state.carouselClientWidth) {
        throw new Error(`${viewport.name}: Generated carousel should overflow inside its own scroller`);
      }
      if (state.request?.method !== "uclaw:ecommerce-generate-images") {
        throw new Error(`${viewport.name}: direct ecommerce image IPC was not called`);
      }
      if (state.progressEventCount < 10 || state.firstProgressStatus !== "completed") {
        throw new Error(`${viewport.name}: incremental image progress did not fire correctly`);
      }
      if (state.progressListenerCount !== 0) {
        throw new Error(`${viewport.name}: ecommerce progress listener should be cleaned up, got ${state.progressListenerCount}`);
      }
      if (state.finalTextIncludesGeneratingStatus) {
        throw new Error(`${viewport.name}: Finished ecommerce result must not keep generating status`);
      }
      if (state.request?.payload?.imageCount !== 2) {
        throw new Error(`${viewport.name}: Expected two direct image payloads after paste, got ${state.request?.payload?.imageCount}`);
      }
      if (state.request?.payload?.language?.id !== "en") {
        throw new Error(`${viewport.name}: Expected direct payload language en, got ${JSON.stringify(state.request?.payload?.language)}`);
      }
      if (state.request?.payload?.visualStyle?.id !== "lifestyle_scene") {
        throw new Error(`${viewport.name}: Expected direct payload visual style lifestyle_scene, got ${JSON.stringify(state.request?.payload?.visualStyle)}`);
      }
      if (state.request?.payload?.aspectRatio?.id !== "ratio_3_4") {
        throw new Error(`${viewport.name}: Expected direct payload aspect ratio ratio_3_4, got ${JSON.stringify(state.request?.payload?.aspectRatio)}`);
      }
      if (!state.request?.payload?.outputTypes?.includes("model_image")) {
        throw new Error(`${viewport.name}: Expected direct payload to request model_image`);
      }
      if (state.request?.payload?.outputCounts?.main_image !== 3) {
        throw new Error(`${viewport.name}: Expected main_image count 3`);
      }
      if (state.request?.payload?.outputCounts?.detail_image !== 6) {
        throw new Error(`${viewport.name}: Expected detail_image count 6`);
      }
      if (state.request?.payload?.outputCounts?.model_image !== 1) {
        throw new Error(`${viewport.name}: Expected model_image count 1`);
      }
      await page.locator("openclaw-tasks-page input[placeholder='如：便携榨汁杯']").fill("二次创建杯");
      await page.locator("openclaw-tasks-page textarea").fill("重新填写卖点");
      await page.locator("openclaw-tasks-page input[type='file']").setInputFiles(imagePath);
      await waitForText(page, "1 张已选择", 10000);
      await page.waitForFunction(() => {
        const button = [...document.querySelectorAll("openclaw-tasks-page button")].find((node) =>
          (node.innerText || node.textContent || "").includes("创建生成任务"),
        );
        return button instanceof HTMLButtonElement && !button.disabled;
      });
      await page.locator("openclaw-tasks-page button").filter({ hasText: "创建生成任务" }).click();
      await page.waitForFunction(() => {
        const visit = (root = document, out = []) => {
          for (const child of root.children || []) {
            out.push(child);
            if (child.shadowRoot) visit(child.shadowRoot, out);
            visit(child, out);
          }
          return out;
        };
        const button = visit().find((node) => node instanceof HTMLButtonElement && (node.innerText || node.textContent || "").includes("任务已创建"));
        return (window.__uclawEcommerceRequests?.length || 0) >= 2 && button instanceof HTMLButtonElement && button.disabled;
      });
      await waitForText(page, "创建生成任务", 10000);
      if (!state.text.includes("最长边建议 1600px")) throw new Error(`${viewport.name}: Amazon preset text missing`);
      if (!state.text.includes("模特图")) throw new Error(`${viewport.name}: Model image text missing`);
      if (!state.text.includes("图片语言")) throw new Error(`${viewport.name}: Image language selector text missing`);
      if (!state.text.includes("English")) throw new Error(`${viewport.name}: English language text missing`);
      if (!state.text.includes("图片风格")) throw new Error(`${viewport.name}: Image style selector text missing`);
      if (!state.text.includes("生活方式")) throw new Error(`${viewport.name}: Lifestyle style text missing`);
      if (!state.text.includes("图片比例")) throw new Error(`${viewport.name}: Image ratio selector text missing`);
      if (!state.text.includes("3:4 竖图")) throw new Error(`${viewport.name}: 3:4 ratio text missing`);
      if (!state.fullTextIncludesThumbnailPreview) throw new Error(`${viewport.name}: Thumbnail preview affordance missing`);
      if (!state.fullTextIncludesUploadShortcuts) throw new Error(`${viewport.name}: Drag and paste upload affordance missing`);
      if (!state.fullTextIncludesIncrementalProgress && !state.sawIncrementalResult) {
        throw new Error(`${viewport.name}: Incremental progress text missing`);
      }
      if (state.scrollWidth > state.viewportWidth + 4) {
        throw new Error(`${viewport.name}: horizontal overflow ${state.scrollWidth} > ${state.viewportWidth}`);
      }

      await verifyGeneratedRecordPersistsViaLocalPath(page, viewport.name);

      const [logDownload] = await Promise.all([
        page.waitForEvent("download", { timeout: 10000 }),
        page.locator("openclaw-tasks-page button.uclaw-ecommerce-log-button").click(),
      ]);
      const logFilename = logDownload.suggestedFilename();
      if (!logFilename.endsWith(".json") || !logFilename.includes("生成日志")) {
        throw new Error(`${viewport.name}: Expected ecommerce JSON log download, got ${logFilename}`);
      }
      await logDownload.cancel().catch(() => {});
      const downloadEvents = [];
      page.on("download", (download) => downloadEvents.push(download.suggestedFilename()));
      await page.locator("openclaw-tasks-page .uclaw-ecommerce-generated").nth(1).click();
      await waitForText(page, "主图2张", 5000);
      const previewState = await evaluateInDom(
        page,
        `
          const cards = allNodes().filter((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-generated"));
          const selected = cards.find((node) => node.classList.contains("is-selected"));
          const featuredTitle = allNodes().find((node) => node instanceof HTMLElement && node.matches(".uclaw-ecommerce-featured strong"));
          return {
            selectedIndex: selected ? cards.indexOf(selected) : -1,
            selectedTitle: selected ? (selected.querySelector("strong")?.innerText || selected.querySelector("strong")?.textContent || "").trim() : "",
            featuredTitle: (featuredTitle?.innerText || featuredTitle?.textContent || "").trim(),
          };
        `,
      );
      await page.waitForTimeout(500);
      if (previewState.selectedIndex !== 1 || previewState.featuredTitle !== "主图2张") {
        throw new Error(`${viewport.name}: Thumbnail click should select featured preview, got ${JSON.stringify(previewState)}`);
      }
      const imageDownloads = downloadEvents.filter((name) => /\.(png|jpg|jpeg|webp|svg)$/i.test(name));
      if (imageDownloads.length > 0) {
        throw new Error(`${viewport.name}: Thumbnail click must not download images, got ${imageDownloads.join(", ")}`);
      }
      await page.locator("openclaw-tasks-page .uclaw-ecommerce-featured-preview").click();
      await page.waitForSelector("openclaw-tasks-page .uclaw-ecommerce-swiper", { timeout: 5000 });
      let swiperState = await evaluateInDom(
        page,
        `
          const swiper = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-swiper"));
          const title = allNodes().find((node) => node instanceof HTMLElement && node.matches(".uclaw-ecommerce-swiper-stage figure strong"));
          const selectedThumb = allNodes().find((node) => node instanceof HTMLElement && node.matches(".uclaw-ecommerce-swiper-strip .is-selected"));
          return {
            open: Boolean(swiper),
            title: (title?.innerText || title?.textContent || "").trim(),
            selectedIndex: selectedThumb ? [...selectedThumb.parentElement.children].indexOf(selectedThumb) : -1,
          };
        `,
      );
      if (!swiperState.open || swiperState.title !== "主图2张" || swiperState.selectedIndex !== 1) {
        throw new Error(`${viewport.name}: Featured click should open swiper preview at selected image, got ${JSON.stringify(swiperState)}`);
      }
      await page.locator("openclaw-tasks-page .uclaw-ecommerce-swiper-nav.is-next").click();
      await waitForText(page, "主图3张", 5000);
      swiperState = await evaluateInDom(
        page,
        `
          const title = allNodes().find((node) => node instanceof HTMLElement && node.matches(".uclaw-ecommerce-swiper-stage figure strong"));
          const selectedThumb = allNodes().find((node) => node instanceof HTMLElement && node.matches(".uclaw-ecommerce-swiper-strip .is-selected"));
          return {
            title: (title?.innerText || title?.textContent || "").trim(),
            selectedIndex: selectedThumb ? [...selectedThumb.parentElement.children].indexOf(selectedThumb) : -1,
          };
        `,
      );
      if (swiperState.title !== "主图3张" || swiperState.selectedIndex !== 2) {
        throw new Error(`${viewport.name}: Swiper next should move to next image, got ${JSON.stringify(swiperState)}`);
      }
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector("openclaw-tasks-page .uclaw-ecommerce-swiper"), null, {
        timeout: 5000,
      });
      if (downloadEvents.filter((name) => /\.(png|jpg|jpeg|webp|svg)$/i.test(name)).length > 0) {
        throw new Error(`${viewport.name}: Opening swiper must not download images`);
      }
      const [featuredDownload] = await Promise.all([
        page.waitForEvent("download", { timeout: 10000 }),
        page.locator("openclaw-tasks-page .uclaw-ecommerce-featured button").filter({ hasText: "下载" }).click(),
      ]);
      const featuredFilename = featuredDownload.suggestedFilename();
      if (!/03-.*\.(png|jpg|jpeg|webp)$/i.test(featuredFilename)) {
        throw new Error(`${viewport.name}: Expected selected featured image download, got ${featuredFilename}`);
      }
      await featuredDownload.cancel().catch(() => {});
      await evaluateInDom(
        page,
        `
          const buttons = allNodes().filter((node) => node instanceof HTMLButtonElement && node.getAttribute("aria-label") === "打开文件夹");
          const visible = buttons.find((node) => {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          });
          if (!visible) throw new Error("No visible open-local button");
          visible.click();
          return true;
        `,
      );
      const openLocalState = await page.evaluate(() => window.__uclawEcommerceOpenLocalPathCalls || []);
      if (!openLocalState.some((payload) => String(payload?.path || "").includes("/tmp/uclaw-ecommerce-fixture"))) {
        throw new Error(`${viewport.name}: Open local folder did not call desktop API, got ${JSON.stringify(openLocalState)}`);
      }
      await evaluateInDom(
        page,
        `
          const buttons = allNodes().filter((node) => node instanceof HTMLButtonElement && node.classList.contains("uclaw-ecommerce-record-delete"));
          if (!buttons.length) throw new Error("No delete record button");
          for (const button of buttons) button.click();
          return buttons.length;
        `,
      );
      await page.waitForFunction(() => {
        const visit = (root = document, out = []) => {
          for (const child of root.children || []) {
            out.push(child);
            if (child.shadowRoot) visit(child.shadowRoot, out);
            visit(child, out);
          }
          return out;
        };
        return visit().filter((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-record")).length === 0;
      }, null, { timeout: 5000 });
      await page
        .evaluate(() => {
          window.scrollTo({ top: 0, left: 0, behavior: "auto" });
          for (const node of document.querySelectorAll(".content, openclaw-router-outlet")) {
            if (node instanceof HTMLElement) {
              node.scrollTop = 0;
              node.scrollLeft = 0;
            }
          }
        })
        .catch(() => {});
      await page.waitForTimeout(100);

      fs.mkdirSync(screenshotsDir, { recursive: true });
      const screenshot = path.join(screenshotsDir, `ecommerce-workbench-ui-${viewport.name}.png`);
      await page.screenshot({ path: screenshot, fullPage: false });
      await page.close();
      results.push({ viewport: viewport.name, screenshot, state });
    }

    if (errors.length > 0) throw new Error(`Browser errors: ${errors.join(" | ")}`);

    console.log(JSON.stringify({ ok: true, step: "ecommerce_workbench_ui", results }, null, 2));
  } finally {
    try {
      fs.unlinkSync(imagePath);
    } catch {}
    await browser?.close();
  }
}

/**
 * CLI entrypoint.
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  await runAcceptance(options);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
