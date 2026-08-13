import { createPublicKey } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { UClawErrorSchema, type UClawError, type UClawErrorCode } from "@uclaw/shared";

import { findOpenClawEntrypoint } from "../plugins/openclaw-cli-runtime.js";

export interface DesktopWiringEnvironment {
  runtimeRoot: string;
  dataRoot: string;
  cacheRoot: string;
  openClawConfig: string;
  openClawEntry: string;
  nodeExecutable: string;
  electronRunAsNode: boolean;
  gatewayToken: string;
}

export interface ActivationServiceConfiguration {
  endpoint: URL;
  trustedPublicKeys: Readonly<Record<string, string>>;
}

export class DesktopWiringError extends Error implements UClawError {
  readonly code: UClawErrorCode;
  readonly retryable: boolean;
  readonly recoveryActions: UClawError["recoveryActions"];
  readonly causeDetails: UClawError["causeDetails"];

  constructor(code: UClawErrorCode, message: string, retryable = false) {
    const error = UClawErrorSchema.parse({
      code,
      message,
      retryable,
      recoveryActions: retryable ? ["retry"] : ["open-diagnostics"],
      causeDetails: { operation: "desktop.wiring" },
    });
    super(error.message);
    this.name = "DesktopWiringError";
    this.code = error.code;
    this.retryable = error.retryable;
    this.recoveryActions = error.recoveryActions;
    this.causeDetails = error.causeDetails;
  }
}

function isWithin(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
}

const activationKeyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");

export function readActivationServiceConfiguration(env: NodeJS.ProcessEnv): ActivationServiceConfiguration {
  const rawEndpoint = env.UCLAW_ACTIVATION_ENDPOINT;
  const rawKeys = env.UCLAW_ACTIVATION_TRUSTED_PUBLIC_KEYS;
  if (!rawEndpoint || !rawKeys) throw new DesktopWiringError("UNCONFIGURED", "Activation service is not configured.");
  try {
    const endpoint = new URL(rawEndpoint);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error("invalid activation endpoint");
    }
    if (!endpoint.pathname.endsWith("/")) endpoint.pathname += "/";
    const parsed = JSON.parse(rawKeys) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid activation keys");
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length < 1 || entries.length > 16) throw new Error("invalid activation keys");
    const trustedPublicKeys: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [keyId, encodedKey] of entries) {
      if (!activationKeyIdPattern.test(keyId) || typeof encodedKey !== "string" || encodedKey.length > 128) {
        throw new Error("invalid activation key");
      }
      const rawKey = Buffer.from(encodedKey, "base64");
      if (rawKey.length !== 32 || rawKey.toString("base64") !== encodedKey) throw new Error("invalid activation key");
      trustedPublicKeys[keyId] = createPublicKey({
        key: Buffer.concat([ed25519SpkiPrefix, rawKey]), format: "der", type: "spki",
      }).export({ format: "pem", type: "spki" }).toString();
    }
    return { endpoint, trustedPublicKeys };
  } catch {
    throw new DesktopWiringError("INVALID_ARGUMENT", "Activation service configuration is invalid.");
  }
}

export async function readDesktopWiringEnvironment(env: NodeJS.ProcessEnv): Promise<DesktopWiringEnvironment> {
  const rawRuntimeRoot = env.UCLAW_RUNTIME_DIR;
  if (!rawRuntimeRoot || !isAbsolute(rawRuntimeRoot) || rawRuntimeRoot.includes("\0")) {
    throw new DesktopWiringError("UNCONFIGURED", "Desktop runtime is not configured.");
  }
  let runtimeRoot: string;
  try {
    runtimeRoot = await realpath(resolve(rawRuntimeRoot));
  } catch {
    throw new DesktopWiringError("UNAVAILABLE", "Desktop runtime is unavailable.");
  }
  const rawEntry = env.UCLAW_OPENCLAW_ENTRY;
  if (rawEntry !== undefined && (!isAbsolute(rawEntry) || rawEntry.includes("\0"))) {
    throw new DesktopWiringError("INVALID_ARGUMENT", "OpenClaw runtime entry is invalid.");
  }
  let openClawEntry: string;
  try {
    openClawEntry = await findOpenClawEntrypoint(runtimeRoot, rawEntry === undefined ? undefined : resolve(rawEntry));
  } catch {
    throw new DesktopWiringError("UNAVAILABLE", "OpenClaw runtime entry is unavailable.");
  }
  if (!isWithin(runtimeRoot, openClawEntry)) {
    throw new DesktopWiringError("FORBIDDEN", "OpenClaw runtime entry is outside the controlled runtime.");
  }
  let nodeExecutable = process.execPath;
  let electronRunAsNode = true;
  if (env.UCLAW_NODE_BIN !== undefined) {
    if (!isAbsolute(env.UCLAW_NODE_BIN) || env.UCLAW_NODE_BIN.includes("\0")) {
      throw new DesktopWiringError("INVALID_ARGUMENT", "Node runtime configuration is invalid.");
    }
    try {
      nodeExecutable = await realpath(resolve(env.UCLAW_NODE_BIN));
    } catch {
      throw new DesktopWiringError("UNAVAILABLE", "Node runtime is unavailable.");
    }
    if (!isWithin(runtimeRoot, nodeExecutable)) {
      throw new DesktopWiringError("FORBIDDEN", "Node runtime is outside the controlled runtime.");
    }
    electronRunAsNode = false;
  }
  const rawConfigPath = env.OPENCLAW_CONFIG_PATH;
  if (!rawConfigPath || !isAbsolute(rawConfigPath) || rawConfigPath.includes("\0")) {
    throw new DesktopWiringError("UNCONFIGURED", "OpenClaw configuration is not configured.");
  }
  const rawDataRoot = env.UCLAW_DATA_DIR;
  if (!rawDataRoot || !isAbsolute(rawDataRoot) || rawDataRoot.includes("\0")) {
    throw new DesktopWiringError("UNCONFIGURED", "Desktop data root is not configured.");
  }
  let configPath: string;
  let dataRoot: string;
  let cacheRoot: string;
  let config: unknown;
  try {
    configPath = await realpath(resolve(rawConfigPath));
    dataRoot = await realpath(resolve(rawDataRoot));
    if (!isWithin(dataRoot, configPath)) {
      throw new DesktopWiringError("FORBIDDEN", "OpenClaw configuration is outside the controlled data root.");
    }
    config = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof DesktopWiringError) throw error;
    throw new DesktopWiringError("UNCONFIGURED", "OpenClaw configuration is unavailable.");
  }
  const rawCacheRoot = env.UCLAW_CACHE_DIR;
  if (!rawCacheRoot || !isAbsolute(rawCacheRoot) || rawCacheRoot.includes("\0")) {
    throw new DesktopWiringError("UNCONFIGURED", "Desktop cache root is not configured.");
  }
  try {
    cacheRoot = await realpath(resolve(rawCacheRoot));
  } catch {
    throw new DesktopWiringError("UNAVAILABLE", "Desktop cache root is unavailable.");
  }
  const gateway = typeof config === "object" && config !== null && !Array.isArray(config)
    ? (config as Record<string, unknown>).gateway
    : undefined;
  const auth = typeof gateway === "object" && gateway !== null && !Array.isArray(gateway)
    ? (gateway as Record<string, unknown>).auth
    : undefined;
  const gatewayToken = typeof auth === "object" && auth !== null && !Array.isArray(auth)
    ? (auth as Record<string, unknown>).token
    : undefined;
  if (
    typeof gatewayToken !== "string" || gatewayToken.length === 0 || gatewayToken.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(gatewayToken)
  ) {
    throw new DesktopWiringError("UNCONFIGURED", "Gateway authentication is not configured.");
  }
  return {
    runtimeRoot,
    dataRoot,
    cacheRoot,
    openClawConfig: configPath,
    openClawEntry,
    nodeExecutable,
    electronRunAsNode,
    gatewayToken,
  };
}
