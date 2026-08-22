#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const DEFAULT_GATEWAY_URL = process.env.SKILLHUB_VERIFY_GATEWAY_URL || "http://127.0.0.1:18789/";
const DEFAULT_CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH ||
  "/Users/biancheng/Library/Application Support/u-claw/.openclaw/openclaw.json";
const DEFAULT_CHROME_PATH =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * Parses optional connected-store acceptance flags without adding package scripts.
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
 * Prints usage for the connected SkillHub store smoke test.
 */
function printUsage() {
  console.log(`Usage: node scripts/verify-skillhub-store-connected-ui.js [--gateway-url <url>] [--config <path>] [--chrome <path>] [--headful]

Runs read-only connected UI acceptance for the SkillHub store homepage, dense list, request-backed toolbar filters, load more, and search reset.

Requires playwright-core on NODE_PATH, for example:
  NODE_PATH=/Users/biancheng/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules node scripts/verify-skillhub-store-connected-ui.js`);
}

/**
 * Loads playwright-core late so syntax checks do not require browser deps.
 */
function loadPlaywright() {
  try {
    return require("playwright-core");
  } catch (error) {
    throw new Error(`playwright-core not found. Set NODE_PATH to Codex bundled node_modules. ${error.message}`);
  }
}

/**
 * Shared browser-side helper for detecting rendered UI, excluding source-bearing tags.
 */
function visibleElementHelperSource() {
  return `
    const isVisibleElement = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      if (["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(node.tagName)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
  `;
}

/**
 * Reads OpenClaw config and returns the parsed JSON.
 */
function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`OpenClaw config not found: ${configPath}`);
  }

  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

/**
 * Extracts the Gateway token without printing secret material.
 */
function getGatewayToken(config) {
  const token = config?.gateway?.auth?.token || config?.gateway?.remote?.token;
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("Gateway token missing in OpenClaw config");
  }

  return token;
}

/**
 * Normalizes Gateway URL so route URLs are predictable.
 */
function normalizeGatewayUrl(value) {
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url.toString();
}

/**
 * Converts the dashboard URL into the WebSocket URL expected by login gate.
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
 * Clicks the first visible button whose text contains the requested label.
 */
async function clickButtonText(page, label) {
  const clicked = await evaluateInDom(
    page,
    `
      for (const node of allNodes()) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.tagName !== "BUTTON") continue;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (!node.textContent?.includes(value)) continue;
        node.click();
        return true;
      }
      return false;
    `,
    label,
  );

  if (!clicked) {
    const labels = await evaluateInDom(
      page,
      `
        return allNodes()
          .filter((node) => node instanceof HTMLButtonElement)
          .map((node) => {
            const rect = node.getBoundingClientRect();
            return { text: (node.innerText || node.textContent || "").trim(), width: rect.width, height: rect.height };
          })
          .filter((entry) => entry.width > 0 && entry.height > 0)
          .slice(0, 80);
      `,
    );
    throw new Error(`Button not found: ${label}; visible buttons=${JSON.stringify(labels)}`);
  }
}

/**
 * Reads the currently visible page text through shadow roots.
 */
async function getVisibleText(page) {
  return evaluateInDom(
    page,
    `
      ${visibleElementHelperSource()}
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
  await page.waitForFunction(
    async (expected) => {
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
      const isVisibleElement = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        if (["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(node.tagName)) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      return allNodes()
        .filter(isVisibleElement)
        .some((node) => (node.innerText || node.textContent || "").includes(expected));
    },
    text,
    { timeout },
  );
}

/**
 * Waits until visible text no longer contains a marker.
 */
async function waitForTextGone(page, text, timeout = 30000) {
  await page.waitForFunction(
    async (expected) => {
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
      const isVisibleElement = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        if (["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(node.tagName)) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      return !allNodes()
        .filter(isVisibleElement)
        .some((node) => (node.innerText || node.textContent || "").includes(expected));
    },
    text,
    { timeout },
  );
}

/**
 * Waits until the deep visible text matches a pattern.
 */
async function waitForTextPattern(page, pattern, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let lastText = "";

  while (Date.now() < deadline) {
    lastText = await getVisibleText(page);
    if (pattern.test(lastText)) {
      return;
    }
    await page.waitForTimeout(200);
  }

  throw new Error(`Text pattern not found: ${pattern}; tail=${JSON.stringify(lastText.slice(-800))}`);
}

/**
 * Waits until the dense SkillHub list has enough visible rows.
 */
async function waitForDenseRows(page, minRows, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let lastCount = 0;

  while (Date.now() < deadline) {
    lastCount = await evaluateInDom(
      page,
      `
        return allNodes().filter((node) => {
          if (!(node instanceof HTMLElement)) return false;
          if (!node.classList.contains("skillhub-dense-row")) return false;
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }).length;
      `,
    );
    if (lastCount >= minRows) {
      return lastCount;
    }
    await page.waitForTimeout(200);
  }

  throw new Error(`Expected at least ${minRows} dense rows, found ${lastCount}`);
}

/**
 * Checks whether the current SkillHub dense list is visible and can request more remote rows.
 */
async function hasSkillHubLoadMore(page) {
  return evaluateInDom(
    page,
    `
      const table = allNodes().find((node) => node instanceof HTMLElement && node.getAttribute("data-skillhub-dense-list") === "true");
      if (!table) return false;
      const rect = table.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      return allNodes().some((node) => node instanceof HTMLElement && node.getAttribute("data-skillhub-load-more") === "true");
    `,
  );
}

/**
 * Reads stable row text keys from the dense list for append-order checks.
 */
async function getSkillHubDenseRowKeys(page, limit = 8) {
  return evaluateInDom(
    page,
    `
      return allNodes()
        .filter((node) => node instanceof HTMLElement && node.classList.contains("skillhub-dense-row"))
        .slice(0, value)
        .map((node) => (node.innerText || node.textContent || "").replace(/\\s+/g, " ").trim());
    `,
    limit,
  );
}

/**
 * Resets toolbar filters to the broad recommended list before testing request-backed pagination.
 */
async function resetSkillHubToolbarForLoadMore(page, requestCount) {
  let nextCount = requestCount;

  await selectSkillHubToolbarOption(page, "场景筛选", "all");
  nextCount = await waitForSkillSearchRequestIncrease(page, nextCount, "scene reset for load more");

  await selectSkillHubToolbarOption(page, "API Key 筛选", "all");
  nextCount = await waitForSkillSearchRequestIncrease(page, nextCount, "API Key reset for load more");

  await selectSkillHubToolbarOption(page, "排序", "recommended");
  nextCount = await waitForSkillSearchRequestIncrease(page, nextCount, "sort reset for load more");

  await waitForDenseRows(page, 1, 45000);
  return nextCount;
}

/**
 * Connects through token hash first, falling back to login gate form.
 */
async function ensureConnected(page, dashboardUrl, gatewayWebSocketUrl, token) {
  const routeUrl = new URL("skills", dashboardUrl);
  routeUrl.hash = new URLSearchParams({ token }).toString();

  await page.goto(routeUrl.toString(), { waitUntil: "domcontentloaded" });
  await page.waitForSelector("body", { timeout: 15000 });

  const hasStore = async () => (await getVisibleText(page)).includes("技能库");
  if (await hasStore()) return;

  const loginGate = page.locator("openclaw-login-gate");
  if ((await loginGate.count()) === 0) {
    await waitForText(page, "技能库", 30000);
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
  await waitForText(page, "技能库", 30000);
}

/**
 * Fills the SkillHub search input from generated UI and dispatches input events.
 */
async function fillSkillHubSearch(page, query) {
  const filled = await evaluateInDom(
    page,
    `
      const inputs = allNodes().filter((node) => node instanceof HTMLInputElement);
      const input = inputs.find((node) => /SkillHub|skills/i.test(node.placeholder || node.getAttribute("aria-label") || ""));
      if (!input) return false;
      input.focus();
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return true;
    `,
    query,
  );

  if (!filled) {
    throw new Error("SkillHub search input not found");
  }
}

/**
 * Installs a browser-side probe around the connected Gateway client's request method.
 */
async function installSkillSearchRequestProbe(page) {
  const installed = await evaluateInDom(
    page,
    `
      globalThis.__uclawSkillHubSearchRequests ??= [];
      const host = allNodes().find((node) => node instanceof HTMLElement && node.tagName.toLowerCase() === "openclaw-skills-page");
      const client = host?.client;
      if (!client || typeof client.request !== "function") return false;
      if (client.__uclawSkillHubSearchProbe === true) return true;
      const original = client.request.bind(client);
      client.request = (method, params, ...rest) => {
        if (method === "skills.search") {
          globalThis.__uclawSkillHubSearchRequests.push({ params, ts: Date.now() });
        }
        return original(method, params, ...rest);
      };
      client.__uclawSkillHubSearchProbe = true;
      return true;
    `,
  );

  if (!installed) {
    throw new Error("Could not install SkillHub skills.search request probe");
  }
}

/**
 * Installs a browser-side probe that intercepts SkillHub install requests.
 */
async function installSkillInstallRequestProbe(page) {
  const installed = await evaluateInDom(
    page,
    `
      globalThis.__uclawSkillHubInstallRequests ??= [];
      globalThis.__uclawSkillHubClickEvents ??= [];
      if (!globalThis.__uclawSkillHubClickProbe) {
        document.addEventListener("click", (event) => {
          const target = event.target instanceof HTMLElement ? event.target : null;
          globalThis.__uclawSkillHubClickEvents.push({
            tag: target?.tagName,
            text: (target?.innerText || target?.textContent || "").trim().slice(0, 40),
            installButton: target?.getAttribute("data-skillhub-install-button") || null,
            className: target?.className || null,
          });
        }, true);
        globalThis.__uclawSkillHubClickProbe = true;
      }
      const host = allNodes().find((node) => node instanceof HTMLElement && node.tagName.toLowerCase() === "openclaw-skills-page");
      const client = host?.client;
      if (!client || typeof client.request !== "function") return false;
      if (client.__uclawSkillHubInstallProbe === true) return true;
      const original = client.request.bind(client);
      client.request = async (method, params, ...rest) => {
        if (method === "skills.install") {
          globalThis.__uclawSkillHubInstallRequests.push({ params, ts: Date.now() });
          if (params?.force === true) {
            return { message: "验证覆盖重装已触发" };
          }
          throw new Error("Skill already exists at /Users/biancheng/Library/Application Support/u-claw/.openclaw/workspace/skills/browser-use. Re-run with force/update.");
        }
        return original(method, params, ...rest);
      };
      client.__uclawSkillHubInstallProbe = true;
      return true;
    `,
  );

  if (!installed) {
    throw new Error("Could not install SkillHub skills.install request probe");
  }
}

/**
 * Reads how many real `skills.search` calls have crossed the connected Gateway client.
 */
async function getSkillSearchRequestCount(page) {
  return page.evaluate(() => globalThis.__uclawSkillHubSearchRequests?.length ?? 0);
}

/**
 * Reads intercepted SkillHub install request count.
 */
async function getSkillInstallRequestCount(page) {
  return page.evaluate(() => globalThis.__uclawSkillHubInstallRequests?.length ?? 0);
}

/**
 * Waits for a new real `skills.search` request after a UI action.
 */
async function waitForSkillSearchRequestIncrease(page, previousCount, label) {
  await page.waitForFunction(
    (count) => (globalThis.__uclawSkillHubSearchRequests?.length ?? 0) > count,
    previousCount,
    { timeout: 15000 },
  );

  const nextCount = await getSkillSearchRequestCount(page);
  if (nextCount <= previousCount) {
    throw new Error(`${label} did not trigger skills.search`);
  }

  return nextCount;
}

/**
 * Changes a SkillHub toolbar select by its accessible label.
 */
async function selectSkillHubToolbarOption(page, label, value) {
  const result = await evaluateInDom(
    page,
    `
      const toolbar = allNodes().find((node) => node instanceof HTMLElement && node.getAttribute("data-skillhub-toolbar") === "true");
      const select = toolbar ? [...toolbar.querySelectorAll("select")].find((node) => node.getAttribute("aria-label") === value.label) : null;
      if (!select) return { ok: false, reason: "select not found" };
      const optionValues = [...select.options].map((option) => option.value);
      if (!optionValues.includes(value.value)) return { ok: false, reason: "option not found", optionValues };
      select.value = value.value;
      select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return { ok: true };
    `,
    { label, value },
  );

  if (!result?.ok) {
    throw new Error(`Could not set ${label}=${value}: ${JSON.stringify(result)}`);
  }
}

/**
 * Dispatches a downward wheel event on the dense SkillHub list.
 */
async function wheelSkillHubDenseList(page) {
  const dispatched = await evaluateInDom(
    page,
    `
      const table = allNodes().find((node) => node instanceof HTMLElement && node.getAttribute("data-skillhub-dense-list") === "true");
      if (!table) return false;
      table.dispatchEvent(new WheelEvent("wheel", { deltaY: 900, bubbles: true, composed: true }));
      return true;
    `,
  );

  if (!dispatched) {
    throw new Error("SkillHub dense list not found for load-more wheel");
  }
}

/**
 * Closes the visible SkillHub install status message.
 */
async function closeSkillHubInstallMessage(page) {
  const clicked = await evaluateInDom(
    page,
    `
      const button = allNodes().find((node) => node instanceof HTMLElement && node.getAttribute("data-skillhub-install-message-close") === "true");
      if (!button) return false;
      button.click();
      return true;
    `,
  );

  if (!clicked) {
    throw new Error("SkillHub install message close button not found");
  }
}

/**
 * Clicks the first visible SkillHub dense-row install button.
 */
async function clickFirstSkillHubInstallButton(page) {
  const rect = await evaluateInDom(
    page,
    `
      const rows = allNodes().filter((node) => node instanceof HTMLElement && node.classList.contains("skillhub-dense-row"));
      for (const row of rows) {
        const button = [...row.querySelectorAll("[data-skillhub-install-button='true'], button")].find((node) => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && !node.disabled && (node.innerText || node.textContent || "").trim() === "安装";
        });
        if (button) {
          button.scrollIntoView({ block: "center", inline: "center" });
          const rect = button.getBoundingClientRect();
          if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) continue;
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const hit = document.elementFromPoint(x, y);
          globalThis.__uclawSkillHubClickTarget = {
            x,
            y,
            text: (button.innerText || button.textContent || "").trim(),
            outerHTML: button.outerHTML,
            attributes: [...button.attributes].map((attribute) => [attribute.name, attribute.value]),
            onclickType: typeof button.onclick,
            hitTag: hit?.tagName || null,
            hitText: (hit?.innerText || hit?.textContent || "").trim().slice(0, 40),
            hitInstallButton: hit instanceof HTMLElement ? hit.getAttribute("data-skillhub-install-button") : null,
          };
          return { x, y, text: (button.innerText || button.textContent || "").trim() };
        }
      }
      return null;
    `,
  );

  if (!rect) {
    throw new Error("No visible enabled SkillHub install button found");
  }

  await page.mouse.click(rect.x, rect.y);
}

/**
 * Runs read-only store acceptance against a real Gateway dashboard.
 */
async function runAcceptance(options) {
  const { chromium } = loadPlaywright();
  const gatewayUrl = normalizeGatewayUrl(options.gatewayUrl);
  const gatewayWebSocketUrl = toGatewayWebSocketUrl(gatewayUrl);
  const token = getGatewayToken(readConfig(options.configPath));
  const errors = [];

  let browser;
  let page;
  let stage = "launch";

  try {
    browser = await chromium.launch({
      headless: !options.headful,
      executablePath: fs.existsSync(options.chromePath) ? options.chromePath : undefined,
    });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));

    stage = "connect";
    await ensureConnected(page, gatewayUrl, gatewayWebSocketUrl, token);

    stage = "homepage";
    await waitForText(page, "推荐首页", 45000);
    await waitForText(page, "全部", 45000);
    await waitForText(page, "可用", 45000);
    await waitForText(page, "需配置", 45000);
    await waitForText(page, "已停用", 45000);
    await waitForText(page, "API Key 不限", 45000);
    await waitForText(page, "全部场景", 45000);
    await waitForText(page, "排序 推荐精选", 45000);
    await waitForText(page, "场景", 45000);
    await waitForDenseRows(page, 8, 45000);

    const denseState = await evaluateInDom(
      page,
      `
        const rows = allNodes().filter((node) => node instanceof HTMLElement && node.classList.contains("skillhub-dense-row"));
        const icons = allNodes().filter((node) => node instanceof HTMLElement && node.classList.contains("skillhub-icon"));
        const toolbarNode = allNodes().find((node) => node instanceof HTMLElement && node.getAttribute("data-skillhub-toolbar") === "true");
        const toolbar = Boolean(toolbarNode);
        const searchInput = toolbarNode?.querySelector("[data-skillhub-search] input");
        const search = Boolean(searchInput);
        const searchBorder = searchInput ? getComputedStyle(searchInput).borderTopStyle !== "none" : false;
        const selects = toolbarNode ? toolbarNode.querySelectorAll("select").length : 0;
        const toolbarButtons = toolbarNode ? toolbarNode.querySelectorAll("button").length : 0;
        const optionTexts = toolbarNode ? [...toolbarNode.querySelectorAll("select")].map((select) => [...select.options].map((option) => option.textContent?.trim())) : [];
        const leftNav = allNodes().some((node) => node instanceof HTMLElement && node.getAttribute("data-skillhub-category-nav") === "true");
        const loadMore = allNodes().some((node) => node instanceof HTMLElement && node.getAttribute("data-skillhub-load-more") === "true");
        return { rowCount: rows.length, iconCount: icons.length, toolbar, search, searchBorder, selects, toolbarButtons, optionTexts, leftNav, loadMore };
      `,
    );
    if (!denseState.toolbar) throw new Error("SkillHub toolbar not found");
    if (!denseState.search) throw new Error("SkillHub toolbar search input not found");
    if (!denseState.searchBorder) throw new Error("SkillHub toolbar search input has no visible border");
    if (denseState.selects < 3) throw new Error("SkillHub toolbar scene/API/sort selects not found");
    if (denseState.toolbarButtons !== 0) throw new Error("SkillHub toolbar should not include a redundant refresh button");
    const flatOptions = denseState.optionTexts.flat();
    for (const label of ["全部场景", "办公效率", "知识管理", "开发编程", "数据分析", "仅看已配置", "仅看需配置", "下载最多", "收藏最多", "名称 A-Z"]) {
      if (!flatOptions.includes(label)) throw new Error(`SkillHub toolbar option missing: ${label}`);
    }
    if (denseState.leftNav) throw new Error("Unexpected SkillHub left category nav found");
    if (denseState.rowCount < 8) throw new Error(`Expected at least 8 dense rows, found ${denseState.rowCount}`);
    if (denseState.iconCount < denseState.rowCount) throw new Error("Some dense rows are missing icon slots");

    stage = "install-click";
    await installSkillInstallRequestProbe(page);
    const installCountBefore = await getSkillInstallRequestCount(page);
    await clickFirstSkillHubInstallButton(page);
    await page.waitForFunction(
      (count) => (globalThis.__uclawSkillHubInstallRequests?.length ?? 0) > count,
      installCountBefore,
      { timeout: 15000 },
    );
    await waitForText(page, "覆盖重装", 15000);
    const forceCountBefore = await getSkillInstallRequestCount(page);
    await clickButtonText(page, "覆盖重装");
    await page.waitForFunction(
      (count) => (globalThis.__uclawSkillHubInstallRequests?.length ?? 0) > count,
      forceCountBefore,
      { timeout: 15000 },
    );
    const forcedInstall = await page.evaluate(() => globalThis.__uclawSkillHubInstallRequests?.at(-1)?.params ?? null);
    if (forcedInstall?.force !== true) {
      throw new Error(`SkillHub force reinstall did not pass force:true: ${JSON.stringify(forcedInstall)}`);
    }
    await waitForText(page, "验证覆盖重装已触发", 15000);
    await closeSkillHubInstallMessage(page);
    await waitForTextGone(page, "验证覆盖重装已触发", 15000);

    stage = "request-backed-toolbar";
    await installSkillSearchRequestProbe(page);
    let requestCount = await getSkillSearchRequestCount(page);
    await selectSkillHubToolbarOption(page, "场景筛选", "office");
    requestCount = await waitForSkillSearchRequestIncrease(page, requestCount, "scene filter change");
    await waitForText(page, "搜索中…", 15000).catch(() => undefined);
    await waitForDenseRows(page, 1, 45000);

    await selectSkillHubToolbarOption(page, "API Key 筛选", "needs-key");
    requestCount = await waitForSkillSearchRequestIncrease(page, requestCount, "API Key filter change");
    await page.waitForTimeout(300);

    await selectSkillHubToolbarOption(page, "排序", "downloads");
    requestCount = await waitForSkillSearchRequestIncrease(page, requestCount, "sort change");
    await page.waitForTimeout(300);

    requestCount = await resetSkillHubToolbarForLoadMore(page, requestCount);
    if (await hasSkillHubLoadMore(page)) {
      const beforeLoadMoreRows = await getSkillHubDenseRowKeys(page, 8);
      await wheelSkillHubDenseList(page);
      requestCount = await waitForSkillSearchRequestIncrease(page, requestCount, "dense list load more");
      await page.waitForTimeout(1500);
      const afterLoadMoreRows = await getSkillHubDenseRowKeys(page, beforeLoadMoreRows.length);
      if (JSON.stringify(afterLoadMoreRows) !== JSON.stringify(beforeLoadMoreRows)) {
        throw new Error(`SkillHub load more replaced existing rows: before=${JSON.stringify(beforeLoadMoreRows)} after=${JSON.stringify(afterLoadMoreRows)}`);
      }
    } else if (denseState.loadMore) {
      throw new Error("SkillHub broad recommended list lost load-more affordance before wheel");
    }

    stage = "primary-tabs";
    await clickButtonText(page, "全部");
    await waitForText(page, "筛选已安装技能", 10000);
    await clickButtonText(page, "可用");
    await waitForText(page, "筛选已安装技能", 10000);
    await clickButtonText(page, "需配置");
    await waitForText(page, "筛选已安装技能", 10000);
    await clickButtonText(page, "已停用");
    await waitForText(page, "筛选已安装技能", 10000);
    await clickButtonText(page, "推荐");
    await waitForText(page, "API Key 不限", 10000);

    stage = "search";
    await fillSkillHubSearch(page, "lark");
    await waitForText(page, "搜索结果", 30000);
    await fillSkillHubSearch(page, "");
    await waitForText(page, "推荐首页", 30000);
  } catch (error) {
    const text = page ? (await getVisibleText(page).catch(() => "")).slice(-1000) : "";
    const debug = page
      ? await page
          .evaluate(() => ({
            clickTarget: globalThis.__uclawSkillHubClickTarget || null,
            clickEvents: globalThis.__uclawSkillHubClickEvents?.slice(-5) || [],
            installRequests: globalThis.__uclawSkillHubInstallRequests || [],
            searchRequests: globalThis.__uclawSkillHubSearchRequests?.length || 0,
            hostState: (() => {
              const host = document.querySelector("openclaw-skills-page");
              return host
                ? {
                    clawhubInstallSlug: host.clawhubInstallSlug ?? null,
                    clawhubInstallMessage: host.clawhubInstallMessage ?? null,
                    skillsAgentId: host.skillsAgentId ?? null,
                    skillsAgentRevision: host.skillsAgentRevision ?? null,
                  }
                : null;
            })(),
          }))
          .catch(() => null)
      : null;
    throw new Error(`${stage}: ${error instanceof Error ? error.message : String(error)} debug=${JSON.stringify(debug)} tail=${JSON.stringify(text)}`);
  } finally {
    await browser?.close().catch(() => undefined);
  }

  if (errors.length > 0) {
    throw new Error(`Browser console/page errors:\n${errors.slice(-5).join("\n")}`);
  }

  console.log("OK SkillHub store connected UI acceptance verified");
}

/**
 * Entrypoint for CLI usage.
 */
async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printUsage();
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    printUsage();
    return;
  }

  try {
    await runAcceptance(options);
  } catch (error) {
    console.error(`SkillHub store connected UI acceptance failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

main();
