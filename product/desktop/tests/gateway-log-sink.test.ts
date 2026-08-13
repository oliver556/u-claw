import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createGatewayLogSink } from "../src/diagnostics/gateway-log-sink.js";

describe("gateway log sink", () => {
  it("writes Gateway records to an independent JSONL and rotates one history file", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-gateway-log-"));
    const logsDir = join(dataDir, "diagnostics", "desktop-logs");
    const sink = createGatewayLogSink({ dataDir, logsDir, maxBytes: 220 });

    await sink.append({ event: "gateway-spawned", pid: 1, instanceId: 1, phase: "starting" });
    await sink.append({ event: "gateway-exited", pid: 1, instanceId: 1, phase: "starting", stderrTail: "x".repeat(180) });

    const current = await readFile(join(logsDir, "uclaw-gateway.jsonl"), "utf8");
    const history = await readFile(join(logsDir, "uclaw-gateway.jsonl.1"), "utf8");
    expect(JSON.parse(current)).toMatchObject({ source: "gateway", event: "gateway-exited" });
    expect(JSON.parse(history)).toMatchObject({ source: "gateway", event: "gateway-spawned" });
  });

  it("does not reject when its log target cannot be written", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uclaw-gateway-log-fail-"));
    const logsDir = join(dataDir, "diagnostics", "desktop-logs");
    await mkdir(logsDir, { recursive: true });
    await writeFile(join(logsDir, "uclaw-gateway.jsonl"), "occupied");
    const target = join(logsDir, "uclaw-gateway.jsonl");
    expect((await stat(target)).isFile()).toBe(true);
    await mkdir(`${target}.1`, { recursive: true });

    const sink = createGatewayLogSink({ dataDir, logsDir, maxBytes: 1 });
    await expect(sink.append({ event: "gateway-spawned", phase: "starting" })).resolves.toBeUndefined();
  });
});
