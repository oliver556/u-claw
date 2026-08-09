import { describe, expect, it } from "vitest";

import {
  DiagnosticsIpcRequestSchema,
  DiagnosticsIpcResponseSchema,
} from "../src/diagnostics.js";

describe("diagnostics IPC contracts", () => {
  it("accepts bounded structured log filters", () => {
    const request = DiagnosticsIpcRequestSchema.parse({
      method: "logs.list",
      requestId: "logs-1",
      params: {
        limit: 100,
        query: "gateway",
        levels: ["warning", "error"],
        sources: ["gateway", "desktop"],
        from: "2026-08-08T00:00:00.000Z",
        to: "2026-08-09T00:00:00.000Z",
      },
    });
    expect(request.method).toBe("logs.list");
  });

  it.each([
    { method: "logs.list", requestId: "x", params: { limit: 501 } },
    { method: "logs.export", requestId: "x", params: { fileName: "../dump.jsonl" } },
    { method: "logs.cleanup", requestId: "x", params: { previewId: "preview", confirm: false } },
    { method: "config.export", requestId: "x", params: { fileName: "C:\\secret.json" } },
    { method: "unknown", requestId: "x", params: {} },
  ])("rejects unsafe or non-allowlisted requests", (request) => {
    expect(DiagnosticsIpcRequestSchema.safeParse(request).success).toBe(false);
  });

  it("rejects oversized renderer responses", () => {
    const response = {
      method: "config.get",
      requestId: "config-1",
      ok: true,
      result: {
        content: "x".repeat(1_000_001),
        entries: [],
        truncated: false,
      },
    };
    expect(DiagnosticsIpcResponseSchema.safeParse(response).success).toBe(false);
  });
});
