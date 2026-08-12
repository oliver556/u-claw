import { describe, expect, it } from "vitest";
import { AutomationIpcRequestSchema, AutomationIpcResponseSchema } from "../src/automation.js";

describe("automation contracts", () => {
  it("rejects path traversal and unknown fields", () => {
    expect(() => AutomationIpcRequestSchema.parse({ method: "agents.files.get", requestId: "r1", params: { agentId: "main", path: "../secret" } })).toThrow();
    expect(() => AutomationIpcRequestSchema.parse({ method: "cron.list", requestId: "r1", params: {}, extra: true })).toThrow();
  });

  it("requires correlated success results and failure errors", () => {
    expect(() => AutomationIpcResponseSchema.parse({ method: "agents.list", requestId: "r1", ok: true })).toThrow();
    expect(() => AutomationIpcResponseSchema.parse({ method: "agents.list", requestId: "r1", ok: false })).toThrow();
  });
});
