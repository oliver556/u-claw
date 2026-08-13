import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as shared from "../src/index.js";

const fixture = JSON.parse(readFileSync(resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../tests/fixtures/builtin-service-operations-v1.json",
), "utf8")) as Record<string, unknown>;

const withUnknown = (value: unknown): unknown => ({ ...(value as Record<string, unknown>), unknown: true });

describe("builtin service operations v1 contract", () => {
  it("validates strict OpenAI-compatible non-streaming model list and chat payloads", () => {
    const models = {
      object: "list",
      data: [{ id: "uclaw-default", object: "model", created: 1_786_579_200, owned_by: "u-claw" }],
    };
    const request = {
      model: "uclaw-default",
      messages: [
        { role: "system", content: "Answer concisely." },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ],
      stream: false,
    };
    const response = {
      id: "chatcmpl_fixture_001",
      object: "chat.completion",
      created: 1_786_579_200,
      model: "uclaw-default",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
    };

    expect(shared.OpenAIModelsResponseSchema.parse(models)).toEqual(models);
    expect(shared.OpenAIChatCompletionRequestSchema.parse(request)).toEqual(request);
    expect(shared.OpenAIChatCompletionResponseSchema.parse(response)).toEqual(response);
    expect(() => shared.OpenAIModelsResponseSchema.parse(withUnknown(models))).toThrow();
    expect(() => shared.OpenAIChatCompletionRequestSchema.parse({ ...request, stream: true })).toThrow();
    expect(() => shared.OpenAIChatCompletionRequestSchema.parse({ ...request, stream: false, temperature: 0 })).toThrow();
    expect(() => shared.OpenAIChatCompletionRequestSchema.parse({
      ...request,
      messages: [{ role: "tool", content: "forbidden" }],
    })).toThrow();
    expect(() => shared.OpenAIChatCompletionRequestSchema.parse({
      ...request,
      messages: [{ role: "user", content: [{ type: "text", text: "not plain text" }] }],
    })).toThrow();
    expect(() => shared.OpenAIChatCompletionResponseSchema.parse({
      ...response,
      choices: [{ ...response.choices[0], unknown: true }],
    })).toThrow();
  });

  it("accepts all four service states with matching reason codes", () => {
    expect(shared.BUILTIN_SERVICE_OPERATIONS_CONTRACT_VERSION).toBe(1);
    for (const status of fixture.statuses as unknown[]) {
      expect(shared.BuiltinServiceStatusSchema.parse(status)).toEqual(status);
    }
    expect(shared.BuiltinServiceStatusSchema.parse({
      ...(fixture.statuses as Record<string, unknown>[])[0],
      reasonCode: "RECOVERY_COMPLETE",
    })).toBeTruthy();
  });

  it("rejects mismatched state reasons and unknown status fields", () => {
    const enabled = (fixture.statuses as Record<string, unknown>[])[0];
    const reasons = [
      "OPERATOR_ENABLED", "OPERATOR_DISABLED", "DEGRADED_HEALTH", "SCHEDULED_MAINTENANCE", "RECOVERY_COMPLETE",
    ];
    const allowed = new Set([
      "enabled:OPERATOR_ENABLED", "enabled:RECOVERY_COMPLETE", "disabled:OPERATOR_DISABLED",
      "degraded:DEGRADED_HEALTH", "maintenance:SCHEDULED_MAINTENANCE",
    ]);
    for (const state of ["enabled", "disabled", "degraded", "maintenance"]) {
      for (const reasonCode of reasons) {
        const parse = () => shared.BuiltinServiceStatusSchema.parse({ ...enabled, state, reasonCode });
        if (allowed.has(`${state}:${reasonCode}`)) expect(parse).not.toThrow();
        else expect(parse).toThrow();
      }
    }
    expect(() => shared.BuiltinServiceStatusSchema.parse(withUnknown(enabled))).toThrow();
    expect(() => shared.BuiltinServiceStatusSchema.parse({ ...enabled, revision: 0 })).toThrow();
  });

  it("requires bounded CAS and idempotency service updates", () => {
    expect(shared.BuiltinServiceStatusUpdateSchema.parse(fixture.serviceUpdate)).toEqual(fixture.serviceUpdate);
    expect(() => shared.BuiltinServiceStatusUpdateSchema.parse(withUnknown(fixture.serviceUpdate))).toThrow();
    expect(() => shared.BuiltinServiceStatusUpdateSchema.parse({ ...fixture.serviceUpdate as object, expectedRevision: 0 })).toThrow();
    expect(() => shared.BuiltinServiceStatusUpdateSchema.parse({ ...fixture.serviceUpdate as object, idempotencyKey: "short" })).toThrow();
    expect(() => shared.BuiltinServiceStatusUpdateSchema.parse({
      ...fixture.serviceUpdate as object,
      state: "enabled",
      reasonCode: "SCHEDULED_MAINTENANCE",
    })).toThrow();
  });

  it("accepts exactly one strict device locator", () => {
    expect(shared.BuiltinDeviceLocatorSchema.parse({ deviceId: "dev_fixture_001" })).toEqual({ deviceId: "dev_fixture_001" });
    expect(shared.BuiltinDeviceLocatorSchema.parse({ userId: "usr_fixture_001" })).toEqual({ userId: "usr_fixture_001" });
    expect(() => shared.BuiltinDeviceLocatorSchema.parse({ deviceId: "dev_fixture_001", userId: "usr_fixture_001" })).toThrow();
    expect(() => shared.BuiltinDeviceLocatorSchema.parse({ deviceId: "dev_fixture_001", unknown: true })).toThrow();
  });

  it("validates strict device controls and every nested policy layer", () => {
    expect(shared.BuiltinDeviceControlsSchema.parse(fixture.deviceControls)).toEqual(fixture.deviceControls);
    expect(() => shared.BuiltinDeviceControlsSchema.parse(withUnknown(fixture.deviceControls))).toThrow();
    const controls = fixture.deviceControls as Record<string, unknown>;
    const policy = controls.policy as Record<string, unknown>;
    expect(() => shared.BuiltinDeviceControlsSchema.parse({ ...controls, policy: { ...policy, unknown: true } })).toThrow();
    expect(() => shared.BuiltinDeviceControlsSchema.parse({
      ...controls,
      policy: { ...policy, quota: { ...(policy.quota as object), unknown: true } },
    })).toThrow();
    expect(() => shared.BuiltinDeviceControlsSchema.parse({
      ...controls,
      policy: { ...policy, rateLimit: { ...(policy.rateLimit as object), concurrentRequests: 10_001 } },
    })).toThrow();
  });

  it("pins device control updates to revision and current bindings", () => {
    expect(shared.BuiltinDeviceControlsUpdateSchema.parse(fixture.deviceUpdate)).toEqual(fixture.deviceUpdate);
    expect(() => shared.BuiltinDeviceControlsUpdateSchema.parse(withUnknown(fixture.deviceUpdate))).toThrow();
    const update = fixture.deviceUpdate as Record<string, unknown>;
    expect(() => shared.BuiltinDeviceControlsUpdateSchema.parse({
      ...update,
      policy: { ...(update.policy as object), unknown: true },
    })).toThrow();
    for (const field of ["expectedRevision", "expectedGeneration", "expectedLicenseId", "expectedTokenId"]) {
      const missing = { ...(fixture.deviceUpdate as Record<string, unknown>) };
      delete missing[field];
      expect(() => shared.BuiltinDeviceControlsUpdateSchema.parse(missing)).toThrow();
    }
  });

  it("validates bounded strict model request and response payloads", () => {
    expect(shared.BuiltinModelRequestSchema.parse(fixture.modelRequest)).toEqual(fixture.modelRequest);
    expect(shared.BuiltinModelResponseSchema.parse(fixture.modelResponse)).toEqual(fixture.modelResponse);
    expect(() => shared.BuiltinModelRequestSchema.parse(withUnknown(fixture.modelRequest))).toThrow();
    expect(() => shared.BuiltinModelResponseSchema.parse(withUnknown(fixture.modelResponse))).toThrow();
    const response = fixture.modelResponse as Record<string, unknown>;
    expect(() => shared.BuiltinModelResponseSchema.parse({
      ...response,
      usage: { ...(response.usage as object), unknown: true },
    })).toThrow();
    expect(() => shared.BuiltinModelRequestSchema.parse({ ...fixture.modelRequest as object, prompt: "" })).toThrow();
    expect(() => shared.BuiltinModelRequestSchema.parse({ ...fixture.modelRequest as object, maxOutputTokens: 32_769 })).toThrow();
    expect(() => shared.BuiltinModelRequestSchema.parse({
      ...fixture.modelRequest as object,
      prompt: "\u{1f642}".repeat(16_385),
    })).toThrow();
  });

  it("validates strict bounded health payloads", () => {
    expect(shared.BuiltinServiceHealthSchema.parse(fixture.health)).toEqual(fixture.health);
    expect(() => shared.BuiltinServiceHealthSchema.parse(withUnknown(fixture.health))).toThrow();
    expect(() => shared.BuiltinServiceHealthSchema.parse({ ...fixture.health as object, revision: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    for (const state of ["disabled", "maintenance"]) {
      expect(() => shared.BuiltinServiceHealthSchema.parse({ ...fixture.health as object, state })).toThrow();
    }
    expect(shared.BuiltinServiceHealthSchema.parse({
      ...fixture.health as object,
      state: "degraded",
      acceptingBuiltin: false,
    })).toBeTruthy();
  });

  it("enforces identifier, timestamp, collection, output, and usage bounds", () => {
    const controls = fixture.deviceControls as Record<string, unknown>;
    const policy = controls.policy as Record<string, unknown>;
    const response = fixture.modelResponse as Record<string, unknown>;
    expect(() => shared.BuiltinDeviceLocatorSchema.parse({ deviceId: "ab" })).toThrow();
    expect(() => shared.BuiltinDeviceLocatorSchema.parse({ deviceId: `d${"x".repeat(128)}` })).toThrow();
    expect(() => shared.BuiltinDeviceControlsSchema.parse({ ...controls, updatedAt: "not-a-timestamp" })).toThrow();
    expect(() => shared.BuiltinDeviceControlsSchema.parse({
      ...controls,
      policy: { ...policy, allowedModels: Array.from({ length: 201 }, (_, index) => `model-${index}`) },
    })).toThrow();
    expect(() => shared.BuiltinModelRequestSchema.parse({ ...fixture.modelRequest as object, model: "?" })).toThrow();
    expect(() => shared.BuiltinModelResponseSchema.parse({ ...response, output: "x".repeat(1_048_577) })).toThrow();
    expect(() => shared.BuiltinModelResponseSchema.parse({
      ...response,
      usage: { ...(response.usage as object), inputTokens: -1 },
    })).toThrow();
    expect(() => shared.BuiltinModelResponseSchema.parse({ ...response, serviceRevision: 0 })).toThrow();
  });
});
