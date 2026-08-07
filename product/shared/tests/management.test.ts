import { describe, expect, it } from "vitest";

import {
  ChannelSummarySchema,
  DiagnosticSummarySchema,
  FileSummarySchema,
  ModelSummarySchema,
  ProviderSummarySchema,
  SkillSummarySchema,
} from "../src/index.js";

describe("management contracts", () => {
  it("parses first-phase read-only summaries", () => {
    expect(ModelSummarySchema.parse({ id: "m", label: "Model", providerId: "p", available: true, locality: "local", capabilities: ["text"] })).toBeTruthy();
    expect(ProviderSummarySchema.parse({ id: "p", label: "Provider", kind: "local", enabled: true, credential: { configured: false }, fields: [], health: "available", models: [] })).toBeTruthy();
    expect(SkillSummarySchema.parse({ id: "s", name: "Skill", source: "bundled", enabled: true, availability: "available" })).toBeTruthy();
    expect(ChannelSummarySchema.parse({ id: "c", kind: "telegram", name: "Channel", configured: false, enabled: false, state: "disconnected" })).toBeTruthy();
    expect(FileSummarySchema.parse({ id: "f", name: "notes.md", mediaType: "text/markdown", size: 10, kind: "workspace", entryType: "file", modifiedAt: "2026-08-07T00:00:00.000Z", writable: false })).toBeTruthy();
    expect(DiagnosticSummarySchema.parse({ id: "d", label: "Gateway", state: "passed", repairable: false })).toBeTruthy();
  });

  it("rejects malformed read-only summaries", () => {
    expect(() => ModelSummarySchema.parse({ id: "m", label: "Model", available: "yes" })).toThrow();
  });
});
