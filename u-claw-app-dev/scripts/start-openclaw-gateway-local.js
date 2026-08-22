#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_PORT = 18789;
const DEFAULT_OPENCLAW_HOME = "/Users/biancheng/Library/Application Support/u-claw";

const appRoot = path.resolve(__dirname, "..");
const openclawPath = path.join(appRoot, "node_modules", "openclaw");
const openclawEntry = path.join(openclawPath, "openclaw.mjs");

/**
 * Parses launcher flags while keeping this helper independent from package.json.
 */
function parseArgs(argv) {
  const options = {
    port: DEFAULT_PORT,
    force: false,
    printCommand: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--print-command") {
      options.printCommand = true;
      continue;
    }

    if (arg === "--force") {
      options.force = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--port") {
      index += 1;
      if (index >= argv.length) {
        throw new Error("--port requires a value");
      }
      options.port = parsePort(argv[index]);
      continue;
    }

    if (arg.startsWith("--port=")) {
      options.port = parsePort(arg.slice("--port=".length));
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

/**
 * Validates the gateway port before passing it to OpenClaw.
 */
function parsePort(value) {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }

  return port;
}

/**
 * Builds OpenClaw's local data environment from macOS U-Claw userData defaults.
 */
function buildEnv() {
  const openclawHome = process.env.OPENCLAW_HOME || DEFAULT_OPENCLAW_HOME;
  const openclawStateDir = process.env.OPENCLAW_STATE_DIR || path.join(openclawHome, ".openclaw");
  const openclawConfigPath = process.env.OPENCLAW_CONFIG_PATH || path.join(openclawStateDir, "openclaw.json");
  const nodeCompileCache = process.env.NODE_COMPILE_CACHE || path.join(openclawHome, ".cache", "v8-compile-cache");

  const env = {
    ...process.env,
    OPENCLAW_HOME: openclawHome,
    OPENCLAW_STATE_DIR: openclawStateDir,
    OPENCLAW_CONFIG_PATH: openclawConfigPath,
    OPENCLAW_EMBEDDED_IN: process.env.OPENCLAW_EMBEDDED_IN || "U-Claw",
    NODE_COMPILE_CACHE: nodeCompileCache,
  };

  if (process.platform === "win32") {
    env.OPENCLAW_DISABLE_BONJOUR = "1";
  }

  return env;
}

/**
 * Returns the exact OpenClaw gateway command this helper will run.
 */
function buildCommand(options) {
  const args = [
    openclawEntry,
    "gateway",
    "run",
    "--allow-unconfigured",
    "--port",
    String(options.port),
  ];

  if (options.force) {
    args.push("--force");
  }

  return {
    bin: process.execPath,
    args,
  };
}

/**
 * Creates only directories needed by the local gateway process.
 */
function prepareLocalDataDirs(env) {
  fs.mkdirSync(env.OPENCLAW_HOME, { recursive: true });
  fs.mkdirSync(env.OPENCLAW_STATE_DIR, { recursive: true });
  fs.mkdirSync(env.NODE_COMPILE_CACHE, { recursive: true });
}

/**
 * Shell-quotes a value for human copy/paste in --print-command mode.
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Prints cwd, env, and argv in one shell-copyable command line.
 */
function formatCommand(command, env) {
  const envKeys = [
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_EMBEDDED_IN",
    "NODE_COMPILE_CACHE",
  ];
  const envParts = envKeys.map((key) => `${key}=${shellQuote(env[key])}`);
  const argv = [command.bin, ...command.args].map(shellQuote).join(" ");

  return `cd ${shellQuote(openclawPath)} && ${envParts.join(" ")} ${argv}`;
}

function printUsage() {
  console.log(`Usage: node scripts/start-openclaw-gateway-local.js [--port <port>] [--force] [--print-command]

Starts OpenClaw Gateway with the current Node executable.

Defaults:
  OPENCLAW_HOME=${DEFAULT_OPENCLAW_HOME}
  port=${DEFAULT_PORT}

Environment:
  OPENCLAW_HOME may override the local U-Claw data directory.

Flags:
  --port <port>       Gateway port. Default: ${DEFAULT_PORT}
  --force             Pass --force to openclaw gateway run.
  --print-command     Print command only; do not start Gateway.`);
}

function main() {
  let options;

  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    printUsage();
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    printUsage();
    return;
  }

  const env = buildEnv();
  const command = buildCommand(options);

  if (options.printCommand) {
    console.log(formatCommand(command, env));
    return;
  }

  if (!fs.existsSync(openclawEntry)) {
    console.error(`OpenClaw entry not found: ${openclawEntry}`);
    process.exitCode = 1;
    return;
  }

  prepareLocalDataDirs(env);

  const child = spawn(command.bin, command.args, {
    cwd: openclawPath,
    env,
    stdio: "inherit",
  });

  child.on("error", (error) => {
    console.error(`Failed to start OpenClaw Gateway: ${error.message}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}

main();
