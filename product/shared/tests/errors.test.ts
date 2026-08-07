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

  it("rejects raw secrets in cause details", () => {
    expect(() =>
      UClawErrorSchema.parse({
        code: "UNKNOWN",
        message: "请求失败",
        retryable: false,
        recoveryActions: [],
        causeDetails: { upstream: "Bearer raw-secret-value" },
      }),
    ).toThrow();
  });

  it.each([
    "Authorization: Basic Zm9vOmJhcg==",
    "Bearer raw-secret-value",
    "ghp_123456789012345678901234567890123456",
    "AKIAIOSFODNN7EXAMPLE",
    "api_key=top-secret-value",
    "token=top-secret-value",
  ])("rejects representative secret leakage in message: %s", (message) => {
    expect(() =>
      UClawErrorSchema.parse({
        code: "UNKNOWN",
        message,
        retryable: false,
        recoveryActions: [],
        causeDetails: {},
      }),
    ).toThrow();
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
  ])("rejects assigned credential text: %s", (message) => {
    expect(() => UClawErrorSchema.parse({
      code: "UNKNOWN",
      message,
      retryable: false,
      recoveryActions: [],
      causeDetails: {},
    })).toThrow();
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
