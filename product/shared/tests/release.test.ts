import { describe, expect, it } from "vitest";

import { ReleaseIpcRequestSchema, ReleaseIpcResponseSchema, ReleaseOperationSchema } from "../src/release.js";

describe("release IPC contract", () => {
  it("marks completed installs that require a controlled restart", () => {
    expect(ReleaseOperationSchema.parse({
      id: "operation-1",
      kind: "install",
      state: "completed",
      phase: "completed",
      processedItems: 3,
      totalItems: 3,
      partialFailures: 0,
      message: "更新已安装。",
      recovery: "none",
      restartRequired: true,
    }).restartRequired).toBe(true);
  });

  it("allows only fixed release, recovery and uninstall actions", () => {
    expect(ReleaseIpcRequestSchema.parse({ method: "release.check", requestId: "check-1", params: { channel: "stable" } })).not.toHaveProperty("url");
    expect(ReleaseIpcRequestSchema.parse({ method: "release.install", requestId: "install-1", params: { updateId: "release-42", previewToken: "preview-42", confirmed: true } })).not.toHaveProperty("path");
    expect(ReleaseIpcRequestSchema.safeParse({ method: "process.exec", requestId: "bad", params: { command: "doctor --fix" } }).success).toBe(false);
    expect(ReleaseIpcRequestSchema.safeParse({ method: "release.check", requestId: "bad", params: { channel: "stable", url: "https://evil.invalid" } }).success).toBe(false);
    expect(ReleaseIpcRequestSchema.parse({ method: "release.rollback-preview", requestId: "rollback-preview", params: {} })).toBeTruthy();
    expect(ReleaseIpcRequestSchema.parse({ method: "release.rollback", requestId: "rollback", params: { previewToken: "rollback-preview-42", confirmed: true } })).toBeTruthy();
  });

  it("keeps update metadata structured and renderer responses path-free", () => {
    const response = ReleaseIpcResponseSchema.parse({
      method: "release.check", requestId: "check-1", ok: true,
      result: { state: "available", checkedAt: "2026-08-09T00:00:00.000Z", currentVersion: "0.1.0", channel: "stable", update: {
        id: "release-42", version: "0.2.0", channel: "stable", publishedAt: "2026-08-09T00:00:00.000Z",
        notes: ["安全更新"], compatibility: { platform: "win32", arch: "x64", runtimeId: "openclaw-2026.7.1-2-win-x64" },
        bytes: 128, mandatory: false, previewToken: "preview-42",
      } },
    });
    expect(JSON.stringify(response)).not.toMatch(/(?:https?:\/\/|[A-Za-z]:\\\\|\/Users\/|\/tmp\/)/);
  });
});
