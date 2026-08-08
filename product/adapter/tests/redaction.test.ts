import { describe, expect, it } from "vitest";

import { redactAdapterLog, redactAdapterRecord } from "../src/redaction.js";

describe("adapter redaction", () => {
  it("delegates text and record redaction to shared renderer-safe rules", () => {
    expect(redactAdapterLog("Authorization: Bearer sk-proj-abcdefghijk")).toBe("Gateway diagnostic event.");
    expect(redactAdapterRecord({ accessToken: "secret-value", status: "ready" })).toEqual({ accessToken: "[REDACTED]", status: "ready" });
  });

  it.each([
    'gateway failed: {"api_key":"unprefixed-secret","body":"private conversation body"}',
    'Authorization: Bearer "abc def"',
    "failed at '/etc/u-claw/config.json'",
  ])("never copies raw text into adapter diagnostics: %s", (message) => {
    expect(redactAdapterLog(message)).toBe("Gateway diagnostic event.");
  });

  it("redacts nested headers, mixed arrays, numeric credentials, and local paths", () => {
    const redacted = redactAdapterRecord({
      status: "ready",
      requestHeaders: {
        Authorization: "Bearer nested-secret",
        Cookie: "session=nested-cookie",
      },
      events: [
        { content: "private conversation body" },
        { token: 1234567890 },
        { "Authorization-Bearer-sk-proj-field-secret": "failed" },
        "failed at /Users/alice/private/chat.txt",
      ],
      payload: { turns: [{ role: "user", value: "second private conversation body" }] },
      credential: 987654321,
      openaiApiKey: "unprefixed-openai-key",
      clientSecretValue: "unprefixed-client-secret",
      credentials: ["array-credential"],
    } as never);
    const serialized = JSON.stringify(redacted);

    expect(redacted.status).toBe("ready");
    expect(serialized).not.toMatch(/nested-secret|nested-cookie|private conversation body|1234567890|987654321|field-secret|unprefixed-openai-key|unprefixed-client-secret|array-credential|\/Users\/alice|chat\.txt/);
    expect(serialized).toContain("[REDACTED]");
  });

  it.each([null, 123456789, ["private conversation body"], new Error("token=secret")])(
    "fails closed for non-record runtime input: %j",
    (input) => {
      expect(redactAdapterRecord(input as never)).toEqual({});
    },
  );

  it("fails closed when a record getter throws", () => {
    const record = {} as Record<string, unknown>;
    Object.defineProperty(record, "payload", {
      enumerable: true,
      get: () => { throw new Error("private conversation body token=secret"); },
    });

    expect(redactAdapterRecord(record)).toEqual({});
  });
});
