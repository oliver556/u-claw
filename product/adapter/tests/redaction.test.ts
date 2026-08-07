import { describe, expect, it } from "vitest";

import { redactAdapterLog, redactAdapterRecord } from "../src/redaction.js";

describe("adapter redaction", () => {
  it("delegates text and record redaction to shared renderer-safe rules", () => {
    expect(redactAdapterLog("Authorization: Bearer sk-proj-abcdefghijk")).toBe("Authorization: Bearer [REDACTED]");
    expect(redactAdapterRecord({ accessToken: "secret-value", status: "ready" })).toEqual({ accessToken: "[REDACTED]", status: "ready" });
  });
});
