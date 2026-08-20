import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import { z } from "zod";

import { findOpenClawEntrypoint } from "../plugins/openclaw-cli-runtime.js";

const InferenceResultSchema = z.object({
  ok: z.literal(true),
  capability: z.enum(["image.generate", "image.edit"]),
  provider: z.string().min(1),
  model: z.string().min(1),
  outputs: z.array(z.object({
    path: z.string().min(1),
    mimeType: z.string().regex(/^image\//u),
    size: z.number().int().positive(),
  }).passthrough()).length(1),
}).passthrough();

const COMMAND_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface OpenClawImageInference {
  infer(input: {
    prompt: string;
    model: string;
    clientRequestId: string;
    image?: string;
  }, signal?: AbortSignal): Promise<{ path: string; mimeType: string; size: number }>;
}

function isWithin(root: string, child: string): boolean {
  const value = relative(root, child);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

export function buildOpenClawImageInferArgs(input: {
  prompt: string;
  model: string;
  image?: string;
}, outputPath: string): string[] {
  return [
    "infer", "image", input.image === undefined ? "generate" : "edit",
    "--model", input.model,
    "--prompt", input.prompt,
    ...(input.image === undefined ? [] : ["--file", input.image]),
    "--count", "1",
    "--output", outputPath,
    "--json",
  ];
}

function parseInferenceOutput(output: string) {
  const marker = output.lastIndexOf("\n{");
  const json = marker >= 0 ? output.slice(marker + 1) : output.slice(output.indexOf("{"));
  return InferenceResultSchema.parse(JSON.parse(json));
}

async function runCommand(options: {
  executable: string;
  entrypoint: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.executable, [options.entrypoint, ...options.args], {
      env: options.environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    const abort = () => child.kill();
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes <= MAX_OUTPUT_BYTES) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { outputBytes += chunk.byteLength; });
    const timeout = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      reject(new Error("OpenClaw image inference failed to start."));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      if (options.signal?.aborted === true) {
        reject(options.signal.reason ?? new Error("Aborted"));
        return;
      }
      if (code !== 0 || outputBytes > MAX_OUTPUT_BYTES) {
        reject(new Error("OpenClaw image inference command failed."));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

export async function createOpenClawImageCliRuntime(input: {
  runtimeRoot: string;
  executable: string;
  entrypoint?: string;
  dataDir: string;
  baseEnvironment?: NodeJS.ProcessEnv;
}): Promise<OpenClawImageInference> {
  if (!isAbsolute(input.runtimeRoot) || !isAbsolute(input.executable) || !isAbsolute(input.dataDir)) {
    throw new Error("OpenClaw image inference paths must be absolute.");
  }
  const entrypoint = await findOpenClawEntrypoint(input.runtimeRoot, input.entrypoint);
  const workspacePath = join(input.dataDir, "workspace");
  await mkdir(workspacePath, { recursive: true, mode: 0o700 });
  const workspace = await realpath(workspacePath);
  const outputDir = join(workspace, "generated-images");
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const environment: NodeJS.ProcessEnv = {
    ...(input.baseEnvironment ?? process.env),
    ELECTRON_RUN_AS_NODE: "1",
    OPENCLAW_HOME: input.dataDir,
    OPENCLAW_STATE_DIR: input.baseEnvironment?.OPENCLAW_STATE_DIR ?? join(input.dataDir, ".openclaw"),
    OPENCLAW_CONFIG_PATH: input.baseEnvironment?.OPENCLAW_CONFIG_PATH ?? join(input.dataDir, ".openclaw", "openclaw.json"),
  };
  return {
    infer: async (request, signal) => {
      const outputPath = join(outputDir, `uclaw-${randomUUID()}.png`);
      const output = parseInferenceOutput(await runCommand({
        executable: input.executable,
        entrypoint,
        args: buildOpenClawImageInferArgs(request, outputPath),
        environment,
        signal,
      }));
      const generated = output.outputs[0]!;
      const resolved = await realpath(generated.path);
      if (resolved !== outputPath || !isWithin(workspace, resolved)) throw new Error("OpenClaw image output escaped workspace.");
      const info = await lstat(resolved);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== generated.size) throw new Error("OpenClaw image output failed validation.");
      return { path: resolved, mimeType: generated.mimeType, size: generated.size };
    },
  };
}
