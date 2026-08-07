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
        causeDetails: { phase: "ready", attempt: 2 },
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
});
