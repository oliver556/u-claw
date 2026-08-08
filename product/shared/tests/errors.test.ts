import { describe, expect, it } from "vitest";

import {
  RendererSafeSummarySchema,
  RendererSafeTextSchema,
  UClawErrorSchema,
  normalizeKey,
} from "../src/index.js";

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
        causeDetails: { upstreamCode: "Authorization: Bearer raw-secret-value" },
      });

    expect(JSON.stringify(parsed)).not.toContain("raw-secret-value");
  });

  it.each([
    "Authorization: Basic Zm9vOmJhcg==",
    "Authorization: Bearer raw-secret-value",
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

  it.each([
    "Authorization: Bearer required",
    "Authorization: required",
    "Bearer authentication required",
    "Token: expired.",
    "Cookie: missing",
  ])("allows non-secret status text: %s", (message) => {
    const parsed = UClawErrorSchema.parse({
      code: "AUTHORIZATION_REQUIRED",
      message,
      retryable: false,
      recoveryActions: [],
      causeDetails: {},
    });

    expect(parsed.message).toBe(message);
  });

  it.each([
    ["Bearer raw-secret-value", "Bearer [REDACTED]"],
    ["Bearer authentication required", "Bearer authentication required"],
    ["Bearer required", "Bearer required"],
    ["Bearer missing", "Bearer missing"],
    ["Bearer expired", "Bearer expired"],
    ["Bearer configured", "Bearer configured"],
    ["Bearer not configured", "Bearer not configured"],
    ["Bearer unavailable", "Bearer unavailable"],
    ["Bearer invalid", "Bearer invalid"],
    ["Bearer redacted", "Bearer redacted"],
    ["Token: not configured", "Token: not configured"],
    ["access_token=not configured", "access_token=not configured"],
    ["Authorization: Bearer not configured", "Authorization: Bearer not configured"],
  ])("redacts credential text with exact output: %s", (input, expected) => {
    expect(RendererSafeTextSchema.parse(input)).toBe(expected);
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
    "sk_" + "live_123456789012345678901234",
    "rk_" + "live_123456789012345678901234",
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

  it.each([
    ["apiKey", "api_key"],
    ["access-token", "access_token"],
    ["auth token", "auth_token"],
    ["session.cookie", "session_cookie"],
    ["privateKey", "private_key"],
  ])("normalizes contextual key %s", (input, expected) => {
    expect(normalizeKey(input)).toBe(expected);
  });

  it("redacts nonempty sensitive values while preserving metrics and safe statuses", () => {
    const parsed = RendererSafeSummarySchema.parse({
      apiKey: "context-secret-1",
      access_token: "context-secret-2",
      authToken: "context-secret-3",
      sessionCookie: true,
      privateKey: ["line-1", "line-2"],
      token: 123456,
      client_password: false,
      tokenCount: 42,
      inputTokens: 10,
      outputTokens: 20,
      maxTokens: 100,
      apiKeyStatus: "configured",
      tokenStatus: "expired",
      refreshToken: "not configured.",
      configured: true,
      present: false,
      enabled: true,
    });

    expect(parsed).toMatchObject({
      apiKey: "[REDACTED]",
      access_token: "[REDACTED]",
      authToken: "[REDACTED]",
      sessionCookie: "[REDACTED]",
      privateKey: "[REDACTED]",
      token: "[REDACTED]",
      client_password: "[REDACTED]",
      tokenCount: 42,
      inputTokens: 10,
      outputTokens: 20,
      maxTokens: 100,
      apiKeyStatus: "configured",
      tokenStatus: "expired",
      refreshToken: "not configured.",
      configured: true,
      present: false,
      enabled: true,
    });
  });

  it.each([
    "failed at /Users/alice/private/chat.txt",
    "failed at /home/alice/private/chat.txt",
    "failed at C:\\Users\\alice\\private\\chat.txt",
    "failed at file:///Users/alice/private/chat.txt",
    "failed at /Users/Alice Smith/private/chat.txt",
    "failed at /etc/u-claw/config.json",
    "failed at D:\\private\\chat.txt",
    "failed at C:/Users/alice/private/chat.txt",
    "failed at \\\\server\\share\\private\\chat.txt",
  ])("redacts local filesystem paths from renderer-safe text: %s", (message) => {
    const parsed = RendererSafeTextSchema.parse(message);

    expect(parsed).toBe("failed at [REDACTED]");
    expect(parsed).not.toContain("alice");
    expect(parsed).not.toContain("chat.txt");
  });

  it.each([
    [
      'gateway failed: {"api_key":"unprefixed-secret","access_token":1234567890,"body":"private conversation body"}',
      "[REDACTED]",
    ],
    ['failed at "/Users/alice/private/chat.txt"', 'failed at "[REDACTED]"'],
    ["opened '/etc/u-claw/config.json'", "opened '[REDACTED]'"],
    ['Authorization: Bearer "abc def"', "Authorization: Bearer [REDACTED]"],
  ])("fully redacts quoted or structured sensitive text: %s", (message, expected) => {
    expect(RendererSafeTextSchema.parse(message)).toBe(expected);
  });
});
