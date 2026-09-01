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
        const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAA7klEQVR4nO3RAQ0AAAjDMO5fNCCDkC5z0F0l2wFghBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBCEEIQQhBD+BjNRAAHIph80AAAAAElFTkSuQmCC";
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
              }));
            });
            window.__uclawEcommerceRequests.push({
              method: "uclaw:ecommerce-generate-images",
              payload: {
                platform: payload?.manifest?.platform,
                productName: payload?.manifest?.name,
                language: payload?.manifest?.language,
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
            return {
              ok: true,
              requestId,
              provider: "newapi",
              model: "gpt-image-2",
              generatedAt: new Date().toISOString(),
              warnings: [],
              images,
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
          materializeEcommerceImage: async (payload) => ({ ok: true, image: payload }),
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
 * Simulates leaving Workflows for Models and coming back, then verifies draft
 * cache restores user input without forcing a generation first.
 */
async function verifyDraftSurvivesRouteSwitch(page) {
  await page.evaluate(() => {
    window.__uclawEcommerceDraftBeforeRouteSwitch = JSON.parse(
      localStorage.getItem("uclaw.ecommerceWorkbench.draft.v1") || "null",
    );
    window.history.pushState({}, "", "/settings/ai-agents");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.waitForFunction(() => !document.querySelector("openclaw-tasks-page"), null, { timeout: 10000 });
  await page.evaluate(() => {
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
  await waitForText(page, "生成图片", 30000);
  await waitForTasksRouteSettled(page);
  await installDirectImageApiStub(page);

  await page.locator("openclaw-tasks-page select").first().selectOption("amazon");
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
      (node.innerText || node.textContent || "").includes("生成图片"),
    );
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  await page.locator("openclaw-tasks-page button").filter({ hasText: "生成图片" }).click();
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
  await waitForText(page, "查看结果", 10000);

  return evaluateInDom(
    page,
    `
      const workbench = allNodes().find((node) => node instanceof HTMLElement && node.getAttribute("data-uclaw-ecommerce-workbench") === "direct-output");
      const files = allNodes().filter((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-file"));
      const generatedCards = allNodes().filter((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-generated"));
      const generatedImages = allNodes().filter((node) => node instanceof HTMLImageElement && node.closest(".uclaw-ecommerce-generated"));
      const featured = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-featured"));
      const featuredImage = allNodes().find((node) => node instanceof HTMLImageElement && node.closest(".uclaw-ecommerce-featured"));
      const featuredTitle = allNodes().find((node) => node instanceof HTMLElement && node.matches(".uclaw-ecommerce-featured strong"));
      const selectedGenerated = generatedCards.find((node) => node.classList.contains("is-selected"));
      const resultBody = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-result-body"));
      const resultStrip = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-result-strip"));
      const qaChips = allNodes().filter((node) => node instanceof HTMLElement && node.matches(".uclaw-ecommerce-qa span"));
      const recordRows = allNodes().filter((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-record"));
      const typeCards = allNodes().filter((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-type"));
      const countControls = allNodes().filter((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-count"));
      const stats = allNodes().filter((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-stat"));
      const layout = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-layout"));
      const panel = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-panel"));
      const side = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-side"));
      const assetRow = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-asset-row"));
      const drop = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-drop"));
      const progress = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-progress"));
      const updateBanners = allNodes().filter((node) => node instanceof HTMLElement && node.classList.contains("update-banner"));
      const activeTypes = typeCards
        .filter((node) => node.classList.contains("is-active"))
        .map((node) => (node.innerText || node.textContent || "").replace(/\\s+/g, " ").trim());
      const generateButton = allNodes().find((node) => node instanceof HTMLButtonElement && (node.innerText || node.textContent || "").includes("生成图片"));
      const manifestButton = allNodes().find((node) => node instanceof HTMLButtonElement && (node.innerText || node.textContent || "").includes("复制 Manifest"));
      const packageButton = allNodes().find((node) => node instanceof HTMLButtonElement && (node.innerText || node.textContent || "").includes("打包下载"));
      const openSessionButton = allNodes().find((node) => node instanceof HTMLButtonElement && (node.innerText || node.textContent || "").includes("打开会话"));
      const carousel = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-generated-grid"));
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
        workbenchRect: elementRect(workbench),
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
        generatedCount: generatedCards.length,
        generatedImageCount: generatedImages.length,
        featuredRect: elementRect(featured),
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
        typeCardCount: typeCards.length,
        countRects,
        typeRects,
        activeTypes,
        generateDisabled: Boolean(generateButton?.disabled),
        hasManifestButton: Boolean(manifestButton),
        hasPackageButton: Boolean(packageButton),
        hasOpenSessionButton: Boolean(openSessionButton),
        carouselDisplay: carouselStyle?.display || "",
        carouselOverflowX: carouselStyle?.overflowX || "",
        carouselSnapType: carouselStyle?.scrollSnapType || "",
        carouselClientWidth: carousel?.clientWidth || 0,
        carouselScrollWidth: carousel?.scrollWidth || 0,
        request,
        progressEventCount: progressEvents.length,
        firstProgressStatus: progressEvents[0]?.status || "",
        progressListenerCount: window.__uclawEcommerceProgressListeners?.length ?? -1,
        sawIncrementalResult: Boolean(window.__uclawEcommerceSawIncrementalResult),
        fullTextIncludesUploadShortcuts: (workbench?.innerText || workbench?.textContent || "").includes("选择/拖拽/粘贴图片"),
        fullTextIncludesIncrementalProgress: (workbench?.innerText || workbench?.textContent || "").includes("出一张显示一张"),
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
        if (state.sideRect.width < 382 || state.sideRect.width > 398) {
          throw new Error(`${viewport.name}: Results rail should stay near 390px, got ${JSON.stringify(state.sideRect)}`);
        }
        const firstRowTops = new Set(state.typeRects.map((rect) => rect.y).slice(0, 3));
        if (firstRowTops.size !== 1) {
          throw new Error(`${viewport.name}: Three type cards should sit on one row, got ${JSON.stringify(state.typeRects)}`);
        }
      }
      if (state.platform !== "amazon") throw new Error(`${viewport.name}: Platform did not switch to amazon: ${state.platform}`);
      if (state.language !== "en") throw new Error(`${viewport.name}: Amazon should default image language to English, got ${state.language}`);
      if (state.fileCount !== 2) throw new Error(`${viewport.name}: Expected file picker plus pasted preview, got ${state.fileCount}`);
      if (!state.dropRect) throw new Error(`${viewport.name}: Upload drop target missing`);
      if (viewport.name === "design") {
        if (state.dropRect.width < 160 || state.dropRect.width > 180) {
          throw new Error(`${viewport.name}: Upload drop target should match design width, got ${JSON.stringify(state.dropRect)}`);
        }
      }
      if (state.typeCardCount !== 3) throw new Error(`${viewport.name}: Expected three output type cards, got ${state.typeCardCount}`);
      if (!state.activeTypes.some((item) => item.includes("模特图"))) {
        throw new Error(`${viewport.name}: Model image type was not selected`);
      }
      const countMaxWidth = viewport.name === "mobile" ? 74 : 82;
      if (!state.countRects?.length || state.countRects.some((rect) => rect.width > countMaxWidth)) {
        throw new Error(`${viewport.name}: Count selector should stay compact, got ${JSON.stringify(state.countRects)}`);
      }
      if (viewport.name === "mobile" && state.typeRects?.some((rect) => rect.width > viewport.width - 48)) {
        throw new Error(`${viewport.name}: Type cards should fit mobile viewport, got ${JSON.stringify(state.typeRects)}`);
      }
      if (state.generatedCount < 10) throw new Error(`${viewport.name}: Expected generated image cards, got ${state.generatedCount}`);
      if (state.generatedImageCount < 10) {
        throw new Error(`${viewport.name}: Expected generated image previews, got ${state.generatedImageCount}`);
      }
      if (!state.featuredRect || !state.featuredImageRect) {
        throw new Error(`${viewport.name}: Featured result preview missing`);
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
      if (state.generateDisabled) throw new Error(`${viewport.name}: Generate button stayed disabled after valid input`);
      if (!state.hasPackageButton) throw new Error(`${viewport.name}: Package download button missing after generation`);
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
      if (state.request?.payload?.imageCount !== 2) {
        throw new Error(`${viewport.name}: Expected two direct image payloads after paste, got ${state.request?.payload?.imageCount}`);
      }
      if (state.request?.payload?.language?.id !== "en") {
        throw new Error(`${viewport.name}: Expected direct payload language en, got ${JSON.stringify(state.request?.payload?.language)}`);
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
      if (!state.text.includes("最长边建议 1600px")) throw new Error(`${viewport.name}: Amazon preset text missing`);
      if (!state.text.includes("模特图")) throw new Error(`${viewport.name}: Model image text missing`);
      if (!state.text.includes("图片语言")) throw new Error(`${viewport.name}: Image language selector text missing`);
      if (!state.text.includes("English")) throw new Error(`${viewport.name}: English language text missing`);
      if (!state.text.includes("点击预览")) throw new Error(`${viewport.name}: Thumbnail preview affordance missing`);
      if (!state.fullTextIncludesUploadShortcuts) throw new Error(`${viewport.name}: Drag and paste upload affordance missing`);
      if (!state.fullTextIncludesIncrementalProgress && !state.sawIncrementalResult) {
        throw new Error(`${viewport.name}: Incremental progress text missing`);
      }
      if (!state.text.includes("详情图6屏")) throw new Error(`${viewport.name}: Detail series count text missing`);
      if (state.scrollWidth > state.viewportWidth + 4) {
        throw new Error(`${viewport.name}: horizontal overflow ${state.scrollWidth} > ${state.viewportWidth}`);
      }

      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 10000 }),
        page.locator("openclaw-tasks-page button").filter({ hasText: "打包下载" }).click(),
      ]);
      const suggestedFilename = download.suggestedFilename();
      if (!suggestedFilename.endsWith(".zip")) {
        throw new Error(`${viewport.name}: Expected ecommerce zip download, got ${suggestedFilename}`);
      }
      await download.cancel().catch(() => {});
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
      const [featuredDownload] = await Promise.all([
        page.waitForEvent("download", { timeout: 10000 }),
        page.locator("openclaw-tasks-page .uclaw-ecommerce-featured a[download]").click(),
      ]);
      const featuredFilename = featuredDownload.suggestedFilename();
      if (!/02-.*\.(png|jpg|jpeg|webp)$/i.test(featuredFilename)) {
        throw new Error(`${viewport.name}: Expected selected featured image download, got ${featuredFilename}`);
      }
      await featuredDownload.cancel().catch(() => {});
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
