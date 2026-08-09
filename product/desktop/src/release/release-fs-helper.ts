import { once } from "node:events";
import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { RuntimeManifest } from "./release-service.js";

type CacheChild = "runtime" | "cache" | "updates";

export interface LauncherReleaseFSHelperOptions {
  launcherPath: string;
  packageRoot: string;
  cacheRoot: string;
  spawn?: typeof spawnChild;
}

export interface LauncherReleaseFSHelper {
  secureInstall(manifest: RuntimeManifest, packageBody: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<void>;
  secureCleanup(child: CacheChild): Promise<void>;
}

async function writeChunk(stream: NodeJS.WritableStream, chunk: Uint8Array): Promise<void> {
  if (!stream.write(chunk)) await once(stream, "drain");
}

export function createLauncherReleaseFSHelper(options: LauncherReleaseFSHelperOptions): LauncherReleaseFSHelper {
  const run = async (args: string[], writeInput: (child: ChildProcessWithoutNullStreams) => Promise<void>, signal?: AbortSignal): Promise<void> => {
    const child = (options.spawn ?? spawnChild)(options.launcherPath, ["--release-fs-helper", ...args], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let outputBytes = 0;
    let outputOverflow = false;
    const countOutput = (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 4096) { outputOverflow = true; child.kill(); }
    };
    child.stdout.on("data", countOutput); child.stderr.on("data", countOutput);
    const abort = () => child.kill();
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, closeSignal) => resolve({ code, signal: closeSignal }));
    });
    try {
      await writeInput(child);
      child.stdin.end();
      const result = await closed;
      signal?.throwIfAborted();
      if (outputOverflow || result.code !== 0 || result.signal !== null) throw new Error("Launcher release filesystem helper failed.");
    } catch (error) {
      child.stdin.destroy();
      child.kill();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  };

  return {
    async secureInstall(manifest, packageBody, signal) {
      await run(["secure-install", "--root", options.packageRoot], async (child) => {
        const header = Buffer.from(JSON.stringify({ schemaVersion: 1, manifest }));
        const prefix = Buffer.allocUnsafe(4); prefix.writeUInt32BE(header.byteLength);
        await writeChunk(child.stdin, prefix); await writeChunk(child.stdin, header);
        let bytes = 0;
        for await (const chunk of packageBody) {
          signal.throwIfAborted();
          bytes += chunk.byteLength;
          if (bytes > manifest.runtimeBytes) throw new Error("Runtime download size exceeded signed manifest.");
          await writeChunk(child.stdin, chunk);
        }
        if (bytes !== manifest.runtimeBytes) throw new Error("Runtime download size did not match signed manifest.");
      }, signal);
    },
    async secureCleanup(child) {
      await run(["cleanup-cache", "--root", options.cacheRoot, "--child", child], async () => undefined);
    },
  };
}
