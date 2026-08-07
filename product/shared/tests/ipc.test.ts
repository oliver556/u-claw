import { describe, expect, it } from "vitest";

import { IpcEventSchema, IpcRequestSchema, IpcResponseSchema } from "../src/index.js";

describe("IPC contracts", () => {
  it("parses whitelisted window and client messages", () => {
    expect(IpcRequestSchema.parse({ channel: "window.minimize", payload: {} })).toBeTruthy();
    expect(IpcRequestSchema.parse({ channel: "client.gateway.status", payload: {} })).toBeTruthy();
    expect(IpcResponseSchema.parse({ channel: "window.minimize", ok: true, data: null })).toBeTruthy();
    expect(IpcEventSchema.parse({ channel: "client.gateway.changed", payload: { connectionState: "connecting", protocolVersion: 4 } })).toBeTruthy();
  });

  it("parses typed client responses and chat events", () => {
    expect(
      IpcResponseSchema.parse({
        channel: "client.models.list",
        ok: true,
        data: [{ id: "m", label: "Model", providerId: "p", available: true, locality: "local", capabilities: ["text"] }],
      }),
    ).toBeTruthy();
    expect(
      IpcEventSchema.parse({
        channel: "client.chat.event",
        payload: { type: "delta", runId: "run-1", mode: "append", text: "x" },
      }),
    ).toBeTruthy();
  });

  it.each([
    { channel: "client.gateway.status", payload: { token: "secret" } },
    { channel: "client.gateway.status", payload: { apiKey: "secret" } },
    { channel: "client.files.read", payload: { path: "/Users/private/file" } },
    { channel: "client.command.run", payload: { command: "rm -rf data" } },
  ])("rejects sensitive or arbitrary IPC input: $channel", (request) => {
    expect(() => IpcRequestSchema.parse(request)).toThrow();
  });
});
