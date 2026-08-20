import { constants } from "node:fs";
import { appendFile, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { redactRendererText } from "@uclaw/shared";

export interface GatewayDiagnosticRecord {
  event: string;
  [key: string]: unknown;
}

export interface GatewayDiagnosticSink {
  append(record: GatewayDiagnosticRecord): void | Promise<void>;
  flush?(): void | Promise<void>;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function isWithin(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
}

export function createGatewayLogSink(input: {
  dataDir: string;
  logsDir: string;
  now?: () => Date;
  maxBytes?: number;
}): GatewayDiagnosticSink {
  const dataDir = resolve(input.dataDir);
  const logsDir = resolve(input.logsDir);
  if (!isAbsolute(input.dataDir) || !isAbsolute(input.logsDir) || !isWithin(dataDir, logsDir)) {
    throw new Error("Gateway logs must remain inside portable data.");
  }
  const path = join(logsDir, "uclaw-gateway.jsonl");
  const historyPath = `${path}.1`;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  let pending = Promise.resolve();

  const write = async (record: GatewayDiagnosticRecord): Promise<void> => {
    await mkdir(logsDir, { recursive: true, mode: 0o700 });
    const [dataReal, logsReal] = await Promise.all([realpath(dataDir), realpath(logsDir)]);
    if (!isWithin(dataReal, logsReal)) throw new Error("Gateway logs must remain inside portable data.");
    const line = `${JSON.stringify({
      timestamp: (input.now?.() ?? new Date()).toISOString(),
      source: "gateway",
      ...record,
    }, (key, value) => typeof value === "string" ? redactRendererText(value, key) : value)}\n`;
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) {
      throw new Error("Gateway log target is unsafe.");
    }
    if (info && info.size + Buffer.byteLength(line) > maxBytes) {
      await rm(historyPath, { force: true });
      await rename(path, historyPath);
    }
    const handle = await open(
      path,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1) throw new Error("Gateway log target is unsafe.");
      await appendFile(handle, line);
    } finally {
      await handle.close();
    }
  };

  return {
    append(record): Promise<void> {
      pending = pending.then(() => write(record), () => write(record)).catch(() => undefined);
      return pending;
    },
    flush(): Promise<void> {
      return pending;
    },
  };
}
