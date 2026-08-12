import { link, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDiagnosticsService } from "../../desktop/src/diagnostics/diagnostics-service.js";
import { LOG_OWNERSHIP_MANIFEST } from "../../desktop/src/portable-paths.js";

describe("diagnostics security integration", () => {
  it("keeps nested mixed-type secrets and filesystem aliases outside renderer/export", async () => {
    const root = await mkdtemp(join(tmpdir(), "uclaw-diagnostics-integration-"));
    const dataDir = join(root, "data");
    const logsDir = join(dataDir, "diagnostics", "desktop-logs");
    const configPath = join(dataDir, ".openclaw", "openclaw.json");
    await mkdir(logsDir, { recursive: true });
    await mkdir(join(dataDir, ".openclaw"), { recursive: true });
    const outside = join(root, "outside.jsonl");
    await writeFile(outside, `${JSON.stringify({ timestamp: "2026-08-09T00:00:00.000Z", level: "error", source: "gateway", message: "outside-secret" })}\n`);
    await symlink(outside, join(logsDir, "uclaw-gateway.jsonl"));
    await link(outside, join(logsDir, "uclaw-adapter.jsonl"));
    await writeFile(join(logsDir, "uclaw-desktop.jsonl"), `${JSON.stringify({ timestamp: "2026-08-09T01:00:00.000Z", level: "info", source: "desktop", event: "gateway.ready", body: ["private conversation"], tool: { arguments: { token: 123456789 } } })}\n`);
    await writeFile(configPath, JSON.stringify({
      gateway: { port: 18789, auth: { token: 123456789 } },
      credentials: [{ cookie: "session-secret" }],
      cause: new Error("Authorization: Bearer nested-secret"),
      stack: ["C:\\Users\\alice\\secret.ts:1"],
      unknown: { valueOf: "type-confusion-secret" },
    }));
    await writeFile(join(logsDir, ".uclaw-log-ownership.json"), JSON.stringify(LOG_OWNERSHIP_MANIFEST));
    const service = createDiagnosticsService({
      dataDir, logsDir, configPath, runtime: { productVersion: "fixture" },
      diagnostics: {
        list: async () => [],
        listLogs: async () => ({
          items: [{ id: "private-id", timestamp: "2026-08-09T01:00:00.000Z", level: "info", source: "desktop", message: "private conversation 123456789" }],
          nextCursor: null, hasMore: false,
        }),
      },
    });
    const [logs, config, exported] = await Promise.all([
      service.dispatch({ method: "logs.list", requestId: "logs", params: { limit: 100 } }),
      service.dispatch({ method: "config.get", requestId: "config", params: {} }),
      service.dispatch({ method: "config.export", requestId: "export", params: { fileName: "redacted.json" } }),
    ]);
    expect(logs).toMatchObject({ ok: true, result: { items: expect.arrayContaining([expect.objectContaining({ message: "Desktop info event." })]) } });
    expect(exported.ok).toBe(true);
    const exportText = exported.ok && exported.method === "config.export"
      ? await readFile(join(dataDir, exported.result.relativePath), "utf8")
      : "";
    expect(`${JSON.stringify(logs)}${JSON.stringify(config)}${exportText}`).not.toMatch(/outside-secret|private conversation|123456789|session-secret|nested-secret|alice|type-confusion-secret/);
  });
});
