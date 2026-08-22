#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_GATEWAY_URL = process.env.SKILLHUB_VERIFY_GATEWAY_URL || "http://127.0.0.1:18789/";
const DEFAULT_CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH ||
  "/Users/biancheng/Library/Application Support/u-claw/.openclaw/openclaw.json";
const DEFAULT_SKILL = process.env.SKILLHUB_VERIFY_SKILL || "browser-automation";
const DEFAULT_CHROME_PATH =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const appRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appRoot, "..");
const stateDir = path.join(repoRoot, ".codex-state");

/**
 * Parses optional acceptance-test flags without requiring package.json changes.
 */
function parseArgs(argv) {
  const options = {
    gatewayUrl: DEFAULT_GATEWAY_URL,
    configPath: DEFAULT_CONFIG_PATH,
    skillName: DEFAULT_SKILL,
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
      if (index >= argv.length) {
        throw new Error("--gateway-url requires a value");
      }
      options.gatewayUrl = argv[index];
      continue;
    }

    if (arg.startsWith("--gateway-url=")) {
      options.gatewayUrl = arg.slice("--gateway-url=".length);
      continue;
    }

    if (arg === "--config") {
      index += 1;
      if (index >= argv.length) {
        throw new Error("--config requires a value");
      }
      options.configPath = argv[index];
      continue;
    }

    if (arg.startsWith("--config=")) {
      options.configPath = arg.slice("--config=".length);
      continue;
    }

    if (arg === "--skill") {
      index += 1;
      if (index >= argv.length) {
        throw new Error("--skill requires a value");
      }
      options.skillName = argv[index];
      continue;
    }

    if (arg.startsWith("--skill=")) {
      options.skillName = arg.slice("--skill=".length);
      continue;
    }

    if (arg === "--chrome") {
      index += 1;
      if (index >= argv.length) {
        throw new Error("--chrome requires a value");
      }
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
 * Prints usage for local connected UI acceptance.
 */
function printUsage() {
  console.log(`Usage: node scripts/verify-skillhub-connected-ui.js [--gateway-url <url>] [--config <path>] [--skill <name>] [--chrome <path>] [--headful]

Runs reversible connected UI acceptance for the chat SkillHub dropdown.

Requires playwright-core on NODE_PATH, for example Codex bundled runtime:
  NODE_PATH=/Users/biancheng/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules node scripts/verify-skillhub-connected-ui.js`);
}

/**
 * Loads playwright-core late so static syntax checks do not need browser deps.
 */
function loadPlaywright() {
  try {
    return require("playwright-core");
  } catch (error) {
    throw new Error(
      `playwright-core not found. Set NODE_PATH to Codex bundled node_modules. ${error.message}`,
    );
  }
}

/**
 * Reads the exact config text and parsed JSON before any UI mutation.
 */
function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`OpenClaw config not found: ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, "utf8");
  return {
    raw,
    json: JSON.parse(raw),
    hash: hash(raw),
  };
}

/**
 * Calculates a short stable hash for restore verification output.
 */
function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/**
 * Creates a timestamped exact backup before the UI save test.
 */
function backupConfig(configPath, raw) {
  fs.mkdirSync(stateDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
  const backupPath = path.join(stateDir, `skillhub_acceptance_openclaw_backup_${stamp}.json`);
  fs.writeFileSync(backupPath, raw);
  return backupPath;
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
 * Normalizes Gateway URL so Playwright can build route URLs predictably.
 */
function normalizeGatewayUrl(value) {
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url.toString();
}

/**
 * Converts the HTTP dashboard URL into the WebSocket URL expected by the login form.
 */
function toGatewayWebSocketUrl(value) {
  const url = new URL(value);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/**
 * Returns skills configured on the first explicit Agent entry, if any.
 */
function getFirstAgentSkills(config) {
  const agents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  const first = agents[0];
  return Array.isArray(first?.skills) ? first.skills.filter((skill) => typeof skill === "string") : [];
}

/**
 * Finds a visible element using several selector strategies.
 */
async function firstVisible(page, selectors, timeout = 4000) {
  const deadline = Date.now() + timeout;
  let lastError;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      try {
        if ((await locator.count()) > 0 && (await locator.isVisible())) {
          return locator;
        }
      } catch (error) {
        lastError = error;
      }
    }
    await page.waitForTimeout(100);
  }

  throw new Error(`No visible selector found: ${selectors.join(", ")}${lastError ? ` (${lastError.message})` : ""}`);
}

/**
 * Connects through the real login gate when the initial page has no saved auth.
 */
async function ensureConnected(page, dashboardUrl, gatewayWebSocketUrl, token) {
  const routeUrl = new URL("chat?session=agent%3Amain%3Amain", dashboardUrl);
  routeUrl.hash = new URLSearchParams({ token }).toString();
  await page.goto(routeUrl.toString(), {
    waitUntil: "domcontentloaded",
  });

  await page.waitForSelector("body", { timeout: 15000 });

  if ((await page.locator("text=选择 SkillHub").count()) > 0) {
    await page.waitForFunction(() => document.body.innerText.includes("选择 SkillHub"), null, { timeout: 20000 });
    await page.waitForTimeout(1500);
    return;
  }

  const loginGate = page.locator("openclaw-login-gate");
  if ((await loginGate.count()) === 0) {
    await page.waitForFunction(() => document.body.innerText.includes("选择 SkillHub"), null, { timeout: 20000 });
    return;
  }

  const urlInput = page.locator("openclaw-login-gate input").nth(0);
  const tokenInput = page.locator("openclaw-login-gate input").nth(1);
  await urlInput.fill(gatewayWebSocketUrl);
  await tokenInput.fill(token);
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

  const connectButton = await firstVisible(page, [
    "openclaw-login-gate .login-gate__connect",
    "openclaw-login-gate button:has-text('Connect')",
    "openclaw-login-gate button:has-text('连接')",
    "button:has-text('Connect')",
    "button:has-text('连接')",
  ]);
  await connectButton.click();
  await page.waitForFunction(() => document.body.innerText.includes("选择 SkillHub"), null, { timeout: 30000 });
  await page.waitForTimeout(1500);
}

/**
 * Selects one SkillHub skill from the chat dropdown and waits for save success.
 */
async function selectSkillHubSkill(page, skillName) {
  const summary = page.locator("details.chat-controls__skillhub summary").first();
  await summary.waitFor({ state: "visible", timeout: 20000 });
  await page.evaluate(() => {
    document.querySelector("details.chat-controls__skillhub summary")?.click();
  });

  await page.waitForFunction(
    ({ skillName: expected }) => {
      const details =
        document.querySelector("details[data-uclaw-skillhub]") ||
        document.querySelector("details.chat-controls__skillhub");
      if (!details?.open) return false;
      return [...details.querySelectorAll("button")].some(
        (button) =>
          button.getAttribute("data-chat-skillhub-option") === expected ||
          button.textContent?.includes(expected),
      );
    },
    { skillName },
    { timeout: 20000 },
  );

  const option = page
    .locator(
      `details.chat-controls__skillhub button[data-chat-skillhub-option="${skillName}"], details[data-uclaw-skillhub] button[data-chat-skillhub-option="${skillName}"]`,
    )
    .first();
  await option.click();

  await page.waitForFunction(
    ({ skillName: expected }) =>
      document.querySelector("details.chat-controls__skillhub summary")?.textContent?.includes(expected),
    { skillName },
    { timeout: 20000 },
  );
}

/**
 * Verifies the UI save wrote the selected skill while preserving old allowlist entries.
 */
function verifySavedConfig(configPath, before, skillName) {
  const after = readConfig(configPath).json;
  const beforeSkills = new Set(getFirstAgentSkills(before.json));
  const afterSkills = new Set(getFirstAgentSkills(after));

  if (!afterSkills.has(skillName)) {
    throw new Error(`Saved config does not contain selected skill: ${skillName}`);
  }

  for (const skill of beforeSkills) {
    if (!afterSkills.has(skill)) {
      throw new Error(`Saved config dropped pre-existing skill: ${skill}`);
    }
  }
}

/**
 * Restores the exact original config text after the reversible save test.
 */
function restoreConfig(configPath, raw) {
  fs.writeFileSync(configPath, raw);
  const restored = fs.readFileSync(configPath, "utf8");
  if (restored !== raw) {
    throw new Error("OpenClaw config restore verification failed");
  }
}

/**
 * Captures safe UI diagnostics without including credentials.
 */
async function collectUiDiagnostics(page) {
  try {
    return await page.evaluate(() => ({
      url: window.location.href.replace(/#.*$/, "#[redacted]"),
      hasSkillHubText: document.body.innerText.includes("选择 SkillHub"),
      skillHubOpen: document.querySelector("details.chat-controls__skillhub")?.open ?? null,
      skillHubText: document.querySelector("details.chat-controls__skillhub")?.innerText.slice(0, 500) ?? null,
      notice: document.body.innerText.includes("已保存，新会话生效"),
      errorText: document.body.innerText.includes("保存 SkillHub 选择失败"),
      bodyTail: document.body.innerText.slice(-800),
    }));
  } catch (error) {
    return { diagnosticError: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Runs reversible connected UI acceptance from browser launch to config restore.
 */
async function runAcceptance(options) {
  const { chromium } = loadPlaywright();
  const gatewayUrl = normalizeGatewayUrl(options.gatewayUrl);
  const gatewayWebSocketUrl = toGatewayWebSocketUrl(gatewayUrl);
  const before = readConfig(options.configPath);
  const token = getGatewayToken(before.json);
  const backupPath = backupConfig(options.configPath, before.raw);
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
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });
    page.on("pageerror", (error) => {
      errors.push(error.message);
    });

    stage = "connect";
    await ensureConnected(page, gatewayUrl, gatewayWebSocketUrl, token);
    stage = "select";
    await selectSkillHubSkill(page, options.skillName);
    stage = "verify saved config";
    verifySavedConfig(options.configPath, before, options.skillName);
  } catch (error) {
    const diagnostics = page ? await collectUiDiagnostics(page) : null;
    const detail = diagnostics ? ` diagnostics=${JSON.stringify(diagnostics)}` : "";
    throw new Error(`${stage}: ${error instanceof Error ? error.message : String(error)}${detail}`);
  } finally {
    await browser?.close().catch(() => undefined);
    restoreConfig(options.configPath, before.raw);
  }

  if (errors.length > 0) {
    throw new Error(`Browser console/page errors:\n${errors.slice(-5).join("\n")}`);
  }

  const restoredHash = readConfig(options.configPath).hash;
  if (restoredHash !== before.hash) {
    throw new Error(`Config hash changed after restore: before ${before.hash}, after ${restoredHash}`);
  }

  console.log(`OK SkillHub connected UI acceptance verified; backup=${backupPath}; restored=${restoredHash}`);
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
    console.error(`SkillHub connected UI acceptance failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

main();
