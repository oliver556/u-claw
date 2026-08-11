import { spawn } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

import { LOCKED_OPENCLAW_VERSION } from "@uclaw/shared";
import { z } from "zod";

import type { PluginRuntimeAdapter, RuntimePluginRecord } from "./runtime-adapter.js";

const PluginListSchema = z.object({
  plugins: z.array(z.object({
    id: z.string().min(1),
    name: z.string().optional(),
    description: z.string().optional(),
    version: z.string().optional(),
    enabled: z.boolean(),
    origin: z.string().optional(),
    source: z.string().optional(),
  }).passthrough()),
}).passthrough();

const MAX_RUNTIME_SCAN_ENTRIES = 20_000;
const COMMAND_TIMEOUT_MS = 120_000;

function isWithin(root: string, child: string): boolean {
  const value = relative(root, child);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

export async function findOpenClawEntrypoint(runtimeRoot: string, explicitEntry?: string): Promise<string> {
  const resolvedRoot = await realpath(runtimeRoot);
  const validateEntry = async (path: string): Promise<string | null> => {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    const resolved = await realpath(path);
    if (!isWithin(resolvedRoot, resolved)) throw new Error("OpenClaw entrypoint escapes runtime root.");
    if (basename(resolved) !== "openclaw.mjs") return null;
    try {
      const packageJson = JSON.parse(await readFile(join(dirname(resolved), "package.json"), "utf8")) as { name?: unknown; version?: unknown };
      return packageJson.name === "openclaw" && packageJson.version === LOCKED_OPENCLAW_VERSION ? resolved : null;
    } catch {
      return null;
    }
  };
  if (explicitEntry !== undefined) {
    const entrypoint = await validateEntry(explicitEntry);
    if (!entrypoint) throw new Error("Locked OpenClaw runtime entrypoint not found.");
    return entrypoint;
  }
  for (const candidate of [
    join(resolvedRoot, "node_modules", "openclaw", "openclaw.mjs"),
    join(resolvedRoot, "openclaw", "openclaw.mjs"),
  ]) {
    try {
      const entrypoint = await validateEntry(candidate);
      if (entrypoint) return entrypoint;
    } catch {
      // Missing or invalid fixed candidates fall through to bounded legacy discovery.
    }
  }
  let visited = 0;
  const visit = async (directory: string): Promise<string | null> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      visited += 1;
      if (visited > MAX_RUNTIME_SCAN_ENTRIES) throw new Error("OpenClaw runtime inventory exceeds limit.");
      const path = join(directory, child.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) continue;
      if (child.isFile() && child.name === "openclaw.mjs") {
        const entrypoint = await validateEntry(path);
        if (entrypoint) return entrypoint;
      }
      if (child.isDirectory()) {
        const found = await visit(path);
        if (found) return found;
      }
    }
    return null;
  };
  const entrypoint = await visit(resolvedRoot);
  if (!entrypoint) throw new Error("Locked OpenClaw runtime entrypoint not found.");
  return entrypoint;
}

async function runCommand(options: {
  executable: string;
  entrypoint: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.executable, [options.entrypoint, ...options.args], {
      env: options.environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes <= 2 * 1024 * 1024) target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    const timeout = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error("OpenClaw Plugin lifecycle process failed to start.", { cause: error }));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 || outputBytes > 2 * 1024 * 1024) {
        reject(new Error("OpenClaw Plugin lifecycle command failed."));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

export async function createOpenClawCliPluginRuntime(input: {
  runtimeRoot: string;
  executable: string;
  dataDir: string;
  baseEnvironment?: NodeJS.ProcessEnv;
}): Promise<PluginRuntimeAdapter> {
  if (!isAbsolute(input.runtimeRoot) || !isAbsolute(input.executable)) throw new Error("OpenClaw runtime paths must be absolute.");
  const entrypoint = await findOpenClawEntrypoint(input.runtimeRoot);
  const packageJson = JSON.parse(await readFile(join(dirname(entrypoint), "package.json"), "utf8")) as { name?: unknown; version?: unknown };
  if (packageJson.name !== "openclaw" || packageJson.version !== LOCKED_OPENCLAW_VERSION) {
    throw new Error("OpenClaw Plugin runtime version does not match lock.");
  }
  const openClawState = join(input.dataDir, ".openclaw");
  const environment: NodeJS.ProcessEnv = {
    ...(input.baseEnvironment ?? process.env),
    ELECTRON_RUN_AS_NODE: "1",
    OPENCLAW_HOME: input.dataDir,
    OPENCLAW_STATE_DIR: openClawState,
    OPENCLAW_CONFIG_PATH: join(openClawState, "openclaw.json"),
  };
  const run = (args: string[]) => runCommand({ executable: input.executable, entrypoint, args, environment });
  const installed = async (): Promise<RuntimePluginRecord[]> => {
    const result = PluginListSchema.parse(JSON.parse(await run(["plugins", "list", "--json"])) as unknown);
    return result.plugins.map((plugin) => ({
      slug: plugin.id,
      name: plugin.name ?? plugin.id,
      description: plugin.description ?? "",
      version: plugin.version ?? "unknown",
      enabled: plugin.enabled,
      origin: ["bundled", "global", "workspace", "config"].includes(plugin.origin ?? "")
        ? plugin.origin as RuntimePluginRecord["origin"]
        : "unknown",
      source: plugin.source ?? "",
    }));
  };
  return {
    installed,
    async installFromPath({ sourceDir, slug }) {
      await run(["plugins", "install", sourceDir, "--force"]);
      if (!(await installed()).some((plugin) => plugin.slug === slug)) throw new Error("OpenClaw did not register installed Plugin.");
    },
    async uninstall(slug) {
      await run(["plugins", "uninstall", slug, "--force"]);
      if ((await installed()).some((plugin) => plugin.slug === slug && plugin.origin !== "bundled")) {
        throw new Error("OpenClaw did not remove installed Plugin.");
      }
    },
    async setEnabled(slug, enabled) {
      await run(["plugins", enabled ? "enable" : "disable", slug]);
      const record = (await installed()).find((plugin) => plugin.slug === slug);
      if (!record || record.enabled !== enabled) throw new Error("OpenClaw did not persist Plugin enablement.");
    },
  };
}
