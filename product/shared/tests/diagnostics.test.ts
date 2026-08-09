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

  it("accepts only structured doctor, repair, and bounded network requests", () => {
    expect(DiagnosticsIpcRequestSchema.parse({ method: "doctor.run", requestId: "doctor-1", params: {} }).method).toBe("doctor.run");
    expect(DiagnosticsIpcRequestSchema.parse({ method: "doctor.repair", requestId: "repair-1", params: { actionId: "gateway-restart", previewToken: "doctor-preview-1", confirmed: true } }).method).toBe("doctor.repair");
    expect(DiagnosticsIpcRequestSchema.safeParse({ method: "doctor.repair", requestId: "bad-action", params: { actionId: "runtime-restart", previewToken: "doctor-preview-1", confirmed: true } }).success).toBe(false);
    expect(DiagnosticsIpcRequestSchema.parse({ method: "network.run", requestId: "network-1", params: { timeoutMs: 2500 } }).method).toBe("network.run");
    expect(DiagnosticsIpcRequestSchema.safeParse({ method: "doctor.repair", requestId: "bad", params: { command: "rm -rf /", confirmed: true } }).success).toBe(false);
    expect(DiagnosticsIpcRequestSchema.safeParse({ method: "network.run", requestId: "bad", params: { target: "https://secret.example", timeoutMs: 999999 } }).success).toBe(false);
  });

  it("accepts path-free structured doctor and network results", () => {
    const doctor = DiagnosticsIpcResponseSchema.parse({ method: "doctor.run", requestId: "doctor-1", ok: true, result: {
      state: "issues", adapter: "openclaw", checks: [{ id: "gateway", label: "Gateway", level: "error", summary: "Gateway 未就绪。", suggestion: "重启受控 Gateway。", repair: { actionId: "gateway-restart", label: "重启 Gateway", previewToken: "doctor-preview-1" } }],
    } });
    const network = DiagnosticsIpcResponseSchema.parse({ method: "network.run", requestId: "network-1", ok: true, result: {
      mode: "intranet-only", checks: [{ id: "provider", label: "Provider", status: "unreachable", level: "warning", summary: "外网不可用。", durationMs: 1200 }], proxy: { configured: true, noProxyConfigured: true },
    } });
    expect(JSON.stringify([doctor, network])).not.toMatch(/(?:command|https?:\/\/|[A-Za-z]:\\\\|\/Users\/)/);
  });
});
