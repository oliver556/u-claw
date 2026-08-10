import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as shared from "../src/index.js";

const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures/new-api-management-v1.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  device: Record<string, unknown>;
  policy: unknown;
  usage: unknown;
  auditEvent: Record<string, unknown>;
};

describe("New API management v1 contract", () => {
  it("exports strict device, policy, usage, and audit schemas", () => {
    expect(shared.NEW_API_MANAGEMENT_CONTRACT_VERSION).toBe(1);
    expect(shared.NewApiDeviceMappingSchema.parse(fixture.device)).toBeTruthy();
    expect(shared.NewApiPolicySchema.parse(fixture.policy)).toBeTruthy();
    expect(shared.NewApiUsageSchema.parse(fixture.usage)).toBeTruthy();
    expect(shared.NewApiAuditEventSchema.parse(fixture.auditEvent)).toBeTruthy();
  });

  it("keeps startup authorization and device tokens in independent fields", () => {
    const device = shared.NewApiDeviceMappingSchema.parse(fixture.device);
    expect(device.startupSecretHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(device.startupSecretSalt).toMatch(/^[a-f0-9]{32,128}$/u);
    expect(device.newApiTokenId).toBe("tok_fixture_001");
    expect(JSON.stringify(device)).not.toMatch(/startupSecret":|tokenSecret|authorization|upstreamKey/iu);
  });

  it("requires token and mapping channel-policy binding with attempt generation", () => {
    const policyDigest = "d".repeat(64);
    const tokenInput = {
      idempotencyKey: "idem-token-binding-001",
      userId: "usr_fixture_001",
      name: "device",
      channelId: "channel_builtin_001",
      policyDigest,
      generation: 1,
    };
    expect(shared.NewApiCreateTokenInputSchema.parse(tokenInput)).toEqual(tokenInput);
    expect(() => shared.NewApiCreateTokenInputSchema.parse({
      idempotencyKey: tokenInput.idempotencyKey, userId: tokenInput.userId, name: tokenInput.name,
    })).toThrow();

    const mappingInput = {
      idempotencyKey: "idem-mapping-binding-001",
      ...fixture.device,
      channelId: tokenInput.channelId,
      policyDigest,
      generation: 1,
      previousTokenId: null,
    };
    delete (mappingInput as Record<string, unknown>).failure;
    delete (mappingInput as Record<string, unknown>).createdAt;
    delete (mappingInput as Record<string, unknown>).updatedAt;
    expect(shared.NewApiCreateDeviceMappingInputSchema.parse(mappingInput)).toEqual(mappingInput);
    expect(() => shared.NewApiCreateDeviceMappingInputSchema.parse({
      ...mappingInput, channelId: "channel_other_001",
    })).not.toThrow();
  });

  it("expresses failed provisioning and pending token compensation", () => {
    expect(shared.NewApiDeviceMappingSchema.parse({
      ...fixture.device,
      status: "failed",
      failure: {
        code: "WRITE_FAILED",
        compensation: { tokenId: "tok_fixture_001", status: "pending", attemptedAt: null },
      },
    })).toBeTruthy();
    expect(() => shared.NewApiDeviceMappingSchema.parse({ ...fixture.device, status: "active", failure: { code: "WRITE_FAILED" } })).toThrow();
  });

  it("rejects audit payloads and errors that can carry secrets", () => {
    expect(() => shared.NewApiAuditEventSchema.parse({
      ...fixture.auditEvent,
      headers: { authorization: "Bearer fixture" },
    })).toThrow();
    const error = shared.NewApiManagementErrorBodySchema.parse({
      error: { category: "conflict", code: "CONFLICT", message: "Bearer fixture-device-token", retryable: false },
    });
    expect(error.error.message).not.toContain("fixture-device-token");
    for (const credential of [
      `ghp_${"a".repeat(24)}`,
      "AKIAIOSFODNN7EXAMPLE",
      `xoxb-${"a".repeat(20)}`,
    ]) {
      const parsed = shared.NewApiManagementErrorBodySchema.parse({
        error: { category: "upstream", code: "UPSTREAM_ERROR", message: `Remote failure ${credential}`, retryable: false },
      });
      expect(parsed.error.message).not.toContain(credential);
    }
  });

  it("classifies management and downstream access failures without raw payloads", () => {
    const categories = [
      "validation", "conflict", "authentication", "not-found", "disabled", "quota", "rate-limit",
      "model-permission", "upstream", "unavailable", "transport", "invalid-response",
    ];
    for (const category of categories) {
      expect(shared.NewApiManagementErrorBodySchema.parse({
        error: { category, code: "FIXTURE_ERROR", message: "Safe fixture failure.", retryable: false },
      })).toBeTruthy();
    }
    expect(() => shared.NewApiManagementErrorBodySchema.parse({
      error: { category: "unknown", code: "FIXTURE_ERROR", message: "Safe fixture failure.", retryable: false },
    })).toThrow();
  });

  it("rejects contradictory user disable state and publishes bounded audit pages", () => {
    const user = {
      id: "usr_fixture_001", deviceId: "dev_fixture_001", username: "uclaw_fixture_001", status: "active",
      policy: fixture.policy, createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z",
    };
    expect(shared.NewApiUserSchema.parse(user)).toBeTruthy();
    expect(() => shared.NewApiUserSchema.parse({ ...user, policy: { ...(fixture.policy as object), disabled: true } })).toThrow();
    expect(() => shared.NewApiUserSchema.parse({ ...user, status: "disabled" })).toThrow();
    expect(shared.NewApiAuditPageSchema.parse({ items: [fixture.auditEvent], nextCursor: null, hasMore: false })).toBeTruthy();
    expect(() => shared.NewApiAuditPageSchema.parse({ items: Array(101).fill(fixture.auditEvent), nextCursor: null, hasMore: false })).toThrow();
  });
});
