import { describe, expect, it } from "vitest";

import {
  ChannelSummarySchema,
  ConfigurationFieldSchema,
  DiagnosticSummarySchema,
  FileSummarySchema,
  ModelSummarySchema,
  ProviderSummarySchema,
  SkillSummarySchema,
} from "../src/index.js";

describe("management contracts", () => {
  it("parses first-phase read-only summaries", () => {
    expect(ModelSummarySchema.parse({ id: "m", label: "Model", providerId: "p", available: true, locality: "local", capabilities: ["text"] })).toBeTruthy();
    expect(ProviderSummarySchema.parse({ id: "p", label: "Provider", kind: "local", enabled: true, credential: { state: "missing" }, fields: [], health: "available", models: [] })).toBeTruthy();
    expect(SkillSummarySchema.parse({ id: "s", name: "Skill", source: "bundled", enabled: true, availability: "available" })).toBeTruthy();
    expect(ChannelSummarySchema.parse({ id: "c", kind: "telegram", name: "Channel", configured: false, enabled: false, state: "disconnected" })).toBeTruthy();
    expect(FileSummarySchema.parse({ id: "f", name: "notes.md", mediaType: "text/markdown", size: 10, kind: "workspace", entryType: "file", modifiedAt: "2026-08-07T00:00:00.000Z", writable: false })).toBeTruthy();
    expect(DiagnosticSummarySchema.parse({ id: "d", label: "Gateway", state: "passed", repairable: false })).toBeTruthy();
  });

  it("rejects malformed read-only summaries", () => {
    expect(() => ModelSummarySchema.parse({ id: "m", label: "Model", available: "yes" })).toThrow();
  });

  it("uses kind-discriminated configuration fields and never exposes secret values", () => {
    expect(ConfigurationFieldSchema.parse({ key: "name", label: "Name", kind: "text", required: true, value: "demo" })).toBeTruthy();
    expect(ConfigurationFieldSchema.parse({ key: "credential", label: "Key", kind: "secret", required: true, secret: { state: "configured", hint: "...1234" } })).toBeTruthy();
    expect(() => ConfigurationFieldSchema.parse({ key: "credential", label: "Key", kind: "secret", required: true, secret: { state: "configured" }, value: "plaintext" })).toThrow();
    expect(() => ConfigurationFieldSchema.parse({ key: "credential", label: "Key", kind: "secret", required: true, secret: { state: "configured", hint: "ghp_123456789012345678901234567890123456" } })).toThrow();
  });
});
