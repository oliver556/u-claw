import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  mapOpenClawExecApproval,
  mapOpenClawPluginApproval,
  mapOpenClawSessionToolEvent,
} from "../src/openclaw-v4-contract.js";

const fixture = (name: string): any => JSON.parse(
  readFileSync(resolve(import.meta.dirname, `../fixtures/openclaw-2026.7.1-2/${name}`), "utf8"),
);

describe("OpenClaw tool and approval contract", () => {
  it("maps bounded summaries without exposing result text or absolute paths", () => {
    const tools = fixture("session.tool.json");

    const started = mapOpenClawSessionToolEvent(tools.start);
    const succeeded = mapOpenClawSessionToolEvent(tools.result);
    const serialized = JSON.stringify([started, succeeded]);

    expect(started).toMatchObject({ state: "running", inputSummary: { fieldCount: 0 } });
    expect(succeeded).toMatchObject({
      state: "succeeded",
      outputSummary: { fieldCount: 2, contentCount: 1 },
    });
    expect(serialized).not.toContain("[REDACTED TOOL RESULT]");
    expect(serialized).not.toContain("/tmp/openclaw-contract");
    expect(serialized.length).toBeLessThan(1_000);
  });

  it("keeps failed tool reasons useful but strips untrusted result content", () => {
    const failed = structuredClone(fixture("session.tool.json").result);
    failed.payload.data.isError = true;
    failed.payload.data.result = {
      message: "Authorization: Bearer tool-secret",
      path: "/Users/private/project/file.txt",
      retryable: false,
    };
    failed.payload.data.name = "/Users/private/tool --token=tool-name-secret";

    const mapped = mapOpenClawSessionToolEvent(failed);
    const serialized = JSON.stringify(mapped);

    expect(mapped).toMatchObject({
      state: "failed",
      toolId: "unknown-tool",
      displayName: "Unknown tool",
      error: { code: "OPERATION_FAILED", message: "OpenClaw tool authorization failed" },
      outputSummary: { fieldCount: 3, retryable: false, failureCategory: "authorization" },
    });
    expect(serialized).not.toContain("tool-secret");
    expect(serialized).not.toContain("/Users/private");
  });

  it("does not expose exec commands, working directories, or plugin descriptions", () => {
    const approvals = fixture("approvals.json");
    const exec = structuredClone(approvals.exec.allowOnce.event);
    exec.payload.request.command = "/Users/private/bin/run --token=approval-secret";
    exec.payload.request.commandArgv = ["/Users/private/bin/run", "--token=approval-secret"];
    exec.payload.request.cwd = "/Users/private/project";
    const plugin = structuredClone(approvals.plugin.allowOnce.event);
    plugin.payload.request.title = "Install from /Users/private/plugin";
    plugin.payload.request.description = "Authorization: Bearer plugin-secret";
    plugin.payload.request.pluginId = "/Users/private/plugin";
    plugin.payload.request.toolName = "Authorization: Bearer plugin-tool-secret";

    const mapped = [mapOpenClawExecApproval(exec), mapOpenClawPluginApproval(plugin)];
    const serialized = JSON.stringify(mapped);

    expect(mapped[0]).toMatchObject({
      title: "Approve command",
      description: "OpenClaw requests permission to execute a command",
      permissions: [{ scope: "gateway" }],
    });
    expect(mapped[1]).toMatchObject({
      title: "Approve plugin operation",
      description: "OpenClaw requests permission for a plugin operation",
      subject: { id: "unknown-plugin" },
      permissions: [{ scope: "unknown-plugin" }],
    });
    expect(serialized).not.toContain("approval-secret");
    expect(serialized).not.toContain("plugin-secret");
    expect(serialized).not.toContain("/Users/private");
  });
});
