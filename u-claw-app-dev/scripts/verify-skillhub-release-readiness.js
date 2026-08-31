#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const assetsDir = path.join(root, "node_modules", "openclaw", "dist", "control-ui", "assets");
const defaultGatewayUrl = process.env.SKILLHUB_VERIFY_GATEWAY_URL || "http://127.0.0.1:18789/";

/**
 * Parses verifier flags without adding package.json command aliases.
 */
function parseArgs(argv) {
  const options = {
    gatewayUrl: defaultGatewayUrl,
    skipGateway: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--skip-gateway") {
      options.skipGateway = true;
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

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

/**
 * Prints command usage for local and CI-like verification.
 */
function printUsage() {
  console.log(`Usage: node scripts/verify-skillhub-release-readiness.js [--skip-gateway] [--gateway-url <url>]

Runs SkillHub release-readiness checks without modifying package.json.

Flags:
  --skip-gateway       Skip HTTP reachability check.
  --gateway-url <url>  Gateway URL. Default: ${defaultGatewayUrl}`);
}

/**
 * Runs one command and records concise diagnostics on failure.
 */
function runStep(label, command, args, errors, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });

  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();

  if (result.error) {
    errors.push(`${label} failed to start: ${result.error.message}`);
    return { ok: false, output };
  }

  if (result.status !== 0) {
    errors.push(`${label} exited ${result.status}: ${lastLines(output)}`);
    return { ok: false, output };
  }

  return { ok: true, output };
}

/**
 * Keeps command failure output readable while preserving the decisive tail.
 */
function lastLines(output) {
  if (!output) {
    return "(no output)";
  }

  return output.split(/\r?\n/).slice(-8).join("\n");
}

/**
 * Lists generated chat assets so readiness checks fail on missing OpenClaw UI output.
 */
function listChatAssets() {
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`Missing OpenClaw control-ui assets directory: ${assetsDir}`);
  }

  const files = fs
    .readdirSync(assetsDir)
    .filter((name) => /^chat-page-.*\.js$/.test(name))
    .sort()
    .map((name) => path.join(assetsDir, name));

  if (files.length === 0) {
    throw new Error(`Missing chat-page asset in ${assetsDir}`);
  }

  return files;
}

/**
 * Verifies the generated OpenClaw chat bundles are syntactically valid JavaScript.
 */
function verifyGeneratedChatSyntax(errors) {
  try {
    for (const file of listChatAssets()) {
      runStep(`syntax ${path.relative(root, file)}`, process.execPath, ["--check", file], errors);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Verifies patch script idempotency after applying the OpenClaw UI patch.
 */
function verifyPatchIdempotency(errors) {
  runStep("patch-openclaw first run", "npm", ["run", "patch-openclaw"], errors);
  const secondRun = runStep("patch-openclaw idempotency run", "npm", ["run", "patch-openclaw"], errors);

  if (secondRun.ok && /\bpatched\b/.test(secondRun.output)) {
    errors.push(`patch-openclaw idempotency run still changed files:\n${lastLines(secondRun.output)}`);
  }
}

/**
 * Verifies the local Gateway helper builds the intended command without starting a service.
 */
function verifyGatewayHelper(errors) {
  const defaultCommand = runStep(
    "gateway helper print-command",
    process.execPath,
    ["scripts/start-openclaw-gateway-local.js", "--print-command"],
    errors,
  );

  if (defaultCommand.ok) {
    if (!defaultCommand.output.includes(process.execPath)) {
      errors.push("gateway helper print-command did not use process.execPath");
    }
    if (defaultCommand.output.includes("'--force'")) {
      errors.push("gateway helper default command unexpectedly includes --force");
    }
  }

  const forceCommand = runStep(
    "gateway helper force print-command",
    process.execPath,
    ["scripts/start-openclaw-gateway-local.js", "--port", "18800", "--force", "--print-command"],
    errors,
  );

  if (forceCommand.ok) {
    if (!forceCommand.output.includes("'--port' '18800'")) {
      errors.push("gateway helper force command did not include requested port 18800");
    }
    if (!forceCommand.output.includes("'--force'")) {
      errors.push("gateway helper force command did not include explicit --force");
    }
  }
}

/**
 * Runs the static SkillHub verifier suite.
 */
function verifyStaticSuite(errors) {
  runStep("syntax patch-openclaw", process.execPath, ["--check", "scripts/patch-openclaw.js"], errors);
  runStep("syntax SkillHub branding verifier", process.execPath, ["--check", "scripts/verify-skillhub-branding.js"], errors);
  runStep("syntax SkillHub chat dropdown verifier", process.execPath, ["--check", "scripts/verify-skillhub-chat-dropdown.js"], errors);
  runStep("syntax ecommerce workflow verifier", process.execPath, ["--check", "scripts/verify-ecommerce-workflow.js"], errors);
  runStep("syntax ecommerce workbench UI verifier", process.execPath, ["--check", "scripts/verify-ecommerce-workbench-ui.js"], errors);
  runStep("syntax Gateway helper", process.execPath, ["--check", "scripts/start-openclaw-gateway-local.js"], errors);
  runStep("syntax release readiness verifier", process.execPath, ["--check", __filename], errors);

  verifyPatchIdempotency(errors);
  verifyGeneratedChatSyntax(errors);

  runStep("SkillHub branding verifier", process.execPath, ["scripts/verify-skillhub-branding.js"], errors);
  runStep("SkillHub chat dropdown verifier", process.execPath, ["scripts/verify-skillhub-chat-dropdown.js"], errors);
  runStep("ecommerce workflow verifier", process.execPath, ["scripts/verify-ecommerce-workflow.js"], errors);
  verifyGatewayHelper(errors);
}

/**
 * Checks Gateway HTTP reachability without shelling out to curl.
 */
function checkGateway(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;

    const request = client.request(
      parsed,
      {
        method: "GET",
        timeout: 5000,
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode || 0));
      },
    );

    request.on("timeout", () => {
      request.destroy(new Error(`Gateway request timed out: ${url}`));
    });
    request.on("error", reject);
    request.end();
  });
}

/**
 * Runs Gateway reachability unless static-only verification was requested.
 */
async function verifyGatewayReachability(options, errors) {
  if (options.skipGateway) {
    console.log("SKIP Gateway HTTP check");
    return;
  }

  try {
    const statusCode = await checkGateway(options.gatewayUrl);
    if (statusCode !== 200) {
      errors.push(`Gateway HTTP expected 200, got ${statusCode} at ${options.gatewayUrl}`);
    }
  } catch (error) {
    errors.push(`Gateway HTTP check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Runs the complete SkillHub release-readiness verification workflow.
 */
async function main() {
  let options;
  const errors = [];

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

  verifyStaticSuite(errors);
  await verifyGatewayReachability(options, errors);

  if (errors.length > 0) {
    console.error("SkillHub release readiness verification failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("OK SkillHub release readiness verified");
}

main();
