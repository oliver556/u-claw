import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createDesktopLogSink } from "../src/diagnostics/desktop-log-sink.js";

describe("desktop log sink", () => {
  it("appends only bounded safe events to the owned desktop log across recreation", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-desktop-log-"));
    const logsDir = join(dataDir, "diagnostics", "desktop-logs");
    await mkdir(logsDir, { recursive: true });
    await createDesktopLogSink({ dataDir, logsDir }).append("gateway-started");
    await createDesktopLogSink({ dataDir, logsDir }).append("gateway-stopped");

    const content = await readFile(join(logsDir, "uclaw-desktop.jsonl"), "utf8");
    expect(content.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ source: "desktop", event: "gateway-started" }),
      expect.objectContaining({ source: "desktop", event: "gateway-stopped" }),
    ]);
    expect(content).not.toMatch(/token|Bearer|\/Users\//i);
  });

  it("rejects paths outside portable data", () => {
    expect(() => createDesktopLogSink({ dataDir: "/portable/data", logsDir: "/tmp/logs" })).toThrow("inside portable data");
  });
});
