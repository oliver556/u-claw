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
  return page.evaluate(
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
    lastText = await getVisibleText(page);
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
  await waitForText(page, "生成预案", 30000);
  await waitForTasksRouteSettled(page);

  await page.locator("openclaw-tasks-page select").first().selectOption("amazon");
  await page.locator("openclaw-tasks-page input[placeholder='如：便携榨汁杯']").fill("便携榨汁杯");
  await page.locator("openclaw-tasks-page input[placeholder='如：厨房小电']").fill("厨房小电");
  await page.locator("openclaw-tasks-page input[placeholder='默认可不填']").fill("通勤白领");
  await page.locator("openclaw-tasks-page textarea").fill("一杯鲜榨\n可拆洗杯体\nUSB-C 充电");
  await page.locator("openclaw-tasks-page input[type='file']").setInputFiles(imagePath);
  await waitForText(page, "1 张已选择", 10000);
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("openclaw-tasks-page button")].find((node) =>
      (node.innerText || node.textContent || "").includes("生成预案"),
    );
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  await page.locator("openclaw-tasks-page button").filter({ hasText: "生成预案" }).click();
  await waitForText(page, "Amazon 输出预案", 10000);

  return evaluateInDom(
    page,
    `
      const workbench = allNodes().find((node) => node instanceof HTMLElement && node.getAttribute("data-uclaw-ecommerce-workbench") === "direct-output");
      const files = allNodes().filter((node) => node instanceof HTMLElement && node.classList.contains("uclaw-ecommerce-file"));
      const outputCards = allNodes().filter((node) => node instanceof HTMLElement && node.matches(".uclaw-ecommerce-output-grid article"));
      const qaChips = allNodes().filter((node) => node instanceof HTMLElement && node.matches(".uclaw-ecommerce-qa span"));
      const generateButton = allNodes().find((node) => node instanceof HTMLButtonElement && (node.innerText || node.textContent || "").includes("生成预案"));
      const manifestButton = allNodes().find((node) => node instanceof HTMLButtonElement && (node.innerText || node.textContent || "").includes("复制 Manifest"));
      const rect = workbench?.getBoundingClientRect();
      return {
        hasWorkbench: Boolean(workbench),
        platform: workbench?.getAttribute("data-uclaw-ecommerce-platform") || "",
        fileCount: files.length,
        outputCount: outputCards.length,
        qaCount: qaChips.length,
        generateDisabled: Boolean(generateButton?.disabled),
        hasManifestButton: Boolean(manifestButton),
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
      if (state.platform !== "amazon") throw new Error(`${viewport.name}: Platform did not switch to amazon: ${state.platform}`);
      if (state.fileCount !== 1) throw new Error(`${viewport.name}: Expected one uploaded preview, got ${state.fileCount}`);
      if (state.outputCount < 2) throw new Error(`${viewport.name}: Expected output manifest cards, got ${state.outputCount}`);
      if (state.qaCount < 4) throw new Error(`${viewport.name}: Expected QA chips, got ${state.qaCount}`);
      if (state.generateDisabled) throw new Error(`${viewport.name}: Generate button stayed disabled after valid input`);
      if (!state.hasManifestButton) throw new Error(`${viewport.name}: Manifest copy button missing after generation`);
      if (!state.text.includes("最长边建议 1600px")) throw new Error(`${viewport.name}: Amazon preset text missing`);
      if (state.scrollWidth > state.viewportWidth + 4) {
        throw new Error(`${viewport.name}: horizontal overflow ${state.scrollWidth} > ${state.viewportWidth}`);
      }

      fs.mkdirSync(screenshotsDir, { recursive: true });
      const screenshot = path.join(screenshotsDir, `ecommerce-workbench-ui-${viewport.name}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
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
