import { constants } from "node:fs";
import { appendFile, lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const EVENTS = new Set(["desktop-started", "gateway-started", "gateway-stopped", "gateway-failed"]);

function isWithin(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
}

export function createDesktopLogSink(input: { dataDir: string; logsDir: string; now?: () => Date }) {
  const dataDir = resolve(input.dataDir); const logsDir = resolve(input.logsDir);
  if (!isAbsolute(input.dataDir) || !isAbsolute(input.logsDir) || !isWithin(dataDir, logsDir)) throw new Error("Desktop logs must remain inside portable data.");
  const path = join(logsDir, "uclaw-desktop.jsonl");
  return {
    async append(event: string): Promise<void> {
      if (!EVENTS.has(event)) throw new Error("Unknown desktop log event.");
      await mkdir(logsDir, { recursive: true, mode: 0o700 });
      const [dataReal, logsReal] = await Promise.all([realpath(dataDir), realpath(logsDir)]);
      if (!isWithin(dataReal, logsReal)) throw new Error("Desktop logs must remain inside portable data.");
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
      if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw new Error("Desktop log target is unsafe.");
      const handle = await open(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink !== 1) throw new Error("Desktop log target is unsafe.");
        await appendFile(handle, `${JSON.stringify({ timestamp: (input.now?.() ?? new Date()).toISOString(), source: "desktop", event })}\n`);
        await handle.sync();
      } finally { await handle.close(); }
    },
  };
}
