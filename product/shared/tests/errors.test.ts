import { describe, expect, it } from "vitest";

import { UClawErrorSchema } from "../src/index.js";

describe("error contracts", () => {
  it("parses a renderer-safe error", () => {
    expect(
      UClawErrorSchema.parse({
        code: "GATEWAY_DISCONNECTED",
        message: "网关连接已断开",
        retryable: true,
        recoveryActions: ["reconnect"],
        causeDetails: { diagnosticCode: "gateway-disconnected", status: "ready", retryAfterMs: 200 },
      }),
    ).toMatchObject({ code: "GATEWAY_DISCONNECTED", retryable: true });
  });

  it("redacts raw secrets in cause details", () => {
    const parsed = UClawErrorSchema.parse({
        code: "UNKNOWN",
        message: "请求失败",
        retryable: false,
        recoveryActions: [],
        causeDetails: { upstreamCode: "Bearer raw-secret-value" },
      });

    expect(JSON.stringify(parsed)).not.toContain("raw-secret-value");
  });

  it.each([
    "Authorization: Basic Zm9vOmJhcg==",
    "Bearer raw-secret-value",
    "ghp_123456789012345678901234567890123456",
    "AKIAIOSFODNN7EXAMPLE",
    "api_key=top-secret-value",
    "token=top-secret-value",
  ])("redacts representative secret leakage in message: %s", (message) => {
    const parsed = UClawErrorSchema.parse({
        code: "UNKNOWN",
        message,
        retryable: false,
        recoveryActions: [],
        causeDetails: {},
      });

    expect(parsed.message).toContain("[REDACTED]");
    expect(parsed.message).not.toBe(message);
  });

  it.each(["Authorization: required", "Token: expired"])("allows non-secret status text: %s", (message) => {
    expect(UClawErrorSchema.parse({
      code: "AUTHORIZATION_REQUIRED",
      message,
      retryable: false,
      recoveryActions: [],
      causeDetails: {},
    })).toBeTruthy();
  });

  it.each([
    "password=hunter2",
    "client_secret: actual-secret",
    "access_token=actual-token",
    "refresh_token: actual-token",
    "Cookie: session=actual-cookie",
    "API Key: actual-secret",
    "aws_secret_access_key=actual-secret-value",
    "github_pat_1234567890123456789012345678901234567890",
    "xoxb-1234567890-1234567890-secret",
    "AIzaSyD12345678901234567890123456789012",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456",
    "Set-Cookie: session=actual-cookie",
  ])("redacts assigned credential text: %s", (message) => {
    const parsed = UClawErrorSchema.parse({
      code: "UNKNOWN",
      message,
      retryable: false,
      recoveryActions: [],
      causeDetails: {},
    });

    expect(parsed.message).toContain("[REDACTED]");
    expect(parsed.message).not.toBe(message);
  });

  it("rejects non-allowlisted cause detail fields", () => {
    expect(() =>
      UClawErrorSchema.parse({
        code: "UNKNOWN",
        message: "请求失败",
        retryable: false,
        recoveryActions: [],
        causeDetails: { arbitrary: "not allowed" },
      }),
    ).toThrow();
  });
});
