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

Runs read-only connected UI acceptance for the SkillHub store homepage, dense list, request-backed toolbar filters, numbered pagination, and search reset.

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
 * Verifies the same-origin SkillHub proxy returns JSON instead of the SPA fallback HTML.
 */
async function verifySkillHubProxyEndpoint(gatewayUrl) {
  const url = new URL("__uclaw__/skillhub/skills", gatewayUrl);
  url.searchParams.set("page", "1");
  url.searchParams.set("pageSize", "1");
  url.searchParams.set("sortBy", "score");
  url.searchParams.set("order", "desc");

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12000),
  });
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!response.ok || !contentType.includes("application/json")) {
    throw new Error(
      `SkillHub proxy must return JSON: status=${response.status} content-type=${contentType} body=${JSON.stringify(text.slice(0, 80))}`,
    );
  }

  const payload = JSON.parse(text);
  if (!Array.isArray(payload?.data?.skills) || typeof payload?.data?.total !== "number") {
    throw new Error(`SkillHub proxy JSON shape invalid: ${JSON.stringify(payload).slice(0, 160)}`);
  }

  const categoryUrl = new URL("__uclaw__/skillhub/skills", gatewayUrl);
  categoryUrl.searchParams.set("page", "1");
  categoryUrl.searchParams.set("pageSize", "3");
  categoryUrl.searchParams.set("sortBy", "score");
  categoryUrl.searchParams.set("order", "desc");
  categoryUrl.searchParams.set("category", "knowledge-management");
  const categoryResponse = await fetch(categoryUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12000),
  });
  const categoryPayload = await categoryResponse.json();
  const categories = (categoryPayload?.data?.skills || []).map((skill) => skill.category);
  if (!categoryResponse.ok || categories.length === 0 || categories.some((category) => category !== "knowledge-management")) {
    throw new Error(`SkillHub proxy did not forward category filter: ${JSON.stringify(categories)}`);
  }
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
 * Checks whether the current SkillHub dense list exposes numbered pagination.
 */
async function hasSkillHubPagination(page) {
  return evaluateInDom(
    page,
    `
      const table = allNodes().find((node) => node instanceof HTMLElement && node.getAttribute("data-skillhub-dense-list") === "true");
      if (!table) return false;
      const rect = table.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      return allNodes().some((node) => node instanceof HTMLElement && node.getAttribute("data-skillhub-pagination") === "true");
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
 * Simulates a remote SkillHub row that is already present in local skills.status.
 */
async function simulateFirstRemoteSkillInstalled(page) {
  const result = await evaluateInDom(
    page,
    `
      const host = document.querySelector("openclaw-skills-page");
      const item = host?.skillHubHomeResults?.find((skill) => skill?.slug || skill?.install?.reference || skill?.id);
      if (!host || !item) return { ok: false, reason: "remote item not found" };
      const skillKey = item.slug || String(item.install?.reference || item.id || "").split("/").pop();
      if (!skillKey) return { ok: false, reason: "skill key not found" };
      const localSkill = {
        name: skillKey,
        skillKey,
        source: "skillhub",
        description: item.description || item.summary || item.displayName || skillKey,
        eligible: true,
        missing: {},
      };
      const existing = Array.isArray(host.report?.skills) ? host.report.skills : [];
      host.report = { ...(host.report || {}), skills: [localSkill, ...existing.filter((skill) => skill?.skillKey !== skillKey && skill?.name !== skillKey)] };
      host.requestUpdate?.();
      return { ok: true, skillKey };
    `,
  );

  if (!result?.ok) {
    throw new Error(`Could not simulate installed SkillHub row: ${JSON.stringify(result)}`);
  }
  return result.skillKey;
}

/**
 * Waits for any remote dense row to render the remembered-installed affordance.
 */
async function waitForRememberedInstalledSkillRow(page, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let lastState = null;

  while (Date.now() < deadline) {
    lastState = await evaluateInDom(
      page,
      `
        const rows = allNodes().filter((node) => node instanceof HTMLElement && node.classList.contains("skillhub-dense-row"));
        for (const row of rows) {
          const badge = row.querySelector("[data-skillhub-installed-badge='true']");
          const uninstall = row.querySelector("[data-skillhub-uninstall-button='true']");
          const actionText = (row.lastElementChild?.innerText || row.lastElementChild?.textContent || "").replace(/\\s+/g, " ").trim();
          if (badge && uninstall) {
            return { ok: true, text: (row.innerText || row.textContent || "").replace(/\\s+/g, " ").trim(), actionText };
          }
        }
        return { ok: false, rowCount: rows.length, text: rows.map((row) => (row.innerText || row.textContent || "").replace(/\\s+/g, " ").trim()).slice(0, 3) };
      `,
    );
    if (lastState?.ok) return lastState;
    await page.waitForTimeout(200);
  }

  throw new Error(`Remembered installed SkillHub row not rendered: ${JSON.stringify(lastState)}`);
}

/**
 * Resets toolbar filters to the broad recommended list before testing numbered pagination.
 */
async function resetSkillHubToolbarForPagination(page, requestCount) {
  let nextCount = requestCount;

  await clickSkillHubSceneOption(page, "all");
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
      const input = inputs.find((node) => /技能商店|技能|SkillHub|skills/i.test(node.placeholder || node.getAttribute("aria-label") || ""));
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
 * Installs a browser-side probe around same-origin SkillHub API fetches.
 */
async function installSkillSearchRequestProbe(page) {
  const installed = await evaluateInDom(
    page,
    `
      globalThis.__uclawSkillHubSearchRequests ??= [];
      if (globalThis.__uclawSkillHubSearchProbe === true) return true;
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input?.url || input);
        if (url.includes("/__uclaw__/skillhub/skills")) {
          const parsed = new URL(url, window.location.origin);
          globalThis.__uclawSkillHubSearchRequests.push({ url: parsed.toString(), params: Object.fromEntries(parsed.searchParams.entries()), ts: Date.now() });
          if (globalThis.__uclawSkillHubDelayNextSearch === true) {
            globalThis.__uclawSkillHubDelayNextSearch = false;
            await new Promise((resolve) => setTimeout(resolve, 600));
          }
        }
        return original(input, init);
      };
      globalThis.__uclawSkillHubSearchProbe = true;
      return true;
    `,
  );

  if (!installed) {
    throw new Error("Could not install SkillHub API request probe");
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
          throw new Error("failed to install skill: Error: EPERM: operation not permitted, rename 'C:\\\\Users\\\\EDY\\\\AppData\\\\Local\\\\U-Claw\\\\usb-portable\\\\data\\\\.openclaw\\\\workspace\\\\skills\\\\.fs-safe-move-1584-test.tmp' -> 'C:\\\\Users\\\\EDY\\\\AppData\\\\Local\\\\U-Claw\\\\usb-portable\\\\data\\\\.openclaw\\\\workspace\\\\skills\\\\tencent-docs'");
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
 * Installs a browser-side probe that intercepts SkillHub uninstall requests.
 */
async function installSkillUninstallRequestProbe(page) {
  const installed = await evaluateInDom(
    page,
    `
      globalThis.__uclawSkillHubUninstallRequests ??= [];
      const host = allNodes().find((node) => node instanceof HTMLElement && node.tagName.toLowerCase() === "openclaw-skills-page");
      const client = host?.client;
      if (!client || typeof client.request !== "function") return false;
      if (client.__uclawSkillHubUninstallProbe === true) return true;
      const original = client.request.bind(client);
      client.request = async (method, params, ...rest) => {
        if (method === "skills.uninstall") {
          globalThis.__uclawSkillHubUninstallRequests.push({ params, ts: Date.now() });
          return { ok: true, skillKey: params?.skillKey || null, targetDir: "/tmp/skillhub-uninstall-probe" };
        }
        return original(method, params, ...rest);
      };
      client.__uclawSkillHubUninstallProbe = true;
      return true;
    `,
  );

  if (!installed) {
    throw new Error("Could not install SkillHub skills.uninstall request probe");
  }
}

/**
 * Installs a browser-side probe that fails legacy ClawHub detail requests.
 */
async function installSkillDetailFailureProbe(page) {
  const installed = await evaluateInDom(
    page,
    `
      globalThis.__uclawSkillHubDetailRequests ??= [];
      const host = allNodes().find((node) => node instanceof HTMLElement && node.tagName.toLowerCase() === "openclaw-skills-page");
      const client = host?.client;
      if (!client || typeof client.request !== "function") return false;
      if (client.__uclawSkillHubDetailFailureProbe === true) return true;
      const original = client.request.bind(client);
      client.request = async (method, params, ...rest) => {
        if (method === "skills.detail") {
          globalThis.__uclawSkillHubDetailRequests.push({ params, ts: Date.now() });
          throw new Error(\`ClawHub /api/v1/skills/\${params?.slug || ""} failed (404): Skill not found\`);
        }
        return original(method, params, ...rest);
      };
      client.__uclawSkillHubDetailFailureProbe = true;
      return true;
    `,
  );

  if (!installed) {
    throw new Error("Could not install SkillHub skills.detail failure probe");
  }
}

/**
 * Delays the next intercepted SkillHub search so loading UI is observable.
 */
async function delayNextSkillHubSearch(page) {
  await page.evaluate(() => {
    globalThis.__uclawSkillHubDelayNextSearch = true;
  });
}

/**
 * Reads how many same-origin SkillHub API calls have crossed the browser.
 */
async function getSkillSearchRequestCount(page) {
  return page.evaluate(() => globalThis.__uclawSkillHubSearchRequests?.length ?? 0);
}

/**
 * Reads the latest same-origin SkillHub API request captured in the browser.
 */
async function getLastSkillSearchRequest(page) {
  return page.evaluate(() => globalThis.__uclawSkillHubSearchRequests?.at(-1) ?? null);
}

/**
 * Reads intercepted SkillHub install request count.
 */
async function getSkillInstallRequestCount(page) {
  return page.evaluate(() => globalThis.__uclawSkillHubInstallRequests?.length ?? 0);
}

/**
 * Reads intercepted SkillHub uninstall request count.
 */
async function getSkillUninstallRequestCount(page) {
  return page.evaluate(() => globalThis.__uclawSkillHubUninstallRequests?.length ?? 0);
}

/**
 * Waits until toolbar/search loading affordances are no longer visible.
 */
async function waitForSkillHubRequestIdle(page, timeout = 15000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const idle = await evaluateInDom(
      page,
      `
        return !allNodes().some((node) => node instanceof HTMLElement && node.getAttribute("data-skillhub-loading") === "true");
      `,
    );
    if (idle) return;
    await page.waitForTimeout(150);
  }

  throw new Error("SkillHub request loading indicator did not settle");
}

/**
 * Waits for a new real SkillHub API request after a UI action.
 */
async function waitForSkillSearchRequestIncrease(page, previousCount, label) {
  await page.waitForFunction(
    (count) => (globalThis.__uclawSkillHubSearchRequests?.length ?? 0) > count,
    previousCount,
    { timeout: 15000 },
  );

  const nextCount = await getSkillSearchRequestCount(page);
  if (nextCount <= previousCount) {
    throw new Error(`${label} did not trigger SkillHub API fetch`);
  }

  await waitForSkillHubRequestIdle(page);
  return nextCount;
}

/**
 * Clicks a scene option in the standalone SkillHub scene picker.
 */
async function clickSkillHubSceneOption(page, value) {
  const result = await evaluateInDom(
    page,
    `
      const picker = allNodes().find((node) => node instanceof HTMLElement && node.getAttribute("data-skillhub-scene-picker") === "true");
      const button = picker ? [...picker.querySelectorAll("[data-skillhub-scene-option='true']")].find((node) => node.getAttribute("data-skillhub-scene-value") === value) : null;
      if (!picker) return { ok: false, reason: "scene picker not found" };
      if (!button) return { ok: false, reason: "scene option not found", values: [...picker.querySelectorAll("[data-skillhub-scene-option='true']")].map((node) => node.getAttribute("data-skillhub-scene-value")) };
      button.click();
      return { ok: true };
    `,
    value,
  );

  if (!result?.ok) {
    throw new Error(`Could not click SkillHub scene ${value}: ${JSON.stringify(result)}`);
  }
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
 * Clicks the explicit next-page button in the SkillHub dense list.
 */
async function clickSkillHubNextPageButton(page) {
  const result = await evaluateInDom(
    page,
    `
      const table = allNodes().find((node) => node instanceof HTMLElement && node.getAttribute("data-skillhub-dense-list") === "true");
      const button = allNodes().find((node) => node instanceof HTMLButtonElement && node.getAttribute("data-skillhub-next-page-button") === "true");
      if (!table) return { ok: false, reason: "table not found" };
      if (!button) return { ok: false, reason: "next-page button not found" };
      if (button.disabled) return { ok: false, reason: "next-page button disabled" };
      button.scrollIntoView({ block: "center", inline: "nearest" });
      button.click();
      return { ok: true };
    `,
  );

  if (!result?.ok) {
    throw new Error(`SkillHub next-page button not ready: ${JSON.stringify(result)}`);
  }
}

/**
 * Reads the currently active SkillHub page number.
 */
async function getActiveSkillHubPage(page) {
  return evaluateInDom(
    page,
    `
      const active = allNodes().find((node) => node instanceof HTMLButtonElement && node.getAttribute("data-skillhub-page-button") === "true" && node.classList.contains("primary"));
      return Number(active?.getAttribute("data-skillhub-page") || active?.textContent || 0);
    `,
  );
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
 * Opens the first visible remote SkillHub dense row without hitting its action button.
 */
async function clickFirstSkillHubDetailRow(page) {
  const row = page.locator(".skillhub-dense-row", { has: page.locator("[data-skillhub-install-button='true']") }).first();
  if ((await row.count()) === 0) {
    throw new Error("No visible remote SkillHub dense row found");
  }
  await row.scrollIntoViewIfNeeded();
  await row.click({ position: { x: 24, y: 24 } });
}

/**
 * Closes the currently visible SkillHub detail dialog.
 */
async function closeSkillHubDetailDialog(page) {
  const clicked = await evaluateInDom(
    page,
    `
      const dialogs = allNodes().filter((node) => node instanceof HTMLDialogElement && node.open);
      const dialog = dialogs.at(-1);
      const button = [...allNodes()].find((node) => {
        if (!(node instanceof HTMLButtonElement)) return false;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        return (node.innerText || node.textContent || "").trim().includes("关闭");
      }) || (dialog ? [...dialog.querySelectorAll("button")].find((node) => (node.innerText || node.textContent || "").trim().includes("关闭")) : null);
      if (!button && dialog) {
        dialog.close();
        return true;
      }
      if (!button) return false;
      button.click();
      return true;
    `,
  );

  return clicked;
}

/**
 * Clicks the first visible SkillHub dense-row uninstall button.
 */
async function clickFirstSkillHubUninstallButton(page) {
  const rect = await evaluateInDom(
    page,
    `
      const buttons = allNodes().filter((node) => node instanceof HTMLButtonElement);
      for (const button of buttons) {
        const rect = button.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || button.disabled) continue;
        if ((button.innerText || button.textContent || "").trim() !== "卸载") continue;
        button.scrollIntoView({ block: "center", inline: "center" });
        const visibleRect = button.getBoundingClientRect();
        if (visibleRect.bottom < 0 || visibleRect.top > window.innerHeight || visibleRect.right < 0 || visibleRect.left > window.innerWidth) continue;
        const x = visibleRect.left + visibleRect.width / 2;
        const y = visibleRect.top + visibleRect.height / 2;
        return { x, y, text: (button.innerText || button.textContent || "").trim() };
      }
      return null;
    `,
  );

  if (!rect) {
    throw new Error("No visible enabled SkillHub uninstall button found");
  }

  await page.mouse.click(rect.x, rect.y);
}

/**
 * Runs read-only store acceptance against a real Gateway dashboard.
 */
async function runAcceptance(options) {
  const { chromium } = loadPlaywright();
  const gatewayUrl = normalizeGatewayUrl(options.gatewayUrl);
  await verifySkillHubProxyEndpoint(gatewayUrl);
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
        const sceneTexts = rows.map((row) => row.children?.[1]?.textContent?.trim() || "").filter(Boolean);
        const toolbarNode = allNodes().find((node) => node instanceof HTMLElement && node.getAttribute("data-skillhub-toolbar") === "true");
        const toolbar = Boolean(toolbarNode);
        const searchInput = toolbarNode?.querySelector("[data-skillhub-search] input");
        const search = Boolean(searchInput);
        const searchBorder = searchInput ? getComputedStyle(searchInput).borderTopStyle !== "none" : false;
        const selects = toolbarNode ? toolbarNode.querySelectorAll("select").length : 0;
        const toolbarButtons = toolbarNode ? toolbarNode.querySelectorAll("button").length : 0;
        const optionTexts = toolbarNode ? [...toolbarNode.querySelectorAll("select")].map((select) => [...select.options].map((option) => option.textContent?.trim())) : [];
        const scenePicker = allNodes().find((node) => node instanceof HTMLElement && node.getAttribute("data-skillhub-scene-picker") === "true");
        const sceneStrip = scenePicker?.querySelector("[data-skillhub-scene-strip='true']");
        const sceneOptions = scenePicker ? [...scenePicker.querySelectorAll("[data-skillhub-scene-option='true']")].map((node) => ({ value: node.getAttribute("data-skillhub-scene-value"), text: node.textContent?.trim(), pressed: node.getAttribute("aria-pressed") })) : [];
        const sceneIconCount = scenePicker ? scenePicker.querySelectorAll(".skillhub-scene-icon").length : 0;
        const sceneSvgCount = scenePicker ? scenePicker.querySelectorAll(".skillhub-scene-icon svg").length : 0;
        const leakedFallbackIcons = scenePicker ? [...scenePicker.querySelectorAll("[data-skillhub-scene-option='true']")].some((node) => /^(?:p|c|b|square)\s/.test(node.textContent?.trim() || "")) : false;
        const sceneStripStyle = sceneStrip ? getComputedStyle(sceneStrip) : null;
        const scenePickerStyle = scenePicker ? getComputedStyle(scenePicker) : null;
        const scenePickerRect = scenePicker?.getBoundingClientRect();
        const toolbarRect = toolbarNode?.getBoundingClientRect();
        const leftNav = allNodes().some((node) => node instanceof HTMLElement && node.getAttribute("data-skillhub-category-nav") === "true");
        const pagination = allNodes().some((node) => node instanceof HTMLElement && node.getAttribute("data-skillhub-pagination") === "true");
        const pageButtons = allNodes().filter((node) => node instanceof HTMLButtonElement && node.getAttribute("data-skillhub-page-button") === "true").length;
        const pageSummary = allNodes().find((node) => node instanceof HTMLElement && node.getAttribute("data-skillhub-page-summary") === "true")?.textContent || "";
        const categoryApi = globalThis.UClawSkillHubCategories;
        const publicCategories = categoryApi?.list?.() || [];
        return {
          rowCount: rows.length,
          iconCount: icons.length,
          sceneTexts,
          toolbar,
          search,
          searchBorder,
          selects,
          toolbarButtons,
          optionTexts,
          scenePicker: Boolean(scenePicker),
          sceneOptions,
          sceneIconCount,
          sceneSvgCount,
          leakedFallbackIcons,
          sceneWrap: sceneStripStyle?.flexWrap,
          sceneOverflowX: sceneStripStyle?.overflowX,
          sceneFlexShrink: scenePickerStyle?.flexShrink,
          sceneToolbarGap: scenePickerRect && toolbarRect ? Math.round(toolbarRect.top - scenePickerRect.bottom) : null,
          sceneHeight: scenePickerRect ? Math.round(scenePickerRect.height) : null,
          leftNav,
          pagination,
          pageButtons,
          pageSummary,
          publicCategoryApi: Boolean(categoryApi),
          publicCategoryCount: publicCategories.length,
          publicCategoryOfficeLabel: categoryApi?.label?.("office"),
          publicCategoryOfficeApi: categoryApi?.apiCategory?.("office"),
          publicCategorySlugLabel: categoryApi?.label?.("knowledge-management"),
        };
      `,
    );
    if (!denseState.toolbar) throw new Error("SkillHub toolbar not found");
    if (!denseState.search) throw new Error("SkillHub toolbar search input not found");
    if (!denseState.searchBorder) throw new Error("SkillHub toolbar search input has no visible border");
    if (!denseState.scenePicker) throw new Error("SkillHub standalone scene picker not found");
    if (denseState.sceneWrap !== "wrap" || denseState.sceneOverflowX === "auto" || denseState.sceneOverflowX === "scroll") {
      throw new Error(`SkillHub scene picker should wrap instead of horizontal scrolling: ${JSON.stringify(denseState)}`);
    }
    if (denseState.sceneFlexShrink !== "0" || denseState.sceneToolbarGap === null || denseState.sceneToolbarGap < 0 || denseState.sceneHeight < 30) {
      throw new Error(`SkillHub scene picker should reserve natural height above toolbar: ${JSON.stringify(denseState)}`);
    }
    if (denseState.selects < 2) throw new Error("SkillHub toolbar API/sort selects not found");
    if (denseState.toolbarButtons !== 0) throw new Error("SkillHub toolbar should not include a redundant refresh button");
    if (!denseState.publicCategoryApi || denseState.publicCategoryCount < 12) {
      throw new Error(`SkillHub category registry should be exposed for external callers: ${JSON.stringify(denseState)}`);
    }
    if (
      denseState.publicCategoryOfficeLabel !== "办公效率" ||
      denseState.publicCategoryOfficeApi !== "office-efficiency" ||
      denseState.publicCategorySlugLabel !== "知识管理"
    ) {
      throw new Error(`SkillHub public category API returned wrong mapping: ${JSON.stringify(denseState)}`);
    }
    const flatOptions = denseState.optionTexts.flat();
    const sceneLabels = denseState.sceneOptions.map((option) => option.text);
    for (const label of ["全部场景", "办公效率", "知识管理", "开发编程", "数据分析"]) {
      if (!sceneLabels.some((text) => text.includes(label))) throw new Error(`SkillHub scene picker option missing: ${label}`);
    }
    if (denseState.leakedFallbackIcons) throw new Error(`SkillHub scene picker leaked fallback text icons: ${JSON.stringify(denseState)}`);
    for (const label of ["仅看已配置", "仅看需配置", "下载最多", "收藏最多", "名称 A-Z"]) {
      if (!flatOptions.includes(label)) throw new Error(`SkillHub toolbar option missing: ${label}`);
    }
    if (denseState.leftNav) throw new Error("Unexpected SkillHub left category nav found");
    if (denseState.rowCount < 8) throw new Error(`Expected at least 8 dense rows, found ${denseState.rowCount}`);
    if (denseState.iconCount < denseState.rowCount) throw new Error("Some dense rows are missing icon slots");
    if (!denseState.sceneTexts.some((text) => /[\u4e00-\u9fff]/.test(text))) {
      throw new Error(`SkillHub scene column should use Chinese labels: ${JSON.stringify(denseState.sceneTexts.slice(0, 8))}`);
    }
    if (denseState.sceneTexts.some((text) => /(?:office-efficiency|knowledge-management|dev-programming|content-creation|life-service|data-analysis)/.test(text))) {
      throw new Error(`SkillHub scene column leaked raw category slug: ${JSON.stringify(denseState.sceneTexts.slice(0, 8))}`);
    }
    if (!denseState.pagination) throw new Error("SkillHub numbered pagination not found");
    if (denseState.pageButtons < 2) throw new Error(`Expected multiple SkillHub page buttons, found ${denseState.pageButtons}`);
    if (!/第\s+1\s+\/\s+\d+\s+页\s+·\s+共/.test(denseState.pageSummary)) {
      throw new Error(`SkillHub page summary missing total: ${JSON.stringify(denseState.pageSummary)}`);
    }
    const scrollState = await evaluateInDom(
      page,
      `
        const shell = allNodes().find((node) => node instanceof HTMLElement && node.getAttribute("data-skillhub-scroll-shell") === "true");
        const table = allNodes().find((node) => node instanceof HTMLElement && node.getAttribute("data-skillhub-scroll-table") === "true");
        const toolbar = allNodes().find((node) => node instanceof HTMLElement && node.getAttribute("data-skillhub-toolbar") === "true");
        const head = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("skillhub-dense-head"));
        const title = allNodes().find((node) => node instanceof HTMLElement && node.classList.contains("page-title") && node.textContent?.includes("技能库"));
        const pageHeader = title?.closest(".content-header");
        const host = shell?.closest("openclaw-skills-page");
        const content = shell?.closest(".content");
        const pageScroller = table?.closest(".content") || document.scrollingElement;
        if (!shell || !table || !toolbar || !head || !title || !pageHeader || !host || !content || !pageScroller) {
          return { ok: false, reason: "scroll nodes missing", hasShell: Boolean(shell), hasTable: Boolean(table), hasToolbar: Boolean(toolbar), hasHead: Boolean(head), hasTitle: Boolean(title), hasPageHeader: Boolean(pageHeader), hasHost: Boolean(host), hasContent: Boolean(content), hasPageScroller: Boolean(pageScroller) };
        }
        table.scrollTop = 0;
        const toolbarTopBefore = toolbar.getBoundingClientRect().top;
        const pageScrollBefore = pageScroller.scrollTop;
        const documentScrollBefore = document.scrollingElement?.scrollTop ?? 0;
        table.scrollTop = 120;
        const toolbarTopAfter = toolbar.getBoundingClientRect().top;
        const pageScrollAfter = pageScroller.scrollTop;
        const documentScrollAfter = document.scrollingElement?.scrollTop ?? 0;
        const tableStyle = getComputedStyle(table);
        const shellStyle = getComputedStyle(shell);
        const hostStyle = getComputedStyle(host);
        const headStyle = getComputedStyle(head);
        const titleStyle = getComputedStyle(title);
        const pageHeaderStyle = getComputedStyle(pageHeader);
        const shellRect = shell.getBoundingClientRect();
        const contentRect = content.getBoundingClientRect();
        const headRect = head.getBoundingClientRect();
        const tableRect = table.getBoundingClientRect();
        const titleRect = title.getBoundingClientRect();
        const pageHeaderRect = pageHeader.getBoundingClientRect();
        const headBg = headStyle.backgroundColor;
        const headBgAlphaMatch = headBg.match(/rgba?\\(([^)]+)\\)/);
        const headBgAlpha = headBgAlphaMatch ? Number((headBgAlphaMatch[1].split(",")[3] || "1").trim()) : 1;
        const titleFontSize = Number.parseFloat(titleStyle.fontSize) || 0;
        const titleLineHeight = Number.parseFloat(titleStyle.lineHeight) || 0;
        const shellBottomGap = Math.round(contentRect.bottom - shellRect.bottom);
        return {
          ok: true,
          flexShell: shell.getAttribute("data-skillhub-flex-fill") === "true" && Number.parseFloat(shellStyle.flexGrow) >= 1 && shellStyle.height !== "0px",
          flexHost: hostStyle.display === "flex" && hostStyle.flexDirection === "column",
          shellBottomGap,
          shellHeight: Math.round(shellRect.height),
          contentHeight: Math.round(contentRect.height),
          tableScrollable: table.scrollHeight > table.clientHeight + 24,
          tableScrollTop: table.scrollTop,
          tableOverflowY: tableStyle.overflowY,
          shellOverflowY: shellStyle.overflowY,
          toolbarStable: Math.abs(toolbarTopAfter - toolbarTopBefore) < 1,
          pageScrollStable: pageScrollBefore === pageScrollAfter && documentScrollBefore === documentScrollAfter,
          opaqueHead: headBgAlpha >= 0.98 && headBg !== "rgba(0, 0, 0, 0)" && Number.parseInt(headStyle.zIndex, 10) >= 5,
          headSticksInsideTable: headRect.top >= tableRect.top - 1 && headRect.bottom <= tableRect.bottom,
          pageHeaderSafe: pageHeaderStyle.overflow === "visible" && pageHeaderStyle.maxHeight === "none" && Number.parseFloat(pageHeaderStyle.paddingTop) <= 2 && pageHeaderRect.height >= 48 && pageHeaderRect.height <= 72,
          titleVisible: titleRect.height >= Math.max(20, titleFontSize * 1.1) && titleLineHeight >= titleFontSize * 1.1 && titleRect.top >= pageHeaderRect.top - 1 && titleRect.top >= contentRect.top - 1,
          titleOverflow: titleStyle.overflow,
          pageHeaderOverflow: pageHeaderStyle.overflow,
          pageHeaderMaxHeight: pageHeaderStyle.maxHeight,
          pageHeaderPaddingTop: pageHeaderStyle.paddingTop,
          pageHeaderHeight: Math.round(pageHeaderRect.height),
          titleHeight: Math.round(titleRect.height),
          titleLineHeight: Math.round(titleLineHeight),
          titleFontSize: Math.round(titleFontSize),
          headBackground: headBg,
          headZIndex: headStyle.zIndex,
          toolbarTopBefore,
          toolbarTopAfter,
          pageScrollBefore,
          pageScrollAfter,
          documentScrollBefore,
          documentScrollAfter,
        };
      `,
    );
    if (!scrollState.ok || !scrollState.flexShell || !scrollState.flexHost || scrollState.shellBottomGap > 48 || scrollState.shellBottomGap < -4 || !scrollState.tableScrollable || scrollState.tableScrollTop <= 0 || !/auto|scroll/.test(scrollState.tableOverflowY) || scrollState.shellOverflowY !== "hidden" || !scrollState.toolbarStable || !scrollState.pageScrollStable || !scrollState.opaqueHead || !scrollState.headSticksInsideTable || !scrollState.pageHeaderSafe || !scrollState.titleVisible) {
      throw new Error(`SkillHub dense list should be the only scroll container: ${JSON.stringify(scrollState)}`);
    }

    stage = "installed-memory";
    await simulateFirstRemoteSkillInstalled(page);
    const remembered = await waitForRememberedInstalledSkillRow(page);
    if (!remembered.text.includes("已安装") || !remembered.text.includes("卸载")) {
      throw new Error(`SkillHub remembered installed row missing installed/uninstall copy: ${JSON.stringify(remembered)}`);
    }
    if (/已安装/.test(remembered.actionText)) {
      throw new Error(`SkillHub remembered installed row duplicated installed copy in action column: ${JSON.stringify(remembered)}`);
    }

    stage = "detail-fallback";
    const simulated = await evaluateInDom(
      page,
      `
        const host = document.querySelector("openclaw-skills-page");
        const item = host?.skillHubHomeResults?.find((skill) => skill?.install?.reference || skill?.id || skill?.slug);
        if (!host || !item) return false;
        host.clawhubDetailSlug = item.install?.reference || item.id || item.slug;
        host.clawhubDetail = null;
        host.clawhubDetailLoading = false;
        host.clawhubDetailError = "ClawHub /api/v1/skills/" + (item.slug || "") + " failed (404): Skill not found";
        host.requestUpdate?.();
        return true;
      `,
    );
    if (!simulated) {
      throw new Error("Could not simulate SkillHub detail 404 fallback state");
    }
    await page.waitForFunction(
      () => {
        const host = document.querySelector("openclaw-skills-page");
        return host?.clawhubDetailLoading === false && Boolean(host?.clawhubDetailSlug);
      },
      null,
      { timeout: 15000 },
    );
    await waitForText(page, "安装来源", 15000);
    const detailText = await getVisibleText(page);
    if (/Skill not found|404|技能商店搜索失败/.test(detailText)) {
      throw new Error(`SkillHub cached detail fallback leaked legacy detail error: ${JSON.stringify(detailText.slice(-800))}`);
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    await closeSkillHubDetailDialog(page);

    stage = "install-click";
    await installSkillInstallRequestProbe(page);
    const installCountBefore = await getSkillInstallRequestCount(page);
    await clickFirstSkillHubInstallButton(page);
    await page.waitForFunction(
      (count) => (globalThis.__uclawSkillHubInstallRequests?.length ?? 0) > count,
      installCountBefore,
      { timeout: 15000 },
    );
    const firstInstall = await page.evaluate(() => globalThis.__uclawSkillHubInstallRequests?.at(-1)?.params ?? null);
    if (firstInstall?.source !== "skillhub" || !firstInstall?.slug || firstInstall.slug.startsWith("@")) {
      throw new Error(`SkillHub list install used wrong request shape: ${JSON.stringify(firstInstall)}`);
    }
    await waitForText(page, "Windows 拒绝写入技能安装目录", 15000);
    await waitForText(page, "覆盖重装", 15000);
    const forceCountBefore = await getSkillInstallRequestCount(page);
    await clickButtonText(page, "覆盖重装");
    await page.waitForFunction(
      (count) => (globalThis.__uclawSkillHubInstallRequests?.length ?? 0) > count,
      forceCountBefore,
      { timeout: 15000 },
    );
    const forcedInstall = await page.evaluate(() => globalThis.__uclawSkillHubInstallRequests?.at(-1)?.params ?? null);
    if (forcedInstall?.force !== true || forcedInstall?.source !== "skillhub") {
      throw new Error(`SkillHub force reinstall did not pass force:true: ${JSON.stringify(forcedInstall)}`);
    }
    await waitForText(page, "验证覆盖重装已触发", 15000);
    await closeSkillHubInstallMessage(page);
    await waitForTextGone(page, "验证覆盖重装已触发", 15000);

    stage = "request-backed-toolbar";
    await installSkillSearchRequestProbe(page);
    let requestCount = await getSkillSearchRequestCount(page);
    await clickSkillHubSceneOption(page, "office");
    requestCount = await waitForSkillSearchRequestIncrease(page, requestCount, "scene filter change");
    const sceneRequest = await getLastSkillSearchRequest(page);
    if (sceneRequest?.params?.category !== "office-efficiency") {
      throw new Error(`SkillHub scene picker sent wrong category: ${JSON.stringify(sceneRequest)}`);
    }
    await waitForText(page, "搜索中…", 15000).catch(() => undefined);
    await waitForDenseRows(page, 1, 45000);
    const activeSceneCountState = await evaluateInDom(
      page,
      `
        const picker = allNodes().find((node) => node instanceof HTMLElement && node.getAttribute("data-skillhub-scene-picker") === "true");
        const options = picker ? [...picker.querySelectorAll("[data-skillhub-scene-option='true']")] : [];
        const active = options.find((node) => node.getAttribute("aria-pressed") === "true");
        const all = options.find((node) => node.getAttribute("data-skillhub-scene-value") === "all");
        return {
          activeValue: active?.getAttribute("data-skillhub-scene-value") || "",
          activeText: active?.textContent?.trim() || "",
          allText: all?.textContent?.trim() || "",
        };
      `,
    );
    if (
      activeSceneCountState.activeValue !== "office"
      || !/办公效率/.test(activeSceneCountState.activeText)
      || !/\d/.test(activeSceneCountState.activeText)
      || /\d/.test(activeSceneCountState.allText)
    ) {
      throw new Error(`SkillHub scene count should follow the selected option: ${JSON.stringify(activeSceneCountState)}`);
    }

    await selectSkillHubToolbarOption(page, "API Key 筛选", "needs-key");
    requestCount = await waitForSkillSearchRequestIncrease(page, requestCount, "API Key filter change");
    const apiKeyRequest = await getLastSkillSearchRequest(page);
    if (apiKeyRequest?.params?.apiKey !== "needs-key") {
      throw new Error(`SkillHub API Key select did not send apiKey: ${JSON.stringify(apiKeyRequest)}`);
    }
    await page.waitForTimeout(300);

    await selectSkillHubToolbarOption(page, "排序", "downloads");
    requestCount = await waitForSkillSearchRequestIncrease(page, requestCount, "sort change");
    await page.waitForTimeout(300);

    requestCount = await resetSkillHubToolbarForPagination(page, requestCount);
    if (await hasSkillHubPagination(page)) {
      const beforePageRows = await getSkillHubDenseRowKeys(page, 8);
      const beforePage = await getActiveSkillHubPage(page);
      if (beforePage !== 1) throw new Error(`Expected active SkillHub page 1 before pagination, got ${beforePage}`);
      await waitForSkillHubRequestIdle(page);
      const scrolledBeforeNext = await evaluateInDom(
        page,
        `
          const table = allNodes().find((node) => node instanceof HTMLElement && node.getAttribute("data-skillhub-scroll-table") === "true");
          if (!table) return { ok: false, reason: "table missing" };
          table.scrollTop = table.scrollHeight;
          return { ok: true, scrollTop: table.scrollTop, clientHeight: table.clientHeight, scrollHeight: table.scrollHeight };
        `,
      );
      if (!scrolledBeforeNext.ok || scrolledBeforeNext.scrollTop <= 0) {
        throw new Error(`SkillHub table could not be scrolled before next page: ${JSON.stringify(scrolledBeforeNext)}`);
      }
      await delayNextSkillHubSearch(page);
      await clickSkillHubNextPageButton(page);
      await waitForText(page, "正在加载第 2 页", 5000);
      requestCount = await waitForSkillSearchRequestIncrease(page, requestCount, "dense list page 2");
      await waitForTextPattern(page, /第\s+2\s+\/\s+\d+\s+页\s+·\s+共/, 15000);
      const afterNextScroll = await evaluateInDom(
        page,
        `
          const table = allNodes().find((node) => node instanceof HTMLElement && node.getAttribute("data-skillhub-scroll-table") === "true");
          return table ? { ok: true, scrollTop: table.scrollTop } : { ok: false, reason: "table missing" };
        `,
      );
      if (!afterNextScroll.ok || afterNextScroll.scrollTop > 2) {
        throw new Error(`SkillHub table scroll did not reset after next page: ${JSON.stringify(afterNextScroll)}`);
      }
      const afterPage = await getActiveSkillHubPage(page);
      const afterPageRows = await getSkillHubDenseRowKeys(page, beforePageRows.length);
      if (afterPage !== 2) {
        throw new Error(`SkillHub page 2 did not become active: ${afterPage}`);
      }
      if (JSON.stringify(afterPageRows) === JSON.stringify(beforePageRows)) {
        throw new Error(`SkillHub page 2 did not replace visible rows: before=${JSON.stringify(beforePageRows)} after=${JSON.stringify(afterPageRows)}`);
      }
      const lastRequest = await page.evaluate(() => globalThis.__uclawSkillHubSearchRequests?.at(-1) ?? null);
      if (lastRequest?.params?.page !== "2" || lastRequest?.params?.pageSize !== "24") {
        throw new Error(`SkillHub page 2 request missing page/pageSize: ${JSON.stringify(lastRequest)}`);
      }
    } else {
      throw new Error("SkillHub numbered pagination unavailable");
    }

    stage = "primary-tabs";
    await clickButtonText(page, "全部");
    await waitForText(page, "筛选已安装技能", 10000);
    await waitForText(page, "卸载", 10000);
    await installSkillUninstallRequestProbe(page);
    const uninstallCountBefore = await getSkillUninstallRequestCount(page);
    await clickFirstSkillHubUninstallButton(page);
    await page.waitForFunction(
      (count) => (globalThis.__uclawSkillHubUninstallRequests?.length ?? 0) > count,
      uninstallCountBefore,
      { timeout: 15000 },
    );
    const uninstallRequest = await page.evaluate(() => globalThis.__uclawSkillHubUninstallRequests?.at(-1) ?? null);
    if (!uninstallRequest?.params?.skillKey) {
      throw new Error(`SkillHub uninstall request missing skillKey: ${JSON.stringify(uninstallRequest)}`);
    }
    await clickButtonText(page, "可用");
    await waitForText(page, "筛选已安装技能", 10000);
    await clickButtonText(page, "需配置");
    await waitForText(page, "筛选已安装技能", 10000);
    await clickButtonText(page, "已停用");
    await waitForText(page, "筛选已安装技能", 10000);
    await clickButtonText(page, "推荐");
    await waitForText(page, "API Key 不限", 10000);

    stage = "search";
    requestCount = await getSkillSearchRequestCount(page);
    await fillSkillHubSearch(page, "小说");
    requestCount = await waitForSkillSearchRequestIncrease(page, requestCount, "search query page 1");
    const searchPageOneRequest = await page.evaluate(() => globalThis.__uclawSkillHubSearchRequests?.at(-1) ?? null);
    if (searchPageOneRequest?.params?.page !== "1" || !String(searchPageOneRequest?.params?.keyword || "").includes("小说")) {
      throw new Error(`SkillHub search page 1 request missing keyword/page: ${JSON.stringify(searchPageOneRequest)}`);
    }
    await waitForText(page, "搜索结果", 30000);
    await waitForText(page, "小说", 30000);
    await waitForDenseRows(page, 1, 30000);
    await waitForSkillHubRequestIdle(page);
    await clickSkillHubNextPageButton(page);
    requestCount = await waitForSkillSearchRequestIncrease(page, requestCount, "search page 2");
    const searchPageRequest = await page.evaluate(() => globalThis.__uclawSkillHubSearchRequests?.at(-1) ?? null);
    if (searchPageRequest?.params?.page !== "2" || !String(searchPageRequest?.params?.keyword || "").includes("小说")) {
      throw new Error(`SkillHub search page 2 request missing keyword/page: ${JSON.stringify(searchPageRequest)}`);
    }
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
            uninstallRequests: globalThis.__uclawSkillHubUninstallRequests || [],
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
